import express from 'express';
import { Noir } from '@noir-lang/noir_js';
import { BarretenbergBackend } from '@noir-lang/backend_barretenberg';
import { readFileSync } from 'fs';
import { join } from 'path';
import Redis from 'ioredis';
import { createHash } from 'crypto';

const app = express();
app.use(express.json());

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

// Load compiled circuits
const swapCircuit = JSON.parse(readFileSync(join(__dirname, '../../circuits/swap-validator/target/swap_validator_circuit.json'), 'utf8'));
const commitmentCircuit = JSON.parse(readFileSync(join(__dirname, '../../circuits/commitment/target/commitment_circuit.json'), 'utf8'));
const nullifierCircuit = JSON.parse(readFileSync(join(__dirname, '../../circuits/nullifier/target/nullifier_circuit.json'), 'utf8'));
const merkleCircuit = JSON.parse(readFileSync(join(__dirname, '../../circuits/merkle-proof/target/merkle_proof_circuit.json'), 'utf8'));

// Initialize Noir instances with Barretenberg backend
const swapNoir = new Noir(swapCircuit, new BarretenbergBackend(swapCircuit));
const commitmentNoir = new Noir(commitmentCircuit, new BarretenbergBackend(commitmentCircuit));
const nullifierNoir = new Noir(nullifierCircuit, new BarretenbergBackend(nullifierCircuit));
const merkleNoir = new Noir(merkleCircuit, new BarretenbergBackend(merkleCircuit));

interface ProofRequest {
  circuitType: 'swap' | 'commitment' | 'nullifier' | 'merkle';
  inputs: any;
  requestId: string;
}

interface ProofResponse {
  requestId: string;
  proof: string;
  publicInputs: any;
  verificationKey: string;
}

// Generate proof for swap validation
async function generateSwapProof(inputs: any): Promise<{ proof: string; publicInputs: any }> {
  const witness = await swapNoir.execute(inputs);
  const proof = await swapNoir.generateProof(witness);
  
  return {
    proof: Buffer.from(proof.proof).toString('hex'),
    publicInputs: {
      commitment: inputs.commitment,
      merkleRoot: inputs.merkle_root,
      nullifierHash: inputs.nullifier_hash,
      amountCommitment: inputs.amount_commitment,
    }
  };
}

// Generate proof for commitment
async function generateCommitmentProof(inputs: any): Promise<{ proof: string; publicInputs: any }> {
  const witness = await commitmentNoir.execute(inputs);
  const proof = await commitmentNoir.generateProof(witness);
  
  return {
    proof: Buffer.from(proof.proof).toString('hex'),
    publicInputs: {
      amount: inputs.amount,
      assetId: inputs.asset_id,
    }
  };
}

// Generate proof for nullifier
async function generateNullifierProof(inputs: any): Promise<{ proof: string; publicInputs: any }> {
  const witness = await nullifierNoir.execute(inputs);
  const proof = await nullifierNoir.generateProof(witness);
  
  return {
    proof: Buffer.from(proof.proof).toString('hex'),
    publicInputs: {}
  };
}

// Generate proof for Merkle verification
async function generateMerkleProof(inputs: any): Promise<{ proof: string; publicInputs: any }> {
  const witness = await merkleNoir.execute(inputs);
  const proof = await merkleNoir.generateProof(witness);
  
  return {
    proof: Buffer.from(proof.proof).toString('hex'),
    publicInputs: {
      merkleRoot: inputs.merkle_root,
    }
  };
}

// API endpoint to generate proofs
app.post('/generate-proof', async (req, res) => {
  try {
    const request: ProofRequest = req.body;
    
    if (!request.circuitType || !request.inputs || !request.requestId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Store request in Redis for tracking
    await redis.set(`proof:request:${request.requestId}`, JSON.stringify(request), 'EX', 3600);
    await redis.set(`proof:status:${request.requestId}`, 'processing', 'EX', 3600);

    let result: { proof: string; publicInputs: any };
    let verificationKey: string;

    switch (request.circuitType) {
      case 'swap':
        result = await generateSwapProof(request.inputs);
        verificationKey = Buffer.from(await swapNoir.getVerificationKey()).toString('hex');
        break;
      case 'commitment':
        result = await generateCommitmentProof(request.inputs);
        verificationKey = Buffer.from(await commitmentNoir.getVerificationKey()).toString('hex');
        break;
      case 'nullifier':
        result = await generateNullifierProof(request.inputs);
        verificationKey = Buffer.from(await nullifierNoir.getVerificationKey()).toString('hex');
        break;
      case 'merkle':
        result = await generateMerkleProof(request.inputs);
        verificationKey = Buffer.from(await merkleNoir.getVerificationKey()).toString('hex');
        break;
      default:
        throw new Error(`Unknown circuit type: ${request.circuitType}`);
    }

    const response: ProofResponse = {
      requestId: request.requestId,
      proof: result.proof,
      publicInputs: result.publicInputs,
      verificationKey: verificationKey,
    };

    // Store result in Redis
    await redis.set(`proof:result:${request.requestId}`, JSON.stringify(response), 'EX', 86400);
    await redis.set(`proof:status:${request.requestId}`, 'completed', 'EX', 86400);

    // Publish to Redis pub/sub for webhook service
    await redis.publish('proof:generated', JSON.stringify({
      requestId: request.requestId,
      circuitType: request.circuitType,
      timestamp: Date.now(),
    }));

    res.json(response);
  } catch (error) {
    console.error('Proof generation error:', error);
    
    if (req.body.requestId) {
      await redis.set(`proof:status:${req.body.requestId}`, 'failed', 'EX', 86400);
      await redis.set(`proof:error:${req.body.requestId}`, JSON.stringify({ error: error.message }), 'EX', 86400);
    }
    
    res.status(500).json({ error: error.message });
  }
});

// Get proof status
app.get('/proof-status/:requestId', async (req, res) => {
  try {
    const { requestId } = req.params;
    const status = await redis.get(`proof:status:${requestId}`);
    
    if (!status) {
      return res.status(404).json({ error: 'Request not found' });
    }

    const response: any = { requestId, status };

    if (status === 'completed') {
      const result = await redis.get(`proof:result:${requestId}`);
      response.result = JSON.parse(result);
    } else if (status === 'failed') {
      const error = await redis.get(`proof:error:${requestId}`);
      response.error = JSON.parse(error);
    }

    res.json(response);
  } catch (error) {
    console.error('Status check error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Verify proof
app.post('/verify-proof', async (req, res) => {
  try {
    const { circuitType, proof, publicInputs } = req.body;

    if (!circuitType || !proof || !publicInputs) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    let noir: Noir;
    switch (circuitType) {
      case 'swap':
        noir = swapNoir;
        break;
      case 'commitment':
        noir = commitmentNoir;
        break;
      case 'nullifier':
        noir = nullifierNoir;
        break;
      case 'merkle':
        noir = merkleNoir;
        break;
      default:
        throw new Error(`Unknown circuit type: ${circuitType}`);
    }

    const proofBuffer = Buffer.from(proof, 'hex');
    const isValid = await noir.verifyProof({
      proof: proofBuffer,
      publicInputs: publicInputs,
    });

    res.json({ valid: isValid });
  } catch (error) {
    console.error('Proof verification error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'proof-generation' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Proof generation service running on port ${PORT}`);
});

export { generateSwapProof, generateCommitmentProof, generateNullifierProof, generateMerkleProof };
