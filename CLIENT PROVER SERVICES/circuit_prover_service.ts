// ============================================
// ZK PROOF GENERATOR MICROSERVICE
// Port: 3008
// Integrates with Noir circuits for proof generation
// ============================================

import express from 'express';
import cors from 'cors';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const execAsync = promisify(exec);
const app = express();
app.use(cors());
app.use(express.json());

// ============================================
// NOIR CIRCUIT MANAGER
// ============================================

interface ProofInput {
  [key: string]: string | string[] | number | number[];
}

interface GeneratedProof {
  proof: string;
  publicInputs: string[];
  verificationKey: string;
}

class NoirCircuitManager {
  private circuitsDir: string;
  private proofsDir: string;

  constructor() {
    this.circuitsDir = process.env.CIRCUITS_DIR || './circuits';
    this.proofsDir = process.env.PROOFS_DIR || './proofs';
  }

  async initialize() {
    await fs.mkdir(this.proofsDir, { recursive: true });
    await this.compileAllCircuits();
  }

  // Compile all Noir circuits
  async compileAllCircuits() {
    const circuits = ['spend_proof', 'range_proof', 'atomic_swap'];
    
    for (const circuit of circuits) {
      const circuitPath = path.join(this.circuitsDir, circuit);
      try {
        console.log(`Compiling ${circuit}...`);
        await execAsync(`nargo compile`, { cwd: circuitPath });
        console.log(`✅ ${circuit} compiled successfully`);
      } catch (error: any) {
        console.error(`❌ Failed to compile ${circuit}:`, error.message);
      }
    }
  }

  // Generate witness from inputs
  async generateWitness(circuitName: string, inputs: ProofInput): Promise<string> {
    const circuitPath = path.join(this.circuitsDir, circuitName);
    const witnessId = crypto.randomBytes(16).toString('hex');
    const witnessFile = path.join(this.proofsDir, `witness_${witnessId}.toml`);

    // Convert inputs to TOML format
    const tomlContent = this.inputsToToml(inputs);
    await fs.writeFile(witnessFile, tomlContent);

    try {
      // Generate witness using nargo
      await execAsync(
        `nargo execute ${witnessFile}`,
        { cwd: circuitPath }
      );

      return witnessId;
    } catch (error: any) {
      throw new Error(`Witness generation failed: ${error.message}`);
    }
  }

  // Generate proof using Noir
  async generateProof(circuitName: string, witnessId: string): Promise<GeneratedProof> {
    const circuitPath = path.join(this.circuitsDir, circuitName);
    const witnessFile = path.join(this.proofsDir, `witness_${witnessId}.toml`);
    const proofFile = path.join(this.proofsDir, `proof_${witnessId}.proof`);

    try {
      // Generate proof using nargo
      await execAsync(
        `nargo prove ${witnessFile} ${proofFile}`,
        { cwd: circuitPath }
      );

      // Read generated proof
      const proofData = await fs.readFile(proofFile, 'utf-8');
      const proof = JSON.parse(proofData);

      // Read verification key
      const vkPath = path.join(circuitPath, 'target', 'verification_key');
      const vk = await fs.readFile(vkPath, 'utf-8');

      return {
        proof: proof.proof,
        publicInputs: proof.publicInputs || [],
        verificationKey: vk
      };
    } catch (error: any) {
      throw new Error(`Proof generation failed: ${error.message}`);
    }
  }

  // Verify proof
  async verifyProof(
    circuitName: string,
    proof: string,
    publicInputs: string[],
    verificationKey: string
  ): Promise<boolean> {
    const circuitPath = path.join(this.circuitsDir, circuitName);
    const verifyId = crypto.randomBytes(16).toString('hex');
    const proofFile = path.join(this.proofsDir, `verify_${verifyId}.proof`);
    const vkFile = path.join(this.proofsDir, `verify_${verifyId}.vk`);

    try {
      // Write proof and VK to files
      await fs.writeFile(proofFile, JSON.stringify({ proof, publicInputs }));
      await fs.writeFile(vkFile, verificationKey);

      // Verify using nargo
      const { stdout } = await execAsync(
        `nargo verify ${proofFile} ${vkFile}`,
        { cwd: circuitPath }
      );

      return stdout.includes('Proof verified');
    } catch (error: any) {
      console.error('Verification failed:', error.message);
      return false;
    }
  }

  // Convert inputs to TOML format
  private inputsToToml(inputs: ProofInput): string {
    let toml = '';
    
    for (const [key, value] of Object.entries(inputs)) {
      if (Array.isArray(value)) {
        toml += `${key} = [${value.join(', ')}]\n`;
      } else if (typeof value === 'string') {
        toml += `${key} = "${value}"\n`;
      } else {
        toml += `${key} = ${value}\n`;
      }
    }
    
    return toml;
  }

  // Clean up old proof files
  async cleanup(olderThanMinutes: number = 60) {
    const files = await fs.readdir(this.proofsDir);
    const now = Date.now();
    const maxAge = olderThanMinutes * 60 * 1000;

    for (const file of files) {
      const filePath = path.join(this.proofsDir, file);
      const stats = await fs.stat(filePath);
      
      if (now - stats.mtimeMs > maxAge) {
        await fs.unlink(filePath);
      }
    }
  }
}

// ============================================
// PROOF GENERATION HELPERS
// ============================================

class SpendProofGenerator {
  private circuitManager: NoirCircuitManager;

  constructor(circuitManager: NoirCircuitManager) {
    this.circuitManager = circuitManager;
  }

  async generate(
    amount: string,
    recipient: string,
    secret: string,
    merklePath: string[],
    merkleIndices: number[],
    merkleRoot: string,
    nullifier: string,
    commitment: string,
    spender: string
  ): Promise<GeneratedProof> {
    const inputs: ProofInput = {
      amount,
      recipient,
      secret,
      merkle_path: merklePath,
      merkle_path_indices: merkleIndices,
      merkle_root: merkleRoot,
      nullifier,
      commitment,
      spender
    };

    const witnessId = await this.circuitManager.generateWitness('spend_proof', inputs);
    return await this.circuitManager.generateProof('spend_proof', witnessId);
  }
}

class RangeProofGenerator {
  private circuitManager: NoirCircuitManager;

  constructor(circuitManager: NoirCircuitManager) {
    this.circuitManager = circuitManager;
  }

  async generate(
    amount: string,
    blindingFactor: string,
    amountCommitment: string,
    minValue: string,
    maxValue: string
  ): Promise<GeneratedProof> {
    const inputs: ProofInput = {
      amount,
      blinding_factor: blindingFactor,
      amount_commitment: amountCommitment,
      min_value: minValue,
      max_value: maxValue
    };

    const witnessId = await this.circuitManager.generateWitness('range_proof', inputs);
    return await this.circuitManager.generateProof('range_proof', witnessId);
  }
}

class SwapProofGenerator {
  private circuitManager: NoirCircuitManager;

  constructor(circuitManager: NoirCircuitManager) {
    this.circuitManager = circuitManager;
  }

  async generateInitiation(
    initiatorAmount: string,
    initiatorRecipient: string,
    initiatorSecret: string,
    initiatorMerklePath: string[],
    initiatorMerkleIndices: number[],
    htlcSecret: string,
    recipientAmount: string,
    recipientAddress: string,
    initiatorMerkleRoot: string,
    initiatorNullifier: string,
    initiatorCommitment: string,
    htlcSecretHash: string,
    recipientCommitment: string,
    swapId: string
  ): Promise<GeneratedProof> {
    const inputs: ProofInput = {
      initiator_amount: initiatorAmount,
      initiator_recipient: initiatorRecipient,
      initiator_secret: initiatorSecret,
      initiator_merkle_path: initiatorMerklePath,
      initiator_merkle_indices: initiatorMerkleIndices,
      htlc_secret: htlcSecret,
      recipient_amount: recipientAmount,
      recipient_address: recipientAddress,
      initiator_merkle_root: initiatorMerkleRoot,
      initiator_nullifier: initiatorNullifier,
      initiator_commitment: initiatorCommitment,
      htlc_secret_hash: htlcSecretHash,
      recipient_commitment: recipientCommitment,
      swap_id: swapId
    };

    const witnessId = await this.circuitManager.generateWitness('atomic_swap', inputs);
    return await this.circuitManager.generateProof('atomic_swap', witnessId);
  }
}

// ============================================
// API ENDPOINTS
// ============================================

const circuitManager = new NoirCircuitManager();
const spendProofGen = new SpendProofGenerator(circuitManager);
const rangeProofGen = new RangeProofGenerator(circuitManager);
const swapProofGen = new SwapProofGenerator(circuitManager);

app.get('/health', (req, res) => {
  res.json({ 
    service: 'zk-proof-generator', 
    status: 'ok',
    timestamp: Date.now() 
  });
});

// Compile circuits
app.post('/api/circuits/compile', async (req, res) => {
  try {
    await circuitManager.compileAllCircuits();
    res.json({ success: true, message: 'Circuits compiled' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Generate spend proof
app.post('/api/proofs/spend', async (req, res) => {
  try {
    const {
      amount, recipient, secret, merklePath, merkleIndices,
      merkleRoot, nullifier, commitment, spender
    } = req.body;

    const proof = await spendProofGen.generate(
      amount, recipient, secret, merklePath, merkleIndices,
      merkleRoot, nullifier, commitment, spender
    );

    res.json({ proof });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Generate range proof
app.post('/api/proofs/range', async (req, res) => {
  try {
    const { amount, blindingFactor, amountCommitment, minValue, maxValue } = req.body;

    const proof = await rangeProofGen.generate(
      amount, blindingFactor, amountCommitment, minValue, maxValue
    );

    res.json({ proof });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Generate swap initiation proof
app.post('/api/proofs/swap/initiate', async (req, res) => {
  try {
    const {
      initiatorAmount, initiatorRecipient, initiatorSecret,
      initiatorMerklePath, initiatorMerkleIndices,
      htlcSecret, recipientAmount, recipientAddress,
      initiatorMerkleRoot, initiatorNullifier, initiatorCommitment,
      htlcSecretHash, recipientCommitment, swapId
    } = req.body;

    const proof = await swapProofGen.generateInitiation(
      initiatorAmount, initiatorRecipient, initiatorSecret,
      initiatorMerklePath, initiatorMerkleIndices,
      htlcSecret, recipientAmount, recipientAddress,
      initiatorMerkleRoot, initiatorNullifier, initiatorCommitment,
      htlcSecretHash, recipientCommitment, swapId
    );

    res.json({ proof });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Verify proof
app.post('/api/proofs/verify', async (req, res) => {
  try {
    const { circuitName, proof, publicInputs, verificationKey } = req.body;
    
    const isValid = await circuitManager.verifyProof(
      circuitName, proof, publicInputs, verificationKey
    );

    res.json({ valid: isValid });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Cleanup old proofs
app.post('/api/proofs/cleanup', async (req, res) => {
  try {
    const { olderThanMinutes } = req.body;
    await circuitManager.cleanup(olderThanMinutes || 60);
    res.json({ success: true, message: 'Cleanup completed' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// STARTUP
// ============================================

async function start() {
  await circuitManager.initialize();
  
  const PORT = process.env.PORT || 3008;
  app.listen(PORT, () => {
    console.log(`🔬 ZK Proof Generator Service running on port ${PORT}`);
    console.log(`✅ Noir circuits initialized`);
  });

  // Schedule cleanup every hour
  setInterval(() => {
    circuitManager.cleanup(60).catch(console.error);
  }, 3600000);
}

start().catch(console.error);

export { NoirCircuitManager, SpendProofGenerator, RangeProofGenerator, SwapProofGenerator };