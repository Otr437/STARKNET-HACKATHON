// ============================================
// CLIENT-SIDE PROOF GENERATION MICROSERVICE
// Port: 3007
// ============================================

import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { MerkleTree } from 'merkletreejs';
import axios from 'axios';

const app = express();
app.use(cors());
app.use(express.json());

// ============================================
// SERVICE CLIENTS
// ============================================

const POSEIDON_SERVICE = process.env.POSEIDON_SERVICE_URL || 'http://localhost:3002';

class PoseidonClient {
  async hash(input: string): Promise<{ hash: string; felt252: string }> {
    const res = await axios.post(`${POSEIDON_SERVICE}/api/hash`, { input });
    return res.data;
  }

  async hash2(inputs: [string, string]): Promise<{ hash: string; felt252: string }> {
    const res = await axios.post(`${POSEIDON_SERVICE}/api/hash2`, { inputs });
    return res.data;
  }

  async hash3(inputs: [string, string, string]): Promise<{ hash: string; felt252: string }> {
    const res = await axios.post(`${POSEIDON_SERVICE}/api/hash3`, { inputs });
    return res.data;
  }
}

// ============================================
// STARCLAD PROOF GENERATOR
// ============================================

interface Note {
  amount: string;
  recipient: string;
  secret: string;
  nullifier: string;
  commitment: string;
  amountCommitment: string;
  index: number;
}

class StarCladProofGenerator {
  private poseidon: PoseidonClient;
  private noteCommitments: bigint[] = [];
  private merkleTree: MerkleTree | null = null;

  constructor() {
    this.poseidon = new PoseidonClient();
  }

  async generateNote(amount: bigint, recipient: string, secret?: string): Promise<Note> {
    const noteSecret = secret || crypto.randomBytes(32).toString('hex');
    
    const nullifierResult = await this.poseidon.hash2([
      '0x' + noteSecret,
      recipient
    ]);
    const nullifier = nullifierResult.felt252;

    const commitmentResult = await this.poseidon.hash3([
      amount.toString(),
      recipient,
      '0x' + noteSecret
    ]);
    const commitment = commitmentResult.felt252;

    const amountCommitmentResult = await this.poseidon.hash2([
      amount.toString(),
      '0x' + noteSecret
    ]);
    const amountCommitment = amountCommitmentResult.felt252;

    const note: Note = {
      amount: amount.toString(),
      recipient,
      secret: noteSecret,
      nullifier,
      commitment,
      amountCommitment,
      index: this.noteCommitments.length
    };

    this.noteCommitments.push(BigInt(commitment));
    
    return note;
  }

  async buildMerkleTree(): Promise<string> {
    const leaves = this.noteCommitments.map(c => 
      Buffer.from(c.toString(16).padStart(64, '0'), 'hex')
    );
    
    this.merkleTree = new MerkleTree(
      leaves,
      async (data: Buffer) => {
        const bigIntValue = BigInt('0x' + data.toString('hex'));
        const result = await this.poseidon.hash(bigIntValue.toString());
        const hashed = BigInt(result.hash);
        return Buffer.from(hashed.toString(16).padStart(64, '0'), 'hex');
      },
      { sortPairs: false, hashLeaves: false }
    );

    return '0x' + this.merkleTree.getRoot().toString('hex');
  }

  async getMerkleProof(noteIndex: number): Promise<string[]> {
    if (!this.merkleTree) {
      await this.buildMerkleTree();
    }

    const leaf = Buffer.from(
      this.noteCommitments[noteIndex].toString(16).padStart(64, '0'),
      'hex'
    );
    
    const proof = this.merkleTree!.getProof(leaf);
    return proof.map(p => '0x' + p.data.toString('hex'));
  }

  async generateSpendProof(note: Note, spenderAddress: string): Promise<any> {
    const recomputedCommitmentResult = await this.poseidon.hash3([
      note.amount,
      note.recipient,
      '0x' + note.secret
    ]);
    
    if (recomputedCommitmentResult.felt252 !== note.commitment) {
      throw new Error('Invalid note secret - commitment mismatch');
    }

    const merkleProof = await this.getMerkleProof(note.index);
    const merkleRoot = await this.buildMerkleTree();

    const messageResult = await this.poseidon.hash3([
      note.nullifier,
      merkleRoot,
      spenderAddress
    ]);
    const message = BigInt(messageResult.hash);

    const signature = await this.generateStarkSignature(note.secret, message);

    return {
      merkle_root: merkleRoot,
      nullifier: note.nullifier,
      proof_elements: merkleProof,
      signature: [signature.r, signature.s],
      _privateInputs: {
        amount: note.amount,
        secret: note.secret,
        recipient: note.recipient
      }
    };
  }

  async generateStarkSignature(secret: string, message: bigint): Promise<{ r: string; s: string }> {
    const secretBigInt = '0x' + secret;
    
    const rResult = await this.poseidon.hash2([secretBigInt, message.toString()]);
    const r = rResult.felt252;
    
    const sResult = await this.poseidon.hash2([secretBigInt, rResult.hash]);
    const s = sResult.felt252;
    
    return { r, s };
  }
}

// ============================================
// BTC HTLC HELPER
// ============================================

class HTLCHelper {
  createSecretHash(secret: string): string {
    return crypto.createHash('sha256')
      .update(Buffer.from(secret, 'hex'))
      .digest('hex');
  }

  generateSecret(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  verifySecret(secret: string, hash: string): boolean {
    const computedHash = this.createSecretHash(secret);
    return computedHash === hash;
  }

  createHTLCData(
    secretHash: string,
    recipientPubKey: string,
    refundPubKey: string,
    locktime: number
  ): any {
    return {
      secretHash,
      recipientPubKey,
      refundPubKey,
      locktime,
      scriptType: 'HTLC',
      createdAt: Date.now()
    };
  }
}

// ============================================
// API ENDPOINTS
// ============================================

const proofGenerator = new StarCladProofGenerator();
const htlcHelper = new HTLCHelper();

app.get('/health', (req, res) => {
  res.json({ 
    service: 'client-proof-generator', 
    status: 'ok',
    timestamp: Date.now() 
  });
});

app.post('/api/proof/generate-note', async (req, res) => {
  try {
    const { amount, recipient, secret } = req.body;
    const note = await proofGenerator.generateNote(BigInt(amount), recipient, secret);
    res.json({ note });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/proof/merkle-root', async (req, res) => {
  try {
    const root = await proofGenerator.buildMerkleTree();
    res.json({ merkleRoot: root });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/proof/merkle-proof', async (req, res) => {
  try {
    const { noteIndex } = req.body;
    const proof = await proofGenerator.getMerkleProof(noteIndex);
    res.json({ proof });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/proof/spend', async (req, res) => {
  try {
    const { note, spenderAddress } = req.body;
    const proof = await proofGenerator.generateSpendProof(note, spenderAddress);
    res.json({ proof });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/htlc/generate-secret', (req, res) => {
  try {
    const secret = htlcHelper.generateSecret();
    const hash = htlcHelper.createSecretHash(secret);
    res.json({ secret, hash });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/htlc/create-hash', (req, res) => {
  try {
    const { secret } = req.body;
    const hash = htlcHelper.createSecretHash(secret);
    res.json({ hash });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/htlc/verify-secret', (req, res) => {
  try {
    const { secret, hash } = req.body;
    const isValid = htlcHelper.verifySecret(secret, hash);
    res.json({ valid: isValid });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/htlc/create-data', (req, res) => {
  try {
    const { secretHash, recipientPubKey, refundPubKey, locktime } = req.body;
    const htlcData = htlcHelper.createHTLCData(
      secretHash,
      recipientPubKey,
      refundPubKey,
      locktime
    );
    res.json({ htlcData });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3007;
app.listen(PORT, () => {
  console.log(`🔐 Client Proof Generator Service running on port ${PORT}`);
});

export { StarCladProofGenerator, HTLCHelper };