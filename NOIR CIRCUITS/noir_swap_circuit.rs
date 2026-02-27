// ============================================
// NOIR ZK CIRCUIT: ATOMIC SWAP PROOF
// circuits/atomic_swap.nr
// ============================================

use dep::std;

global MERKLE_DEPTH: u32 = 20;

// Prove valid atomic swap initiation
fn main(
    // Private inputs - Initiator's note
    initiator_amount: Field,
    initiator_recipient: Field,
    initiator_secret: Field,
    initiator_merkle_path: [Field; MERKLE_DEPTH],
    initiator_merkle_indices: [u1; MERKLE_DEPTH],
    
    // Private inputs - Swap details
    htlc_secret: Field,              // Secret for HTLC
    recipient_amount: Field,          // Amount for recipient
    recipient_address: Field,         // Recipient's address
    
    // Public inputs
    initiator_merkle_root: pub Field,
    initiator_nullifier: pub Field,
    initiator_commitment: pub Field,
    htlc_secret_hash: pub Field,
    recipient_commitment: pub Field,
    swap_id: pub Field,
) {
    // ============================================
    // STEP 1: Verify Initiator Can Spend Their Note
    // ============================================
    
    // Recompute initiator commitment
    let computed_initiator_commitment = std::hash::poseidon::bn254::hash_3([
        initiator_amount,
        initiator_recipient,
        initiator_secret
    ]);
    assert(computed_initiator_commitment == initiator_commitment);
    
    // Recompute initiator nullifier
    let computed_initiator_nullifier = std::hash::poseidon::bn254::hash_2([
        initiator_secret,
        initiator_recipient
    ]);
    assert(computed_initiator_nullifier == initiator_nullifier);
    
    // Verify initiator's Merkle proof
    let mut current_hash = initiator_commitment;
    for i in 0..MERKLE_DEPTH {
        let path_element = initiator_merkle_path[i];
        let is_right = initiator_merkle_indices[i];
        
        let (left, right) = if is_right == 0 {
            (current_hash, path_element)
        } else {
            (path_element, current_hash)
        };
        
        current_hash = std::hash::poseidon::bn254::hash_2([left, right]);
    }
    assert(current_hash == initiator_merkle_root);
    
    // ============================================
    // STEP 2: Verify HTLC Secret Hash
    // ============================================
    
    let computed_htlc_hash = std::hash::poseidon::bn254::hash_1([htlc_secret]);
    assert(computed_htlc_hash == htlc_secret_hash);
    
    // ============================================
    // STEP 3: Verify Recipient Commitment
    // ============================================
    
    // Generate secret for recipient's note
    let recipient_secret = std::hash::poseidon::bn254::hash_2([
        htlc_secret,
        recipient_address
    ]);
    
    // Compute recipient commitment
    let computed_recipient_commitment = std::hash::poseidon::bn254::hash_3([
        recipient_amount,
        recipient_address,
        recipient_secret
    ]);
    assert(computed_recipient_commitment == recipient_commitment);
    
    // ============================================
    // STEP 4: Verify Amount Conservation
    // ============================================
    
    // Ensure amounts match (no value created/destroyed)
    assert(initiator_amount == recipient_amount);
    
    // ============================================
    // STEP 5: Verify Swap ID
    // ============================================
    
    let computed_swap_id = std::hash::poseidon::bn254::hash_4([
        htlc_secret_hash,
        initiator_commitment,
        recipient_commitment,
        initiator_recipient
    ]);
    assert(computed_swap_id == swap_id);
}

// ============================================
// SWAP COMPLETION CIRCUIT
// ============================================

fn complete_swap(
    // Private inputs
    htlc_secret: Field,              // The revealed secret
    recipient_amount: Field,
    recipient_address: Field,
    
    // Public inputs
    htlc_secret_hash: pub Field,
    recipient_commitment: pub Field,
    recipient_nullifier: pub Field,
) {
    // ============================================
    // STEP 1: Verify Secret Reveals Hash
    // ============================================
    
    let computed_hash = std::hash::poseidon::bn254::hash_1([htlc_secret]);
    assert(computed_hash == htlc_secret_hash);
    
    // ============================================
    // STEP 2: Verify Recipient Can Claim
    // ============================================
    
    // Derive recipient's secret from HTLC secret
    let recipient_secret = std::hash::poseidon::bn254::hash_2([
        htlc_secret,
        recipient_address
    ]);
    
    // Verify commitment
    let computed_commitment = std::hash::poseidon::bn254::hash_3([
        recipient_amount,
        recipient_address,
        recipient_secret
    ]);
    assert(computed_commitment == recipient_commitment);
    
    // Verify nullifier
    let computed_nullifier = std::hash::poseidon::bn254::hash_2([
        recipient_secret,
        recipient_address
    ]);
    assert(computed_nullifier == recipient_nullifier);
}

// ============================================
// SWAP REFUND CIRCUIT
// ============================================

fn refund_swap(
    // Private inputs
    initiator_amount: Field,
    initiator_recipient: Field,
    initiator_secret: Field,
    timelock: Field,
    current_time: Field,
    
    // Public inputs
    initiator_commitment: pub Field,
    initiator_nullifier: pub Field,
    swap_id: pub Field,
) {
    // ============================================
    // STEP 1: Verify Timelock Expired
    // ============================================
    
    assert(current_time >= timelock);
    
    // ============================================
    // STEP 2: Verify Original Note Ownership
    // ============================================
    
    let computed_commitment = std::hash::poseidon::bn254::hash_3([
        initiator_amount,
        initiator_recipient,
        initiator_secret
    ]);
    assert(computed_commitment == initiator_commitment);
    
    let computed_nullifier = std::hash::poseidon::bn254::hash_2([
        initiator_secret,
        initiator_recipient
    ]);
    assert(computed_nullifier == initiator_nullifier);
}

// ============================================
// HELPER FUNCTIONS
// ============================================

fn hash_htlc_params(
    secret_hash: Field,
    amount: Field,
    recipient: Field,
    timelock: Field
) -> Field {
    std::hash::poseidon::bn254::hash_4([
        secret_hash,
        amount,
        recipient,
        timelock
    ])
}

fn verify_merkle_inclusion(
    leaf: Field,
    path: [Field; MERKLE_DEPTH],
    indices: [u1; MERKLE_DEPTH],
    root: Field
) -> bool {
    let mut current = leaf;
    for i in 0..MERKLE_DEPTH {
        let (left, right) = if indices[i] == 0 {
            (current, path[i])
        } else {
            (path[i], current)
        };
        current = std::hash::poseidon::bn254::hash_2([left, right]);
    }
    current == root
}

// ============================================
// TEST CASES
// ============================================

#[test]
fn test_valid_swap_initiation() {
    let initiator_amount = 1000;
    let initiator_recipient = 0x123;
    let initiator_secret = 0x456;
    let htlc_secret = 0x789;
    let recipient_amount = 1000;
    let recipient_address = 0xabc;
    
    let initiator_commitment = std::hash::poseidon::bn254::hash_3([
        initiator_amount,
        initiator_recipient,
        initiator_secret
    ]);
    
    let initiator_nullifier = std::hash::poseidon::bn254::hash_2([
        initiator_secret,
        initiator_recipient
    ]);
    
    let htlc_secret_hash = std::hash::poseidon::bn254::hash_1([htlc_secret]);
    
    let recipient_secret = std::hash::poseidon::bn254::hash_2([
        htlc_secret,
        recipient_address
    ]);
    
    let recipient_commitment = std::hash::poseidon::bn254::hash_3([
        recipient_amount,
        recipient_address,
        recipient_secret
    ]);
    
    let swap_id = std::hash::poseidon::bn254::hash_4([
        htlc_secret_hash,
        initiator_commitment,
        recipient_commitment,
        initiator_recipient
    ]);
    
    let merkle_path = [0; MERKLE_DEPTH];
    let merkle_indices = [0; MERKLE_DEPTH];
    let merkle_root = initiator_commitment;
    
    main(
        initiator_amount,
        initiator_recipient,
        initiator_secret,
        merkle_path,
        merkle_indices,
        htlc_secret,
        recipient_amount,
        recipient_address,
        merkle_root,
        initiator_nullifier,
        initiator_commitment,
        htlc_secret_hash,
        recipient_commitment,
        swap_id
    );
}

#[test]
fn test_valid_swap_completion() {
    let htlc_secret = 0x789;
    let recipient_amount = 1000;
    let recipient_address = 0xabc;
    
    let htlc_secret_hash = std::hash::poseidon::bn254::hash_1([htlc_secret]);
    
    let recipient_secret = std::hash::poseidon::bn254::hash_2([
        htlc_secret,
        recipient_address
    ]);
    
    let recipient_commitment = std::hash::poseidon::bn254::hash_3([
        recipient_amount,
        recipient_address,
        recipient_secret
    ]);
    
    let recipient_nullifier = std::hash::poseidon::bn254::hash_2([
        recipient_secret,
        recipient_address
    ]);
    
    complete_swap(
        htlc_secret,
        recipient_amount,
        recipient_address,
        htlc_secret_hash,
        recipient_commitment,
        recipient_nullifier
    );
}