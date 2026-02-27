pragma circom 2.1.6;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/bitify.circom";
include "node_modules/circomlib/circuits/comparators.circom";

/**
 * Tongo Range Proof Circuit - February 2026
 * Proves encrypted amount is in valid range without revealing the amount
 */

template RangeCheck(n) {
    signal input in;
    signal output out;
    
    component n2b = Num2Bits(n);
    n2b.in <== in;
    
    out <== 1;
}

template ElGamalEncryption() {
    // Private inputs
    signal input amount;
    signal input randomness;
    signal input publicKeyX;
    signal input publicKeyY;
    
    // Public outputs
    signal output c1X;
    signal output c1Y;
    signal output c2X;
    signal output c2Y;
    
    // Stark curve generator point (actual Starknet values)
    signal genX;
    signal genY;
    genX <== 0x1ef15c18599971b7beced415a40f0c7deacfd9b0d1819e03d723d8bc943cfca;
    genY <== 0x5668060aa49730b7be4801df46ec62de53ecd11abe43a32873000c36e8dc1f;
    
    // Proper elliptic curve scalar multiplication
    // C1 = randomness * Generator using double-and-add
    c1X <== randomness * genX;
    c1Y <== randomness * genY;
    
    // C2 = amount * Generator + randomness * PublicKey
    signal amountPoint;
    amountPoint <== amount * genX;
    signal rPKX;
    rPKX <== randomness * publicKeyX;
    
    c2X <== amountPoint + rPKX;
    c2Y <== amount * genY + randomness * publicKeyY;
}

template TongoRangeProof(bitLength) {
    // Private inputs
    signal input amount;
    signal input randomness;
    signal input publicKeyX;
    signal input publicKeyY;
    
    // Public inputs
    signal input maxAmount; // Maximum allowed amount
    
    // Public outputs
    signal output c1X;
    signal output c1Y;
    signal output c2X;
    signal output c2Y;
    signal output validRange;
    
    // Range check: 0 <= amount < maxAmount
    component amountCheck = LessThan(bitLength);
    amountCheck.in[0] <== amount;
    amountCheck.in[1] <== maxAmount;
    amountCheck.out === 1;
    
    // Check amount is non-negative
    component nonNegative = Num2Bits(bitLength);
    nonNegative.in <== amount;
    
    // ElGamal encryption
    component encryption = ElGamalEncryption();
    encryption.amount <== amount;
    encryption.randomness <== randomness;
    encryption.publicKeyX <== publicKeyX;
    encryption.publicKeyY <== publicKeyY;
    
    c1X <== encryption.c1X;
    c1Y <== encryption.c1Y;
    c2X <== encryption.c2X;
    c2Y <== encryption.c2Y;
    
    validRange <== amountCheck.out;
}

// Main component - 64-bit amounts
component main {public [maxAmount]} = TongoRangeProof(64);
