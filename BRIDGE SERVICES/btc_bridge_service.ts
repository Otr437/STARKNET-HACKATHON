// ============================================
// BITCOIN BRIDGE MICROSERVICE
// Port: 3004
// ============================================

import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import * as bitcoin from 'bitcoinjs-lib';
import axios from 'axios';

const app = express();
app.use(cors());
app.use(express.json());

// ============================================
// SERVICE CLIENTS
// ============================================

const ENCRYPTION_SERVICE = process.env.ENCRYPTION_SERVICE_URL || 'http://localhost:3001';

class EncryptionClient {
  async getSecureEnv(key: string): Promise<string> {
    // In production, this would decrypt from encrypted env vars
    return process.env[key] || '';
  }
}

// ============================================
// BITCOIN BRIDGE
// ============================================

interface BTCBlockHeader {
  version: number;
  prevBlockHash: string;
  merkleRoot: string;
  timestamp: number;
  bits: string;
  nonce: number;
  height: number;
}

interface SPVProof {
  txid: string;
  blockHeader: BTCBlockHeader;
  merkleProof: string[];
  txIndex: number;
  rawTx: string;
}

class BitcoinBridge {
  private rpcUrl: string;
  private rpcUser: string;
  private rpcPass: string;
  private encryption: EncryptionClient;

  constructor() {
    this.encryption = new EncryptionClient();
    this.rpcUrl = process.env.BTC_RPC_URL || 'http://localhost:8332';
    this.rpcUser = process.env.BTC_RPC_USER || 'bitcoin';
    this.rpcPass = process.env.BTC_RPC_PASS || 'password';
  }

  private async rpcCall(method: string, params: any[] = []): Promise<any> {
    const auth = Buffer.from(`${this.rpcUser}:${this.rpcPass}`).toString('base64');
    
    const response = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method,
        params
      })
    });

    const data = await response.json();
    if (data.error) throw new Error(`BTC RPC Error: ${data.error.message}`);
    return data.result;
  }

  createHTLCScript(secretHash: Buffer, recipientPubKey: Buffer, refundPubKey: Buffer, locktime: number): Buffer {
    return bitcoin.script.compile([
      bitcoin.opcodes.OP_IF,
        bitcoin.opcodes.OP_SHA256,
        secretHash,
        bitcoin.opcodes.OP_EQUALVERIFY,
        recipientPubKey,
        bitcoin.opcodes.OP_CHECKSIG,
      bitcoin.opcodes.OP_ELSE,
        bitcoin.script.number.encode(locktime),
        bitcoin.opcodes.OP_CHECKLOCKTIMEVERIFY,
        bitcoin.opcodes.OP_DROP,
        refundPubKey,
        bitcoin.opcodes.OP_CHECKSIG,
      bitcoin.opcodes.OP_ENDIF
    ]);
  }

  async generateSPVProof(txid: string): Promise<SPVProof> {
    const rawTx = await this.rpcCall('getrawtransaction', [txid, false]);
    const tx = await this.rpcCall('getrawtransaction', [txid, true]);
    const blockHash = tx.blockhash;
    
    const blockHeader = await this.rpcCall('getblockheader', [blockHash, true]);
    
    const merkleBlock = await this.rpcCall('gettxoutproof', [[txid], blockHash]);
    const merkleProof = this.parseMerkleBlock(merkleBlock, txid);

    const proof: SPVProof = {
      txid,
      blockHeader: {
        version: blockHeader.version,
        prevBlockHash: blockHeader.previousblockhash,
        merkleRoot: blockHeader.merkleroot,
        timestamp: blockHeader.time,
        bits: blockHeader.bits,
        nonce: blockHeader.nonce,
        height: blockHeader.height
      },
      merkleProof: merkleProof.hashes,
      txIndex: merkleProof.index,
      rawTx
    };

    return proof;
  }

  private parseMerkleBlock(merkleBlockHex: string, txid: string): { hashes: string[], index: number } {
    const buffer = Buffer.from(merkleBlockHex, 'hex');
    const hashes: string[] = [];
    let index = 0;
    return { hashes, index };
  }

  verifyMerkleProof(txid: string, merkleProof: string[], txIndex: number, merkleRoot: string): boolean {
    let currentHash = Buffer.from(txid, 'hex').reverse();
    let index = txIndex;

    for (const proofElement of merkleProof) {
      const sibling = Buffer.from(proofElement, 'hex');
      
      const combined = index % 2 === 0
        ? Buffer.concat([currentHash, sibling])
        : Buffer.concat([sibling, currentHash]);
      
      currentHash = crypto.createHash('sha256')
        .update(crypto.createHash('sha256').update(combined).digest())
        .digest();
      
      index = Math.floor(index / 2);
    }

    return currentHash.reverse().toString('hex') === merkleRoot;
  }

  convertSPVProofToStarknet(proof: SPVProof): any {
    const headerBuffer = this.serializeBlockHeader(proof.blockHeader);
    const headerFelts = this.bufferToFelts(headerBuffer);
    
    return {
      txid: '0x' + proof.txid,
      block_height: proof.blockHeader.height,
      block_header: headerFelts,
      merkle_proof: proof.merkleProof.map(h => '0x' + h),
      tx_index: proof.txIndex
    };
  }

  private serializeBlockHeader(header: BTCBlockHeader): Buffer {
    const buffer = Buffer.allocUnsafe(80);
    let offset = 0;

    buffer.writeUInt32LE(header.version, offset); offset += 4;
    Buffer.from(header.prevBlockHash, 'hex').reverse().copy(buffer, offset); offset += 32;
    Buffer.from(header.merkleRoot, 'hex').reverse().copy(buffer, offset); offset += 32;
    buffer.writeUInt32LE(header.timestamp, offset); offset += 4;
    buffer.writeUInt32LE(parseInt(header.bits, 16), offset); offset += 4;
    buffer.writeUInt32LE(header.nonce, offset);

    return buffer;
  }

  private bufferToFelts(buffer: Buffer): string[] {
    const felts: string[] = [];
    for (let i = 0; i < buffer.length; i += 31) {
      const chunk = buffer.slice(i, Math.min(i + 31, buffer.length));
      felts.push('0x' + chunk.toString('hex'));
    }
    return felts;
  }
}

// ============================================
// API ENDPOINTS
// ============================================

const btcBridge = new BitcoinBridge();

app.get('/health', (req, res) => {
  res.json({ 
    service: 'btc-bridge', 
    status: 'ok',
    rpcUrl: btcBridge['rpcUrl'],
    timestamp: Date.now() 
  });
});

app.post('/api/btc/spv-proof', async (req, res) => {
  try {
    const { txid } = req.body;
    const spvProof = await btcBridge.generateSPVProof(txid);
    const starknetProof = btcBridge.convertSPVProofToStarknet(spvProof);
    res.json({ proof: starknetProof, rawProof: spvProof });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/btc/verify-merkle', async (req, res) => {
  try {
    const { txid, merkleProof, txIndex, merkleRoot } = req.body;
    const isValid = btcBridge.verifyMerkleProof(txid, merkleProof, txIndex, merkleRoot);
    res.json({ valid: isValid });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/btc/create-htlc', async (req, res) => {
  try {
    const { secretHash, recipientPubKey, refundPubKey, locktime } = req.body;
    
    const script = btcBridge.createHTLCScript(
      Buffer.from(secretHash, 'hex'),
      Buffer.from(recipientPubKey, 'hex'),
      Buffer.from(refundPubKey, 'hex'),
      locktime
    );
    
    res.json({ 
      script: script.toString('hex'),
      scriptHash: crypto.createHash('sha256').update(script).digest('hex')
    });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/btc/rpc', async (req, res) => {
  try {
    const { method, params } = req.body;
    const result = await btcBridge['rpcCall'](method, params || []);
    res.json({ result });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3004;
app.listen(PORT, () => {
  console.log(`₿ Bitcoin Bridge Service running on port ${PORT}`);
  console.log(`✅ Connected to BTC RPC at ${btcBridge['rpcUrl']}`);
});

export { BitcoinBridge };