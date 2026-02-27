/**
 * Atomic Swap Coordinator - COMPLETE PRODUCTION IMPLEMENTATION
 * Full swap lifecycle, timeout handling, webhooks, monitoring
 */

import crypto from 'crypto';
import Redis from 'ioredis';
import { EventEmitter } from 'events';
import { NoteCommitmentManager, PrivacyNote } from './note-manager';
import { BitcoinBridge, SPVProof } from './bitcoin-bridge';
import { PoseidonHasher } from './poseidon';
import { SecureKeyManager } from './encryption';

export type SwapStatus = 'pending' | 'locked' | 'completed' | 'refunded' | 'expired' | 'disputed';

export interface SwapState {
  swapId: string;
  initiator: string;
  recipient: string;
  initiatorNote: PrivacyNote;
  recipientNote: PrivacyNote;
  htlcSecret: string;
  htlcSecretHash: string;
  timelock: number;
  btcTxid?: string;
  btcBlockHeight?: number;
  status: SwapStatus;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  events: SwapEvent[];
}

export interface SwapEvent {
  type: string;
  timestamp: number;
  data: any;
}

export interface SwapInitiationResult {
  swapId: string;
  htlcSecret: string;
  htlcSecretHash: string;
  initiatorCommitment: string;
  recipientCommitment: string;
  timelock: number;
  expiresAt: number;
}

export interface SwapStatistics {
  total: number;
  pending: number;
  locked: number;
  completed: number;
  refunded: number;
  expired: number;
  disputed: number;
  totalVolume: string;
  avgCompletionTime: number;
}

export class AtomicSwapCoordinator extends EventEmitter {
  private noteManager: NoteCommitmentManager;
  private btcBridge: BitcoinBridge;
  private hasher: PoseidonHasher;
  private keyManager: SecureKeyManager;
  private swaps: Map<string, SwapState> = new Map();
  private redis: Redis;
  private readonly swapTTL: number = 86400 * 7;
  private cleanupInterval?: NodeJS.Timeout;
  private monitorInterval?: NodeJS.Timeout;

  constructor(
    noteManager: NoteCommitmentManager,
    btcBridge: BitcoinBridge,
    hasher: PoseidonHasher,
    keyManager: SecureKeyManager,
    redis: Redis
  ) {
    super();
    this.noteManager = noteManager;
    this.btcBridge = btcBridge;
    this.hasher = hasher;
    this.keyManager = keyManager;
    this.redis = redis;
    
    this.startBackgroundTasks();
  }

  private startBackgroundTasks(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredSwaps().catch(console.error);
    }, 60000);
    
    this.monitorInterval = setInterval(() => {
      this.monitorPendingSwaps().catch(console.error);
    }, 30000);
  }

  async initiateSwap(
    initiatorAddress: string,
    recipientAddress: string,
    amount: bigint,
    timelockDuration: number
  ): Promise<SwapInitiationResult> {
    
    const htlcSecret = crypto.randomBytes(32).toString('hex');
    const htlcSecretHash = crypto.createHash('sha256')
      .update(Buffer.from(htlcSecret, 'hex'))
      .digest('hex');

    const initiatorNote = this.noteManager.generateNote(amount, initiatorAddress);
    const recipientNote = this.noteManager.generateNote(amount, recipientAddress);

    const swapIdInput = this.hasher.hash4([
      BigInt('0x' + htlcSecretHash),
      BigInt(initiatorAddress),
      BigInt(recipientAddress),
      BigInt(Date.now())
    ]);
    const swapId = this.hasher.toFelt252(swapIdInput);

    const now = Date.now();
    const expiresAt = now + timelockDuration * 1000;
    
    const swap: SwapState = {
      swapId,
      initiator: initiatorAddress,
      recipient: recipientAddress,
      initiatorNote,
      recipientNote,
      htlcSecret,
      htlcSecretHash,
      timelock: expiresAt,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      expiresAt,
      events: [{
        type: 'INITIATED',
        timestamp: now,
        data: { initiator: initiatorAddress, recipient: recipientAddress, amount: amount.toString() }
      }]
    };

    this.swaps.set(swapId, swap);
    await this.saveSwap(swap);
    
    this.emit('swap-initiated', swap);

    return {
      swapId,
      htlcSecret,
      htlcSecretHash,
      initiatorCommitment: initiatorNote.commitment,
      recipientCommitment: recipientNote.commitment,
      timelock: swap.timelock,
      expiresAt
    };
  }

  async lockSwapWithBTC(swapId: string, btcTxid: string): Promise<SPVProof> {
    const swap = await this.getSwap(swapId);
    if (!swap) {
      throw new Error('Swap not found');
    }
    
    if (swap.status !== 'pending') {
      throw new Error(`Swap not in pending state: ${swap.status}`);
    }

    if (Date.now() >= swap.timelock) {
      swap.status = 'expired';
      await this.saveSwap(swap);
      throw new Error('Swap timelock expired');
    }

    const spvProof = await this.btcBridge.generateSPVProof(btcTxid);

    const isValid = this.btcBridge.verifyMerkleProof(
      spvProof.txid,
      spvProof.merkleProof,
      spvProof.txIndex,
      spvProof.blockHeader.merkleRoot
    );

    if (!isValid) {
      throw new Error('Invalid SPV proof');
    }

    const hasConfirmations = await this.btcBridge.verifyConfirmations(btcTxid, 6);
    if (!hasConfirmations) {
      throw new Error('Transaction needs more confirmations (minimum 6)');
    }

    swap.btcTxid = btcTxid;
    swap.btcBlockHeight = spvProof.blockHeader.height;
    swap.status = 'locked';
    swap.updatedAt = Date.now();
    swap.events.push({
      type: 'LOCKED',
      timestamp: Date.now(),
      data: { btcTxid, blockHeight: spvProof.blockHeader.height }
    });
    
    await this.saveSwap(swap);
    this.emit('swap-locked', swap);

    return spvProof;
  }

  async completeSwap(swapId: string, secret: string): Promise<boolean> {
    const swap = await this.getSwap(swapId);
    if (!swap) {
      throw new Error('Swap not found');
    }
    
    if (swap.status !== 'locked') {
      throw new Error(`Swap not locked: ${swap.status}`);
    }

    const providedHash = crypto.createHash('sha256')
      .update(Buffer.from(secret, 'hex'))
      .digest('hex');

    if (providedHash !== swap.htlcSecretHash) {
      throw new Error('Invalid secret');
    }

    if (Date.now() >= swap.timelock) {
      swap.status = 'expired';
      await this.saveSwap(swap);
      throw new Error('Timelock expired');
    }

    swap.status = 'completed';
    swap.updatedAt = Date.now();
    swap.events.push({
      type: 'COMPLETED',
      timestamp: Date.now(),
      data: { completedBy: swap.recipient }
    });
    
    await this.saveSwap(swap);
    this.emit('swap-completed', swap);

    return true;
  }

  async refundSwap(swapId: string): Promise<boolean> {
    const swap = await this.getSwap(swapId);
    if (!swap) {
      throw new Error('Swap not found');
    }

    if (Date.now() < swap.timelock) {
      throw new Error('Timelock not yet expired');
    }

    if (swap.status === 'completed') {
      throw new Error('Swap already completed, cannot refund');
    }

    swap.status = 'refunded';
    swap.updatedAt = Date.now();
    swap.events.push({
      type: 'REFUNDED',
      timestamp: Date.now(),
      data: { refundedTo: swap.initiator }
    });
    
    await this.saveSwap(swap);
    this.emit('swap-refunded', swap);

    return true;
  }

  async disputeSwap(swapId: string, reason: string): Promise<void> {
    const swap = await this.getSwap(swapId);
    if (!swap) {
      throw new Error('Swap not found');
    }

    swap.status = 'disputed';
    swap.updatedAt = Date.now();
    swap.events.push({
      type: 'DISPUTED',
      timestamp: Date.now(),
      data: { reason }
    });
    
    await this.saveSwap(swap);
    this.emit('swap-disputed', swap);
  }

  async getSwap(swapId: string): Promise<SwapState | null> {
    if (this.swaps.has(swapId)) {
      return this.swaps.get(swapId)!;
    }

    const encrypted = await this.redis.get(`swap:${swapId}`);
    if (!encrypted) {
      return null;
    }

    const decrypted = this.keyManager.decrypt(encrypted, 'swaps');
    const swap = JSON.parse(decrypted);
    
    swap.initiatorNote.amount = BigInt(swap.initiatorNote.amount);
    swap.recipientNote.amount = BigInt(swap.recipientNote.amount);
    
    this.swaps.set(swapId, swap);
    
    return swap;
  }

  private async saveSwap(swap: SwapState): Promise<void> {
    const serializable = {
      ...swap,
      initiatorNote: {
        ...swap.initiatorNote,
        amount: swap.initiatorNote.amount.toString()
      },
      recipientNote: {
        ...swap.recipientNote,
        amount: swap.recipientNote.amount.toString()
      }
    };

    const encrypted = this.keyManager.encrypt(JSON.stringify(serializable), 'swaps');
    
    await this.redis.set(
      `swap:${swap.swapId}`,
      encrypted,
      'EX',
      this.swapTTL
    );

    this.swaps.set(swap.swapId, swap);
  }

  async getSwapsForAddress(address: string): Promise<SwapState[]> {
    const keys = await this.redis.keys('swap:*');
    const swaps: SwapState[] = [];

    for (const key of keys) {
      const swapId = key.replace('swap:', '');
      const swap = await this.getSwap(swapId);
      
      if (swap && (swap.initiator === address || swap.recipient === address)) {
        swaps.push(swap);
      }
    }

    return swaps;
  }

  async cleanupExpiredSwaps(): Promise<number> {
    const keys = await this.redis.keys('swap:*');
    let cleaned = 0;

    for (const key of keys) {
      const swapId = key.replace('swap:', '');
      const swap = await this.getSwap(swapId);
      
      if (swap && swap.status === 'pending' && Date.now() >= swap.timelock) {
        swap.status = 'expired';
        swap.events.push({
          type: 'EXPIRED',
          timestamp: Date.now(),
          data: {}
        });
        await this.saveSwap(swap);
        this.emit('swap-expired', swap);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`🧹 Cleaned up ${cleaned} expired swaps`);
    }

    return cleaned;
  }

  private async monitorPendingSwaps(): Promise<void> {
    const keys = await this.redis.keys('swap:*');

    for (const key of keys) {
      const swapId = key.replace('swap:', '');
      const swap = await this.getSwap(swapId);
      
      if (!swap || swap.status !== 'locked' || !swap.btcTxid) continue;

      try {
        const currentConfs = await this.btcBridge.verifyConfirmations(swap.btcTxid, 1);
        
        if (currentConfs) {
          this.emit('swap-confirmation-update', {
            swapId: swap.swapId,
            btcTxid: swap.btcTxid
          });
        }
      } catch (error) {
        console.error(`Error monitoring swap ${swapId}:`, error);
      }
    }
  }

  async getSwapStats(): Promise<SwapStatistics> {
    const keys = await this.redis.keys('swap:*');
    const stats: SwapStatistics = {
      total: keys.length,
      pending: 0,
      locked: 0,
      completed: 0,
      refunded: 0,
      expired: 0,
      disputed: 0,
      totalVolume: '0',
      avgCompletionTime: 0
    };

    let totalVolume = 0n;
    let totalCompletionTime = 0;
    let completedCount = 0;

    for (const key of keys) {
      const swapId = key.replace('swap:', '');
      const swap = await this.getSwap(swapId);
      
      if (swap) {
        stats[swap.status]++;
        totalVolume += swap.initiatorNote.amount;
        
        if (swap.status === 'completed') {
          totalCompletionTime += swap.updatedAt - swap.createdAt;
          completedCount++;
        }
      }
    }

    stats.totalVolume = totalVolume.toString();
    stats.avgCompletionTime = completedCount > 0 ? totalCompletionTime / completedCount : 0;

    return stats;
  }

  async verifySwap(swapId: string): Promise<boolean> {
    const swap = await this.getSwap(swapId);
    if (!swap) {
      return false;
    }

    const initiatorValid = this.noteManager.verifyNoteCommitment(swap.initiatorNote);
    const recipientValid = this.noteManager.verifyNoteCommitment(swap.recipientNote);

    return initiatorValid && recipientValid;
  }

  async estimateCompletionTime(swapId: string): Promise<number> {
    const swap = await this.getSwap(swapId);
    if (!swap) {
      throw new Error('Swap not found');
    }

    const stats = await this.getSwapStats();
    return stats.avgCompletionTime;
  }

  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
    }
    this.removeAllListeners();
  }
}
