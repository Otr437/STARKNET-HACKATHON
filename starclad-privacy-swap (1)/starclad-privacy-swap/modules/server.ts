/**
 * PrivacySwapServer - Production Express server
 * HTTPS/HTTP, all REST routes, Zod validation, graceful shutdown, health checks
 */
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import https from 'https';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import fs from 'fs';
import Redis from 'ioredis';
import { SecureKeyManager } from './encryption';
import { PoseidonHasher } from './poseidon';
import { NoteCommitmentManager } from './note-manager';
import { BitcoinBridge } from './bitcoin-bridge';
import { AtomicSwapCoordinator } from './atomic-swap';
import { StarknetContractManager } from './starknet-contract';
import { ServerMiddleware, Schemas, validate } from './server-middleware';

export interface ServerConfig {
  port?: number;
  httpsPort?: number;
  corsOrigins?: string[];
  enableHttps?: boolean;
  certPath?: string;
  keyPath?: string;
  maxRpm?: number;
  requireApiKey?: boolean;
  enableStarknet?: boolean;
}

export class PrivacySwapServer {
  private app: Express;
  private httpServer?: http.Server;
  private httpsServer?: https.Server;
  private km!: SecureKeyManager;
  private hasher!: PoseidonHasher;
  private noteManager!: NoteCommitmentManager;
  private btcBridge!: BitcoinBridge;
  private swapCoordinator!: AtomicSwapCoordinator;
  private starknet?: StarknetContractManager;
  private middleware!: ServerMiddleware;
  private redis!: Redis;
  private ready = false;
  private readonly cfg: Required<ServerConfig>;

  constructor(cfg: ServerConfig = {}) {
    this.app = express();
    this.cfg = {
      port: cfg.port ?? 3000,
      httpsPort: cfg.httpsPort ?? 3443,
      corsOrigins: cfg.corsOrigins ?? ['*'],
      enableHttps: cfg.enableHttps ?? false,
      certPath: cfg.certPath ?? './certs/server.crt',
      keyPath: cfg.keyPath ?? './certs/server.key',
      maxRpm: cfg.maxRpm ?? 100,
      requireApiKey: cfg.requireApiKey ?? false,
      enableStarknet: cfg.enableStarknet ?? true,
    };
  }

  async initialize(masterPassword: string): Promise<void> {
    // Keys
    this.km = new SecureKeyManager(masterPassword);
    await this.km.initializeAsync(masterPassword);

    // Poseidon
    this.hasher = new PoseidonHasher();
    await this.hasher.initialize();

    // Redis
    const redisUrl = this.km.getSecureEnv('REDIS_URL');
    this.redis = new Redis(redisUrl);
    await this.redis.ping();

    // Core modules
    this.noteManager = new NoteCommitmentManager(this.hasher, this.km, this.redis);
    await this.noteManager.initialize();

    this.btcBridge = new BitcoinBridge(this.km);

    this.swapCoordinator = new AtomicSwapCoordinator(
      this.noteManager, this.btcBridge, this.hasher, this.km, this.redis,
    );

    // Starknet (optional - skip if not configured)
    if (this.cfg.enableStarknet) {
      try {
        this.starknet = new StarknetContractManager(this.km);
        this.starknet.startEventPolling();
      } catch (e: any) {
        console.warn(`[Server] Starknet disabled: ${e.message}`);
      }
    }

    // Middleware
    this.middleware = new ServerMiddleware(this.km, this.redis, this.cfg.maxRpm);
    await this.middleware.loadApiKeys();

    this._setupMiddleware();
    this._setupRoutes();
    this._setupErrors();
    this.ready = true;
    console.log('[Server] all components initialized');
  }

  private _setupMiddleware(): void {
    this.app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"] } } }));
    this.app.use(compression());
    this.app.use(cors({ origin: this.cfg.corsOrigins, credentials: true }));
    this.app.use(express.json({ limit: '1mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '1mb' }));
    this.app.use(this.middleware.requestLogger());
    this.app.use(this.middleware.rateLimiter());
    if (this.cfg.requireApiKey) this.app.use(this.middleware.apiKeyAuth());
  }

  private _setupRoutes(): void {
    const r = express.Router();

    // ── Health ───────────────────────────────────────────────────────────────
    this.app.get('/health', async (_req, res) => {
      try {
        await this.redis.ping();
        res.json({ status: 'ok', uptime: process.uptime(), ts: Date.now(), services: { redis: 'up', poseidon: this.hasher.getMetrics() } });
      } catch {
        res.status(503).json({ status: 'degraded', redis: 'down' });
      }
    });

    this.app.get('/metrics', (_req, res) => {
      res.json({ poseidon: this.hasher.getMetrics(), notes: this.noteManager.getStats() });
    });

    // ── Notes ────────────────────────────────────────────────────────────────
    r.post('/notes/generate', validate(Schemas.generateNote), async (req, res) => {
      const { amount, recipient, secret } = (req as any).validated;
      const note = this.noteManager.generateNote(amount, recipient, secret);
      res.json({
        commitment: note.commitment,
        nullifier: note.nullifier,
        amountCommitment: note.amountCommitment,
        leafIndex: note.leafIndex,
        encryptedNote: this.noteManager.storeNoteEncrypted(note),
      });
    });

    r.get('/notes/merkle-root', (_req, res) => {
      res.json({ merkleRoot: this.noteManager.buildMerkleTree(), commitmentCount: this.noteManager.getCommitmentCount() });
    });

    r.post('/proofs/spend', validate(Schemas.spendProof), async (req, res) => {
      const { commitment, spender } = (req as any).validated;
      const proof = this.noteManager.generateSpendProof(commitment, spender);
      res.json({ proof });
    });

    // ── Swaps ────────────────────────────────────────────────────────────────
    r.post('/swaps/initiate', validate(Schemas.initiateSwap), async (req, res) => {
      const { initiator, recipient, amount, timelockDuration } = (req as any).validated;
      const result = await this.swapCoordinator.initiateSwap(initiator, recipient, amount, timelockDuration);
      res.json(result);
    });

    r.post('/swaps/lock', validate(Schemas.lockSwap), async (req, res) => {
      const { swapId, btcTxid } = (req as any).validated;
      const spv = await this.swapCoordinator.lockWithBTC(swapId, btcTxid);
      res.json({ spvProof: this.btcBridge.convertSPVProofToStarknet(spv) });
    });

    r.post('/swaps/complete', validate(Schemas.completeSwap), async (req, res) => {
      const { swapId, secret } = (req as any).validated;
      const ok = await this.swapCoordinator.completeSwap(swapId, secret);
      res.json({ success: ok });
    });

    r.post('/swaps/refund', validate(Schemas.refundSwap), async (req, res) => {
      const { swapId } = (req as any).validated;
      const ok = await this.swapCoordinator.refundSwap(swapId);
      res.json({ success: ok });
    });

    r.get('/swaps/stats', async (_req, res) => {
      res.json(await this.swapCoordinator.getStats());
    });

    r.get('/swaps/:swapId', async (req, res) => {
      const swap = await this.swapCoordinator.getSwap(req.params.swapId);
      if (!swap) return res.status(404).json({ error: 'Swap not found' });
      // Strip HTLC secret from public response
      const { htlcSecret: _s, ...safe } = swap as any;
      res.json(safe);
    });

    // ── Bitcoin ──────────────────────────────────────────────────────────────
    r.post('/btc/spv-proof', validate(Schemas.spvProof), async (req, res) => {
      const { txid } = (req as any).validated;
      const proof = await this.btcBridge.generateSPVProof(txid);
      res.json({ proof: this.btcBridge.convertSPVProofToStarknet(proof), confirmations: proof.confirmations });
    });

    r.get('/btc/fee-estimate', async (_req, res) => {
      res.json({ feeRate: await this.btcBridge.estimateFee(6) });
    });

    // ── Starknet ─────────────────────────────────────────────────────────────
    r.get('/starknet/merkle-root', async (_req, res) => {
      if (!this.starknet) return res.status(503).json({ error: 'Starknet not configured' });
      res.json({ merkleRoot: await this.starknet.getMerkleRoot() });
    });

    r.get('/starknet/nullifier/:nullifier', async (req, res) => {
      if (!this.starknet) return res.status(503).json({ error: 'Starknet not configured' });
      const spent = await this.starknet.isNullifierSpent(req.params.nullifier);
      res.json({ nullifier: req.params.nullifier, spent });
    });

    r.get('/starknet/balance', async (_req, res) => {
      if (!this.starknet) return res.status(503).json({ error: 'Starknet not configured' });
      res.json({ balance: (await this.starknet.getRelayerBalance()).toString() });
    });

    // Mount all under /api
    this.app.use('/api', r);
  }

  private _setupErrors(): void {
    // 404
    this.app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
    // 500
    this.app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      console.error('[Server] unhandled error:', err);
      res.status(500).json({ error: 'Internal server error' });
    });
  }

  async start(): Promise<void> {
    if (!this.ready) throw new Error('Server not initialized');

    if (this.cfg.enableHttps && fs.existsSync(this.cfg.certPath) && fs.existsSync(this.cfg.keyPath)) {
      const opts = { cert: fs.readFileSync(this.cfg.certPath), key: fs.readFileSync(this.cfg.keyPath) };
      this.httpsServer = https.createServer(opts, this.app);
      await new Promise<void>(r => this.httpsServer!.listen(this.cfg.httpsPort, r));
      console.log(`[Server] HTTPS on :${this.cfg.httpsPort}`);
    }

    this.httpServer = http.createServer(this.app);
    await new Promise<void>(r => this.httpServer!.listen(this.cfg.port, r));
    console.log(`[Server] HTTP on :${this.cfg.port}`);
  }

  async shutdown(): Promise<void> {
    console.log('[Server] shutting down...');
    this.swapCoordinator?.shutdown();
    this.starknet?.shutdown();
    this.km?.destroy();
    await this.redis?.quit();
    await Promise.all([
      this.httpServer && new Promise<void>(r => this.httpServer!.close(() => r())),
      this.httpsServer && new Promise<void>(r => this.httpsServer!.close(() => r())),
    ].filter(Boolean));
    console.log('[Server] shutdown complete');
  }
}
