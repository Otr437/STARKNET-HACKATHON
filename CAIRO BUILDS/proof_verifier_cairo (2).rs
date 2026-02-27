use starknet::ContractAddress;
use super::merkle_tree::{verify_merkle_proof, MerkleProof};
use super::commitment::{compute_nullifier, verify_commitment};

#[derive(Drop, Serde)]
pub struct SwapProof {
    pub merkle_proof: MerkleProof,
    pub old_commitment: felt252,
    pub new_commitment: felt252,
    pub nullifier: felt252,
    pub token_in: ContractAddress,
    pub token_out: ContractAddress,
    pub amount_in: u256,
    pub amount_out: u256,
    pub secret: felt252,
    pub nullifier_secret: felt252,
    pub leaf_index: u32,
}

#[derive(Drop, Serde)]
pub struct WithdrawalProof {
    pub merkle_proof: MerkleProof,
    pub commitment: felt252,
    pub nullifier: felt252,
    pub token: ContractAddress,
    pub amount: u256,
    pub recipient: ContractAddress,
    pub secret: felt252,
    pub nullifier_secret: felt252,
    pub leaf_index: u32,
}

pub fn verify_swap_proof(
    proof: SwapProof,
    merkle_root: felt252
) -> bool {
    // Verify merkle proof
    if !verify_merkle_proof(proof.old_commitment, merkle_root, proof.merkle_proof) {
        return false;
    }
    
    // Verify old commitment
    if !verify_commitment(
        proof.old_commitment,
        proof.token_in,
        proof.amount_in,
        proof.secret,
        proof.nullifier_secret
    ) {
        return false;
    }
    
    // Verify nullifier
    let computed_nullifier = compute_nullifier(
        proof.nullifier_secret,
        proof.old_commitment,
        proof.leaf_index
    );
    
    if computed_nullifier != proof.nullifier {
        return false;
    }
    
    // Verify new commitment structure
    if !verify_commitment(
        proof.new_commitment,
        proof.token_out,
        proof.amount_out,
        proof.secret,
        proof.nullifier_secret
    ) {
        return false;
    }
    
    true
}

pub fn verify_withdrawal_proof(
    proof: WithdrawalProof,
    merkle_root: felt252
) -> bool {
    // Verify merkle proof
    if !verify_merkle_proof(proof.commitment, merkle_root, proof.merkle_proof) {
        return false;
    }
    
    // Verify commitment
    if !verify_commitment(
        proof.commitment,
        proof.token,
        proof.amount,
        proof.secret,
        proof.nullifier_secret
    ) {
        return false;
    }
    
    // Verify nullifier
    let computed_nullifier = compute_nullifier(
        proof.nullifier_secret,
        proof.commitment,
        proof.leaf_index
    );
    
    if computed_nullifier != proof.nullifier {
        return false;
    }
    
    true
}