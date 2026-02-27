// ============================================
// NOIR ZK CIRCUIT: RANGE PROOF
// circuits/range_proof.nr
// ============================================

use dep::std;

// Number of bits for range proof (64 bits = u64)
global RANGE_BITS: u32 = 64;

// Main proving function for range proofs
fn main(
    // Private inputs
    amount: Field,          // The hidden amount
    blinding_factor: Field, // Random blinding for commitment
    
    // Public inputs
    amount_commitment: pub Field,  // Commitment to amount
    min_value: pub Field,          // Minimum allowed value
    max_value: pub Field,          // Maximum allowed value
) {
    // ============================================
    // STEP 1: Verify Amount Commitment
    // ============================================
    
    // Recompute commitment: Poseidon(amount, blinding_factor)
    let computed_commitment = std::hash::poseidon::bn254::hash_2([
        amount,
        blinding_factor
    ]);
    
    assert(computed_commitment == amount_commitment);
    
    // ============================================
    // STEP 2: Range Check (min <= amount <= max)
    // ============================================
    
    // Convert to u64 for comparison
    let amount_u64 = amount as u64;
    let min_u64 = min_value as u64;
    let max_u64 = max_value as u64;
    
    // Check lower bound
    assert(amount_u64 >= min_u64);
    
    // Check upper bound
    assert(amount_u64 <= max_u64);
    
    // ============================================
    // STEP 3: Bit Decomposition (prove in range)
    // ============================================
    
    // Decompose amount into bits
    let amount_bits = amount.to_le_bits(RANGE_BITS);
    
    // Verify each bit is 0 or 1
    for i in 0..RANGE_BITS {
        let bit = amount_bits[i];
        assert((bit == 0) | (bit == 1));
    }
    
    // Reconstruct amount from bits to verify decomposition
    let mut reconstructed: Field = 0;
    let mut power: Field = 1;
    
    for i in 0..RANGE_BITS {
        if amount_bits[i] == 1 {
            reconstructed = reconstructed + power;
        }
        power = power * 2;
    }
    
    assert(reconstructed == amount);
}

// ============================================
// PEDERSEN COMMITMENT VARIANT
// ============================================

fn main_pedersen(
    // Private inputs
    amount: Field,
    blinding_factor: Field,
    
    // Public inputs
    commitment: pub Field,
    min_value: pub Field,
    max_value: pub Field,
    generator_g: pub Field,  // Generator point for amount
    generator_h: pub Field,  // Generator point for blinding
) {
    // Pedersen commitment: C = amount*G + blinding*H
    let computed_commitment = pedersen_commit(amount, blinding_factor, generator_g, generator_h);
    assert(computed_commitment == commitment);
    
    // Range check
    let amount_u64 = amount as u64;
    assert(amount_u64 >= min_value as u64);
    assert(amount_u64 <= max_value as u64);
}

// ============================================
// HELPER FUNCTIONS
// ============================================

// Compute Pedersen commitment
fn pedersen_commit(
    amount: Field,
    blinding: Field,
    g: Field,
    h: Field
) -> Field {
    // Simplified - in production use elliptic curve operations
    std::hash::poseidon::bn254::hash_3([amount, blinding, g + h])
}

// Check if value is a power of 2
fn is_power_of_two(value: Field) -> bool {
    let v = value as u64;
    (v != 0) & ((v & (v - 1)) == 0)
}

// Compute commitment with Poseidon
fn compute_amount_commitment(amount: Field, blinding: Field) -> Field {
    std::hash::poseidon::bn254::hash_2([amount, blinding])
}

// ============================================
// TEST CASES
// ============================================

#[test]
fn test_valid_range_proof() {
    let amount = 5000;
    let blinding = 0x123456789;
    let min_value = 100;
    let max_value = 10000;
    
    let commitment = compute_amount_commitment(amount, blinding);
    
    main(amount, blinding, commitment, min_value, max_value);
}

#[test(should_fail)]
fn test_amount_too_low() {
    let amount = 50;  // Below min
    let blinding = 0x123456789;
    let min_value = 100;
    let max_value = 10000;
    
    let commitment = compute_amount_commitment(amount, blinding);
    
    main(amount, blinding, commitment, min_value, max_value);
}

#[test(should_fail)]
fn test_amount_too_high() {
    let amount = 20000;  // Above max
    let blinding = 0x123456789;
    let min_value = 100;
    let max_value = 10000;
    
    let commitment = compute_amount_commitment(amount, blinding);
    
    main(amount, blinding, commitment, min_value, max_value);
}

#[test(should_fail)]
fn test_invalid_commitment() {
    let amount = 5000;
    let blinding = 0x123456789;
    let min_value = 100;
    let max_value = 10000;
    
    let wrong_commitment = 0x999999;  // Invalid
    
    main(amount, blinding, wrong_commitment, min_value, max_value);
}