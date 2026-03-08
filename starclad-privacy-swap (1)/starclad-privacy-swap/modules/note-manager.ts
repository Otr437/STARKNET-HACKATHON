/**
 * NoteCommitmentManager - Privacy notes with Redis persistence
 * Poseidon commitments, nullifier tracking, Merkle tree, spend proofs
 */
import crypto from 'crypto';
import { MerkleTree } from 'merkletreejs';
import type Redis from 'ioredis';
import { PoseidonHasher } from './poseidon';
import { SecureKeyManager } from './encryption';

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
}

export interface NoteStats {
  totalNotes: number;
  spentNotes: number;
  unspentNotes: number;
  totalValue: string;
  spentValue: string;
  unspentValue: string;
  uniqueRecipients: number;
  nullifiersUsed: number;
  merkleTreeSize: number;
}

export class NoteCommitmentManager {
  private notes = new Map<string, PrivacyNote>();
  private nullifiers = new Set<string>();
  private commitments: bigint[] = [];
  private merkleTree: MerkleTree | null = null;
  private readonly NOTE_PREFIX = 'note:';
  private readonly NULL_PREFIX = 'nullifier:';

  constructor(
    private hasher: PoseidonHasher,
    private km: SecureKeyManager,
    private redis?: Redis,
  ) {}

  async initialize(): Promise<void> {
    if (!this.redis) return;
    const keys = await this.redis.keys(`${this.NOTE_PREFIX}*`);
    for (const k of keys) {
      const enc = await this.redis.get(k);
      if (!enc) continue;
      try {
        const note = this._decryptNote(enc);
        this.notes.set(note.commitment, note);
        this.commitments.push(BigInt(note.commitment));
      } catch { /* corrupted entry, skip */ }
    }
    const nkeys = await this.redis.keys(`${this.NULL_PREFIX}*`);
    for (const k of nkeys) this.nullifiers.add(k.replace(this.NULL_PREFIX, ''));
    console.log(`[NoteManager] loaded ${this.notes.size} notes, ${this.nullifiers.size} nullifiers`);
  }

  generateNote(amount: bigint, recipient: string, secret?: string): PrivacyNote {
    const sec = secret ?? crypto.randomBytes(31).toString('hex');
    const secBig = BigInt('0x' + sec);
    const recBig = BigInt(recipient);

    const nullifierBig = this.hasher.createNullifier(secBig, recBig);
    const commitBig = this.hasher.createCommitment(amount, recBig, secBig);
    const amtCommitBig = this.hasher.createAmountCommitment(amount, secBig);

    const note: PrivacyNote = {
      amount,
      recipient,
      secret: sec,
      nullifier: this.hasher.toFelt252(nullifierBig),
      commitment: this.hasher.toFelt252(commitBig),
      amountCommitment: this.hasher.toFelt252(amtCommitBig),
      leafIndex: this.commitments.length,
      timestamp: Date.now(),
      spent: false,
    };

    this.commitments.push(commitBig);
    this.notes.set(note.commitment, note);
    this.merkleTree = null; // invalidate

    if (this.redis) this._persistNote(note).catch(console.error);
    return note;
  }

  buildMerkleTree(): string {
    if (this.merkleTree && this.commitments.length === this.merkleTree.getLeafCount()) {
      return '0x' + this.merkleTree.getRoot().toString('hex');
    }
    const leaves = this.commitments.map(c => Buffer.from(c.toString(16).padStart(64, '0'), 'hex'));
    this.merkleTree = new MerkleTree(
      leaves,
      (data: Buffer) => {
        const v = BigInt('0x' + data.toString('hex'));
        const h = this.hasher.hash(v);
        return Buffer.from(h.toString(16).padStart(64, '0'), 'hex');
      },
      { sortPairs: false, hashLeaves: false },
    );
    return '0x' + this.merkleTree.getRoot().toString('hex');
  }

  getMerkleProof(commitment: string): string[] {
    if (!this.merkleTree) this.buildMerkleTree();
    const note = this._requireNote(commitment);
    const leaf = Buffer.from(commitment.slice(2), 'hex');
    return this.merkleTree!.getProof(leaf).map(p => '0x' + p.data.toString('hex'));
  }

  generateSpendProof(commitment: string, spender: string): SpendProof {
    const note = this._requireNote(commitment);
    if (note.recipient !== spender) throw new Error('Unauthorized: not note recipient');
    if (note.spent) throw new Error('Note already spent');
    if (this.nullifiers.has(note.nullifier)) throw new Error('Nullifier already used');

    const proof = this.getMerkleProof(commitment);
    const root = this.buildMerkleTree();

    const spenderBig = BigInt(spender);
    const nullBig = BigInt(note.nullifier);
    const rootBig = BigInt(root);
    const secBig = BigInt('0x' + note.secret);

    const msg = this.hasher.hash3(nullBig, rootBig, spenderBig);
    const r = this.hasher.hash2(secBig, msg);
    const s = this.hasher.hash2(secBig, r);

    return {
      merkle_root: root,
      nullifier: note.nullifier,
      proof_elements: proof,
      signature: [this.hasher.toFelt252(r), this.hasher.toFelt252(s)],
      leaf_index: note.leafIndex,
    };
  }

  async markSpent(commitment: string, txHash: string): Promise<void> {
    const note = this._requireNote(commitment);
    note.spent = true;
    note.spentAt = Date.now();
    note.spentTxHash = txHash;
    this.nullifiers.add(note.nullifier);
    if (this.redis) {
      await this._persistNote(note);
      await this.redis.set(`${this.NULL_PREFIX}${note.nullifier}`, txHash);
    }
  }

  verifyNoteCommitment(note: PrivacyNote): boolean {
    return this.hasher.verifyCommitment(BigInt(note.commitment), note.amount, BigInt(note.recipient), BigInt('0x' + note.secret));
  }

  isNullifierUsed(nullifier: string): boolean { return this.nullifiers.has(nullifier); }
  getNote(commitment: string): PrivacyNote | undefined { return this.notes.get(commitment); }
  getCommitmentCount(): number { return this.commitments.length; }

  getStats(): NoteStats {
    const all = [...this.notes.values()];
    const spent = all.filter(n => n.spent);
    const unspent = all.filter(n => !n.spent);
    return {
      totalNotes: all.length,
      spentNotes: spent.length,
      unspentNotes: unspent.length,
      totalValue: all.reduce((s, n) => s + n.amount, 0n).toString(),
      spentValue: spent.reduce((s, n) => s + n.amount, 0n).toString(),
      unspentValue: unspent.reduce((s, n) => s + n.amount, 0n).toString(),
      uniqueRecipients: new Set(all.map(n => n.recipient)).size,
      nullifiersUsed: this.nullifiers.size,
      merkleTreeSize: this.commitments.length,
    };
  }

  getNotesByRecipient(recipient: string): PrivacyNote[] {
    return [...this.notes.values()].filter(n => n.recipient === recipient);
  }

  getTotalBalance(recipient: string): bigint {
    return this.getNotesByRecipient(recipient).filter(n => !n.spent).reduce((s, n) => s + n.amount, 0n);
  }

  storeNoteEncrypted(note: PrivacyNote): string {
    return this.km.encrypt(JSON.stringify({ ...note, amount: note.amount.toString() }), 'notes');
  }

  retrieveNoteEncrypted(enc: string): PrivacyNote {
    const d = JSON.parse(this.km.decrypt(enc, 'notes'));
    return { ...d, amount: BigInt(d.amount) };
  }

  private _requireNote(commitment: string): PrivacyNote {
    const n = this.notes.get(commitment);
    if (!n) throw new Error(`Note not found: ${commitment}`);
    return n;
  }

  private async _persistNote(note: PrivacyNote): Promise<void> {
    if (!this.redis) return;
    await this.redis.set(`${this.NOTE_PREFIX}${note.commitment}`, this.storeNoteEncrypted(note));
  }

  private _decryptNote(enc: string): PrivacyNote { return this.retrieveNoteEncrypted(enc); }
}
