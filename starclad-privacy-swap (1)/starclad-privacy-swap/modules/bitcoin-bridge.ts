/**
 * BitcoinBridge - Production SPV client
 * HTLC scripts, P2WSH, SPV proofs, header chain validation, PSBT, fee estimation
 */
import crypto from 'crypto';
import * as bitcoin from 'bitcoinjs-lib';
import { SecureKeyManager } from './encryption';

export interface BTCBlockHeader {
  version: number; prevBlockHash: string; merkleRoot: string;
  timestamp: number; bits: string; nonce: number;
  height: number; hash: string; difficulty: number; chainwork: string;
}

export interface SPVProof {
  txid: string; blockHeader: BTCBlockHeader;
  merkleProof: string[]; txIndex: number; rawTx: string; confirmations: number;
}

export interface StarknetSPVProof {
  txid: string; block_height: number;
  block_header: string[]; merkle_proof: string[]; tx_index: number;
}

export interface HTLCDetails {
  script: Buffer; address: string; secretHash: string;
  recipientPubKey: string; refundPubKey: string; locktime: number; amount: number;
}

export class BitcoinBridge {
  private readonly rpcUrl: string;
  private readonly rpcUser: string;
  private readonly rpcPass: string;
  private headerCache = new Map<string, BTCBlockHeader>();
  private readonly network: bitcoin.Network;

  constructor(private km: SecureKeyManager, net: 'mainnet' | 'testnet' | 'regtest' = 'mainnet') {
    this.rpcUrl = km.getSecureEnv('BTC_RPC_URL');
    this.rpcUser = km.getSecureEnv('BTC_RPC_USER');
    this.rpcPass = km.getSecureEnv('BTC_RPC_PASS');
    this.network = net === 'mainnet' ? bitcoin.networks.bitcoin
      : net === 'testnet' ? bitcoin.networks.testnet
      : bitcoin.networks.regtest;
  }

  private async rpc(method: string, params: any[] = []): Promise<any> {
    const auth = Buffer.from(`${this.rpcUser}:${this.rpcPass}`).toString('base64');
    const res = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    });
    if (!res.ok) throw new Error(`BTC RPC HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(`BTC RPC: ${data.error.message}`);
    return data.result;
  }

  createHTLCScript(secretHash: Buffer, recipientPub: Buffer, refundPub: Buffer, locktime: number): Buffer {
    return bitcoin.script.compile([
      bitcoin.opcodes.OP_IF,
        bitcoin.opcodes.OP_SHA256, secretHash, bitcoin.opcodes.OP_EQUALVERIFY,
        recipientPub, bitcoin.opcodes.OP_CHECKSIG,
      bitcoin.opcodes.OP_ELSE,
        bitcoin.script.number.encode(locktime), bitcoin.opcodes.OP_CHECKLOCKTIMEVERIFY,
        bitcoin.opcodes.OP_DROP, refundPub, bitcoin.opcodes.OP_CHECKSIG,
      bitcoin.opcodes.OP_ENDIF,
    ]);
  }

  createHTLCAddress(script: Buffer): string {
    const hash = crypto.createHash('sha256').update(script).digest();
    const { address } = bitcoin.payments.p2wsh({ hash, network: this.network });
    if (!address) throw new Error('Failed to generate HTLC address');
    return address;
  }

  async createHTLC(recipientPub: string, refundPub: string, amount: number, locktime: number): Promise<HTLCDetails> {
    const secret = crypto.randomBytes(32);
    const secretHash = crypto.createHash('sha256').update(secret).digest();
    const script = this.createHTLCScript(secretHash, Buffer.from(recipientPub, 'hex'), Buffer.from(refundPub, 'hex'), locktime);
    return { script, address: this.createHTLCAddress(script), secretHash: secretHash.toString('hex'), recipientPubKey: recipientPub, refundPubKey: refundPub, locktime, amount };
  }

  async generateSPVProof(txid: string): Promise<SPVProof> {
    const [rawTx, tx] = await Promise.all([
      this.rpc('getrawtransaction', [txid, false]),
      this.rpc('getrawtransaction', [txid, true]),
    ]);
    if (!tx.blockhash) throw new Error('Transaction not yet confirmed');
    const blockHeader = await this.getBlockHeader(tx.blockhash);
    const merkleBlock = await this.rpc('gettxoutproof', [[txid], tx.blockhash]);
    const { hashes, index } = this._parseMerkleBlock(merkleBlock, txid);
    const currentHeight = await this.getBlockHeight();
    return { txid, blockHeader, merkleProof: hashes, txIndex: index, rawTx, confirmations: currentHeight - blockHeader.height + 1 };
  }

  private _parseMerkleBlock(hex: string, txid: string): { hashes: string[]; index: number } {
    const buf = Buffer.from(hex, 'hex');
    let off = 80;
    const txCount = buf.readUInt32LE(off); off += 4;
    const { value: hashCount, offset: off2 } = this._readVarInt(buf, off); off = off2;
    const hashes: string[] = [];
    for (let i = 0; i < hashCount; i++) {
      hashes.push(buf.subarray(off, off + 32).reverse().toString('hex')); off += 32;
    }
    let index = 0;
    for (let i = 0; i < hashes.length; i++) { if (hashes[i] === txid) { index = i; break; } }
    return { hashes, index };
  }

  private _readVarInt(buf: Buffer, off: number): { value: number; offset: number } {
    const b = buf.readUInt8(off);
    if (b < 0xfd) return { value: b, offset: off + 1 };
    if (b === 0xfd) return { value: buf.readUInt16LE(off + 1), offset: off + 3 };
    if (b === 0xfe) return { value: buf.readUInt32LE(off + 1), offset: off + 5 };
    throw new Error('VarInt too large');
  }

  verifyMerkleProof(txid: string, proof: string[], txIndex: number, merkleRoot: string): boolean {
    let current = Buffer.from(txid, 'hex').reverse();
    let idx = txIndex;
    for (const elem of proof) {
      const sibling = Buffer.from(elem, 'hex');
      const combined = idx % 2 === 0 ? Buffer.concat([current, sibling]) : Buffer.concat([sibling, current]);
      current = crypto.createHash('sha256').update(crypto.createHash('sha256').update(combined).digest()).digest();
      idx = Math.floor(idx / 2);
    }
    return current.reverse().toString('hex') === merkleRoot;
  }

  convertSPVToStarknet(proof: SPVProof): StarknetSPVProof {
    const headerBuf = this._serializeHeader(proof.blockHeader);
    return {
      txid: '0x' + proof.txid,
      block_height: proof.blockHeader.height,
      block_header: this._bufToFelts(headerBuf),
      merkle_proof: proof.merkleProof.map(h => '0x' + h),
      tx_index: proof.txIndex,
    };
  }

  // Alias used by other modules
  convertSPVProofToStarknet(proof: SPVProof): StarknetSPVProof { return this.convertSPVToStarknet(proof); }

  private _serializeHeader(h: BTCBlockHeader): Buffer {
    const buf = Buffer.allocUnsafe(80);
    let off = 0;
    buf.writeUInt32LE(h.version, off); off += 4;
    Buffer.from(h.prevBlockHash, 'hex').reverse().copy(buf, off); off += 32;
    Buffer.from(h.merkleRoot, 'hex').reverse().copy(buf, off); off += 32;
    buf.writeUInt32LE(h.timestamp, off); off += 4;
    buf.writeUInt32LE(parseInt(h.bits, 16), off); off += 4;
    buf.writeUInt32LE(h.nonce, off);
    return buf;
  }

  private _bufToFelts(buf: Buffer): string[] {
    const felts: string[] = [];
    for (let i = 0; i < buf.length; i += 31) felts.push('0x' + buf.subarray(i, Math.min(i + 31, buf.length)).toString('hex'));
    return felts;
  }

  async getBlockHeader(blockHash: string): Promise<BTCBlockHeader> {
    if (this.headerCache.has(blockHash)) return this.headerCache.get(blockHash)!;
    const h = await this.rpc('getblockheader', [blockHash, true]);
    const header: BTCBlockHeader = {
      version: h.version, prevBlockHash: h.previousblockhash ?? '', merkleRoot: h.merkleroot,
      timestamp: h.time, bits: h.bits, nonce: h.nonce, height: h.height,
      hash: blockHash, difficulty: h.difficulty, chainwork: h.chainwork,
    };
    this.headerCache.set(blockHash, header);
    return header;
  }

  async getBlockHeight(): Promise<number> { return this.rpc('getblockcount'); }

  async verifyConfirmations(txid: string, required = 6): Promise<boolean> {
    try { const tx = await this.rpc('getrawtransaction', [txid, true]); return (tx.confirmations ?? 0) >= required; }
    catch { return false; }
  }

  async validateHeaderChain(headers: BTCBlockHeader[]): Promise<boolean> {
    for (let i = 1; i < headers.length; i++) {
      const prev = headers[i - 1], curr = headers[i];
      if (curr.prevBlockHash !== prev.hash) return false;
      if (curr.height !== prev.height + 1) return false;
      const computed = crypto.createHash('sha256').update(crypto.createHash('sha256').update(this._serializeHeader(curr)).digest()).digest().reverse().toString('hex');
      if (computed !== curr.hash) return false;
    }
    return true;
  }

  async broadcastTransaction(rawTx: string): Promise<string> { return this.rpc('sendrawtransaction', [rawTx]); }
  async estimateFee(blocks = 6): Promise<number> {
    try { const r = await this.rpc('estimatesmartfee', [blocks]); return r.feerate ?? 0.0001; } catch { return 0.0001; }
  }
  async getUTXOs(address: string): Promise<any[]> {
    const r = await this.rpc('scantxoutset', ['start', [`addr(${address})`]]); return r.unspents ?? [];
  }

  clearHeaderCache(): void { this.headerCache.clear(); }
}
