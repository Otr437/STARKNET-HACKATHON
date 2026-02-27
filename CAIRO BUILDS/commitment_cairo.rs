use core::pedersen::pedersen;
use core::poseidon::poseidon_hash_span;

#[derive(Drop, Copy, Serde)]
pub struct Commitment {
    pub value: felt252,
}

#[derive(Drop, Copy, Serde)]
pub struct CommitmentData {
    pub token: starknet::ContractAddress,
    pub amount: u256,
    pub secret: felt252,
    pub nullifier_secret: felt252,
}

pub fn compute_commitment(data: CommitmentData) -> felt252 {
    let amount_low: felt252 = data.amount.low.into();
    let amount_high: felt252 = data.amount.high.into();
    
    let inputs = array![
        data.token.into(),
        amount_low,
        amount_high,
        data.secret,
        data.nullifier_secret
    ];
    
    poseidon_hash_span(inputs.span())
}

pub fn compute_nullifier(secret: felt252, commitment: felt252, leaf_index: u32) -> felt252 {
    let inputs = array![
        secret,
        commitment,
        leaf_index.into()
    ];
    
    poseidon_hash_span(inputs.span())
}

pub fn verify_commitment(
    commitment: felt252,
    token: starknet::ContractAddress,
    amount: u256,
    secret: felt252,
    nullifier_secret: felt252
) -> bool {
    let data = CommitmentData {
        token,
        amount,
        secret,
        nullifier_secret
    };
    
    compute_commitment(data) == commitment
}