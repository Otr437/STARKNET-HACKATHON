/*
═══════════════════════════════════════════════════════════
🔐 CRYPTO-PROTECTED CODE 🔐
═══════════════════════════════════════════════════════════

Author:           Leon Sage
Organization:     Sage Audio LLC
Copyright:        © 2025 Leon Sage. All Rights Reserved.
License:          Proprietary
Signed:           2026-02-26 11:42:21
Certificate:      CodeSigning-LeonSage

CRYPTOGRAPHIC FINGERPRINT:
SHA-256:  456129CBBCD1E1E436B505A5F7CA7E4ACD9985D67E8D5FCBF9849E85DEB3F894
SHA-512:  F7C9283F27CE2C4EA801387A4D11AFADCCF29D146DFBFB7EC1CB6E5FEC7D3F32509434E1C8A6A0E1FEDBCAB278371E6D01A7091EEAFF5F1A6D7092AD6C1C4F98
MD5:      EB6C8A4ABCA7C757B38F78E472B1DC4B
File Size: 3368 bytes

LICENSE:
PROPRIETARY LICENSE

Copyright (c) 2026 Leon Sage. All Rights Reserved.
Sage Audio LLC

This software is proprietary and confidential property of Leon Sage.
UNAUTHORIZED COPYING, MODIFICATION, DISTRIBUTION, OR USE IS STRICTLY PROHIBITED.

⚠️  ANTI-THEFT NOTICE:
This code is cryptographically signed and protected. Any
unauthorized modification, distribution, or removal of this
protection constitutes copyright infringement.
═══════════════════════════════════════════════════════════
*/
import { poseidon } from 'circomlibjs';

export class MerkleTree {
    private leaves: string[] = [];
    private readonly TREE_DEPTH = 20;
    private readonly ZERO_VALUE = '0x0';

    constructor(initialLeaves: string[] = []) {
        this.leaves = initialLeaves;
    }

    // Add commitment to tree
    insert(commitment: string): number {
        const index = this.leaves.length;
        this.leaves.push(commitment);
        console.log(`Added leaf ${index}: ${commitment}`);
        return index;
    }

    // Get Merkle root
    getRoot(): string {
        if (this.leaves.length === 0) {
            return this.ZERO_VALUE;
        }

        let currentLevel = [...this.leaves];
        
        // Pad to power of 2
        while (currentLevel.length < Math.pow(2, this.TREE_DEPTH)) {
            currentLevel.push(this.ZERO_VALUE);
        }

        // Build tree bottom-up
        for (let level = 0; level < this.TREE_DEPTH; level++) {
            const nextLevel: string[] = [];
            
            for (let i = 0; i < currentLevel.length; i += 2) {
                const left = currentLevel[i];
                const right = currentLevel[i + 1] || this.ZERO_VALUE;
                nextLevel.push(poseidon([left, right]).toString());
            }
            
            currentLevel = nextLevel;
        }

        return currentLevel[0];
    }

    // Get proof for a leaf
    getProof(leafIndex: number): { path: string[]; indices: number[] } {
        if (leafIndex >= this.leaves.length) {
            throw new Error('Leaf index out of bounds');
        }

        const path: string[] = [];
        const indices: number[] = [];

        let currentLevel = [...this.leaves];
        while (currentLevel.length < Math.pow(2, this.TREE_DEPTH)) {
            currentLevel.push(this.ZERO_VALUE);
        }

        let index = leafIndex;

        for (let level = 0; level < this.TREE_DEPTH; level++) {
            const isRightNode = index % 2;
            const siblingIndex = isRightNode ? index - 1 : index + 1;

            path.push(currentLevel[siblingIndex]);
            indices.push(isRightNode);

            // Move to parent level
            const nextLevel: string[] = [];
            for (let i = 0; i < currentLevel.length; i += 2) {
                const left = currentLevel[i];
                const right = currentLevel[i + 1] || this.ZERO_VALUE;
                nextLevel.push(poseidon([left, right]).toString());
            }

            currentLevel = nextLevel;
            index = Math.floor(index / 2);
        }

        return { path, indices };
    }

    // Get all leaves
    getLeaves(): string[] {
        return [...this.leaves];
    }

    // Get leaf count
    getLeafCount(): number {
        return this.leaves.length;
    }

    // Verify proof
    verifyProof(leafIndex: number, leaf: string, proof: { path: string[]; indices: number[] }): boolean {
        let current = leaf;

        for (let i = 0; i < this.TREE_DEPTH; i++) {
            const pathElement = proof.path[i];
            const isRight = proof.indices[i];

            if (isRight === 0) {
                current = poseidon([current, pathElement]).toString();
            } else {
                current = poseidon([pathElement, current]).toString();
            }
        }

        return current === this.getRoot();
    }
}

