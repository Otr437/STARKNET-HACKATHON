pragma circom 2.1.6;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/comparators.circom";
include "node_modules/circomlib/circuits/bitify.circom";

/**
 * Semaphore Identity Circuit - February 2026
 * Proves group membership and generates nullifier without revealing identity
 */

template MerkleTreeInclusionProof(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal output root;
    
    component hashers[levels];
    component selectors[levels];
    
    for (var i = 0; i < levels; i++) {
        hashers[i] = Poseidon(2);
        selectors[i] = DualMux();
        
        selectors[i].in[0] <== i == 0 ? leaf : hashers[i-1].out;
        selectors[i].in[1] <== pathElements[i];
        selectors[i].s <== pathIndices[i];
        
        hashers[i].inputs[0] <== selectors[i].out[0];
        hashers[i].inputs[1] <== selectors[i].out[1];
    }
    
    root <== hashers[levels-1].out;
}

template DualMux() {
    signal input in[2];
    signal input s;
    signal output out[2];
    
    s * (1 - s) === 0;
    out[0] <== (in[1] - in[0]) * s + in[0];
    out[1] <== (in[0] - in[1]) * s + in[1];
}

template Semaphore(levels) {
    // Private inputs
    signal input identityNullifier;
    signal input identityTrapdoor;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    
    // Public inputs
    signal input externalNullifier;
    signal input signalHash;
    signal output merkleRoot;
    signal output nullifierHash;
    
    // Compute identity commitment
    component identityHasher = Poseidon(2);
    identityHasher.inputs[0] <== identityNullifier;
    identityHasher.inputs[1] <== identityTrapdoor;
    signal identityCommitment;
    identityCommitment <== identityHasher.out;
    
    // Prove membership in Merkle tree
    component merkleProof = MerkleTreeInclusionProof(levels);
    merkleProof.leaf <== identityCommitment;
    for (var i = 0; i < levels; i++) {
        merkleProof.pathElements[i] <== pathElements[i];
        merkleProof.pathIndices[i] <== pathIndices[i];
    }
    merkleRoot <== merkleProof.root;
    
    // Compute nullifier hash
    component nullifierHasher = Poseidon(2);
    nullifierHasher.inputs[0] <== externalNullifier;
    nullifierHasher.inputs[1] <== identityNullifier;
    nullifierHash <== nullifierHasher.out;
    
    // Verify signal hash (ensures signal matches)
    signal signalHashSquared;
    signalHashSquared <== signalHash * signalHash;
}

// Main component - 20 levels (supports 2^20 = 1M members)
component main {public [externalNullifier, signalHash]} = Semaphore(20);
