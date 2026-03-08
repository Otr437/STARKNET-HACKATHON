// ============================================================
//  Shielded RWA Withdrawal Circuit
//  Noir 0.36.0 — Poseidon2 hash, depth-20 Merkle tree
//
//  Proves all of the following WITHOUT revealing which note:
//  1. The prover knows (secret, asset_id, amount)
//  2. Poseidon2(secret, asset_id, amount) is a leaf in the tree
//  3. The nullifier is correctly derived from the secret
//
//  Public inputs: merkle_root, nullifier, destination, amount
// ============================================================

use dep::std;

global TREE_DEPTH: u32 = 20;

fn main(
    // ── Private inputs ─────────────────────────────────────
    secret:       Field,
    asset_id:     Field,
    amount:       Field,
    merkle_path:  [Field; TREE_DEPTH],
    path_indices: [Field; TREE_DEPTH],   // 0 = left, 1 = right

    // ── Public inputs ──────────────────────────────────────
    merkle_root:  pub Field,
    nullifier:    pub Field,
    destination:  pub Field,             // StarkNet address as Field
    pub_amount:   pub Field              // amount exposed so bridge can settle
) {
    // 1. Validate
    assert(secret != 0,   "secret must not be zero");
    assert(amount > 0,    "amount must be positive");
    assert(asset_id != 0, "asset_id must not be zero");
    assert(amount == pub_amount, "public amount must match private amount");

    // 2. Recompute the note commitment
    let note_commitment = std::hash::poseidon2::Poseidon2::hash(
        [secret, asset_id, amount], 3
    );

    // 3. Walk the Merkle path and verify the leaf exists in the tree
    let mut current = note_commitment;
    for i in 0..TREE_DEPTH {
        let sibling   = merkle_path[i];
        let is_right  = path_indices[i];

        // is_right == 0  →  current is the left child
        // is_right == 1  →  current is the right child
        if is_right == 0 {
            current = std::hash::poseidon2::Poseidon2::hash([current, sibling], 2);
        } else {
            current = std::hash::poseidon2::Poseidon2::hash([sibling, current], 2);
        }
    }
    assert(current == merkle_root, "Merkle proof invalid — note not in tree");

    // 4. Verify nullifier (prevents double-spend)
    let computed_nullifier = std::hash::poseidon2::Poseidon2::hash(
        [secret, asset_id], 2
    );
    assert(nullifier == computed_nullifier, "nullifier mismatch");

    // 5. Bind destination so proof cannot be re-submitted to a different address
    assert(destination != 0, "destination must not be zero");
    // destination is a public input — the contract checks it matches msg.sender
}
