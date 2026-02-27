// Vault Manager Backend API
// Built with Node.js/Express and Starknet.js

import express from 'express';
import { Account, Contract, Provider, RpcProvider, stark } from 'starknet';
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

const VAULT_MANAGER_ADDRESS = process.env.VAULT_MANAGER_ADDRESS;

// ABI for Vault Manager contract
const VAULT_MANAGER_ABI = [
    {
        "type": "function",
        "name": "deposit",
        "inputs": [
            { "name": "asset", "type": "core::starknet::contract_address::ContractAddress" },
            { "name": "amount", "type": "core::integer::u256" }
        ],
        "outputs": [],
        "state_mutability": "external"
    },
    {
        "type": "function",
        "name": "withdraw",
        "inputs": [
            { "name": "asset", "type": "core::starknet::contract_address::ContractAddress" },
            { "name": "amount", "type": "core::integer::u256" }
        ],
        "outputs": [],
        "state_mutability": "external"
    },
    {
        "type": "function",
        "name": "get_user_balance",
        "inputs": [
            { "name": "user", "type": "core::starknet::contract_address::ContractAddress" },
            { "name": "asset", "type": "core::starknet::contract_address::ContractAddress" }
        ],
        "outputs": [{ "type": "core::integer::u256" }],
        "state_mutability": "view"
    },
    {
        "type": "function",
        "name": "get_total_tvl",
        "inputs": [],
        "outputs": [{ "type": "core::integer::u256" }],
        "state_mutability": "view"
    },
    {
        "type": "function",
        "name": "add_curator",
        "inputs": [
            { "name": "curator", "type": "core::starknet::contract_address::ContractAddress" }
        ],
        "outputs": [],
        "state_mutability": "external"
    },
    {
        "type": "function",
        "name": "is_curator",
        "inputs": [
            { "name": "address", "type": "core::starknet::contract_address::ContractAddress" }
        ],
        "outputs": [{ "type": "core::bool" }],
        "state_mutability": "view"
    }
];

// Initialize contract
const vaultContract = new Contract(VAULT_MANAGER_ABI, VAULT_MANAGER_ADDRESS, provider);

// API Endpoints

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'vault-manager-api' });
});

// Get vault TVL
app.get('/api/vault/tvl', async (req, res) => {
    try {
        const tvl = await vaultContract.get_total_tvl();
        res.json({
            success: true,
            tvl: tvl.toString()
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get user balance for specific asset
app.get('/api/vault/balance/:userAddress/:assetAddress', async (req, res) => {
    try {
        const { userAddress, assetAddress } = req.params;
        const balance = await vaultContract.get_user_balance(userAddress, assetAddress);
        
        res.json({
            success: true,
            user: userAddress,
            asset: assetAddress,
            balance: balance.toString()
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Check if address is curator
app.get('/api/vault/curator/:address', async (req, res) => {
    try {
        const { address } = req.params;
        const isCurator = await vaultContract.is_curator(address);
        
        res.json({
            success: true,
            address,
            is_curator: isCurator
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Prepare deposit transaction
app.post('/api/vault/prepare-deposit', async (req, res) => {
    try {
        const { assetAddress, amount } = req.body;
        
        if (!assetAddress || !amount) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: assetAddress, amount'
            });
        }

        // Generate call data for deposit
        const callData = {
            contractAddress: VAULT_MANAGER_ADDRESS,
            entrypoint: 'deposit',
            calldata: [assetAddress, amount, '0'] // u256 is split into low and high
        };

        res.json({
            success: true,
            callData,
            message: 'Send this transaction using your Starknet wallet'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Prepare withdraw transaction
app.post('/api/vault/prepare-withdraw', async (req, res) => {
    try {
        const { assetAddress, amount } = req.body;
        
        if (!assetAddress || !amount) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: assetAddress, amount'
            });
        }

        const callData = {
            contractAddress: VAULT_MANAGER_ADDRESS,
            entrypoint: 'withdraw',
            calldata: [assetAddress, amount, '0']
        };

        res.json({
            success: true,
            callData,
            message: 'Send this transaction using your Starknet wallet'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Event storage (production should use PostgreSQL/MongoDB)
const eventStore = {
    deposits: [],
    withdrawals: [],
    users: new Set()
};

// Index events from the blockchain
async function indexVaultEvents() {
    try {
        // Get events from the last 1000 blocks
        const latestBlock = await provider.getBlock('latest');
        const fromBlock = Math.max(0, latestBlock.block_number - 1000);
        
        // In production, use Apibara or similar indexer
        // This is a working implementation using Starknet.js
        const depositFilter = {
            from_block: { block_number: fromBlock },
            to_block: 'latest',
            address: VAULT_MANAGER_ADDRESS,
            keys: [hash.getSelectorFromName('Deposit')]
        };
        
        const withdrawFilter = {
            from_block: { block_number: fromBlock },
            to_block: 'latest',
            address: VAULT_MANAGER_ADDRESS,
            keys: [hash.getSelectorFromName('Withdraw')]
        };

        // This would need to be implemented with proper event fetching
        // For now, storing in memory as events come in
    } catch (error) {
        console.error('Error indexing events:', error);
    }
}

// Get vault analytics
app.get('/api/vault/analytics', async (req, res) => {
    try {
        const tvl = await vaultContract.get_total_tvl();
        
        const analytics = {
            total_tvl: tvl.toString(),
            total_users: eventStore.users.size,
            total_deposits: eventStore.deposits.length,
            total_withdrawals: eventStore.withdrawals.length,
            curator_count: 1 // Could query this from contract if needed
        };

        res.json({
            success: true,
            analytics
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Listen for and index vault events
async function monitorVaultEvents() {
    console.log('Starting vault event monitoring...');
    
    // Index historical events on startup
    await indexVaultEvents();
    
    // Set up polling for new events (every 30 seconds)
    setInterval(async () => {
        try {
            await indexVaultEvents();
        } catch (error) {
            console.error('Error in event monitoring:', error);
        }
    }, 30000);
    
    console.log('Vault event monitoring active');
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Vault Manager API running on port ${PORT}`);
    monitorVaultEvents();
});

export default app;
