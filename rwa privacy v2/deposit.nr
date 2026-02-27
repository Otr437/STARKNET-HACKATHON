// Shielded RWA Deposit Circuit
// Proves validity without revealing who deposited

use dep::std;

fn main(
    // Private inputs
    secret: Field,
    asset_id: Field,
    amount: Field,
    
    // Public outputs
    note_commitment: pub Field,
    nullifier: pub Field
) {
    // Create note commitment
    let computed_commitment = std::hash::poseidon2::Poseidon2::hash([
        secret,
        asset_id,
        amount
    ], 3);
    
    assert(note_commitment == computed_commitment);
    
    // Create nullifier (prevents double-spend)
    let computed_nullifier = std::hash::poseidon2::Poseidon2::hash([
        secret,
        asset_id
    ], 2);
    
    assert(nullifier == computed_nullifier);
    
    // Validate inputs
    assert(amount > 0);
    assert(secret != 0);
}
