// ============================================================
//  Shielded RWA Deposit Circuit
//  Noir 0.36.0 — Poseidon2 hash
//
//  Proves a note commitment is valid without revealing:
//  - Who is depositing
//  - The secret
//
//  Public outputs only: commitment + nullifier
//  These go on-chain; nothing else does.
// ============================================================

use dep::std;

fn main(
    // ── Private inputs (never leave the browser) ───────────
    secret:          Field,   // random 248-bit scalar
    asset_id:        Field,   // felt252 of asset symbol
    amount:          Field,   // amount * 10^decimals

    // ── Public outputs (go on-chain) ───────────────────────
    note_commitment: pub Field,
    nullifier:       pub Field
) {
    // 1. Validate private inputs
    assert(secret != 0,   "secret must not be zero");
    assert(amount > 0,    "amount must be positive");
    assert(asset_id != 0, "asset_id must not be zero");

    // 2. Compute and assert note commitment
    //    commitment = Poseidon2(secret || asset_id || amount)
    let computed_commitment = std::hash::poseidon2::Poseidon2::hash(
        [secret, asset_id, amount], 3
    );
    assert(note_commitment == computed_commitment,
        "commitment does not match private inputs");

    // 3. Compute and assert nullifier
    //    nullifier = Poseidon2(secret || asset_id)
    //    Binds the nullifier to the asset but NOT to the amount,
    //    so partial-amount withdrawals cannot re-use the nullifier.
    let computed_nullifier = std::hash::poseidon2::Poseidon2::hash(
        [secret, asset_id], 2
    );
    assert(nullifier == computed_nullifier,
        "nullifier does not match private inputs");
}
