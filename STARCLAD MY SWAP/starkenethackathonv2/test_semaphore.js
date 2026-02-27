#!/usr/bin/env node
/**
 * Semaphore Proof Generation and Verification Test - February 2026
 * Production script for testing zero-knowledge proofs
 */

const snarkjs = require("snarkjs");
const fs = require("fs");
const { poseidon } = require("circomlibjs");

async function testSemaphore() {
    console.log("=".repeat(60));
    console.log("SEMAPHORE PROOF GENERATION TEST");
    console.log("=".repeat(60));
    
    // Step 1: Generate identity
    console.log("\n[Step 1] Generating identity...");
    
    const identityNullifier = BigInt("0x" + Buffer.from("alice_nullifier").toString("hex"));
    const identityTrapdoor = BigInt("0x" + Buffer.from("alice_trapdoor").toString("hex"));
    
    // Compute identity commitment using Poseidon
    const identityCommitment = poseidon([identityNullifier, identityTrapdoor]);
    
    console.log("Identity Nullifier:", identityNullifier.toString());
    console.log("Identity Trapdoor:", identityTrapdoor.toString());
    console.log("Identity Commitment:", identityCommitment.toString());
    
    // Step 2: Build Merkle tree
    console.log("\n[Step 2] Building Merkle tree...");
    
    const members = [
        identityCommitment,
        poseidon([BigInt(111), BigInt(222)]),
        poseidon([BigInt(333), BigInt(444)]),
    ];
    
    const tree = buildMerkleTree(members, 20);
    const memberIndex = 0; // Alice is first member
    const merkleProof = getMerkleProof(tree, memberIndex);
    
    console.log("Group size:", members.length);
    console.log("Merkle root:", tree[tree.length - 1][0].toString());
    console.log("Member index:", memberIndex);
    
    // Step 3: Prepare signal
    console.log("\n[Step 3] Preparing signal...");
    
    const signal = "YES"; // Vote
    const externalNullifier = BigInt("0x" + Buffer.from("proposal_42").toString("hex"));
    const signalHash = poseidon([BigInt("0x" + Buffer.from(signal).toString("hex"))]);
    
    console.log("Signal:", signal);
    console.log("External Nullifier:", externalNullifier.toString());
    console.log("Signal Hash:", signalHash.toString());
    
    // Step 4: Compute nullifier hash
    const nullifierHash = poseidon([externalNullifier, identityNullifier]);
    console.log("Nullifier Hash:", nullifierHash.toString());
    
    // Step 5: Generate proof
    console.log("\n[Step 4] Generating zero-knowledge proof...");
    
    const input = {
        identityNullifier: identityNullifier.toString(),
        identityTrapdoor: identityTrapdoor.toString(),
        pathElements: merkleProof.pathElements.map(x => x.toString()),
        pathIndices: merkleProof.pathIndices.map(x => x.toString()),
        externalNullifier: externalNullifier.toString(),
        signalHash: signalHash.toString(),
    };
    
    // Save input
    fs.writeFileSync(
        "build/semaphore/input.json",
        JSON.stringify(input, null, 2)
    );
    
    console.log("Input saved to build/semaphore/input.json");
    
    // Generate witness
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        input,
        "build/semaphore/semaphore_js/semaphore.wasm",
        "build/semaphore/semaphore_final.zkey"
    );
    
    console.log("\nProof generated!");
    console.log("Public signals:");
    console.log("  Merkle Root:", publicSignals[0]);
    console.log("  Nullifier Hash:", publicSignals[1]);
    
    // Save proof
    fs.writeFileSync(
        "build/semaphore/proof.json",
        JSON.stringify(proof, null, 2)
    );
    
    fs.writeFileSync(
        "build/semaphore/public.json",
        JSON.stringify(publicSignals, null, 2)
    );
    
    console.log("\nProof saved to build/semaphore/proof.json");
    
    // Step 5: Verify proof
    console.log("\n[Step 5] Verifying proof...");
    
    const vKey = JSON.parse(
        fs.readFileSync("build/semaphore/verification_key.json")
    );
    
    const verified = await snarkjs.groth16.verify(vKey, publicSignals, proof);
    
    console.log("\nVerification result:", verified ? "✓ VALID" : "✗ INVALID");
    
    if (verified) {
        console.log("\n" + "=".repeat(60));
        console.log("SUCCESS! Semaphore proof is valid!");
        console.log("=".repeat(60));
        console.log("\nProof Properties:");
        console.log("  - Group membership proven without revealing identity");
        console.log("  - Signal authenticated anonymously");
        console.log("  - Double-signaling prevented via nullifier");
        console.log("  - Zero-knowledge: verifier learns nothing about prover");
        console.log("=".repeat(60));
    }
    
    return verified;
}

function buildMerkleTree(leaves, depth) {
    // Pad leaves to power of 2
    const treeSize = 2 ** depth;
    const paddedLeaves = [...leaves];
    while (paddedLeaves.length < treeSize) {
        paddedLeaves.push(BigInt(0));
    }
    
    // Build tree bottom-up
    const tree = [paddedLeaves];
    
    for (let level = 0; level < depth; level++) {
        const currentLevel = tree[level];
        const nextLevel = [];
        
        for (let i = 0; i < currentLevel.length; i += 2) {
            const left = currentLevel[i];
            const right = currentLevel[i + 1];
            const parent = poseidon([left, right]);
            nextLevel.push(parent);
        }
        
        tree.push(nextLevel);
    }
    
    return tree;
}

function getMerkleProof(tree, leafIndex) {
    const pathElements = [];
    const pathIndices = [];
    
    let index = leafIndex;
    
    for (let level = 0; level < tree.length - 1; level++) {
        const isLeft = index % 2 === 0;
        const siblingIndex = isLeft ? index + 1 : index - 1;
        
        pathElements.push(tree[level][siblingIndex]);
        pathIndices.push(isLeft ? 0 : 1);
        
        index = Math.floor(index / 2);
    }
    
    return { pathElements, pathIndices };
}

// Run test
if (require.main === module) {
    testSemaphore()
        .then(verified => {
            process.exit(verified ? 0 : 1);
        })
        .catch(err => {
            console.error("Error:", err);
            process.exit(1);
        });
}

module.exports = { testSemaphore, buildMerkleTree, getMerkleProof };
