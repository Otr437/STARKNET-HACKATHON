/*
═══════════════════════════════════════════════════════════
🔐 CRYPTO-PROTECTED CODE 🔐
═══════════════════════════════════════════════════════════

Author:           Leon Sage
Organization:     Sage Audio LLC
Copyright:        © 2025 Leon Sage. All Rights Reserved.
License:          Proprietary
Signed:           2026-02-26 11:42:20
Certificate:      CodeSigning-LeonSage

CRYPTOGRAPHIC FINGERPRINT:
SHA-256:  24EC53F9B9460C22352471CA82627321098373839593F548A7B60DCA338058C4
SHA-512:  EC9EFB3438197279BF2682DAC3F8626906401853BE42B07F7896DA862EFA61B7F07806A1E47C61CDDF0F9E5EB8993894CFDFC91B4ABC794B4C92DEA47085A432
MD5:      EE42FEA1AEB7E80837F9C37085C5F9CB
File Size: 4961 bytes

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
import { RpcProvider, Contract } from 'starknet';
import { MerkleTree } from './merkle.js';
import { WebSocketServer } from 'ws';

export class EventListener {
    private provider: RpcProvider;
    private contract: Contract;
    private merkleTree: MerkleTree;
    private wss: WebSocketServer;
    private lastBlockProcessed: number = 0;

    constructor(
        rpcUrl: string,
        contractAddress: string,
        contractAbi: any,
        wsPort: number = 8080
    ) {
        this.provider = new RpcProvider({ nodeUrl: rpcUrl });
        this.contract = new Contract(contractAbi, contractAddress, this.provider);
        this.merkleTree = new MerkleTree();
        
        // WebSocket for real-time updates to frontend
        this.wss = new WebSocketServer({ port: wsPort });
        console.log(`✅ WebSocket server on port ${wsPort}`);
    }

    // Start listening for events
    async start() {
        console.log('🎧 Starting event listener...');
        
        // Get initial state
        await this.syncHistoricalEvents();
        
        // Poll for new events every 10 seconds
        setInterval(() => this.pollNewEvents(), 10000);
        
        console.log('✅ Event listener running');
    }

    // Sync all historical deposit events
    private async syncHistoricalEvents() {
        console.log('📥 Syncing historical deposits...');
        
        try {
            // Get all Deposit events from contract
            const events = await this.provider.getEvents({
                address: this.contract.address,
                from_block: { block_number: 0 },
                to_block: 'latest',
                keys: [[this.getEventKey('Deposit')]],
                chunk_size: 1000
            });

            for (const event of events.events) {
                const commitment = event.data[0]; // First data field is commitment
                const leafIndex = this.merkleTree.insert(commitment);
                console.log(`Added historical leaf ${leafIndex}`);
            }

            const root = this.merkleTree.getRoot();
            console.log(`✅ Synced ${this.merkleTree.getLeafCount()} deposits`);
            console.log(`📊 Merkle root: ${root}`);

            // Broadcast to all connected clients
            this.broadcast({
                type: 'sync_complete',
                leafCount: this.merkleTree.getLeafCount(),
                root
            });

        } catch (error) {
            console.error('❌ Error syncing events:', error);
        }
    }

    // Poll for new events
    private async pollNewEvents() {
        try {
            const currentBlock = await this.provider.getBlockNumber();
            
            if (currentBlock <= this.lastBlockProcessed) {
                return;
            }

            const events = await this.provider.getEvents({
                address: this.contract.address,
                from_block: { block_number: this.lastBlockProcessed + 1 },
                to_block: { block_number: currentBlock },
                keys: [[this.getEventKey('Deposit')]],
                chunk_size: 100
            });

            for (const event of events.events) {
                const commitment = event.data[0];
                const leafIndex = this.merkleTree.insert(commitment);
                
                console.log(`🆕 New deposit: leaf ${leafIndex}`);
                
                // Broadcast to clients
                this.broadcast({
                    type: 'new_deposit',
                    commitment,
                    leafIndex,
                    root: this.merkleTree.getRoot()
                });
            }

            this.lastBlockProcessed = currentBlock;

        } catch (error) {
            console.error('❌ Error polling events:', error);
        }
    }

    // Get Merkle proof for a commitment
    getProof(leafIndex: number): { path: string[]; indices: number[]; root: string } {
        const proof = this.merkleTree.getProof(leafIndex);
        return {
            ...proof,
            root: this.merkleTree.getRoot()
        };
    }

    // Get current Merkle root
    getRoot(): string {
        return this.merkleTree.getRoot();
    }

    // Get all leaves
    getLeaves(): string[] {
        return this.merkleTree.getLeaves();
    }

    // Get leaf count
    getLeafCount(): number {
        return this.merkleTree.getLeafCount();
    }

    // Broadcast to all WebSocket clients
    private broadcast(data: any) {
        const message = JSON.stringify(data);
        this.wss.clients.forEach(client => {
            if (client.readyState === 1) { // OPEN
                client.send(message);
            }
        });
    }

    // Get event key hash
    private getEventKey(eventName: string): string {
        // Starknet event keys are starknet_keccak of event name
        // For simplicity, using a placeholder
        return '0x' + eventName;
    }
}

