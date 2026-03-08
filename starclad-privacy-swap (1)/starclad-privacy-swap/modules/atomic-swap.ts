/**
 * AtomicSwapCoordinator - Full lifecycle with Redis persistence
 * Timelock expiry, BTC confirmation monitoring, dispute handling, stats
 */
import crypto from 'crypto';
import { EventEmitter } from 'events';
import type Redis from 'ioredis';
import { NoteCommitmentManager, type PrivacyNote } from './note-manager';
import { BitcoinBridge, type SPVProof } from './bitcoin-bridge';
import { PoseidonHasher } from './poseidon';
import { SecureKeyManager } from './encryption';

export type SwapStatus = 'pending' | 'locked' | 'completed' | 'refunded' | 'expired' | 'disputed';

export interface SwapState {
  swapId: string;
  initiator: string;
  recipient: string;
  initiatorNote: Omit<PrivacyNote, 'amount'> & { amount: string };
  recipientNote: Omit<PrivacyNote, 'amount'> & { amount: string };
  htlcSecret: string;
  htlcSecretHash: string;
  timelock: number;
  btcTxid?: string;
  btcBlockHeight?: number;
  status: SwapStatus;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  events: Array<{ type: string; timestamp: number; data: any }>;
}

export interface SwapInitResult {
  swapId: string;
  htlcSecret: string;
  htlcSecretHash: string;
  initiatorCommitment: string;
  recipientCommitment: string;
  timelock: number;
  expiresAt: number;
}

export interface SwapStats {
  total: number;
  pending: number;
  locked: number;
  completed: number;
  refunded: number;
  expired: number;
  disputed: number;
  totalVolume: string;
  avgCompletionTimeMs: number;
}

const SWAP_TTL_SEC = 86400 * 7; // 7 days

export class AtomicSwapCoordinator extends EventEmitter {
  private cache = new Map<string, SwapState>();
  private cleanupTimer?: NodeJS.Timeout;
  private monitorTimer?: NodeJS.Timeout;

  constructor(
    private noteManager: NoteCommitmentManager,
    private btcBridge: BitcoinBridge,
    private hasher: PoseidonHasher,
    private km: SecureKeyManager,
    private redis: Redis,
  ) {
    super();
    this.cleanupTimer = setInterval(() => this._cleanupExpired().catch(console.error), 60_000);
    this.monitorTimer = setInterval(() => this._monitorLocked().catch(console.error), 30_000);
  }

  async initiateSwap(initiator: string, recipient: string, amount: bigint, timelockSec: number): Promise<SwapInitResult> {
    const htlcSecret = crypto.randomBytes(32).toString('hex');
    const htlcSecretHash = crypto.createHash('sha256').update(Buffer.from(htlcSecret, 'hex')).digest('hex');

    const initiatorNote = this.noteManager.generateNote(amount, initiator);
    const recipientNote = this.noteManager.generateNote(amount, recipient);

    const swapIdBig = this.hasher.hash4(
      BigInt('0x' + htlcSecretHash.slice(0, 62)),
      BigInt(initiator),
      BigInt(recipient),
      BigInt(Date.now()),
    );
    const swapId = this.hasher.toFelt252(swapIdBig);

    const now = Date.now();
    const expiresAt = now + timelockSec * 1000;

    const state: SwapState = {
      swapId,
      initiator,
      recipient,
      initiatorNote: { ...initiatorNote, amount: initiatorNote.amount.toString() },
      recipientNote: { ...recipientNote, amount: recipientNote.amount.toString() },
      htlcSecret,
      htlcSecretHash,
      timelock: expiresAt,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      expiresAt,
      events: [{ type: 'INITIATED', timestamp: now, data: { initiator, recipient, amount: amount.toString() } }],
    };

    await this._save(state);
    this.emit('swap:initiated', state);

    return { swapId, htlcSecret, htlcSecretHash, initiatorCommitment: initiatorNote.commitment, recipientCommitment: recipientNote.commitment, timelock: expiresAt, expiresAt };
  }

  async lockWithBTC(swapId: string, btcTxid: string): Promise<SPVProof> {
    const state = await this._requireSwap(swapId);
    if (state.status !== 'pending') throw new Error(`Expected pending, got: ${state.status}`);
    if (Date.now() >= state.timelock) { await this._expire(state); throw new Error('Timelock expired'); }

    const proof = await this.btcBridge.generateSPVProof(btcTxid);
    if (!this.btcBridge.verifyMerkleProof(proof.txid, proof.merkleProof, proof.txIndex, proof.blockHeader.merkleRoot))
      throw new Error('Invalid SPV merkle proof');
    if (proof.confirmations < 6) throw new Error(`Need ≥ 6 confirmations, got ${proof.confirmations}`);

    state.btcTxid = btcTxid;
    state.btcBlockHeight = proof.blockHeader.height;
    state.status = 'locked';
    state.updatedAt = Date.now();
    state.events.push({ type: 'LOCKED', timestamp: Date.now(), data: { btcTxid, blockHeight: proof.blockHeader.height } });
    await this._save(state);
    this.emit('swap:locked', state);
    return proof;
  }

  async completeSwap(swapId: string, secret: string): Promise<boolean> {
    const state = await this._requireSwap(swapId);
    if (state.status !== 'locked') throw new Error(`Expected locked, got: ${state.status}`);
    if (Date.now() >= state.timelock) { await this._expire(state); throw new Error('Timelock expired'); }

    const hash = crypto.createHash('sha256').update(Buffer.from(secret, 'hex')).digest('hex');
    if (hash !== state.htlcSecretHash) throw new Error('Invalid HTLC secret');

    state.status = 'completed';
    state.updatedAt = Date.now();
    state.events.push({ type: 'COMPLETED', timestamp: Date.now(), data: {} });
    await this._save(state);
    this.emit('swap:completed', state);
    return true;
  }

  async refundSwap(swapId: string): Promise<boolean> {
    const state = await this._requireSwap(swapId);
    if (Date.now() < state.timelock) throw new Error('Timelock has not expired yet');
    if (state.status === 'completed') throw new Error('Cannot refund a completed swap');

    state.status = 'refunded';
    state.updatedAt = Date.now();
    state.events.push({ type: 'REFUNDED', timestamp: Date.now(), data: { refundedTo: state.initiator } });
    await this._save(state);
    this.emit('swap:refunded', state);
    return true;
  }

  async disputeSwap(swapId: string, reason: string): Promise<void> {
    const state = await this._requireSwap(swapId);
    state.status = 'disputed';
    state.updatedAt = Date.now();
    state.events.push({ type: 'DISPUTED', timestamp: Date.now(), data: { reason } });
    await this._save(state);
    this.emit('swap:disputed', state);
  }

  async getSwap(swapId: string): Promise<SwapState | null> {
    if (this.cache.has(swapId)) return this.cache.get(swapId)!;
    const enc = await this.redis.get(`swap:${swapId}`);
    if (!enc) return null;
    const state = JSON.parse(this.km.decrypt(enc, 'swaps'));
    this.cache.set(swapId, state);
    return state;
  }

  async getSwapsByAddress(address: string): Promise<SwapState[]> {
    const keys = await this.redis.keys('swap:*');
    const results: SwapState[] = [];
    for (const k of keys) {
      const s = await this.getSwap(k.replace('swap:', ''));
      if (s && (s.initiator === address || s.recipient === address)) results.push(s);
    }
    return results;
  }

  async getStats(): Promise<SwapStats> {
    const keys = await this.redis.keys('swap:*');
    const stats: SwapStats = { total: keys.length, pending: 0, locked: 0, completed: 0, refunded: 0, expired: 0, disputed: 0, totalVolume: '0', avgCompletionTimeMs: 0 };
    let vol = 0n, totalTime = 0, completedCount = 0;
    for (const k of keys) {
      const s = await this.getSwap(k.replace('swap:', ''));
      if (!s) continue;
      stats[s.status]++;
      vol += BigInt(s.initiatorNote.amount);
      if (s.status === 'completed') { totalTime += s.updatedAt - s.createdAt; completedCount++; }
    }
    stats.totalVolume = vol.toString();
    stats.avgCompletionTimeMs = completedCount ? totalTime / completedCount : 0;
    return stats;
  }

  private async _save(state: SwapState): Promise<void> {
    const enc = this.km.encrypt(JSON.stringify(state), 'swaps');
    await this.redis.set(`swap:${state.swapId}`, enc, 'EX', SWAP_TTL_SEC);
    this.cache.set(state.swapId, state);
  }

  private async _requireSwap(swapId: string): Promise<SwapState> {
    const s = await this.getSwap(swapId);
    if (!s) throw new Error(`Swap not found: ${swapId}`);
    return s;
  }

  private async _expire(state: SwapState): Promise<void> {
    state.status = 'expired';
    state.updatedAt = Date.now();
    state.events.push({ type: 'EXPIRED', timestamp: Date.now(), data: {} });
    await this._save(state);
    this.emit('swap:expired', state);
  }

  private async _cleanupExpired(): Promise<void> {
    const keys = await this.redis.keys('swap:*');
    for (const k of keys) {
      const s = await this.getSwap(k.replace('swap:', ''));
      if (s?.status === 'pending' && Date.now() >= s.timelock) await this._expire(s);
    }
  }

  private async _monitorLocked(): Promise<void> {
    const keys = await this.redis.keys('swap:*');
    for (const k of keys) {
      const s = await this.getSwap(k.replace('swap:', ''));
      if (!s || s.status !== 'locked' || !s.btcTxid) continue;
      try {
        const confirmed = await this.btcBridge.verifyConfirmations(s.btcTxid, 1);
        if (confirmed) this.emit('swap:confirmation', { swapId: s.swapId, txid: s.btcTxid });
      } catch { /* non-fatal */ }
    }
  }

  shutdown(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.removeAllListeners();
  }
}
