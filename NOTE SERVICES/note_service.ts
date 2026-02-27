// ============================================
// PRIVACY NOTE MICROSERVICE
// Port: 3003
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
const ENCRYPTION_SERVICE = process.env.ENCRYPTION_SERVICE_URL || 'http://localhost:3001';

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

  async hash4(inputs: [string, string, string, string]): Promise<{ hash: string; felt252: string }> {
    const res = await axios.post(`${POSEIDON_SERVICE}/api/hash4`, { inputs });
    return res.data;
  }
}

class EncryptionClient {
  async encrypt(data: string, purpose: string): Promise<string> {
    const res = await axios.post(`${ENCRYPTION_SERVICE}/api/encrypt`, { data, purpose });
    return res.data.encrypted;
  }

  async decrypt(encrypted: string, purpose: string): Promise<string> {
    const res = await axios.post(`${ENCRYPTION_SERVICE}/api/decrypt`, { encrypted, purpose });
    return res.data.decrypted;
  }
}

// ============================================
// PRIVACY NOTE MANAGER
// ============================================

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

class NoteCommitmentManager {
  private poseidon: PoseidonClient;
  private encryption: EncryptionClient;
  private notes: Map<string, PrivacyNote> = new Map();
  private commitments: bigint[] = [];
  private merkleTree: MerkleTree | null = null;

  constructor() {
    this.poseidon = new PoseidonClient();
    this.encryption = new EncryptionClient();
  }

  async generateNote(amount: bigint, recipient: string, secret?: string): Promise<PrivacyNote> {
    const noteSecret = secret || crypto.randomBytes(31).toString('hex');
    const secretBigInt = BigInt('0x' + noteSecret);
    const recipientBigInt = BigInt(recipient);

    const nullifierResult = await this.poseidon.hash2([
      secretBigInt.toString(),
      recipientBigInt.toString()
    ]);
    const nullifierBigInt = BigInt(nullifierResult.hash);

    const commitmentResult = await this.poseidon.hash3([
      amount.toString(),
      recipientBigInt.toString(),
      secretBigInt.toString()
    ]);
    const commitmentBigInt = BigInt(commitmentResult.hash);

    const amountCommitmentResult = await this.poseidon.hash2([
      amount.toString(),
      secretBigInt.toString()
    ]);
    const amountCommitmentBigInt = BigInt(amountCommitmentResult.hash);

    const note: PrivacyNote = {
      amount,
      recipient,
      secret: noteSecret,
      nullifier: nullifierResult.felt252,
      commitment: commitmentResult.felt252,
      amountCommitment: amountCommitmentResult.felt252,
      leafIndex: this.commitments.length,
      timestamp: Date.now()
    };

    this.commitments.push(commitmentBigInt);
    this.notes.set(note.commitment, note);
    this.merkleTree = null;

    return note;
  }

  async buildMerkleTree(): Promise<string> {
    if (this.merkleTree && this.commitments.length === this.merkleTree.getLeafCount()) {
      return '0x' + this.merkleTree.getRoot().toString('hex');
    }

    const leaves = this.commitments.map(c => 
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
      { 
        sortPairs: false,
        hashLeaves: false
      }
    );

    return '0x' + this.merkleTree.getRoot().toString('hex');
  }

  async getMerkleProof(commitment: string): Promise<string[]> {
    if (!this.merkleTree) {
      await this.buildMerkleTree();
    }

    const note = this.notes.get(commitment);
    if (!note) throw new Error('Note not found');

    const leaf = Buffer.from(commitment.slice(2), 'hex');
    const proof = this.merkleTree!.getProof(leaf);
    
    return proof.map(p => '0x' + p.data.toString('hex'));
  }

  async generateSpendProof(commitment: string, spender: string): Promise<any> {
    const note = this.notes.get(commitment);
    if (!note) throw new Error('Note not found');

    if (note.recipient !== spender) {
      throw new Error('Unauthorized: not note recipient');
    }

    const merkleProof = await this.getMerkleProof(commitment);
    const merkleRoot = await this.buildMerkleTree();

    const spenderBigInt = BigInt(spender);
    const nullifierBigInt = BigInt(note.nullifier);
    const merkleRootBigInt = BigInt(merkleRoot);

    const messageResult = await this.poseidon.hash3([
      nullifierBigInt.toString(),
      merkleRootBigInt.toString(),
      spenderBigInt.toString()
    ]);
    const message = BigInt(messageResult.hash);

    const secretBigInt = BigInt('0x' + note.secret);
    const rResult = await this.poseidon.hash2([secretBigInt.toString(), message.toString()]);
    const r = BigInt(rResult.hash);
    
    const sResult = await this.poseidon.hash2([secretBigInt.toString(), r.toString()]);
    const s = BigInt(sResult.hash);

    return {
      merkle_root: merkleRoot,
      nullifier: note.nullifier,
      proof_elements: merkleProof,
      signature: [rResult.felt252, sResult.felt252],
      _private: {
        amount: note.amount.toString(),
        secret: note.secret,
        recipient: note.recipient
      }
    };
  }

  async storeNoteEncrypted(note: PrivacyNote): Promise<string> {
    const noteData = JSON.stringify({
      ...note,
      amount: note.amount.toString()
    });
    return await this.encryption.encrypt(noteData, 'notes');
  }

  async retrieveNoteEncrypted(encrypted: string): Promise<PrivacyNote> {
    const decrypted = await this.encryption.decrypt(encrypted, 'notes');
    const parsed = JSON.parse(decrypted);
    return {
      ...parsed,
      amount: BigInt(parsed.amount)
    };
  }

  getNote(commitment: string): PrivacyNote | undefined {
    return this.notes.get(commitment);
  }

  getAllCommitments(): string[] {
    return Array.from(this.notes.keys());
  }
}

// ============================================
// API ENDPOINTS
// ============================================

const noteManager = new NoteCommitmentManager();

app.get('/health', (req, res) => {
  res.json({ 
    service: 'privacy-note', 
    status: 'ok',
    totalNotes: noteManager.getAllCommitments().length,
    timestamp: Date.now() 
  });
});

app.post('/api/notes/generate', async (req, res) => {
  try {
    const { amount, recipient, secret } = req.body;
    const note = await noteManager.generateNote(BigInt(amount), recipient, secret);
    
    const encrypted = await noteManager.storeNoteEncrypted(note);
    
    res.json({
      commitment: note.commitment,
      nullifier: note.nullifier,
      amountCommitment: note.amountCommitment,
      encryptedNote: encrypted
    });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/merkle/root', async (req, res) => {
  try {
    const root = await noteManager.buildMerkleTree();
    res.json({ merkleRoot: root });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/merkle/proof', async (req, res) => {
  try {
    const { commitment } = req.body;
    const proof = await noteManager.getMerkleProof(commitment);
    res.json({ proof });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/proofs/spend', async (req, res) => {
  try {
    const { commitment, spender } = req.body;
    const proof = await noteManager.generateSpendProof(commitment, spender);
    res.json({ proof });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/notes/:commitment', async (req, res) => {
  try {
    const note = noteManager.getNote(req.params.commitment);
    if (!note) {
      return res.status(404).json({ error: 'Note not found' });
    }
    res.json({
      commitment: note.commitment,
      nullifier: note.nullifier,
      amountCommitment: note.amountCommitment,
      leafIndex: note.leafIndex,
      timestamp: note.timestamp
    });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/notes', (req, res) => {
  const commitments = noteManager.getAllCommitments();
  res.json({ commitments, total: commitments.length });
});

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => {
  console.log(`📝 Privacy Note Service running on port ${PORT}`);
});

export { NoteCommitmentManager };