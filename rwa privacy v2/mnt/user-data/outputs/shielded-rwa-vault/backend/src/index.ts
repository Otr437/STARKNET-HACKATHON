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
SHA-256:  2F1B25CF71BE18250D6A4316C7F15CDE1077E40ABB143D3B579B136C7407B768
SHA-512:  D5C5D031FD60C817760C843699363BC776DB1A938EDBAFC255F2A08C17335A2E09D2D409CB07010EAE0CACAFBF88968DEF4014D1BBD74CF7D8C20241DAF1F347
MD5:      A82DC4ABDE97A3E69A568C5B024A7E92
File Size: 6426 bytes

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
import express from 'express';
import cors from 'cors';
import { RpcProvider } from 'starknet';
import { poseidon } from 'circomlibjs';
import { WebSocketServer } from 'ws';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3001;
const RPC_URL = process.env.STARKNET_RPC_URL || 'https://starknet-sepolia.public.blastapi.io/rpc/v0_7';
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || '';

class MerkleTreeBuilder {
    private leaves: string[] = [];
    private root: string = '0x0';

    addLeaf(leaf: string, index: number) {
        this.leaves[index] = leaf;
        this.recomputeRoot();
    }

    private recomputeRoot() {
        if (this.leaves.length === 0) {
            this.root = '0x0';
            return;
        }

        let currentLevel = [...this.leaves];
        const ZERO = '0x0';

        // Pad to power of 2
        while (currentLevel.length % 2 !== 0) {
            currentLevel.push(ZERO);
        }

        // Build tree bottom-up
        for (let level = 0; level < 20; level++) {
            if (currentLevel.length === 1) break;

            const nextLevel: string[] = [];
            for (let i = 0; i < currentLevel.length; i += 2) {
                const left = currentLevel[i] || ZERO;
                const right = currentLevel[i + 1] || ZERO;
                const parent = poseidon([left, right]);
                nextLevel.push(parent);
            }
            currentLevel = nextLevel;
        }

        this.root = currentLevel[0];
    }

    getRoot(): string {
        return this.root;
    }

    getLeaves(): string[] {
        return this.leaves;
    }

    getMerklePath(leafIndex: number): { path: string[]; indices: number[] } {
        const path: string[] = [];
        const indices: number[] = [];
        const ZERO = '0x0';

        let currentLevel = [...this.leaves];
        let index = leafIndex;

        // Pad level
        while (currentLevel.length % 2 !== 0) {
            currentLevel.push(ZERO);
        }

        for (let level = 0; level < 20; level++) {
            const isRightNode = index % 2;
            const siblingIndex = isRightNode ? index - 1 : index + 1;
            
            const sibling = currentLevel[siblingIndex] || ZERO;
            path.push(sibling);
            indices.push(isRightNode ? 1 : 0);

            // Move to next level
            const nextLevel: string[] = [];
            for (let i = 0; i < currentLevel.length; i += 2) {
                const left = currentLevel[i] || ZERO;
                const right = currentLevel[i + 1] || ZERO;
                nextLevel.push(poseidon([left, right]));
            }
            currentLevel = nextLevel;
            index = Math.floor(index / 2);

            if (currentLevel.length === 1) break;
        }

        return { path, indices };
    }
}

const merkleTree = new MerkleTreeBuilder();
const provider = new RpcProvider({ nodeUrl: RPC_URL });
let lastProcessedBlock = 0;

// Listen for Deposit events
async function listenForDeposits() {
    console.log('🔊 Listening for Deposit events...');
    console.log('Contract:', CONTRACT_ADDRESS);

    setInterval(async () => {
        try {
            const currentBlock = await provider.getBlockNumber();
            
            if (currentBlock <= lastProcessedBlock) {
                return;
            }

            console.log(`Checking blocks ${lastProcessedBlock + 1} to ${currentBlock}...`);

            // Get events from contract
            const events = await provider.getEvents({
                address: CONTRACT_ADDRESS,
                from_block: { block_number: lastProcessedBlock + 1 },
                to_block: { block_number: currentBlock },
                keys: [['Deposit']], // Event selector
                chunk_size: 100
            });

            for (const event of events.events) {
                // Parse Deposit event
                // event.data: [commitment, leaf_index, timestamp]
                const commitment = event.data[0];
                const leafIndex = parseInt(event.data[1], 16);
                
                console.log(`📥 New deposit: ${commitment} at index ${leafIndex}`);
                
                merkleTree.addLeaf(commitment, leafIndex);
                
                // Broadcast to websocket clients
                broadcastTreeUpdate();
            }

            lastProcessedBlock = currentBlock;

        } catch (error) {
            console.error('Error fetching events:', error);
        }
    }, 5000); // Check every 5 seconds
}

// WebSocket for real-time updates
const wss = new WebSocketServer({ port: 3002 });
const clients = new Set();

wss.on('connection', (ws) => {
    console.log('👤 Client connected');
    clients.add(ws);
    
    // Send current tree state
    ws.send(JSON.stringify({
        type: 'tree_state',
        root: merkleTree.getRoot(),
        leaves: merkleTree.getLeaves()
    }));

    ws.on('close', () => {
        clients.delete(ws);
    });
});

function broadcastTreeUpdate() {
    const message = JSON.stringify({
        type: 'tree_update',
        root: merkleTree.getRoot(),
        leavesCount: merkleTree.getLeaves().length
    });

    clients.forEach((client: any) => {
        if (client.readyState === 1) {
            client.send(message);
        }
    });
}

// API endpoints
app.get('/health', (req, res) => {
    res.json({ status: 'ok', leaves: merkleTree.getLeaves().length });
});

app.get('/tree', (req, res) => {
    res.json({
        root: merkleTree.getRoot(),
        leaves: merkleTree.getLeaves()
    });
});

app.get('/merkle-path/:index', (req, res) => {
    const index = parseInt(req.params.index);
    
    if (isNaN(index) || index < 0 || index >= merkleTree.getLeaves().length) {
        return res.status(400).json({ error: 'Invalid index' });
    }

    const { path, indices } = merkleTree.getMerklePath(index);
    
    res.json({
        leafIndex: index,
        commitment: merkleTree.getLeaves()[index],
        path,
        indices,
        root: merkleTree.getRoot()
    });
});

app.listen(PORT, () => {
    console.log(`✅ Backend running on http://localhost:${PORT}`);
    console.log(`✅ WebSocket on ws://localhost:3002`);
    
    if (!CONTRACT_ADDRESS) {
        console.warn('⚠️  CONTRACT_ADDRESS not set. Set it in .env');
    } else {
        listenForDeposits();
    }
});

