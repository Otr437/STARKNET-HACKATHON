// ============================================
// STARKNET CONTRACT MANAGER MICROSERVICE
// Port: 3006
// ============================================

import express from 'express';
import cors from 'cors';
import { Account, RpcProvider, Contract, CallData } from 'starknet';
import axios from 'axios';

const app = express();
app.use(cors());
app.use(express.json());

// ============================================
// SERVICE CLIENTS
// ============================================

const ENCRYPTION_SERVICE = process.env.ENCRYPTION_SERVICE_URL || 'http://localhost:3001';

class EncryptionClient {
  async decryptPrivateKey(encrypted: string): Promise<string> {
    const res = await axios.post(`${ENCRYPTION_SERVICE}/api/decrypt-key`, { encrypted });
    return res.data.privateKey;
  }
}

// ============================================
// STARKNET CONTRACT MANAGER
// ============================================

class StarknetContractManager {
  private provider: RpcProvider;
  private account: Account;
  private swapContract: Contract;
  private bridgeContract: Contract;

  constructor() {
    const rpcUrl = process.env.STARKNET_RPC_URL || 'https://starknet-mainnet.public.blastapi.io';
    this.provider = new RpcProvider({ nodeUrl: rpcUrl });

    const privateKey = process.env.RELAYER_PRIVATE_KEY || '0x0';
    const accountAddress = process.env.RELAYER_ADDRESS || '0x0';

    this.account = new Account(this.provider, accountAddress, privateKey);

    const swapAddress = process.env.SWAP_CONTRACT_ADDRESS || '0x0';
    const bridgeAddress = process.env.BRIDGE_CONTRACT_ADDRESS || '0x0';

    this.swapContract = new Contract([], swapAddress, this.provider);
    this.bridgeContract = new Contract([], bridgeAddress, this.provider);
  }

  async commitNote(noteHash: string, proof: any): Promise<string> {
    try {
      const call = this.swapContract.populate('commit_note', [noteHash, proof]);
      const { transaction_hash } = await this.account.execute(call);
      return transaction_hash;
    } catch (error: any) {
      throw new Error(`Failed to commit note: ${error.message}`);
    }
  }

  async initiatePrivacySwap(
    initiatorNoteHash: string,
    initiatorNullifier: string,
    recipientNoteHash: string,
    htlcSecretHash: string,
    timelockDuration: number,
    proof: any
  ): Promise<string> {
    try {
      const call = this.swapContract.populate('initiate_privacy_swap', [
        initiatorNoteHash,
        initiatorNullifier,
        recipientNoteHash,
        htlcSecretHash,
        timelockDuration,
        proof
      ]);

      const { transaction_hash } = await this.account.execute(call);
      return transaction_hash;
    } catch (error: any) {
      throw new Error(`Failed to initiate swap: ${error.message}`);
    }
  }

  async lockSwapWithBTC(swapId: string, btcTxid: string, spvProof: any): Promise<string> {
    try {
      const call = this.swapContract.populate('lock_swap_with_btc', [
        swapId,
        btcTxid,
        spvProof.merkle_proof
      ]);

      const { transaction_hash } = await this.account.execute(call);
      return transaction_hash;
    } catch (error: any) {
      throw new Error(`Failed to lock swap: ${error.message}`);
    }
  }

  async completeSwap(swapId: string, secret: string, recipientProof: any): Promise<string> {
    try {
      const call = this.swapContract.populate('complete_swap', [
        swapId,
        secret,
        recipientProof
      ]);

      const { transaction_hash } = await this.account.execute(call);
      return transaction_hash;
    } catch (error: any) {
      throw new Error(`Failed to complete swap: ${error.message}`);
    }
  }

  async refundSwap(swapId: string, refundProof: any): Promise<string> {
    try {
      const call = this.swapContract.populate('refund_swap', [swapId, refundProof]);
      const { transaction_hash } = await this.account.execute(call);
      return transaction_hash;
    } catch (error: any) {
      throw new Error(`Failed to refund swap: ${error.message}`);
    }
  }

  async submitBlockHeader(header: any): Promise<string> {
    try {
      const call = this.bridgeContract.populate('submit_block_header', [header]);
      const { transaction_hash } = await this.account.execute(call);
      return transaction_hash;
    } catch (error: any) {
      throw new Error(`Failed to submit block header: ${error.message}`);
    }
  }

  async verifyBTCTransaction(spvProof: any, amount: bigint, scriptHash: string): Promise<string> {
    try {
      const call = this.bridgeContract.populate('verify_btc_transaction', [
        spvProof,
        amount.toString(),
        scriptHash
      ]);

      const { transaction_hash } = await this.account.execute(call);
      return transaction_hash;
    } catch (error: any) {
      throw new Error(`Failed to verify BTC tx: ${error.message}`);
    }
  }

  async getSwap(swapId: string): Promise<any> {
    try {
      const result = await this.swapContract.call('get_swap', [swapId]);
      return result;
    } catch (error: any) {
      throw new Error(`Failed to get swap: ${error.message}`);
    }
  }

  async isNullifierSpent(nullifier: string): Promise<boolean> {
    try {
      const result = await this.swapContract.call('is_nullifier_spent', [nullifier]);
      return result[0] === 1n;
    } catch (error: any) {
      throw new Error(`Failed to check nullifier: ${error.message}`);
    }
  }

  async getMerkleRoot(): Promise<string> {
    try {
      const result = await this.swapContract.call('get_merkle_root', []);
      return result[0].toString();
    } catch (error: any) {
      throw new Error(`Failed to get merkle root: ${error.message}`);
    }
  }

  async getTransactionStatus(txHash: string): Promise<any> {
    try {
      const receipt = await this.provider.getTransactionReceipt(txHash);
      return receipt;
    } catch (error: any) {
      throw new Error(`Failed to get tx status: ${error.message}`);
    }
  }
}

// ============================================
// API ENDPOINTS
// ============================================

const contractManager = new StarknetContractManager();

app.get('/health', (req, res) => {
  res.json({ 
    service: 'starknet-contract-manager', 
    status: 'ok',
    network: process.env.STARKNET_RPC_URL,
    relayerAddress: process.env.RELAYER_ADDRESS,
    timestamp: Date.now() 
  });
});

app.post('/api/contract/commit-note', async (req, res) => {
  try {
    const { noteHash, proof } = req.body;
    const txHash = await contractManager.commitNote(noteHash, proof);
    res.json({ transactionHash: txHash });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/contract/initiate-swap', async (req, res) => {
  try {
    const { initiatorNoteHash, initiatorNullifier, recipientNoteHash, htlcSecretHash, timelockDuration, proof } = req.body;
    const txHash = await contractManager.initiatePrivacySwap(
      initiatorNoteHash,
      initiatorNullifier,
      recipientNoteHash,
      htlcSecretHash,
      timelockDuration,
      proof
    );
    res.json({ transactionHash: txHash });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/contract/lock-swap', async (req, res) => {
  try {
    const { swapId, btcTxid, spvProof } = req.body;
    const txHash = await contractManager.lockSwapWithBTC(swapId, btcTxid, spvProof);
    res.json({ transactionHash: txHash });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/contract/complete-swap', async (req, res) => {
  try {
    const { swapId, secret, recipientProof } = req.body;
    const txHash = await contractManager.completeSwap(swapId, secret, recipientProof);
    res.json({ transactionHash: txHash });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/contract/refund-swap', async (req, res) => {
  try {
    const { swapId, refundProof } = req.body;
    const txHash = await contractManager.refundSwap(swapId, refundProof);
    res.json({ transactionHash: txHash });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/bridge/submit-header', async (req, res) => {
  try {
    const { header } = req.body;
    const txHash = await contractManager.submitBlockHeader(header);
    res.json({ transactionHash: txHash });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/bridge/verify-btc-tx', async (req, res) => {
  try {
    const { spvProof, amount, scriptHash } = req.body;
    const txHash = await contractManager.verifyBTCTransaction(spvProof, BigInt(amount), scriptHash);
    res.json({ transactionHash: txHash });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/contract/swap/:swapId', async (req, res) => {
  try {
    const swap = await contractManager.getSwap(req.params.swapId);
    res.json({ swap });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/contract/nullifier/:nullifier', async (req, res) => {
  try {
    const isSpent = await contractManager.isNullifierSpent(req.params.nullifier);
    res.json({ isSpent });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/contract/merkle-root', async (req, res) => {
  try {
    const root = await contractManager.getMerkleRoot();
    res.json({ merkleRoot: root });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/transaction/:txHash', async (req, res) => {
  try {
    const status = await contractManager.getTransactionStatus(req.params.txHash);
    res.json({ status });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3006;
app.listen(PORT, () => {
  console.log(`⛓️ Starknet Contract Manager running on port ${PORT}`);
  console.log(`✅ Connected to ${process.env.STARKNET_RPC_URL}`);
});

export { StarknetContractManager };