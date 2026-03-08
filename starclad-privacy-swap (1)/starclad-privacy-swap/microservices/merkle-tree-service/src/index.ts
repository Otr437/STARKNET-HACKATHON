import express from 'express';
import { createHash } from 'crypto';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { poseidon2 } from 'poseidon-lite';

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/privacy_swap',
});

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

const TREE_DEPTH = 20;
const ZERO_VALUE = BigInt(0);

// Sparse Merkle Tree implementation
class SparseMerkleTree {
  private depth: number;
  private zeroCache: Map<number, string>;
  private leaves: Map<number, string>;
  private nodes: Map<string, string>;

  constructor(depth: number) {
    this.depth = depth;
    this.zeroCache = new Map();
    this.leaves = new Map();
    this.nodes = new Map();
    this.initializeZeroCache();
  }

  private initializeZeroCache() {
    let currentZero = ZERO_VALUE.toString();
    this.zeroCache.set(0, currentZero);

    for (let i = 1; i <= this.depth; i++) {
      currentZero = this.hash(currentZero, currentZero);
      this.zeroCache.set(i, currentZero);
    }
  }

  private hash(left: string, right: string): string {
    const leftBigInt = BigInt(left);
    const rightBigInt = BigInt(right);
    return poseidon2([leftBigInt, rightBigInt]).toString();
  }

  private getNode(level: number, index: number): string {
    const key = `${level}:${index}`;
    if (this.nodes.has(key)) {
      return this.nodes.get(key);
    }
    return this.zeroCache.get(level);
  }

  private setNode(level: number, index: number, value: string) {
    const key = `${level}:${index}`;
    this.nodes.set(key, value);
  }

  async insert(leafIndex: number, leaf: string): Promise<string> {
    if (leafIndex >= Math.pow(2, this.depth)) {
      throw new Error('Leaf index out of bounds');
    }

    this.leaves.set(leafIndex, leaf);
    this.setNode(0, leafIndex, leaf);

    let currentIndex = leafIndex;
    let currentValue = leaf;

    for (let level = 0; level < this.depth; level++) {
      const isRightNode = currentIndex % 2 === 1;
      const siblingIndex = isRightNode ? currentIndex - 1 : currentIndex + 1;
      const siblingValue = this.getNode(level, siblingIndex);

      const parentValue = isRightNode
        ? this.hash(siblingValue, currentValue)
        : this.hash(currentValue, siblingValue);

      currentIndex = Math.floor(currentIndex / 2);
      this.setNode(level + 1, currentIndex, parentValue);
      currentValue = parentValue;
    }

    // Save to database
    await this.persistTree(leafIndex, leaf, currentValue);

    return currentValue;
  }

  getMerklePath(leafIndex: number): { path: string[]; pathIndices: number[] } {
    const path: string[] = [];
    const pathIndices: number[] = [];

    let currentIndex = leafIndex;

    for (let level = 0; level < this.depth; level++) {
      const isRightNode = currentIndex % 2 === 1;
      const siblingIndex = isRightNode ? currentIndex - 1 : currentIndex + 1;
      const siblingValue = this.getNode(level, siblingIndex);

      path.push(siblingValue);
      pathIndices.push(isRightNode ? 1 : 0);

      currentIndex = Math.floor(currentIndex / 2);
    }

    return { path, pathIndices };
  }

  getRoot(): string {
    return this.getNode(this.depth, 0);
  }

  private async persistTree(leafIndex: number, leaf: string, root: string) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO merkle_leaves (leaf_index, leaf_value, tree_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (leaf_index, tree_id) DO UPDATE SET leaf_value = $2`,
        [leafIndex, leaf, 'main']
      );

      await client.query(
        `INSERT INTO merkle_roots (root_hash, leaf_count, tree_id, created_at)
         VALUES ($1, $2, $3, NOW())`,
        [root, leafIndex + 1, 'main']
      );

      await client.query('COMMIT');

      // Cache in Redis
      await redis.set(`merkle:root:latest`, root, 'EX', 3600);
      await redis.set(`merkle:leaf:${leafIndex}`, leaf, 'EX', 86400);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async loadFromDatabase() {
    const result = await pool.query(
      `SELECT leaf_index, leaf_value FROM merkle_leaves
       WHERE tree_id = 'main' ORDER BY leaf_index ASC`
    );

    for (const row of result.rows) {
      this.leaves.set(row.leaf_index, row.leaf_value);
      this.setNode(0, row.leaf_index, row.leaf_value);
    }

    // Rebuild tree
    for (const [index, leaf] of this.leaves.entries()) {
      await this.insert(index, leaf);
    }
  }
}

const tree = new SparseMerkleTree(TREE_DEPTH);

// Initialize tree from database on startup
(async () => {
  try {
    await tree.loadFromDatabase();
    console.log('Merkle tree loaded from database');
  } catch (error) {
    console.error('Error loading tree:', error);
  }
})();

// Add commitment to tree
app.post('/add-commitment', async (req, res) => {
  try {
    const { commitment } = req.body;

    if (!commitment) {
      return res.status(400).json({ error: 'Missing commitment' });
    }

    // Get next leaf index
    const result = await pool.query(
      `SELECT COALESCE(MAX(leaf_index), -1) + 1 as next_index
       FROM merkle_leaves WHERE tree_id = 'main'`
    );
    const leafIndex = result.rows[0].next_index;

    // Insert into tree
    const newRoot = await tree.insert(leafIndex, commitment);

    // Publish event
    await redis.publish('merkle:commitment:added', JSON.stringify({
      commitment,
      leafIndex,
      newRoot,
      timestamp: Date.now(),
    }));

    res.json({
      leafIndex,
      commitment,
      merkleRoot: newRoot,
    });
  } catch (error) {
    console.error('Error adding commitment:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get Merkle proof for commitment
app.get('/merkle-proof/:leafIndex', async (req, res) => {
  try {
    const leafIndex = parseInt(req.params.leafIndex);

    if (isNaN(leafIndex) || leafIndex < 0) {
      return res.status(400).json({ error: 'Invalid leaf index' });
    }

    const { path, pathIndices } = tree.getMerklePath(leafIndex);
    const root = tree.getRoot();

    res.json({
      leafIndex,
      path,
      pathIndices,
      merkleRoot: root,
    });
  } catch (error) {
    console.error('Error getting Merkle proof:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get current Merkle root
app.get('/merkle-root', async (req, res) => {
  try {
    // Check cache first
    const cachedRoot = await redis.get('merkle:root:latest');
    if (cachedRoot) {
      return res.json({ merkleRoot: cachedRoot });
    }

    const root = tree.getRoot();
    await redis.set('merkle:root:latest', root, 'EX', 3600);

    res.json({ merkleRoot: root });
  } catch (error) {
    console.error('Error getting Merkle root:', error);
    res.status(500).json({ error: error.message });
  }
});

// Verify Merkle proof
app.post('/verify-proof', async (req, res) => {
  try {
    const { commitment, path, pathIndices, merkleRoot } = req.body;

    if (!commitment || !path || !pathIndices || !merkleRoot) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    let current = commitment;

    for (let i = 0; i < path.length; i++) {
      const isRight = pathIndices[i] === 1;
      const sibling = path[i];

      current = isRight
        ? poseidon2([BigInt(sibling), BigInt(current)]).toString()
        : poseidon2([BigInt(current), BigInt(sibling)]).toString();
    }

    const isValid = current === merkleRoot;

    res.json({ valid: isValid, computedRoot: current });
  } catch (error) {
    console.error('Error verifying proof:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get tree statistics
app.get('/stats', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
         COUNT(*) as total_leaves,
         MAX(leaf_index) as max_index
       FROM merkle_leaves WHERE tree_id = 'main'`
    );

    const rootResult = await pool.query(
      `SELECT root_hash, created_at
       FROM merkle_roots
       WHERE tree_id = 'main'
       ORDER BY created_at DESC LIMIT 1`
    );

    res.json({
      totalLeaves: parseInt(result.rows[0].total_leaves),
      maxIndex: result.rows[0].max_index,
      currentRoot: rootResult.rows[0]?.root_hash,
      lastUpdate: rootResult.rows[0]?.created_at,
    });
  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'merkle-tree' });
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`Merkle tree service running on port ${PORT}`);
});

export { SparseMerkleTree };
