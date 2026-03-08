import express from 'express';
import { Pool } from 'pg';
import Redis from 'ioredis';
import axios from 'axios';
import { randomBytes } from 'crypto';
import { poseidon1, poseidon2, poseidon3, poseidon4 } from 'poseidon-lite';

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/privacy_swap',
});

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

// Service URLs
const PROOF_SERVICE_URL = process.env.PROOF_SERVICE_URL || 'http://localhost:3001';
const MERKLE_SERVICE_URL = process.env.MERKLE_SERVICE_URL || 'http://localhost:3002';

enum SwapStatus {
  PENDING = 'PENDING',
  COMMITMENT_CREATED = 'COMMITMENT_CREATED',
  MERKLE_ADDED = 'MERKLE_ADDED',
  PROOF_GENERATING = 'PROOF_GENERATING',
  PROOF_GENERATED = 'PROOF_GENERATED',
  LOCKED = 'LOCKED',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  EXPIRED = 'EXPIRED',
}

interface CreateSwapRequest {
  sourceChain: 'BITCOIN' | 'ETHEREUM' | 'STARKNET';
  destChain: 'BITCOIN' | 'ETHEREUM' | 'STARKNET';
  sourceAsset: number;
  destAsset: number;
  amount: string;
  recipientAddress: string;
  expirationMinutes: number;
}

interface SwapResponse {
  swapId: string;
  commitment: string;
  commitmentHash: string;
  nullifierHash: string;
  amountCommitment: string;
  status: SwapStatus;
  expiresAt: number;
}

// Generate cryptographic commitments
function generateCommitment(secret: bigint, nullifierSecret: bigint, amount: bigint): string {
  const inputs = [secret, nullifierSecret, amount];
  return poseidon3(inputs).toString();
}

function generateNullifier(secret: bigint, commitment: bigint, nullifierSecret: bigint): string {
  const nullifier = poseidon3([secret, commitment, nullifierSecret]);
  return poseidon1([nullifier]).toString();
}

function generateAmountCommitment(amount: bigint, secret: bigint): string {
  return poseidon2([amount, secret]).toString();
}

// Create new swap
app.post('/swaps', async (req, res) => {
  const client = await pool.connect();
  try {
    const request: CreateSwapRequest = req.body;

    // Validate request
    if (!request.sourceChain || !request.destChain || !request.amount || !request.recipientAddress) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (request.sourceChain === request.destChain) {
      return res.status(400).json({ error: 'Source and destination chains must be different' });
    }

    // Generate cryptographic materials
    const secret = BigInt('0x' + randomBytes(31).toString('hex'));
    const nullifierSecret = BigInt('0x' + randomBytes(31).toString('hex'));
    const amount = BigInt(request.amount);

    const commitment = generateCommitment(secret, nullifierSecret, amount);
    const commitmentHash = poseidon1([BigInt(commitment)]).toString();
    const nullifierHash = generateNullifier(secret, BigInt(commitment), nullifierSecret);
    const amountCommitment = generateAmountCommitment(amount, secret);

    // Calculate expiration
    const expiresAt = Date.now() + (request.expirationMinutes || 60) * 60 * 1000;

    // Generate swap ID
    const swapId = randomBytes(16).toString('hex');

    await client.query('BEGIN');

    // Store swap in database
    await client.query(
      `INSERT INTO swaps (
        id, swap_id, source_chain, dest_chain, source_asset, dest_asset,
        amount, commitment, commitment_hash, nullifier_hash, amount_commitment,
        recipient_address, secret, nullifier_secret, status, expires_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, to_timestamp($16/1000.0), NOW())`,
      [
        randomBytes(16).toString('hex'),
        swapId,
        request.sourceChain,
        request.destChain,
        request.sourceAsset,
        request.destAsset,
        request.amount,
        commitment,
        commitmentHash,
        nullifierHash,
        amountCommitment,
        request.recipientAddress,
        secret.toString(),
        nullifierSecret.toString(),
        SwapStatus.COMMITMENT_CREATED,
        expiresAt,
      ]
    );

    // Add commitment to Merkle tree
    const merkleResponse = await axios.post(`${MERKLE_SERVICE_URL}/add-commitment`, {
      commitment,
    });

    const leafIndex = merkleResponse.data.leafIndex;
    const merkleRoot = merkleResponse.data.merkleRoot;

    // Update swap with Merkle info
    await client.query(
      `UPDATE swaps SET 
       merkle_root = $1,
       merkle_leaf_index = $2,
       status = $3,
       updated_at = NOW()
       WHERE swap_id = $4`,
      [merkleRoot, leafIndex, SwapStatus.MERKLE_ADDED, swapId]
    );

    await client.query('COMMIT');

    // Publish event
    await redis.publish('swap:created', JSON.stringify({
      swapId,
      commitment,
      merkleRoot,
      leafIndex,
      timestamp: Date.now(),
    }));

    const response: SwapResponse = {
      swapId,
      commitment,
      commitmentHash,
      nullifierHash,
      amountCommitment,
      status: SwapStatus.MERKLE_ADDED,
      expiresAt,
    };

    res.json(response);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating swap:', error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Generate proof for swap
app.post('/swaps/:swapId/generate-proof', async (req, res) => {
  try {
    const { swapId } = req.params;

    // Get swap details
    const result = await pool.query(
      `SELECT * FROM swaps WHERE swap_id = $1`,
      [swapId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Swap not found' });
    }

    const swap = result.rows[0];

    // Check if swap is expired
    if (new Date() > swap.expires_at) {
      await pool.query(
        `UPDATE swaps SET status = $1 WHERE swap_id = $2`,
        [SwapStatus.EXPIRED, swapId]
      );
      return res.status(400).json({ error: 'Swap expired' });
    }

    // Get Merkle proof
    const merkleProofResponse = await axios.get(
      `${MERKLE_SERVICE_URL}/merkle-proof/${swap.merkle_leaf_index}`
    );

    const { path, pathIndices, merkleRoot } = merkleProofResponse.data;

    // Update status
    await pool.query(
      `UPDATE swaps SET status = $1, updated_at = NOW() WHERE swap_id = $2`,
      [SwapStatus.PROOF_GENERATING, swapId]
    );

    // Generate proof
    const proofRequestId = randomBytes(16).toString('hex');
    const proofResponse = await axios.post(`${PROOF_SERVICE_URL}/generate-proof`, {
      circuitType: 'swap',
      requestId: proofRequestId,
      inputs: {
        secret: swap.secret,
        nullifier_secret: swap.nullifier_secret,
        amount: swap.amount,
        merkle_path: path,
        merkle_path_indices: pathIndices,
        commitment: swap.commitment,
        merkle_root: merkleRoot,
        nullifier_hash: swap.nullifier_hash,
        amount_commitment: swap.amount_commitment,
      },
    });

    // Update swap with proof
    await pool.query(
      `UPDATE swaps SET 
       proof = $1,
       verification_key = $2,
       status = $3,
       updated_at = NOW()
       WHERE swap_id = $4`,
      [
        proofResponse.data.proof,
        proofResponse.data.verificationKey,
        SwapStatus.PROOF_GENERATED,
        swapId,
      ]
    );

    // Publish event
    await redis.publish('swap:proof:generated', JSON.stringify({
      swapId,
      proofRequestId,
      timestamp: Date.now(),
    }));

    res.json({
      swapId,
      proof: proofResponse.data.proof,
      publicInputs: proofResponse.data.publicInputs,
      status: SwapStatus.PROOF_GENERATED,
    });
  } catch (error) {
    console.error('Error generating proof:', error);
    
    // Update status to failed
    await pool.query(
      `UPDATE swaps SET status = $1, updated_at = NOW() WHERE swap_id = $2`,
      [SwapStatus.FAILED, req.params.swapId]
    );

    res.status(500).json({ error: error.message });
  }
});

// Get swap details
app.get('/swaps/:swapId', async (req, res) => {
  try {
    const { swapId } = req.params;
    const result = await pool.query(
      `SELECT 
         swap_id, source_chain, dest_chain, source_asset, dest_asset,
         amount, commitment, commitment_hash, nullifier_hash,
         amount_commitment, merkle_root, merkle_leaf_index,
         recipient_address, status, proof, source_tx_hash, dest_tx_hash,
         created_at, updated_at, expires_at
       FROM swaps WHERE swap_id = $1`,
      [swapId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Swap not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update swap status
app.put('/swaps/:swapId/status', async (req, res) => {
  try {
    const { swapId } = req.params;
    const { status, txHash, chain } = req.body;

    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }

    const updates: string[] = ['status = $1', 'updated_at = NOW()'];
    const values: any[] = [status];
    let paramCount = 2;

    if (txHash) {
      const field = chain === 'source' ? 'source_tx_hash' : 'dest_tx_hash';
      updates.push(`${field} = $${paramCount++}`);
      values.push(txHash);
    }

    values.push(swapId);

    const result = await pool.query(
      `UPDATE swaps SET ${updates.join(', ')}
       WHERE swap_id = $${paramCount}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Swap not found' });
    }

    // Publish event
    await redis.publish('swap:status:updated', JSON.stringify({
      swapId,
      status,
      txHash,
      timestamp: Date.now(),
    }));

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List swaps
app.get('/swaps', async (req, res) => {
  try {
    const { status, chain, limit = 50, offset = 0 } = req.query;

    let query = `SELECT 
      swap_id, source_chain, dest_chain, amount, status,
      created_at, expires_at
      FROM swaps`;
    
    const conditions: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (status) {
      conditions.push(`status = $${paramCount++}`);
      values.push(status);
    }

    if (chain) {
      conditions.push(`(source_chain = $${paramCount} OR dest_chain = $${paramCount})`);
      values.push(chain);
      paramCount++;
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramCount++} OFFSET $${paramCount}`;
    values.push(limit, offset);

    const result = await pool.query(query, values);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'swap-coordinator' });
});

// Start expiration checker
setInterval(async () => {
  try {
    await pool.query(
      `UPDATE swaps SET status = $1, updated_at = NOW()
       WHERE expires_at < NOW() AND status NOT IN ($2, $3, $4)`,
      [SwapStatus.EXPIRED, SwapStatus.COMPLETED, SwapStatus.FAILED, SwapStatus.EXPIRED]
    );
  } catch (error) {
    console.error('Error checking expiration:', error);
  }
}, 60000);

const PORT = process.env.PORT || 3005;
app.listen(PORT, () => {
  console.log(`Swap coordinator service running on port ${PORT}`);
});
