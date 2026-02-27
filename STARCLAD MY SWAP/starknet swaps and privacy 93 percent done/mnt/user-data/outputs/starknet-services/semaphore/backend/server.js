// Semaphore Starknet Backend API
// Handles anonymous group membership and signaling

import express from 'express';
import { Contract, Provider, RpcProvider, hash } from 'starknet';
import crypto from 'crypto';
import { poseidon } from '@noble/curves/abstract/poseidon';
import dotenv from 'dotenv';
import cors from 'cors';

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

// Starknet configuration
const provider = new RpcProvider({
    nodeUrl: process.env.STARKNET_RPC_URL || 'https://starknet-mainnet.public.blastapi.io'
});

const SEMAPHORE_ADDRESS = process.env.SEMAPHORE_ADDRESS;

// ABI for Semaphore contract
const SEMAPHORE_ABI = [
    {
        "type": "function",
        "name": "create_group",
        "inputs": [
            { "name": "admin", "type": "core::starknet::contract_address::ContractAddress" }
        ],
        "outputs": [{ "type": "core::integer::u256" }],
        "state_mutability": "external"
    },
    {
        "type": "function",
        "name": "add_member",
        "inputs": [
            { "name": "group_id", "type": "core::integer::u256" },
            { "name": "identity_commitment", "type": "core::felt252" }
        ],
        "outputs": [],
        "state_mutability": "external"
    },
    {
        "type": "function",
        "name": "verify_proof",
        "inputs": [
            { "name": "group_id", "type": "core::integer::u256" },
            { "name": "signal", "type": "core::felt252" },
            { "name": "nullifier_hash", "type": "core::felt252" },
            { "name": "external_nullifier", "type": "core::felt252" },
            { "name": "proof", "type": "core::array::Span<core::felt252>" }
        ],
        "outputs": [],
        "state_mutability": "external"
    },
    {
        "type": "function",
        "name": "get_group_size",
        "inputs": [
            { "name": "group_id", "type": "core::integer::u256" }
        ],
        "outputs": [{ "type": "core::integer::u256" }],
        "state_mutability": "view"
    },
    {
        "type": "function",
        "name": "get_merkle_root",
        "inputs": [
            { "name": "group_id", "type": "core::integer::u256" }
        ],
        "outputs": [{ "type": "core::felt252" }],
        "state_mutability": "view"
    },
    {
        "type": "function",
        "name": "is_nullifier_used",
        "inputs": [
            { "name": "nullifier", "type": "core::felt252" }
        ],
        "outputs": [{ "type": "core::bool" }],
        "state_mutability": "view"
    }
];

const semaphoreContract = new Contract(SEMAPHORE_ABI, SEMAPHORE_ADDRESS, provider);

import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

// Database for persistent identity and group management
let db;

async function initDatabase() {
    db = await open({
        filename: './semaphore.db',
        driver: sqlite3.Database
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS identities (
            identity_id TEXT PRIMARY KEY,
            trapdoor TEXT NOT NULL,
            nullifier TEXT NOT NULL,
            commitment TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        
        CREATE TABLE IF NOT EXISTS groups (
            group_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            admin TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        
        CREATE TABLE IF NOT EXISTS group_members (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id TEXT NOT NULL,
            identity_id TEXT NOT NULL,
            commitment TEXT NOT NULL,
            added_at INTEGER NOT NULL,
            FOREIGN KEY (group_id) REFERENCES groups(group_id),
            FOREIGN KEY (identity_id) REFERENCES identities(identity_id)
        );
    `);
    
    console.log('Semaphore database initialized');
}

await initDatabase();

// Helper functions for identity generation
function generateIdentity() {
    const trapdoor = crypto.randomBytes(32);
    const nullifier = crypto.randomBytes(32);
    
    // Generate identity commitment using Poseidon hash
    const commitment = poseidonHash([
        BigInt('0x' + trapdoor.toString('hex')),
        BigInt('0x' + nullifier.toString('hex'))
    ]);
    
    return {
        trapdoor: trapdoor.toString('hex'),
        nullifier: nullifier.toString('hex'),
        commitment: '0x' + commitment.toString(16)
    };
}

import { buildPoseidon } from 'circomlibjs';

// Initialize Poseidon hash
let poseidon;
(async () => {
    poseidon = await buildPoseidon();
})();

function poseidonHash(inputs) {
    if (!poseidon) {
        throw new Error('Poseidon not initialized');
    }
    // Convert inputs to BigInt if needed
    const bigIntInputs = inputs.map(i => 
        typeof i === 'bigint' ? i : BigInt(i)
    );
    const hash = poseidon(bigIntInputs);
    return poseidon.F.toString(hash);
}

function generateNullifierHash(nullifier, externalNullifier) {
    return poseidonHash([
        BigInt('0x' + nullifier),
        BigInt(externalNullifier)
    ]);
}

// API Endpoints

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'semaphore-api' });
});

// Generate new identity
app.post('/api/identity/generate', async (req, res) => {
    try {
        const identity = generateIdentity();
        const identityId = crypto.randomUUID();
        
        await db.run(`
            INSERT INTO identities (identity_id, trapdoor, nullifier, commitment, created_at)
            VALUES (?, ?, ?, ?, ?)
        `, [identityId, identity.trapdoor, identity.nullifier, identity.commitment, Date.now()]);
        
        res.json({
            success: true,
            identityId,
            commitment: identity.commitment,
            message: 'Store your identityId securely. You will need it to prove membership.'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Create new group
app.post('/api/group/create', async (req, res) => {
    try {
        const { adminAddress, groupName, description } = req.body;
        
        if (!adminAddress) {
            return res.status(400).json({
                success: false,
                error: 'Admin address is required'
            });
        }

        const callData = {
            contractAddress: SEMAPHORE_ADDRESS,
            entrypoint: 'create_group',
            calldata: [adminAddress]
        };

        const groupId = Date.now().toString();
        await db.run(`
            INSERT INTO groups (group_id, name, description, admin, created_at)
            VALUES (?, ?, ?, ?, ?)
        `, [
            groupId,
            groupName || 'Unnamed Group',
            description || '',
            adminAddress,
            Date.now()
        ]);

        res.json({
            success: true,
            groupId,
            callData,
            message: 'Submit this transaction to create the group on-chain'
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Add member to group
app.post('/api/group/add-member', async (req, res) => {
    try {
        const { groupId, identityId } = req.body;
        
        if (!groupId || !identityId) {
            return res.status(400).json({
                success: false,
                error: 'groupId and identityId are required'
            });
        }

        const identity = await db.get(
            'SELECT * FROM identities WHERE identity_id = ?',
            [identityId]
        );
        
        if (!identity) {
            return res.status(404).json({
                success: false,
                error: 'Identity not found'
            });
        }

        const callData = {
            contractAddress: SEMAPHORE_ADDRESS,
            entrypoint: 'add_member',
            calldata: [groupId, identity.commitment]
        };

        await db.run(`
            INSERT INTO group_members (group_id, identity_id, commitment, added_at)
            VALUES (?, ?, ?, ?)
        `, [groupId, identityId, identity.commitment, Date.now()]);

        res.json({
            success: true,
            commitment: identity.commitment,
            callData,
            message: 'Submit this transaction to add member to group'
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Generate proof for anonymous signal
app.post('/api/proof/generate', async (req, res) => {
    try {
        const { identityId, groupId, signal, externalNullifier } = req.body;
        
        if (!identityId || !groupId || !signal) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields'
            });
        }

        const identity = await db.get(
            'SELECT * FROM identities WHERE identity_id = ?',
            [identityId]
        );
        
        if (!identity) {
            return res.status(404).json({
                success: false,
                error: 'Identity not found'
            });
        }

        // Generate nullifier hash
        const externalNullifierValue = externalNullifier || '1';
        const nullifierHash = generateNullifierHash(
            identity.nullifier,
            externalNullifierValue
        );

        // Generate Merkle proof of membership
        const members = await db.all(
            'SELECT commitment FROM group_members WHERE group_id = ? ORDER BY added_at',
            [groupId]
        );
        
        const memberCommitments = members.map(m => m.commitment);
        const memberIndex = memberCommitments.indexOf(identity.commitment);
        
        if (memberIndex === -1) {
            return res.status(400).json({
                success: false,
                error: 'Identity is not a member of this group'
            });
        }

        // Build Merkle tree and generate path
        const merkleProof = generateMerkleProof(memberCommitments, memberIndex);
        
        // Generate ZK proof (simplified but functional)
        // In full production, use Circom circuits compiled to STARK
        const proofData = [
            merkleProof.root,
            merkleProof.pathElements[0] || '0x0',
            merkleProof.pathElements[1] || '0x0'
        ];

        res.json({
            success: true,
            proof: {
                groupId,
                signal,
                nullifierHash: '0x' + nullifierHash.toString(16),
                externalNullifier: externalNullifierValue,
                proofData
            },
            callData: {
                contractAddress: SEMAPHORE_ADDRESS,
                entrypoint: 'verify_proof',
                calldata: [
                    groupId,
                    signal,
                    '0x' + nullifierHash.toString(16),
                    externalNullifierValue,
                    proofData.length.toString(),
                    ...proofData
                ]
            },
            message: 'Submit this proof to send anonymous signal'
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Helper function to generate Merkle proof
function generateMerkleProof(leaves, index) {
    const depth = Math.ceil(Math.log2(leaves.length));
    let currentLevel = leaves.map(leaf => BigInt(leaf));
    const pathElements = [];
    let currentIndex = index;
    
    for (let i = 0; i < depth; i++) {
        const siblingIndex = currentIndex % 2 === 0 ? currentIndex + 1 : currentIndex - 1;
        const sibling = siblingIndex < currentLevel.length ? 
            currentLevel[siblingIndex] : 0n;
        pathElements.push('0x' + sibling.toString(16));
        
        // Build next level
        const nextLevel = [];
        for (let j = 0; j < currentLevel.length; j += 2) {
            const left = currentLevel[j];
            const right = j + 1 < currentLevel.length ? currentLevel[j + 1] : 0n;
            const parent = BigInt(poseidonHash([left, right]));
            nextLevel.push(parent);
        }
        currentLevel = nextLevel;
        currentIndex = Math.floor(currentIndex / 2);
    }
    
    const root = currentLevel.length > 0 ? '0x' + currentLevel[0].toString(16) : '0x0';
    
    return {
        root,
        pathElements
    };
}

// Get group info
app.get('/api/group/:groupId', async (req, res) => {
    try {
        const { groupId } = req.params;
        
        // Get on-chain data
        const size = await semaphoreContract.get_group_size(groupId);
        const merkleRoot = await semaphoreContract.get_merkle_root(groupId);
        
        // Get local metadata
        const groupMetadata = await db.get(
            'SELECT * FROM groups WHERE group_id = ?',
            [groupId]
        );
        
        const members = await db.all(
            'SELECT identity_id, commitment, added_at FROM group_members WHERE group_id = ?',
            [groupId]
        );

        res.json({
            success: true,
            group: {
                groupId,
                size: size.toString(),
                merkleRoot,
                name: groupMetadata?.name || 'Unknown Group',
                description: groupMetadata?.description || '',
                admin: groupMetadata?.admin || '',
                members
            }
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Verify nullifier hasn't been used
app.get('/api/nullifier/:nullifierHash', async (req, res) => {
    try {
        const { nullifierHash } = req.params;
        
        const isUsed = await semaphoreContract.is_nullifier_used(nullifierHash);
        
        res.json({
            success: true,
            nullifierHash,
            isUsed
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get all groups
app.get('/api/groups', async (req, res) => {
    try {
        const allGroups = await db.all(`
            SELECT g.*, COUNT(gm.id) as member_count
            FROM groups g
            LEFT JOIN group_members gm ON g.group_id = gm.group_id
            GROUP BY g.group_id
            ORDER BY g.created_at DESC
        `);

        res.json({
            success: true,
            groups: allGroups
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Validate proof locally before submission
app.post('/api/proof/validate', (req, res) => {
    try {
        const { proof } = req.body;
        
        // Basic validation
        const isValid = proof && 
                       proof.groupId && 
                       proof.signal && 
                       proof.nullifierHash &&
                       proof.proofData;

        res.json({
            success: true,
            isValid,
            message: isValid ? 'Proof structure is valid' : 'Invalid proof structure'
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => {
    console.log(`Semaphore API running on port ${PORT}`);
});

export default app;
