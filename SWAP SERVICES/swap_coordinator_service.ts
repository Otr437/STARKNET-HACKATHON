// ============================================
// ATOMIC SWAP COORDINATOR MICROSERVICE
// Port: 3005
// ============================================

import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import Redis from 'ioredis';
import axios from 'axios';

const app = express();
app.use(cors());
app.use(express.json());

// ============================================
// SERVICE CLIENTS
// ============================================

const NOTE_SERVICE = process.env.NOTE_SERVICE_URL || 'http://localhost:3003';
const BTC_BRIDGE_SERVICE = process.env.BTC_BRIDGE_SERVICE_URL || 'http://localhost:3004';
const POSEIDON_SERVICE = process.env.POSEIDON_SERVICE_URL || 'http://localhost:3002';
const ENCRYPTION_SERVICE = process.env.ENCRYPTION_SERVICE_URL || 'http://localhost:3001';

interface PrivacyNote {
  amount: bigint;
  recipient: string;
  secret: string;
  nullifier: string;
  commitment: string;
  amountCommitment: string;
  leafIndex: number;
  timestamp: number;
}

interface SwapState {
  swapId: string;
  initiator: string;
  recipient: string;
  initiatorNote: PrivacyNote;
  recipientNote: PrivacyNote;
  htlcSecret: string;
  htlcSecretHash: string;
  timelock: number;
  btcTxid?: string;
  status: 'pending' | 'locked' | 'completed' | 'refunded';
  createdAt: number;
}

class ServiceClients {
  static async generateNote(amount: string, recipient: string, secret?: string): Promise<any> {
    const res = await axios.post(`${NOTE_SERVICE}/api/notes/generate`, {
      amount, recipient, secret
    });
    return res.data;
  }

  static async generateSPVProof(txid: string): Promise<any> {
    const res = await axios.post(`${BTC_BRIDGE_SERVICE}/api/btc/spv-proof`, { txid });
    return res.data;
  }

  static async verifyMerkleProof(txid: string, merkleProof: string[], txIndex: number, merkleRoot: string): Promise<boolean> {
    const res = await axios.post(`${BTC_BRIDGE_SERVICE}/api/btc/verify-merkle`, {
      txid, merkleProof, txIndex, merkleRoot
    });
    return res.data.valid;
  }

  static async hash4(inputs: [string, string, string, string]): Promise<{ hash: string; felt252: string }> {
    const res = await axios.post(`${POSEIDON_SERVICE}/api/hash4`, { inputs });
    return res.data;
  }

  static async encrypt(data: string, purpose: string): Promise<string> {
    const res = await axios.post(`${ENCRYPTION_SERVICE}/api/encrypt`, { data, purpose });
    return res.data.encrypted;
  }

  static async decrypt(encrypted: string, purpose: string): Promise<string> {
    const res = await axios.post(`${ENCRYPTION_SERVICE}/api/decrypt`, { encrypted, purpose });
    return res.data.decrypted;
  }
}

// ============================================
// ATOMIC SWAP COORDINATOR
// ============================================

class AtomicSwapCoordinator {
  private swaps: Map<string, SwapState> = new Map();
  private redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async initiateSwap(
    initiatorAddress: string,
    recipientAddress: string,
    amount: bigint,
    timelockDuration: number
  ): Promise<{ swapId: string; htlcSecret: string; htlcSecretHash: string }> {
    
    const htlcSecret = crypto.randomBytes(32).toString('hex');
    const htlcSecretHash = crypto.createHash('sha256')
      .update(Buffer.from(htlcSecret, 'hex'))
      .digest('hex');

    // Generate privacy notes via Note Service
    const initiatorNoteRes = await ServiceClients.generateNote(
      amount.toString(), 
      initiatorAddress
    );
    
    const recipientNoteRes = await ServiceClients.generateNote(
      amount.toString(), 
      recipientAddress
    );

    // Create mock notes from responses
    const initiatorNote: PrivacyNote = {
      amount,
      recipient: initiatorAddress,
      secret: '',
      nullifier: initiatorNoteRes.nullifier,
      commitment: initiatorNoteRes.commitment,
      amountCommitment: initiatorNoteRes.amountCommitment,
      leafIndex: 0,
      timestamp: Date.now()
    };

    const recipientNote: PrivacyNote = {
      amount,
      recipient: recipientAddress,
      secret: '',
      nullifier: recipientNoteRes.nullifier,
      commitment: recipientNoteRes.commitment,
      amountCommitment: recipientNoteRes.amountCommitment,
      leafIndex: 1,
      timestamp: Date.now()
    };

    const swapIdResult = await ServiceClients.hash4([
      '0x' + htlcSecretHash,
      initiatorAddress,
      recipientAddress,
      Date.now().toString()
    ]);
    const swapId = swapIdResult.felt252;

    const swap: SwapState = {
      swapId,
      initiator: initiatorAddress,
      recipient: recipientAddress,
      initiatorNote,
      recipientNote,
      htlcSecret,
      htlcSecretHash,
      timelock: Date.now() + timelockDuration * 1000,
      status: 'pending',
      createdAt: Date.now()
    };

    this.swaps.set(swapId, swap);
    
    const encrypted = await ServiceClients.encrypt(
      JSON.stringify({
        ...swap,
        initiatorNote: { ...swap.initiatorNote, amount: swap.initiatorNote.amount.toString() },
        recipientNote: { ...swap.recipientNote, amount: swap.recipientNote.amount.toString() }
      }),
      'swaps'
    );

    await this.redis.set(
      `swap:${swapId}`,
      encrypted,
      'EX',
      timelockDuration + 86400
    );

    return {
      swapId,
      htlcSecret,
      htlcSecretHash
    };
  }

  async lockSwapWithBTC(swapId: string, btcTxid: string): Promise<any> {
    const swap = this.swaps.get(swapId);
    if (!swap) throw new Error('Swap not found');
    if (swap.status !== 'pending') throw new Error('Swap not in pending state');

    const spvProofData = await ServiceClients.generateSPVProof(btcTxid);
    const spvProof = spvProofData.rawProof;

    const isValid = await ServiceClients.verifyMerkleProof(
      spvProof.txid,
      spvProof.merkleProof,
      spvProof.txIndex,
      spvProof.blockHeader.merkleRoot
    );

    if (!isValid) throw new Error('Invalid SPV proof');

    swap.btcTxid = btcTxid;
    swap.status = 'locked';
    this.swaps.set(swapId, swap);

    const encrypted = await ServiceClients.encrypt(
      JSON.stringify({
        ...swap,
        initiatorNote: { ...swap.initiatorNote, amount: swap.initiatorNote.amount.toString() },
        recipientNote: { ...swap.recipientNote, amount: swap.recipientNote.amount.toString() }
      }),
      'swaps'
    );

    await this.redis.set(`swap:${swapId}`, encrypted);

    return spvProofData.proof;
  }

  async completeSwap(swapId: string, secret: string): Promise<boolean> {
    const swap = this.swaps.get(swapId);
    if (!swap) throw new Error('Swap not found');
    if (swap.status !== 'locked') throw new Error('Swap not locked');

    const providedHash = crypto.createHash('sha256')
      .update(Buffer.from(secret, 'hex'))
      .digest('hex');

    if (providedHash !== swap.htlcSecretHash) {
      throw new Error('Invalid secret');
    }

    if (Date.now() >= swap.timelock) {
      throw new Error('Timelock expired');
    }

    swap.status = 'completed';
    this.swaps.set(swapId, swap);

    const encrypted = await ServiceClients.encrypt(
      JSON.stringify({
        ...swap,
        initiatorNote: { ...swap.initiatorNote, amount: swap.initiatorNote.amount.toString() },
        recipientNote: { ...swap.recipientNote, amount: swap.recipientNote.amount.toString() }
      }),
      'swaps'
    );

    await this.redis.set(`swap:${swapId}`, encrypted);

    return true;
  }

  async getSwap(swapId: string): Promise<SwapState | null> {
    if (this.swaps.has(swapId)) {
      return this.swaps.get(swapId)!;
    }

    const encrypted = await this.redis.get(`swap:${swapId}`);
    if (!encrypted) return null;

    const decrypted = await ServiceClients.decrypt(encrypted, 'swaps');
    const swap = JSON.parse(decrypted);
    
    swap.initiatorNote.amount = BigInt(swap.initiatorNote.amount);
    swap.recipientNote.amount = BigInt(swap.recipientNote.amount);
    
    this.swaps.set(swapId, swap);
    return swap;
  }
}

// ============================================
// API ENDPOINTS
// ============================================

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const swapCoordinator = new AtomicSwapCoordinator(redis);

app.get('/health', (req, res) => {
  res.json({ 
    service: 'swap-coordinator', 
    status: 'ok',
    redisConnected: redis.status === 'ready',
    timestamp: Date.now() 
  });
});

app.post('/api/swaps/initiate', async (req, res) => {
  try {
    const { initiator, recipient, amount, timelockDuration } = req.body;
    const result = await swapCoordinator.initiateSwap(
      initiator,
      recipient,
      BigInt(amount),
      timelockDuration
    );
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/swaps/lock', async (req, res) => {
  try {
    const { swapId, btcTxid } = req.body;
    const spvProof = await swapCoordinator.lockSwapWithBTC(swapId, btcTxid);
    res.json({ spvProof });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/swaps/complete', async (req, res) => {
  try {
    const { swapId, secret } = req.body;
    const result = await swapCoordinator.completeSwap(swapId, secret);
    res.json({ success: result });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/swaps/:swapId', async (req, res) => {
  try {
    const swap = await swapCoordinator.getSwap(req.params.swapId);
    if (!swap) {
      return res.status(404).json({ error: 'Swap not found' });
    }
    res.json({
      swapId: swap.swapId,
      status: swap.status,
      timelock: swap.timelock,
      btcTxid: swap.btcTxid,
      createdAt: swap.createdAt
    });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3005;
app.listen(PORT, () => {
  console.log(`🔄 Atomic Swap Coordinator running on port ${PORT}`);
  console.log(`✅ Redis connected: ${redis.status === 'ready'}`);
});

export { AtomicSwapCoordinator };