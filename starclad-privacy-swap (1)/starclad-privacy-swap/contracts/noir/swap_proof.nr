// COMPLETE NOIR ATOMIC SWAP PROOF CIRCUIT
// Proves valid atomic swap with HTLC secret reveal

use dep::std;

global MERKLE_TREE_DEPTH: u32 = 20;

fn main(
    // Private inputs - initiator note
    initiator_amount: Field,
    initiator_secret: Field,
    initiator_address: pub Field,
    
    // Private inputs - recipient note
    recipient_amount: Field,
    recipient_secret: Field,
    recipient_address: pub Field,
    
    // HTLC secret
    htlc_secret: Field,
    htlc_secret_hash: pub Field,
    
    // Merkle proofs
    merkle_root: pub Field,
    initiator_merkle_path: [Field; 20],
    initiator_merkle_indices: [u1; 20],
    recipient_merkle_path: [Field; 20],
    recipient_merkle_indices: [u1; 20],
    
    // Public outputs
    initiator_nullifier: pub Field,
    recipient_nullifier: pub Field,
    initiator_commitment: pub Field,
    recipient_commitment: pub Field,
) {
    // 1. Verify amounts match
    assert(initiator_amount == recipient_amount);
    
    // 2. Verify HTLC secret hash
    let computed_htlc_hash = poseidon1([htlc_secret]);
    assert(computed_htlc_hash == htlc_secret_hash);
    
    // 3. Verify initiator commitment
    let computed_initiator_commitment = poseidon3([
        initiator_amount,
        initiator_address,
        initiator_secret
    ]);
    assert(computed_initiator_commitment == initiator_commitment);
    
    // 4. Verify initiator nullifier
    let computed_initiator_nullifier = poseidon2([
        initiator_secret,
        initiator_address
    ]);
    assert(computed_initiator_nullifier == initiator_nullifier);
    
    // 5. Verify initiator merkle proof
    verify_merkle_proof(
        initiator_commitment,
        merkle_root,
        initiator_merkle_path,
        initiator_merkle_indices
    );
    
    // 6. Verify recipient commitment
    let computed_recipient_commitment = poseidon3([
        recipient_amount,
        recipient_address,
        recipient_secret
    ]);
    assert(computed_recipient_commitment == recipient_commitment);
    
    // 7. Verify recipient nullifier
    let computed_recipient_nullifier = poseidon2([
        recipient_secret,
        recipient_address
    ]);
    assert(computed_recipient_nullifier == recipient_nullifier);
    
    // 8. Verify recipient merkle proof
    verify_merkle_proof(
        recipient_commitment,
        merkle_root,
        recipient_merkle_path,
        recipient_merkle_indices
    );
    
    // 9. Range checks
    assert(initiator_amount < 21000000 * 100000000);
    assert(recipient_amount < 21000000 * 100000000);
}

fn verify_merkle_proof(
    leaf: Field,
    root: Field,
    path: [Field; 20],
    indices: [u1; 20]
) {
    let mut current_hash = leaf;
    
    for i in 0..MERKLE_TREE_DEPTH {
        let path_element = path[i];
        let is_right = indices[i];
        
        if is_right == 0 {
            current_hash = poseidon2([current_hash, path_element]);
        } else {
            current_hash = poseidon2([path_element, current_hash]);
        }
    }
    
    assert(current_hash == root);
}

fn poseidon1(inputs: [Field; 1]) -> Field {
    std::hash::poseidon::bn254::hash_1(inputs)
}

fn poseidon2(inputs: [Field; 2]) -> Field {
    std::hash::poseidon::bn254::hash_2(inputs)
}

fn poseidon3(inputs: [Field; 3]) -> Field {
    std::hash::poseidon::bn254::hash_3(inputs)
}

#[test]
fn test_swap_proof() {
    // Test atomic swap proof
    let amount = 5000000;
    let initiator_secret = 111111;
    let recipient_secret = 222222;
    let htlc_secret = 333333;
    
    let initiator_address = 777777;
    let recipient_address = 888888;
    
    let htlc_secret_hash = poseidon1([htlc_secret]);
    
    let initiator_commitment = poseidon3([amount, initiator_address, initiator_secret]);
    let recipient_commitment = poseidon3([amount, recipient_address, recipient_secret]);
    
    let initiator_nullifier = poseidon2([initiator_secret, initiator_address]);
    let recipient_nullifier = poseidon2([recipient_secret, recipient_address]);
    
    let merkle_path = [0; 20];
    let merkle_indices = [0; 20];
    let merkle_root = initiator_commitment;
    
    main(
        amount,
        initiator_secret,
        initiator_address,
        amount,
        recipient_secret,
        recipient_address,
        htlc_secret,
        htlc_secret_hash,
        merkle_root,
        merkle_path,
        merkle_indices,
        merkle_path,
        merkle_indices,
        initiator_nullifier,
        recipient_nullifier,
        initiator_commitment,
        recipient_commitment
    );
}
