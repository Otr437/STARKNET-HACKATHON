/**
 * Privacy Note System - COMPLETE PRODUCTION IMPLEMENTATION
 * Database persistence, note scanning, batch operations, Merkle optimization
 */

import crypto from 'crypto';
import { MerkleTree } from 'merkletreejs';
import { PoseidonHasher } from './poseidon';
import { SecureKeyManager } from './encryption';
import Redis from 'ioredis';

export interface PrivacyNote {
  amount: bigint;
  recipient: string;
  secret: string;
  nullifier: string;
  commitment: string;
  amountCommitment: string;
  leafIndex: number;
  timestamp: number;
  spent: boolean;
  spentAt?: number;
  spentTxHash?: string;
}

export interface SpendProof {
  merkle_root: string;
  nullifier: string;
  proof_elements: string[];
  signature: [string, string];
  leaf_index: number;
  _private?: {
    amount: string;
    secret: string;
    recipient: string;
  };
}

export interface NoteFilter {
  recipient?: string;
  spent?: boolean;
  minAmount?: bigint;
  maxAmount?: bigint;
  fromTimestamp?: number;
  toTimestamp?: number;
}

export interface BatchNoteResult {
  notes: PrivacyNote[];
  merkleRoot: string;
  processingTime: number;
}

export class NoteCommitmentManager {
  private hasher: PoseidonHasher;
  private notes: Map<string, PrivacyNote> = new Map();
  private nullifierSet: Set<string> = new Set();
  private commitments: bigint[] = [];
  private merkleTree: MerkleTree | null = null;
  private keyManager: SecureKeyManager;
  private redis: Redis;
  private readonly dbPrefix = 'note:';
  private readonly nullifierPrefix = 'nullifier:';

  constructor(hasher: PoseidonHasher, keyManager: SecureKeyManager, redis?: Redis) {
    this.hasher = hasher;
    this.keyManager = keyManager;
    if (redis) {
      this.redis = redis;
    }
  }

  async initialize(): Promise<void> {
    if (this.redis) {
      await this.loadNotesFromRedis();
      await this.loadNullifiersFromRedis();
    }
    console.log(`✅ NoteManager initialized with ${this.notes.size} notes`);
  }

  private async loadNotesFromRedis(): Promise<void> {
    const keys = await this.redis.keys(`${this.dbPrefix}*`);
    for (const key of keys) {
      const encrypted = await this.redis.get(key);
      if (encrypted) {
        try {
          const note = this.retrieveNoteEncrypted(encrypted);
          this.notes.set(note.commitment, note);
          this.commitments.push(BigInt(note.commitment));
        } catch (error) {
          console.warn(`Failed to load note ${key}:`, error);
        }
      }
    }
  }

  private async loadNullifiersFromRedis(): Promise<void> {
    const keys = await this.redis.keys(`${this.nullifierPrefix}*`);
    for (const key of keys) {
      const nullifier = key.replace(this.nullifierPrefix, '');
      this.nullifierSet.add(nullifier);
    }
  }

  generateNote(amount: bigint, recipient: string, secret?: string): PrivacyNote {
    const noteSecret = secret || crypto.randomBytes(31).toString('hex');
    const secretBigInt = BigInt('0x' + noteSecret);
    const recipientBigInt = BigInt(recipient);

    const nullifierBigInt = this.hasher.createNullifier(secretBigInt, recipientBigInt);
    const commitmentBigInt = this.hasher.createCommitment(amount, recipientBigInt, secretBigInt);
    const amountCommitmentBigInt = this.hasher.createAmountCommitment(amount, secretBigInt);

    const note: PrivacyNote = {
      amount,
      recipient,
      secret: noteSecret,
      nullifier: this.hasher.toFelt252(nullifierBigInt),
      commitment: this.hasher.toFelt252(commitmentBigInt),
      amountCommitment: this.hasher.toFelt252(amountCommitmentBigInt),
      leafIndex: this.commitments.length,
      timestamp: Date.now(),
      spent: false
    };

    this.commitments.push(commitmentBigInt);
    this.notes.set(note.commitment, note);
    this.merkleTree = null;

    if (this.redis) {
      this.saveNoteToRedis(note).catch(console.error);
    }

    return note;
  }

  async generateBatchNotes(recipients: { amount: bigint; address: string }[]): Promise<BatchNoteResult> {
    const startTime = Date.now();
    const notes: PrivacyNote[] = [];

    for (const { amount, address } of recipients) {
      const note = this.generateNote(amount, address);
      notes.push(note);
    }

    const merkleRoot = this.buildMerkleTree();

    return {
      notes,
      merkleRoot,
      processingTime: Date.now() - startTime
    };
  }

  private async saveNoteToRedis(note: PrivacyNote): Promise<void> {
    const encrypted = this.storeNoteEncrypted(note);
    await this.redis.set(`${this.dbPrefix}${note.commitment}`, encrypted);
  }

  buildMerkleTree(): string {
    if (this.merkleTree && this.commitments.length === this.merkleTree.getLeafCount()) {
      return '0x' + this.merkleTree.getRoot().toString('hex');
    }

    const leaves = this.commitments.map(c => 
      Buffer.from(c.toString(16).padStart(64, '0'), 'hex')
    );

    this.merkleTree = new MerkleTree(
      leaves,
      (data: Buffer) => {
        const bigIntValue = BigInt('0x' + data.toString('hex'));
        const hashed = this.hasher.hash(bigIntValue);
        return Buffer.from(hashed.toString(16).padStart(64, '0'), 'hex');
      },
      { 
        sortPairs: false,
        hashLeaves: false
      }
    );

    return '0x' + this.merkleTree.getRoot().toString('hex');
  }

  getMerkleProof(commitment: string): string[] {
    if (!this.merkleTree) {
      this.buildMerkleTree();
    }

    const note = this.notes.get(commitment);
    if (!note) {
      throw new Error('Note not found');
    }

    const leaf = Buffer.from(commitment.slice(2), 'hex');
    const proof = this.merkleTree!.getProof(leaf);
    
    return proof.map(p => '0x' + p.data.toString('hex'));
  }

  generateSpendProof(commitment: string, spender: string): SpendProof {
    const note = this.notes.get(commitment);
    if (!note) {
      throw new Error('Note not found');
    }

    if (note.recipient !== spender) {
      throw new Error('Unauthorized: not note recipient');
    }

    if (note.spent) {
      throw new Error('Note already spent');
    }

    if (this.nullifierSet.has(note.nullifier)) {
      throw new Error('Nullifier already used');
    }

    const merkleProof = this.getMerkleProof(commitment);
    const merkleRoot = this.buildMerkleTree();

    const spenderBigInt = BigInt(spender);
    const nullifierBigInt = BigInt(note.nullifier);
    const merkleRootBigInt = BigInt(merkleRoot);

    const message = this.hasher.hash3([nullifierBigInt, merkleRootBigInt, spenderBigInt]);

    const secretBigInt = BigInt('0x' + note.secret);
    const r = this.hasher.hash2([secretBigInt, message]);
    const s = this.hasher.hash2([secretBigInt, r]);

    return {
      merkle_root: merkleRoot,
      nullifier: note.nullifier,
      proof_elements: merkleProof,
      signature: [this.hasher.toFelt252(r), this.hasher.toFelt252(s)],
      leaf_index: note.leafIndex,
      _private: {
        amount: note.amount.toString(),
        secret: note.secret,
        recipient: note.recipient
      }
    };
  }

  async markNoteAsSpent(commitment: string, txHash: string): Promise<void> {
    const note = this.notes.get(commitment);
    if (!note) {
      throw new Error('Note not found');
    }

    note.spent = true;
    note.spentAt = Date.now();
    note.spentTxHash = txHash;

    this.nullifierSet.add(note.nullifier);

    if (this.redis) {
      await this.saveNoteToRedis(note);
      await this.redis.set(`${this.nullifierPrefix}${note.nullifier}`, txHash);
    }
  }

  isNullifierUsed(nullifier: string): boolean {
    return this.nullifierSet.has(nullifier);
  }

  async scanAndRecoverNotes(recipient: string, secrets: string[]): Promise<PrivacyNote[]> {
    const recovered: PrivacyNote[] = [];

    for (const secret of secrets) {
      try {
        const secretBigInt = BigInt('0x' + secret);
        const recipientBigInt = BigInt(recipient);
        
        const nullifierBigInt = this.hasher.createNullifier(secretBigInt, recipientBigInt);
        const nullifier = this.hasher.toFelt252(nullifierBigInt);

        for (const [commitment, note] of this.notes.entries()) {
          if (note.nullifier === nullifier) {
            recovered.push(note);
          }
        }
      } catch (error) {
        console.warn(`Failed to scan with secret ${secret}:`, error);
      }
    }

    return recovered;
  }

  queryNotes(filter: NoteFilter): PrivacyNote[] {
    let results = Array.from(this.notes.values());

    if (filter.recipient) {
      results = results.filter(n => n.recipient === filter.recipient);
    }

    if (filter.spent !== undefined) {
      results = results.filter(n => n.spent === filter.spent);
    }

    if (filter.minAmount !== undefined) {
      results = results.filter(n => n.amount >= filter.minAmount!);
    }

    if (filter.maxAmount !== undefined) {
      results = results.filter(n => n.amount <= filter.maxAmount!);
    }

    if (filter.fromTimestamp) {
      results = results.filter(n => n.timestamp >= filter.fromTimestamp!);
    }

    if (filter.toTimestamp) {
      results = results.filter(n => n.timestamp <= filter.toTimestamp!);
    }

    return results;
  }

  verifyProof(proof: SpendProof, commitment: string): boolean {
    const note = this.notes.get(commitment);
    if (!note) {
      return false;
    }

    const leaf = Buffer.from(commitment.slice(2), 'hex');
    const proofBuffers = proof.proof_elements.map((p: string) => ({
      data: Buffer.from(p.slice(2), 'hex'),
      position: 'right' as const
    }));

    if (!this.merkleTree) this.buildMerkleTree();
    const root = this.merkleTree!.verify(proofBuffers, leaf, this.merkleTree!.getRoot());

    return root;
  }

  storeNoteEncrypted(note: PrivacyNote): string {
    const noteData = JSON.stringify({
      ...note,
      amount: note.amount.toString()
    });
    return this.keyManager.encrypt(noteData, 'notes');
  }

  retrieveNoteEncrypted(encrypted: string): PrivacyNote {
    const decrypted = this.keyManager.decrypt(encrypted, 'notes');
    const note = JSON.parse(decrypted);
    note.amount = BigInt(note.amount);
    return note;
  }

  getNote(commitment: string): PrivacyNote | undefined {
    return this.notes.get(commitment);
  }

  getAllNotes(): PrivacyNote[] {
    return Array.from(this.notes.values());
  }

  getNotesByRecipient(recipient: string): PrivacyNote[] {
    return this.queryNotes({ recipient });
  }

  getUnspentNotes(recipient?: string): PrivacyNote[] {
    return this.queryNotes({ recipient, spent: false });
  }

  getSpentNotes(recipient?: string): PrivacyNote[] {
    return this.queryNotes({ recipient, spent: true });
  }

  getTotalBalance(recipient: string): bigint {
    const unspent = this.getUnspentNotes(recipient);
    return unspent.reduce((sum, note) => sum + note.amount, 0n);
  }

  getCommitmentCount(): number {
    return this.commitments.length;
  }

  getCurrentRoot(): string | null {
    if (!this.merkleTree) {
      return null;
    }
    return '0x' + this.merkleTree.getRoot().toString('hex');
  }

  verifyNoteCommitment(note: PrivacyNote): boolean {
    const secretBigInt = BigInt('0x' + note.secret);
    const recipientBigInt = BigInt(note.recipient);
    const commitmentBigInt = BigInt(note.commitment);

    return this.hasher.verifyCommitment(
      commitmentBigInt,
      note.amount,
      recipientBigInt,
      secretBigInt
    );
  }

  verifyNoteNullifier(note: PrivacyNote): boolean {
    const secretBigInt = BigInt('0x' + note.secret);
    const recipientBigInt = BigInt(note.recipient);
    const nullifierBigInt = BigInt(note.nullifier);

    return this.hasher.verifyNullifier(
      nullifierBigInt,
      secretBigInt,
      recipientBigInt
    );
  }

  async exportNotes(recipient?: string): Promise<string> {
    const notes = recipient ? this.getNotesByRecipient(recipient) : this.getAllNotes();
    const exported = notes.map(note => ({
      ...note,
      amount: note.amount.toString()
    }));
    
    const data = JSON.stringify(exported, null, 2);
    const encrypted = this.keyManager.encrypt(data, 'note_export');
    
    return encrypted;
  }

  async importNotes(encrypted: string): Promise<number> {
    const decrypted = this.keyManager.decrypt(encrypted, 'note_export');
    const notes = JSON.parse(decrypted);
    
    let imported = 0;
    for (const noteData of notes) {
      try {
        noteData.amount = BigInt(noteData.amount);
        this.notes.set(noteData.commitment, noteData as PrivacyNote);
        this.commitments.push(BigInt(noteData.commitment));
        
        if (this.redis) {
          await this.saveNoteToRedis(noteData as PrivacyNote);
        }
        
        imported++;
      } catch (error) {
        console.warn('Failed to import note:', error);
      }
    }
    
    this.merkleTree = null;
    return imported;
  }

  getStatistics() {
    const all = this.getAllNotes();
    const spent = all.filter(n => n.spent);
    const unspent = all.filter(n => !n.spent);
    
    const totalValue = all.reduce((sum, n) => sum + n.amount, 0n);
    const spentValue = spent.reduce((sum, n) => sum + n.amount, 0n);
    const unspentValue = unspent.reduce((sum, n) => sum + n.amount, 0n);

    return {
      totalNotes: all.length,
      spentNotes: spent.length,
      unspentNotes: unspent.length,
      totalValue: totalValue.toString(),
      spentValue: spentValue.toString(),
      unspentValue: unspentValue.toString(),
      uniqueRecipients: new Set(all.map(n => n.recipient)).size,
      nullifiersUsed: this.nullifierSet.size,
      merkleTreeSize: this.commitments.length
    };
  }
}
