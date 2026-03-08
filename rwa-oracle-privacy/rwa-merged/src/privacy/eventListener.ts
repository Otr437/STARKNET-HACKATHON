/**
 * src/privacy/eventListener.ts
 *
 * Listens to ShieldedRWAVault Deposit events on StarkNet,
 * maintains the off-chain Poseidon Merkle tree, and broadcasts
 * real-time updates to frontend clients via WebSocket.
 */

import { RpcProvider, hash } from "starknet";
import { WebSocketServer, WebSocket } from "ws";
import { PoseidonMerkleTree, MerkleProof } from "./merkleTree.js";
import logger from "../utils/logger.js";

// StarkNet event selector: starknet_keccak("Deposit")
const DEPOSIT_SELECTOR = hash.getSelectorFromName("Deposit");

export interface DepositEvent {
  commitment: string;
  leafIndex:  number;
  timestamp:  number;
  blockNumber: number;
  txHash:     string;
}

export class PrivacyEventListener {
  private provider:         RpcProvider;
  private vaultAddress:     string;
  private tree:             PoseidonMerkleTree;
  private wss:              WebSocketServer;
  private clients:          Set<WebSocket> = new Set();
  private lastBlock:        number = 0;
  private deposits:         DepositEvent[] = [];
  private pollIntervalMs:   number;

  constructor(opts: {
    rpcUrl:        string;
    vaultAddress:  string;
    wsPort?:       number;
    pollIntervalMs?: number;
  }) {
    this.provider       = new RpcProvider({ nodeUrl: opts.rpcUrl });
    this.vaultAddress   = opts.vaultAddress;
    this.tree           = new PoseidonMerkleTree();
    this.pollIntervalMs = opts.pollIntervalMs ?? 10_000;

    this.wss = new WebSocketServer({ port: opts.wsPort ?? 8080 });
    this.wss.on("connection", (ws) => this._onClientConnect(ws));

    logger.info({ wsPort: opts.wsPort ?? 8080 }, "PrivacyEventListener: WebSocket ready");
  }

  // ── Start ─────────────────────────────────────────────────
  async start(): Promise<void> {
    logger.info("PrivacyEventListener: syncing historical deposits...");
    await this._syncHistorical();
    logger.info({ count: this.tree.leafCount }, "PrivacyEventListener: historical sync done");

    setInterval(() => this._pollNew().catch(e => {
      logger.error({ err: e.message }, "PrivacyEventListener: poll error");
    }), this.pollIntervalMs);
  }

  // ── Proof API ─────────────────────────────────────────────
  async getProof(leafIndex: number): Promise<MerkleProof> {
    return this.tree.getProof(leafIndex);
  }

  async getRoot(): Promise<string> {
    return this.tree.getRoot();
  }

  getLeaves(): string[] {
    return this.tree.getAllLeaves();
  }

  getDepositCount(): number {
    return this.tree.leafCount;
  }

  getRecentDeposits(limit = 20): DepositEvent[] {
    return this.deposits.slice(-limit).reverse();
  }

  // ── Historical sync ───────────────────────────────────────
  private async _syncHistorical(): Promise<void> {
    if (!this.vaultAddress) return;

    try {
      const events = await this.provider.getEvents({
        address:    this.vaultAddress,
        from_block: { block_number: 0 },
        to_block:   "latest",
        keys:       [[DEPOSIT_SELECTOR]],
        chunk_size: 1000,
      });

      for (const ev of events.events) {
        const commitment  = ev.data[0];
        const leafIndex   = parseInt(ev.data[1], 16);
        const timestamp   = parseInt(ev.data[2], 16);
        const blockNumber = typeof ev.block_number === "number" ? ev.block_number : 0;
        const txHash      = ev.transaction_hash;

        this.tree.insert(commitment);
        this.deposits.push({ commitment, leafIndex, timestamp, blockNumber, txHash });
      }

      this.lastBlock = await this.provider.getBlockNumber();
    } catch (err: any) {
      logger.warn({ err: err.message }, "PrivacyEventListener: historical sync failed");
    }
  }

  // ── Poll for new events ───────────────────────────────────
  private async _pollNew(): Promise<void> {
    if (!this.vaultAddress) return;

    const currentBlock = await this.provider.getBlockNumber();
    if (currentBlock <= this.lastBlock) return;

    const events = await this.provider.getEvents({
      address:    this.vaultAddress,
      from_block: { block_number: this.lastBlock + 1 },
      to_block:   { block_number: currentBlock },
      keys:       [[DEPOSIT_SELECTOR]],
      chunk_size: 100,
    });

    for (const ev of events.events) {
      const commitment  = ev.data[0];
      const leafIndex   = parseInt(ev.data[1], 16);
      const timestamp   = parseInt(ev.data[2], 16);
      const blockNumber = typeof ev.block_number === "number" ? ev.block_number : currentBlock;
      const txHash      = ev.transaction_hash;

      this.tree.insert(commitment);
      const dep: DepositEvent = { commitment, leafIndex, timestamp, blockNumber, txHash };
      this.deposits.push(dep);

      logger.info({ commitment, leafIndex, txHash }, "PrivacyEventListener: new deposit");

      const root = await this.tree.getRoot();
      this._broadcast({ type: "new_deposit", ...dep, root, totalDeposits: this.tree.leafCount });
    }

    this.lastBlock = currentBlock;
  }

  // ── WebSocket ─────────────────────────────────────────────
  private _onClientConnect(ws: WebSocket): void {
    this.clients.add(ws);
    logger.debug("PrivacyEventListener: WS client connected");

    // Send current state immediately
    (async () => {
      const root = await this.tree.getRoot();
      ws.send(JSON.stringify({
        type:          "tree_state",
        root,
        totalDeposits: this.tree.leafCount,
        recentDeposits: this.getRecentDeposits(10),
      }));
    })().catch(() => {});

    ws.on("close",   () => this.clients.delete(ws));
    ws.on("error",   (e) => logger.warn({ err: e.message }, "WS client error"));
  }

  private _broadcast(data: object): void {
    const msg = JSON.stringify(data);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }
}
