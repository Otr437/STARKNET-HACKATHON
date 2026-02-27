// Private BTC Swap Backend API
// Handles cross-chain atomic swaps between Bitcoin and Starknet

import express from 'express';
import { Contract, Provider, RpcProvider, hash } from 'starknet';
import bitcoin from 'bitcoinjs-lib';
import crypto from 'crypto';
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

const BTC_SWAP_ADDRESS = process.env.BTC_SWAP_ADDRESS;

// Bitcoin configuration
const BITCOIN_NETWORK = process.env.BITCOIN_NETWORK === 'mainnet' 
    ? bitcoin.networks.bitcoin 
    : bitcoin.networks.testnet;

// ABI for BTC Swap contract
const BTC_SWAP_ABI = [
    {
        "type": "function",
        "name": "initiate_swap",
        "inputs": [
            { "name": "participant", "type": "core::starknet::contract_address::ContractAddress" },
            { "name": "asset", "type": "core::starknet::contract_address::ContractAddress" },
            { "name": "amount", "type": "core::integer::u256" },
            { "name": "hash_lock", "type": "core::felt252" },
            { "name": "time_lock", "type": "core::integer::u64" },
            { "name": "btc_address", "type": "core::felt252" },
            { "name": "btc_amount", "type": "core::integer::u256" }
        ],
        "outputs": [{ "type": "core::integer::u256" }],
        "state_mutability": "external"
    },
    {
        "type": "function",
        "name": "complete_swap",
        "inputs": [
            { "name": "swap_id", "type": "core::integer::u256" },
            { "name": "secret", "type": "core::felt252" }
        ],
        "outputs": [],
        "state_mutability": "external"
    },
    {
        "type": "function",
        "name": "get_swap",
        "inputs": [
            { "name": "swap_id", "type": "core::integer::u256" }
        ],
        "outputs": [{ "type": "Swap" }],
        "state_mutability": "view"
    }
];

const swapContract = new Contract(BTC_SWAP_ABI, BTC_SWAP_ADDRESS, provider);

import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

// Database setup for persistent swap storage
let db;

async function initDatabase() {
    db = await open({
        filename: './swaps.db',
        driver: sqlite3.Database
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS swaps (
            swap_id TEXT PRIMARY KEY,
            secret TEXT NOT NULL,
            hash_lock TEXT NOT NULL,
            btc_address TEXT NOT NULL,
            btc_amount TEXT NOT NULL,
            participant_address TEXT NOT NULL,
            asset_address TEXT NOT NULL,
            amount TEXT NOT NULL,
            time_lock INTEGER NOT NULL,
            status TEXT NOT NULL,
            btc_tx_hash TEXT,
            created_at INTEGER NOT NULL
        )
    `);
    
    console.log('Database initialized');
}

// Initialize on startup
await initDatabase();

// Helper: Generate secret and hash
function generateSecretAndHash() {
    const secret = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(Buffer.from(secret, 'hex')).digest('hex');
    return { secret, hash };
}

// Helper: Convert Bitcoin address to felt252
function btcAddressToFelt(address) {
    // Proper conversion: Use Bitcoin address hash
    const addressBuffer = Buffer.from(address, 'utf8');
    const hash = crypto.createHash('sha256').update(addressBuffer).digest();
    // Take first 31 bytes to fit in felt252 (252 bits max)
    const felt = '0x' + hash.slice(0, 31).toString('hex');
    return felt;
}

// API Endpoints

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'btc-swap-api' });
});

// Initiate swap (Starknet -> BTC)
app.post('/api/swap/initiate', async (req, res) => {
    try {
        const {
            participantAddress,
            assetAddress,
            amount,
            btcAddress,
            btcAmount,
            timeLockHours = 24
        } = req.body;

        if (!participantAddress || !assetAddress || !amount || !btcAddress || !btcAmount) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields'
            });
        }

        // Generate secret and hash
        const { secret, hash: hashLock } = generateSecretAndHash();
        
        // Calculate time lock (current time + hours)
        const timeLock = Math.floor(Date.now() / 1000) + (timeLockHours * 3600);

        // Convert BTC address to felt
        const btcAddressFelt = btcAddressToFelt(btcAddress);

        // Store swap details in database
        const swapId = Date.now().toString();
        await db.run(`
            INSERT INTO swaps (
                swap_id, secret, hash_lock, btc_address, btc_amount,
                participant_address, asset_address, amount, time_lock,
                status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            swapId,
            secret,
            hashLock,
            btcAddress,
            btcAmount,
            participantAddress,
            assetAddress,
            amount,
            timeLock,
            'initiated',
            Date.now()
        ]);

        // Prepare transaction data
        const callData = {
            contractAddress: BTC_SWAP_ADDRESS,
            entrypoint: 'initiate_swap',
            calldata: [
                participantAddress,
                assetAddress,
                amount,
                '0',
                `0x${hashLock}`,
                timeLock.toString(),
                btcAddressFelt,
                btcAmount,
                '0'
            ]
        };

        res.json({
            success: true,
            swapId,
            hashLock: `0x${hashLock}`,
            timeLock,
            btcAddress,
            callData,
            message: 'Submit this transaction to initiate the swap. Secret will be revealed upon completion.'
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get swap details
app.get('/api/swap/:swapId', async (req, res) => {
    try {
        const { swapId } = req.params;
        
        // Query from database
        const swap = await db.get(
            'SELECT * FROM swaps WHERE swap_id = ?',
            [swapId]
        );
        
        if (swap) {
            return res.json({
                success: true,
                swap: {
                    ...swap,
                    secret: swap.status === 'completed' ? swap.secret : undefined
                }
            });
        }

        // If not in DB, try querying contract
        const onChainSwap = await swapContract.get_swap(swapId);
        
        res.json({
            success: true,
            swap: onChainSwap
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Complete swap and reveal secret
app.post('/api/swap/complete', async (req, res) => {
    try {
        const { swapId, btcTxHash } = req.body;

        if (!swapId) {
            return res.status(400).json({
                success: false,
                error: 'Missing swapId'
            });
        }

        const swap = await db.get(
            'SELECT * FROM swaps WHERE swap_id = ?',
            [swapId]
        );
        
        if (!swap) {
            return res.status(404).json({
                success: false,
                error: 'Swap not found'
            });
        }

        // Verify Bitcoin transaction if provided
        if (btcTxHash) {
            try {
                // In production, verify the transaction on Bitcoin blockchain
                // using a Bitcoin node or API like blockchain.info, blockstream.info
                const btcApiUrl = process.env.BITCOIN_NETWORK === 'mainnet'
                    ? `https://blockchain.info/rawtx/${btcTxHash}`
                    : `https://blockstream.info/testnet/api/tx/${btcTxHash}`;
                
                const response = await fetch(btcApiUrl);
                if (!response.ok) {
                    return res.status(400).json({
                        success: false,
                        error: 'Invalid Bitcoin transaction hash'
                    });
                }
                
                const txData = await response.json();
                
                // Verify transaction outputs match swap requirements
                let validOutput = false;
                for (const output of txData.vout) {
                    // Check if any output matches expected amount (with some tolerance for fees)
                    if (output.value && Math.abs(output.value - swap.btc_amount / 100000000) < 0.0001) {
                        validOutput = true;
                        break;
                    }
                }
                
                if (!validOutput) {
                    return res.status(400).json({
                        success: false,
                        error: 'Bitcoin transaction amount does not match swap'
                    });
                }
            } catch (error) {
                console.error('BTC verification error:', error);
                return res.status(500).json({
                    success: false,
                    error: 'Failed to verify Bitcoin transaction'
                });
            }
        }

        // Update swap status
        await db.run(
            'UPDATE swaps SET status = ?, btc_tx_hash = ? WHERE swap_id = ?',
            ['completed', btcTxHash, swapId]
        );

        // Reveal secret
        res.json({
            success: true,
            secret: swap.secret,
            message: 'Use this secret to complete the swap on Starknet',
            callData: {
                contractAddress: BTC_SWAP_ADDRESS,
                entrypoint: 'complete_swap',
                calldata: [swapId, `0x${Buffer.from(swap.secret, 'hex').toString('hex')}`]
            }
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Create Bitcoin HTLC script
app.post('/api/swap/btc-script', async (req, res) => {
    try {
        const { hashLock, recipientPubKey, senderPubKey, timeLock } = req.body;

        if (!hashLock || !recipientPubKey || !senderPubKey || !timeLock) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields'
            });
        }

        // Create HTLC script
        const script = bitcoin.script.compile([
            bitcoin.opcodes.OP_IF,
            bitcoin.opcodes.OP_SHA256,
            Buffer.from(hashLock, 'hex'),
            bitcoin.opcodes.OP_EQUALVERIFY,
            Buffer.from(recipientPubKey, 'hex'),
            bitcoin.opcodes.OP_ELSE,
            bitcoin.script.number.encode(timeLock),
            bitcoin.opcodes.OP_CHECKLOCKTIMEVERIFY,
            bitcoin.opcodes.OP_DROP,
            Buffer.from(senderPubKey, 'hex'),
            bitcoin.opcodes.OP_ENDIF,
            bitcoin.opcodes.OP_CHECKSIG
        ]);

        const p2sh = bitcoin.payments.p2sh({
            redeem: { output: script },
            network: BITCOIN_NETWORK
        });

        res.json({
            success: true,
            htlcAddress: p2sh.address,
            script: script.toString('hex'),
            message: 'Send BTC to this address to lock funds'
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get active swaps for user
app.get('/api/swap/user/:address', async (req, res) => {
    try {
        const { address } = req.params;
        
        const userSwaps = await db.all(`
            SELECT swap_id, participant_address, asset_address, amount, 
                   btc_address, btc_amount, status, time_lock, created_at,
                   CASE WHEN status = 'completed' THEN secret ELSE NULL END as secret
            FROM swaps 
            WHERE participant_address = ? OR asset_address = ?
            ORDER BY created_at DESC
        `, [address, address]);

        res.json({
            success: true,
            swaps: userSwaps
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Verify secret
app.post('/api/swap/verify-secret', (req, res) => {
    try {
        const { secret, hashLock } = req.body;

        if (!secret || !hashLock) {
            return res.status(400).json({
                success: false,
                error: 'Missing secret or hashLock'
            });
        }

        const computedHash = crypto.createHash('sha256')
            .update(Buffer.from(secret, 'hex'))
            .digest('hex');

        const isValid = computedHash === hashLock.replace('0x', '');

        res.json({
            success: true,
            isValid,
            computedHash: `0x${computedHash}`
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
    console.log(`BTC Swap API running on port ${PORT}`);
});

export default app;
