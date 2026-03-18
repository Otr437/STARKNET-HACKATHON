import express from 'express';
import { Pool } from 'pg';
import Redis from 'ioredis';
import axios from 'axios';
import { WebSocketProvider, Contract, ethers } from 'ethers';
import { RpcProvider, Account, Contract as StarknetContract } from 'starknet';
import * as bitcoin from 'bitcoinjs-lib';
import rateLimit from 'express-rate-limit';

const app = express();
app.use(express.json());

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/privacy_swap',
});

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

// Bitcoin RPC configuration
const BITCOIN_RPC_URL = process.env.BITCOIN_RPC_URL || 'http://localhost:8332';
const BITCOIN_RPC_USER = process.env.BITCOIN_RPC_USER || 'bitcoin';
const BITCOIN_RPC_PASS = process.env.BITCOIN_RPC_PASS || 'password';

// Ethereum configuration
const ETHEREUM_RPC = process.env.ETHEREUM_RPC;
if (!ETHEREUM_RPC) throw new Error('ETHEREUM_RPC env var required');
const ethProvider = new ethers.JsonRpcProvider(ETHEREUM_RPC);

const STARKNET_RPC = process.env.STARKNET_RPC;
if (!STARKNET_RPC) throw new Error('STARKNET_RPC env var required');
const starknetProvider = new RpcProvider({ nodeUrl: STARKNET_RPC });

// Contract ABIs and addresses
const SWAP_CONTRACT_ADDRESS = process.env.SWAP_CONTRACT_ADDRESS;
const SWAP_CONTRACT_ABI = [
  'event CommitmentAdded(bytes32 indexed commitment, uint256 leafIndex, bytes32 merkleRoot)',
  'event SwapInitiated(bytes32 indexed swapId, bytes32 nullifierHash, uint256 amount)',
  'event SwapCompleted(bytes32 indexed swapId, address recipient)',
  'function verifyProof(bytes calldata proof, bytes32 merkleRoot, bytes32 nullifierHash) external returns (bool)',
];

const swapContract = new Contract(SWAP_CONTRACT_ADDRESS, SWAP_CONTRACT_ABI, ethProvider);

// Bitcoin RPC call
async function bitcoinRPC(method: string, params: any[] = []): Promise<any> {
  try {
    const response = await axios.post(
      BITCOIN_RPC_URL,
      {
        jsonrpc: '1.0',
        id: 'monitor',
        method,
        params,
      },
      {
        auth: {
          username: BITCOIN_RPC_USER,
          password: BITCOIN_RPC_PASS,
        },
      }
    );
    return response.data.result;
  } catch (error) {
    console.error(`Bitcoin RPC error (${method}):`, error.message);
    throw error;
  }
}

// Monitor Bitcoin transactions
async function monitorBitcoinTransactions() {
  try {
    const blockCount = await bitcoinRPC('getblockcount');
    const cachedBlock = await redis.get('btc:last_block');
    const lastProcessed = cachedBlock ? parseInt(cachedBlock) : blockCount - 10;

    for (let height = lastProcessed + 1; height <= blockCount; height++) {
      const blockHash = await bitcoinRPC('getblockhash', [height]);
      const block = await bitcoinRPC('getblock', [blockHash, 2]);

      for (const tx of block.tx) {
        await processBitcoinTransaction(tx, height);
      }

      await redis.set('btc:last_block', height);
    }
  } catch (error) {
    console.error('Bitcoin monitoring error:', error);
  }
}

// Process Bitcoin transaction
async function processBitcoinTransaction(tx: any, blockHeight: number) {
  const client = await pool.connect();
  try {
    // Check if transaction contains commitment in OP_RETURN
    for (const vout of tx.vout) {
      if (vout.scriptPubKey.type === 'nulldata') {
        const opReturnData = vout.scriptPubKey.hex;
        
        // Check if it's our commitment format (starts with our magic bytes)
        if (opReturnData.startsWith('6a20')) { // OP_RETURN + 32 bytes
          const commitment = '0x' + opReturnData.slice(4);
          
          await client.query(
            `INSERT INTO btc_commitments (txid, commitment, block_height, created_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (txid) DO NOTHING`,
            [tx.txid, commitment, blockHeight]
          );

          // Publish event
          await redis.publish('btc:commitment:detected', JSON.stringify({
            txid: tx.txid,
            commitment,
            blockHeight,
            timestamp: Date.now(),
          }));
        }
      }
    }

    // Check for HTLC outputs
    for (let i = 0; i < tx.vout.length; i++) {
      const vout = tx.vout[i];
      if (vout.scriptPubKey.type === 'scripthash') {
        // Decode script to check for our HTLC pattern
        const scriptHash = vout.scriptPubKey.hex;
        
        // Store potential HTLC for monitoring
        await client.query(
          `INSERT INTO btc_htlcs (txid, vout, script_hash, value, block_height, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (txid, vout) DO NOTHING`,
          [tx.txid, i, scriptHash, vout.value, blockHeight]
        );
      }
    }
  } catch (error) {
    console.error('Error processing Bitcoin transaction:', error);
  } finally {
    client.release();
  }
}

// Monitor Ethereum events
async function monitorEthereumEvents() {
  try {
    const lastBlock = await redis.get('eth:last_block');
    const fromBlock = lastBlock ? parseInt(lastBlock) : 'latest';

    // Listen for CommitmentAdded events
    swapContract.on('CommitmentAdded', async (commitment, leafIndex, merkleRoot, event) => {
      const client = await pool.connect();
      try {
        await client.query(
          `INSERT INTO eth_commitments (tx_hash, commitment, leaf_index, merkle_root, block_number, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (tx_hash) DO NOTHING`,
          [event.log.transactionHash, commitment, leafIndex.toString(), merkleRoot, event.log.blockNumber]
        );

        await redis.publish('eth:commitment:added', JSON.stringify({
          txHash: event.log.transactionHash,
          commitment,
          leafIndex: leafIndex.toString(),
          merkleRoot,
          blockNumber: event.log.blockNumber,
          timestamp: Date.now(),
        }));
      } finally {
        client.release();
      }
    });

    // Listen for SwapInitiated events
    swapContract.on('SwapInitiated', async (swapId, nullifierHash, amount, event) => {
      const client = await pool.connect();
      try {
        await client.query(
          `UPDATE swaps SET 
           status = 'LOCKED',
           source_tx_hash = $1,
           updated_at = NOW()
           WHERE swap_id = $2`,
          [event.log.transactionHash, swapId]
        );

        await redis.publish('eth:swap:initiated', JSON.stringify({
          swapId,
          nullifierHash,
          amount: amount.toString(),
          txHash: event.log.transactionHash,
          timestamp: Date.now(),
        }));
      } finally {
        client.release();
      }
    });

    // Listen for SwapCompleted events
    swapContract.on('SwapCompleted', async (swapId, recipient, event) => {
      const client = await pool.connect();
      try {
        await client.query(
          `UPDATE swaps SET 
           status = 'COMPLETED',
           dest_tx_hash = $1,
           updated_at = NOW()
           WHERE swap_id = $2`,
          [event.log.transactionHash, swapId]
        );

        await redis.publish('eth:swap:completed', JSON.stringify({
          swapId,
          recipient,
          txHash: event.log.transactionHash,
          timestamp: Date.now(),
        }));
      } finally {
        client.release();
      }
    });

    const currentBlock = await ethProvider.getBlockNumber();
    await redis.set('eth:last_block', currentBlock);
  } catch (error) {
    console.error('Ethereum monitoring error:', error);
  }
}

// Monitor StarkNet transactions
async function monitorStarkNetTransactions() {
  try {
    const lastBlock = await redis.get('starknet:last_block');
    const currentBlock = await starknetProvider.getBlockNumber();
    const fromBlock = lastBlock ? parseInt(lastBlock) + 1 : currentBlock - 100;

    for (let blockNum = fromBlock; blockNum <= currentBlock; blockNum++) {
      const block = await starknetProvider.getBlockWithTxs(blockNum);

      for (const tx of block.transactions) {
        await processStarkNetTransaction(tx, blockNum);
      }

      await redis.set('starknet:last_block', blockNum);
    }
  } catch (error) {
    console.error('StarkNet monitoring error:', error);
  }
}

// Process StarkNet transaction
async function processStarkNetTransaction(tx: any, blockNumber: number) {
  const client = await pool.connect();
  try {
    // Check if transaction is to our swap contract
    if (tx.contract_address === process.env.STARKNET_SWAP_CONTRACT) {
      // Decode transaction data
      const selector = tx.entry_point_selector;
      
      // Check for add_commitment function
      // sn_keccak("add_commitment")
      if (selector === '0x2069719c80d117c42e91ca68e5109ba8e75e6185acf01b2c409f960774bea0c') {
        const commitment = tx.calldata[0];
        
        await client.query(
          `INSERT INTO starknet_commitments (tx_hash, commitment, block_number, created_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (tx_hash) DO NOTHING`,
          [tx.transaction_hash, commitment, blockNumber]
        );

        await redis.publish('starknet:commitment:added', JSON.stringify({
          txHash: tx.transaction_hash,
          commitment,
          blockNumber,
          timestamp: Date.now(),
        }));
      }
    }
  } catch (error) {
    console.error('Error processing StarkNet transaction:', error);
  } finally {
    client.release();
  }
}

// Start monitoring all chains
async function startMonitoring() {
  console.log('Starting blockchain monitors...');

  // Bitcoin: Poll every 10 seconds
  setInterval(monitorBitcoinTransactions, 10000);

  // Ethereum: Event-based monitoring
  await monitorEthereumEvents();

  // StarkNet: Poll every 15 seconds
  setInterval(monitorStarkNetTransactions, 15000);
}

// API endpoints
app.get('/status/:chain', apiLimiter, async (req, res) => {
  try {
    const { chain } = req.params;
    const lastBlock = await redis.get(`${chain}:last_block`);
    
    res.json({
      chain,
      lastProcessedBlock: lastBlock ? parseInt(lastBlock) : null,
      timestamp: Date.now(),
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.get('/commitment/:txHash', apiLimiter, async (req, res) => {
  try {
    const { txHash } = req.params;
    
    const result = await pool.query(
      `SELECT * FROM 
       (SELECT 'BTC' as chain, * FROM btc_commitments WHERE txid = $1
        UNION ALL
        SELECT 'ETH' as chain, * FROM eth_commitments WHERE tx_hash = $1
        UNION ALL
        SELECT 'STARKNET' as chain, * FROM starknet_commitments WHERE tx_hash = $1)
       WHERE EXISTS (SELECT 1)`,
      [txHash]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'blockchain-monitor' });
});

const PORT = process.env.PORT || 3003;
app.listen(PORT, async () => {
  console.log(`Blockchain monitor service running on port ${PORT}`);
  await startMonitoring();
});
