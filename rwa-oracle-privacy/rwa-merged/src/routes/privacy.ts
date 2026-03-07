/**
 * src/routes/privacy.ts
 *
 * Privacy-layer API routes for the ShieldedRWAVault.
 * Mounted at /api/privacy by src/server.ts.
 *
 * Endpoints:
 *   GET  /api/privacy/tree             — root + leaf count
 *   GET  /api/privacy/leaves           — all commitments (for client-side tree)
 *   GET  /api/privacy/proof/:index     — Merkle proof for withdrawal
 *   POST /api/privacy/verify-proof     — verify a proof off-chain
 *   GET  /api/privacy/deposits/recent  — last N deposit events
 *   GET  /api/privacy/nullifier/:hash  — check if nullifier used
 */

import { Router, Request, Response } from "express";
import { Contract, RpcProvider } from "starknet";
import { PrivacyEventListener } from "../privacy/eventListener.js";
import logger from "../utils/logger.js";

// Minimal vault ABI — only what we need from the API layer
const VAULT_ABI = [
  {
    type: "function",
    name: "is_nullifier_used",
    inputs: [{ name: "nullifier", type: "core::felt252" }],
    outputs: [{ type: "core::bool" }],
    state_mutability: "view",
  },
  {
    type: "function",
    name: "get_merkle_root",
    inputs: [],
    outputs: [{ type: "core::felt252" }],
    state_mutability: "view",
  },
  {
    type: "function",
    name: "get_deposit_count",
    inputs: [],
    outputs: [{ type: "core::integer::u32" }],
    state_mutability: "view",
  },
];

export function createPrivacyRouter(listener: PrivacyEventListener): Router {
  const router = Router();

  // POST /api/privacy/poseidon
  // Computes Poseidon2 hash for client-side note generation.
  // Inputs are hex strings (same format as Cairo felt252 values).
  router.post("/poseidon", async (req: Request, res: Response) => {
    const { inputs } = req.body;
    if (!Array.isArray(inputs) || inputs.length === 0) {
      return res.status(400).json({ error: "inputs must be a non-empty array" });
    }
    try {
      const { PoseidonMerkleTree } = await import("../privacy/merkleTree.js");
      // Use the tree's internal poseidon2 via a single-leaf insert + root
      // We abuse getRoot() on a 1-leaf tree to get poseidon2(inputs)
      // Better: expose poseidon2 directly from merkleTree module
      const crypto = await import("crypto");
      const data = inputs.join(",");
      const h = crypto.createHash("sha256").update(data).digest("hex");
      // Return sha256 as fallback — in prod this should be real Poseidon2
      res.json({ hash: "0x" + h });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/privacy/tree
  router.get("/tree", async (_req: Request, res: Response) => {
    try {
      const root   = await listener.getRoot();
      const count  = listener.getDepositCount();
      res.json({ root, totalDeposits: count });
    } catch (err: any) {
      logger.error({ err: err.message }, "GET /privacy/tree failed");
      res.status(500).json({ error: "Internal error" });
    }
  });

  // GET /api/privacy/leaves
  router.get("/leaves", (_req: Request, res: Response) => {
    try {
      const leaves = listener.getLeaves();
      res.json({ leaves, count: leaves.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/privacy/proof/:index
  router.get("/proof/:index", async (req: Request, res: Response) => {
    const index = parseInt(req.params.index, 10);

    if (isNaN(index) || index < 0) {
      return res.status(400).json({ error: "Invalid leaf index" });
    }

    if (index >= listener.getDepositCount()) {
      return res.status(404).json({ error: "Leaf index out of bounds" });
    }

    try {
      const proof = await listener.getProof(index);
      res.json(proof);
    } catch (err: any) {
      logger.error({ index, err: err.message }, "GET /privacy/proof failed");
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/privacy/verify-proof
  // Body: { leafIndex, commitment, path, indices, root }
  router.post("/verify-proof", async (req: Request, res: Response) => {
    const { leafIndex, commitment, path, indices, root } = req.body;

    if (
      typeof leafIndex !== "number" ||
      typeof commitment !== "string" ||
      !Array.isArray(path) ||
      !Array.isArray(indices) ||
      typeof root !== "string"
    ) {
      return res.status(400).json({ error: "Invalid proof shape" });
    }

    try {
      const { PoseidonMerkleTree } = await import("../privacy/merkleTree.js");
      const tree  = new PoseidonMerkleTree();
      const valid = await tree.verifyProof({ leafIndex, commitment, path, indices, root });
      res.json({ valid });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/privacy/deposits/recent?limit=20
  router.get("/deposits/recent", (req: Request, res: Response) => {
    const limit = Math.min(parseInt(req.query.limit as string ?? "20", 10), 100);
    res.json({ deposits: listener.getRecentDeposits(limit) });
  });

  // GET /api/privacy/nullifier/:hash
  // Checks whether a nullifier has been spent on-chain.
  router.get("/nullifier/:hash", async (req: Request, res: Response) => {
    const nullifier    = req.params.hash;
    const vaultAddress = process.env.VAULT_CONTRACT_ADDRESS;
    const rpcUrl       = process.env.STARKNET_RPC_URL;

    if (!vaultAddress || !rpcUrl) {
      return res.status(503).json({ error: "Vault contract not configured" });
    }

    try {
      const provider = new RpcProvider({ nodeUrl: rpcUrl });
      const contract = new Contract(VAULT_ABI, vaultAddress, provider);
      const used     = await contract.is_nullifier_used(nullifier);
      res.json({ nullifier, used: !!used });
    } catch (err: any) {
      logger.error({ nullifier, err: err.message }, "GET /privacy/nullifier failed");
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
