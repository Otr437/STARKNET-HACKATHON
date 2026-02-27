// ============================================
// POSEIDON HASH MICROSERVICE
// Port: 3002
// ============================================

import express from 'express';
import cors from 'cors';
import { buildPoseidon } from 'circomlibjs';

const app = express();
app.use(cors());
app.use(express.json());

// ============================================
// POSEIDON HASHER
// ============================================

class PoseidonHasher {
  private poseidon: any;
  private initialized: boolean = false;

  async initialize() {
    if (!this.initialized) {
      this.poseidon = await buildPoseidon();
      this.initialized = true;
    }
  }

  hash(input: bigint): bigint {
    if (!this.initialized) throw new Error('Poseidon not initialized');
    const hash = this.poseidon([input]);
    return this.poseidon.F.toObject(hash);
  }

  hash2(inputs: [bigint, bigint]): bigint {
    if (!this.initialized) throw new Error('Poseidon not initialized');
    const hash = this.poseidon(inputs);
    return this.poseidon.F.toObject(hash);
  }

  hash3(inputs: [bigint, bigint, bigint]): bigint {
    if (!this.initialized) throw new Error('Poseidon not initialized');
    const hash = this.poseidon(inputs);
    return this.poseidon.F.toObject(hash);
  }

  hash4(inputs: [bigint, bigint, bigint, bigint]): bigint {
    if (!this.initialized) throw new Error('Poseidon not initialized');
    const hash = this.poseidon(inputs);
    return this.poseidon.F.toObject(hash);
  }

  toFelt252(value: bigint): string {
    return '0x' + value.toString(16).padStart(64, '0');
  }
}

// ============================================
// API ENDPOINTS
// ============================================

const hasher = new PoseidonHasher();

app.get('/health', (req, res) => {
  res.json({ 
    service: 'poseidon-hash', 
    status: hasher['initialized'] ? 'ready' : 'initializing',
    timestamp: Date.now() 
  });
});

app.post('/api/hash', async (req, res) => {
  try {
    const { input } = req.body;
    const result = hasher.hash(BigInt(input));
    res.json({ 
      hash: result.toString(),
      felt252: hasher.toFelt252(result)
    });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/hash2', async (req, res) => {
  try {
    const { inputs } = req.body;
    if (!Array.isArray(inputs) || inputs.length !== 2) {
      throw new Error('Expected array of 2 inputs');
    }
    const result = hasher.hash2([BigInt(inputs[0]), BigInt(inputs[1])]);
    res.json({ 
      hash: result.toString(),
      felt252: hasher.toFelt252(result)
    });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/hash3', async (req, res) => {
  try {
    const { inputs } = req.body;
    if (!Array.isArray(inputs) || inputs.length !== 3) {
      throw new Error('Expected array of 3 inputs');
    }
    const result = hasher.hash3([
      BigInt(inputs[0]), 
      BigInt(inputs[1]), 
      BigInt(inputs[2])
    ]);
    res.json({ 
      hash: result.toString(),
      felt252: hasher.toFelt252(result)
    });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/hash4', async (req, res) => {
  try {
    const { inputs } = req.body;
    if (!Array.isArray(inputs) || inputs.length !== 4) {
      throw new Error('Expected array of 4 inputs');
    }
    const result = hasher.hash4([
      BigInt(inputs[0]), 
      BigInt(inputs[1]), 
      BigInt(inputs[2]),
      BigInt(inputs[3])
    ]);
    res.json({ 
      hash: result.toString(),
      felt252: hasher.toFelt252(result)
    });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/to-felt252', async (req, res) => {
  try {
    const { value } = req.body;
    const felt252 = hasher.toFelt252(BigInt(value));
    res.json({ felt252 });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// ============================================
// STARTUP
// ============================================

async function start() {
  await hasher.initialize();
  const PORT = process.env.PORT || 3002;
  app.listen(PORT, () => {
    console.log(`🔢 Poseidon Hash Service running on port ${PORT}`);
    console.log(`✅ Poseidon initialized and ready`);
  });
}

start().catch(console.error);

export { PoseidonHasher };