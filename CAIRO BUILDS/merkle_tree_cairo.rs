use core::poseidon::poseidon_hash_span;

const TREE_HEIGHT: u32 = 20;
const MAX_LEAVES: u32 = 1048576; // 2^20

#[derive(Drop, Copy, Serde)]
pub struct MerkleProof {
    pub path_elements: Span<felt252>,
    pub path_indices: Span<u32>,
}

pub fn compute_merkle_root(leaf: felt252, proof: MerkleProof) -> felt252 {
    let mut current = leaf;
    let mut i: u32 = 0;
    
    loop {
        if i >= proof.path_elements.len() {
            break;
        }
        
        let path_element = *proof.path_elements.at(i);
        let is_right = *proof.path_indices.at(i) == 1;
        
        if is_right {
            current = hash_pair(path_element, current);
        } else {
            current = hash_pair(current, path_element);
        }
        
        i += 1;
    };
    
    current
}

pub fn hash_pair(left: felt252, right: felt252) -> felt252 {
    let inputs = array![left, right];
    poseidon_hash_span(inputs.span())
}

pub fn verify_merkle_proof(
    leaf: felt252,
    root: felt252,
    proof: MerkleProof
) -> bool {
    compute_merkle_root(leaf, proof) == root
}

pub fn get_zero_hash(level: u32) -> felt252 {
    if level == 0 {
        return 0;
    }
    
    let prev = get_zero_hash(level - 1);
    hash_pair(prev, prev)
}