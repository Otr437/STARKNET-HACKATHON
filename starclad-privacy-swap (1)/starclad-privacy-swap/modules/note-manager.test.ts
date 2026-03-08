/**
 * Tests: NoteCommitmentManager + PoseidonHasher
 */
import { PoseidonHasher } from '../modules/poseidon';
import { SecureKeyManager } from '../modules/encryption';
import { NoteCommitmentManager } from '../modules/note-manager';

let hasher: PoseidonHasher;
let km: SecureKeyManager;
let manager: NoteCommitmentManager;

beforeAll(async () => {
  hasher = new PoseidonHasher();
  await hasher.initialize();
  km = new SecureKeyManager('test_master_password_32_chars_min!!', './test_secure/salt.bin');
  manager = new NoteCommitmentManager(hasher, km);
});

afterAll(() => {
  km.destroy();
});

describe('PoseidonHasher', () => {
  test('hash2 is deterministic', () => {
    const a = 12345n, b = 67890n;
    expect(hasher.hash2(a, b)).toBe(hasher.hash2(a, b));
  });

  test('commitment + nullifier verify correctly', () => {
    const amount = 1_000_000n;
    const recipient = BigInt('0x1234567890abcdef');
    const secret = BigInt('0xdeadbeef12345678');
    const commitment = hasher.createCommitment(amount, recipient, secret);
    const nullifier = hasher.createNullifier(secret, recipient);
    expect(hasher.verifyCommitment(commitment, amount, recipient, secret)).toBe(true);
    expect(hasher.verifyNullifier(nullifier, secret, recipient)).toBe(true);
  });

  test('toFelt252 roundtrip', () => {
    const v = 99999999999999999n;
    expect(hasher.fromFelt252(hasher.toFelt252(v))).toBe(v);
  });
});

describe('NoteCommitmentManager', () => {
  test('generates valid note', () => {
    const note = manager.generateNote(500_000n, '0x' + 'ab'.repeat(32));
    expect(note.commitment).toMatch(/^0x[0-9a-f]{64}$/);
    expect(note.nullifier).toMatch(/^0x[0-9a-f]{64}$/);
    expect(note.spent).toBe(false);
  });

  test('merkle root is hex string', () => {
    manager.generateNote(1n, '0x' + '01'.repeat(32));
    const root = manager.buildMerkleTree();
    expect(root).toMatch(/^0x[0-9a-f]+$/);
  });

  test('commitment count increments', () => {
    const before = manager.getCommitmentCount();
    manager.generateNote(1n, '0x' + '02'.repeat(32));
    expect(manager.getCommitmentCount()).toBe(before + 1);
  });

  test('spend proof generation', () => {
    const addr = '0x' + '03'.repeat(32);
    const note = manager.generateNote(1_000n, addr);
    const proof = manager.generateSpendProof(note.commitment, addr);
    expect(proof.nullifier).toBe(note.nullifier);
    expect(proof.proof_elements).toBeInstanceOf(Array);
    expect(proof.signature).toHaveLength(2);
  });

  test('cannot spend twice', () => {
    const addr = '0x' + '04'.repeat(32);
    const note = manager.generateNote(1_000n, addr);
    manager.generateSpendProof(note.commitment, addr);
    // mark as spent manually via nullifier set trick
    (manager as any).nullifiers.add(note.nullifier);
    expect(() => manager.generateSpendProof(note.commitment, addr)).toThrow('Nullifier already used');
  });

  test('wrong spender rejected', () => {
    const addr = '0x' + '05'.repeat(32);
    const note = manager.generateNote(1_000n, addr);
    expect(() => manager.generateSpendProof(note.commitment, '0x' + '06'.repeat(32))).toThrow('Unauthorized');
  });

  test('encrypted note roundtrip', () => {
    const note = manager.generateNote(42n, '0x' + '07'.repeat(32));
    const enc = manager.storeNoteEncrypted(note);
    const dec = manager.retrieveNoteEncrypted(enc);
    expect(dec.commitment).toBe(note.commitment);
    expect(dec.amount).toBe(42n);
  });

  test('stats returns valid shape', () => {
    const stats = manager.getStats();
    expect(typeof stats.totalNotes).toBe('number');
    expect(typeof stats.totalValue).toBe('string');
  });
});
