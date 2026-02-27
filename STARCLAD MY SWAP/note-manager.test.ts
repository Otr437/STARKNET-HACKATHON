/**
 * Test Suite for Privacy Note Manager
 */

import { PoseidonHasher } from '../poseidon';
import { NoteCommitmentManager } from '../note-manager';
import { SecureKeyManager } from '../encryption';

describe('NoteCommitmentManager', () => {
  let hasher: PoseidonHasher;
  let keyManager: SecureKeyManager;
  let noteManager: NoteCommitmentManager;

  beforeAll(async () => {
    // Initialize components
    hasher = new PoseidonHasher();
    await hasher.initialize();
    
    keyManager = new SecureKeyManager('test-password-123');
    noteManager = new NoteCommitmentManager(hasher, keyManager);
  });

  afterAll(() => {
    keyManager.destroy();
  });

  describe('generateNote', () => {
    it('should generate a valid privacy note', () => {
      const amount = BigInt(1000000);
      const recipient = '0x123456789abcdef';
      
      const note = noteManager.generateNote(amount, recipient);
      
      expect(note).toBeDefined();
      expect(note.amount).toBe(amount);
      expect(note.recipient).toBe(recipient);
      expect(note.secret).toMatch(/^[0-9a-f]+$/);
      expect(note.commitment).toMatch(/^0x[0-9a-f]{64}$/);
      expect(note.nullifier).toMatch(/^0x[0-9a-f]{64}$/);
      expect(note.amountCommitment).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('should generate unique commitments for different notes', () => {
      const amount = BigInt(1000000);
      const recipient = '0x123456789abcdef';
      
      const note1 = noteManager.generateNote(amount, recipient);
      const note2 = noteManager.generateNote(amount, recipient);
      
      expect(note1.commitment).not.toBe(note2.commitment);
      expect(note1.nullifier).not.toBe(note2.nullifier);
    });

    it('should accept custom secret', () => {
      const amount = BigInt(1000000);
      const recipient = '0x123456789abcdef';
      const secret = 'deadbeef'.repeat(8);
      
      const note = noteManager.generateNote(amount, recipient, secret);
      
      expect(note.secret).toBe(secret);
    });
  });

  describe('buildMerkleTree', () => {
    it('should build a valid Merkle tree', () => {
      const root = noteManager.buildMerkleTree();
      
      expect(root).toMatch(/^0x[0-9a-f]+$/);
    });

    it('should return consistent root for same commitments', () => {
      const root1 = noteManager.buildMerkleTree();
      const root2 = noteManager.buildMerkleTree();
      
      expect(root1).toBe(root2);
    });
  });

  describe('generateSpendProof', () => {
    it('should generate valid spend proof for note owner', () => {
      const amount = BigInt(1000000);
      const recipient = '0x123456789abcdef';
      
      const note = noteManager.generateNote(amount, recipient);
      const proof = noteManager.generateSpendProof(note.commitment, recipient);
      
      expect(proof).toBeDefined();
      expect(proof.merkle_root).toMatch(/^0x[0-9a-f]+$/);
      expect(proof.nullifier).toBe(note.nullifier);
      expect(proof.proof_elements).toBeInstanceOf(Array);
      expect(proof.signature).toHaveLength(2);
    });

    it('should throw error for non-existent note', () => {
      expect(() => {
        noteManager.generateSpendProof('0xdeadbeef', '0x123');
      }).toThrow('Note not found');
    });

    it('should throw error for unauthorized spender', () => {
      const amount = BigInt(1000000);
      const recipient = '0x123456789abcdef';
      
      const note = noteManager.generateNote(amount, recipient);
      
      expect(() => {
        noteManager.generateSpendProof(note.commitment, '0xdifferentaddress');
      }).toThrow('Unauthorized');
    });
  });

  describe('verifyProof', () => {
    it('should verify valid proof', () => {
      const amount = BigInt(1000000);
      const recipient = '0x123456789abcdef';
      
      const note = noteManager.generateNote(amount, recipient);
      const proof = noteManager.generateSpendProof(note.commitment, recipient);
      
      const isValid = noteManager.verifyProof(proof, note.commitment);
      expect(isValid).toBe(true);
    });
  });

  describe('storeNoteEncrypted', () => {
    it('should encrypt and decrypt note', () => {
      const amount = BigInt(1000000);
      const recipient = '0x123456789abcdef';
      
      const note = noteManager.generateNote(amount, recipient);
      const encrypted = noteManager.storeNoteEncrypted(note);
      
      expect(encrypted).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
      
      const decrypted = noteManager.retrieveNoteEncrypted(encrypted);
      
      expect(decrypted.amount).toBe(note.amount);
      expect(decrypted.recipient).toBe(note.recipient);
      expect(decrypted.secret).toBe(note.secret);
      expect(decrypted.commitment).toBe(note.commitment);
    });
  });

  describe('verifyNoteCommitment', () => {
    it('should verify valid note commitment', () => {
      const amount = BigInt(1000000);
      const recipient = '0x123456789abcdef';
      
      const note = noteManager.generateNote(amount, recipient);
      const isValid = noteManager.verifyNoteCommitment(note);
      
      expect(isValid).toBe(true);
    });

    it('should reject invalid note commitment', () => {
      const amount = BigInt(1000000);
      const recipient = '0x123456789abcdef';
      
      const note = noteManager.generateNote(amount, recipient);
      note.commitment = '0xdeadbeef' + '0'.repeat(56);
      
      const isValid = noteManager.verifyNoteCommitment(note);
      
      expect(isValid).toBe(false);
    });
  });

  describe('getCommitmentCount', () => {
    it('should return correct commitment count', () => {
      const initialCount = noteManager.getCommitmentCount();
      
      noteManager.generateNote(BigInt(1000), '0x123');
      noteManager.generateNote(BigInt(2000), '0x456');
      
      const newCount = noteManager.getCommitmentCount();
      
      expect(newCount).toBe(initialCount + 2);
    });
  });
});
