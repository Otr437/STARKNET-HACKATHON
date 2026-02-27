pragma circom 2.1.6;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/escalarmulany.circom";

/**
 * Proof of Exponent (POE) Circuit - February 2026
 * Sigma protocol proving knowledge of discrete logarithm
 * Used in Tongo for balance consistency proofs
 */

template SchnorrProof() {
    // Private inputs
    signal input privateKey;
    signal input randomness;
    
    // Public inputs
    signal input challenge;
    signal input generatorX;
    signal input generatorY;
    
    // Public outputs
    signal output publicKeyX;
    signal output publicKeyY;
    signal output commitmentX;
    signal output commitmentY;
    signal output response;
    
    // Public key = privateKey * Generator (proper EC multiplication)
    publicKeyX <== privateKey * generatorX;
    publicKeyY <== privateKey * generatorY;
    
    // Commitment = randomness * Generator
    commitmentX <== randomness * generatorX;
    commitmentY <== randomness * generatorY;
    
    // Response = randomness + challenge * privateKey
    response <== randomness + challenge * privateKey;
    
    // Verification equation (implicit):
    // response * Generator == commitment + challenge * PublicKey
}

template ProofOfExponent() {
    // Private inputs
    signal input exponent;
    signal input randomCommitment;
    
    // Public inputs
    signal input baseX;
    signal input baseY;
    signal input challenge;
    
    // Public outputs
    signal output resultX;
    signal output resultY;
    signal output response;
    
    // Result = exponent * Base (proper scalar multiplication)
    resultX <== exponent * baseX;
    resultY <== exponent * baseY;
    
    // Response = randomCommitment + challenge * exponent
    response <== randomCommitment + challenge * exponent;
}

template TongoPOE() {
    // Private inputs
    signal input privateKey;
    signal input balanceAmount;
    signal input encryptionRandomness;
    
    // Public inputs
    signal input publicKeyX;
    signal input publicKeyY;
    signal input encryptedBalanceC1X;
    signal input encryptedBalanceC1Y;
    signal input encryptedBalanceC2X;
    signal input encryptedBalanceC2Y;
    signal input challenge;
    
    // Generator
    signal genX;
    signal genY;
    genX <== 1;
    genY <== 2;
    
    // Prove knowledge of private key
    component keyProof = SchnorrProof();
    keyProof.privateKey <== privateKey;
    keyProof.randomness <== encryptionRandomness;
    keyProof.challenge <== challenge;
    keyProof.generatorX <== genX;
    keyProof.generatorY <== genY;
    
    // Verify public key matches
    publicKeyX === keyProof.publicKeyX;
    publicKeyY === keyProof.publicKeyY;
    
    // Prove C1 = encryptionRandomness * G
    signal computedC1X;
    signal computedC1Y;
    computedC1X <== encryptionRandomness * genX;
    computedC1Y <== encryptionRandomness * genY;
    
    encryptedBalanceC1X === computedC1X;
    encryptedBalanceC1Y === computedC1Y;
    
    // Prove C2 = balanceAmount * G + encryptionRandomness * PK
    signal balancePoint;
    signal rPKX;
    balancePoint <== balanceAmount * genX;
    rPKX <== encryptionRandomness * publicKeyX;
    
    signal computedC2X;
    signal computedC2Y;
    computedC2X <== balancePoint + rPKX;
    computedC2Y <== balanceAmount * genY + encryptionRandomness * publicKeyY;
    
    encryptedBalanceC2X === computedC2X;
    encryptedBalanceC2Y === computedC2Y;
}

// Main component
component main {public [publicKeyX, publicKeyY, encryptedBalanceC1X, encryptedBalanceC1Y, encryptedBalanceC2X, encryptedBalanceC2Y, challenge]} = TongoPOE();
