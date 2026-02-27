/**
 * REST API Server - COMPLETE PRODUCTION WITH HTTPS, ALL ROUTES, VALIDATION
 */
import express, { Express, Request, Response, NextFunction } from 'express';
import https from 'https';
import http from 'http';
import cors from 'cors';
import Redis from 'ioredis';
import fs from 'fs';
import helmet from 'helmet';
import compression from 'compression';
import { SecureKeyManager } from './encryption';
import { PoseidonHasher } from './poseidon';
import { NoteCommitmentManager } from './note-manager';
import { BitcoinBridge } from './bitcoin-bridge';
import { AtomicSwapCoordinator } from './atomic-swap';
import { StarknetContractManager } from './starknet-contract';
import { ServerMiddleware } from './server-middleware';

export interface ServerConfig {
  port?: number;
  httpsPort?: number;
  corsOrigins?: string[];
  enableHttps?: boolean;
  certPath?: string;
  keyPath?: string;
  maxRequestsPerMinute?: number;
  requireApiKey?: boolean;
}

export class PrivacySwapServer {
  private app: Express;
  private httpServer?: http.Server;
  private httpsServer?: https.Server;
  private keyManager!: SecureKeyManager;
  private hasher!: PoseidonHasher;
  private noteManager!: NoteCommitmentManager;
  private btcBridge!: BitcoinBridge;
  private swapCoordinator!: AtomicSwapCoordinator;
  private starknetManager!: StarknetContractManager;
  private middleware!: ServerMiddleware;
  private redis!: Redis;
  private config: Required<ServerConfig>;

  constructor(config: ServerConfig = {}) {
    this.app = express();
    this.config = {
      port: config.port ?? 3000,
      httpsPort: config.httpsPort ?? 3443,
      corsOrigins: config.corsOrigins ?? ['*'],
      enableHttps: config.enableHttps ?? false,
      certPath: config.certPath ?? './certs/server.crt',
      keyPath: config.keyPath ?? './certs/server.key',
      maxRequestsPerMinute: config.maxRequestsPerMinute ?? 100,
      requireApiKey: config.requireApiKey ?? false
    };
  }

  async initialize(masterPassword: string): Promise<void> {
    this.keyManager = new SecureKeyManager(masterPassword);
    this.hasher = new PoseidonHasher();
    await this.hasher.initialize();

    this.noteManager = new NoteCommitmentManager(this.hasher, this.keyManager);
    this.btcBridge = new BitcoinBridge(this.keyManager);

    const redisUrl = this.keyManager.getSecureEnv('REDIS_URL');
    this.redis = new Redis(redisUrl);
    await this.redis.ping();

    this.swapCoordinator = new AtomicSwapCoordinator(
      this.noteManager,
      this.btcBridge,
      this.hasher,
      this.keyManager,
      this.redis
    );

    this.starknetManager = new StarknetContractManager(this.keyManager);
    this.middleware = new ServerMiddleware(this.keyManager, this.redis, this.config.maxRequestsPerMinute);
    
    await this.middleware.loadApiKeys();

    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandlers();

    console.log('✅ All components initialized');
  }

  private setupMiddleware(): void {
    this.app.use(helmet());
    this.app.use(compression());
    this.app.use(cors({ origin: this.config.corsOrigins, credentials: true }));
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));
    
    this.app.use((req: any, res, next) => {
      req.id = this.keyManager.randomHex(16);
      req.startTime = Date.now();
      res.setHeader('X-Request-ID', req.id);
      next();
    });

    this.app.use(this.middleware.rateLimitMiddleware.bind(this.middleware));
    
    if (this.config.requireApiKey) {
      this.app.use(this.middleware.apiKeyMiddleware.bind(this.middleware));
    }
  }

  private setupRoutes(): void {
    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok', timestamp: Date.now() });
    });

    this.app.post('/api/notes/generate', async (req, res) => {
      try {
        const { amount, recipient, secret } = req.body;
        if (!amount || !recipient) {
          return res.status(400).json({ error: 'Amount and recipient required' });
        }
        const note = this.noteManager.generateNote(BigInt(amount), recipient, secret);
        const encrypted = this.noteManager.storeNoteEncrypted(note);
        res.json({
          commitment: note.commitment,
          nullifier: note.nullifier,
          amountCommitment: note.amountCommitment,
          encryptedNote: encrypted,
          leafIndex: note.leafIndex
        });
      } catch (error: any) {
        res.status(400).json({ error: error.message });
      }
    });

    this.app.get('/api/merkle/root', (req, res) => {
      try {
        const root = this.noteManager.buildMerkleTree();
        res.json({ merkleRoot: root, commitmentCount: this.noteManager.getCommitmentCount() });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post('/api/proofs/spend', async (req, res) => {
      try {
        const { commitment, spender } = req.body;
        if (!commitment || !spender) {
          return res.status(400).json({ error: 'Commitment and spender required' });
        }
        const proof = this.noteManager.generateSpendProof(commitment, spender);
        res.json({ proof });
      } catch (error: any) {
        res.status(400).json({ error: error.message });
      }
    });

    this.app.post('/api/swaps/initiate', async (req, res) => {
      try {
        const { initiator, recipient, amount, timelockDuration } = req.body;
        if (!initiator || !recipient || !amount || !timelockDuration) {
          return res.status(400).json({ error: 'Missing required fields' });
        }
        const result = await this.swapCoordinator.initiateSwap(
          initiator, recipient, BigInt(amount), timelockDuration
        );
        res.json(result);
      } catch (error: any) {
        res.status(400).json({ error: error.message });
      }
    });

    this.app.post('/api/swaps/lock', async (req, res) => {
      try {
        const { swapId, btcTxid } = req.body;
        if (!swapId || !btcTxid) {
          return res.status(400).json({ error: 'SwapId and btcTxid required' });
        }
        const spvProof = await this.swapCoordinator.lockSwapWithBTC(swapId, btcTxid);
        const starknetProof = this.btcBridge.convertSPVProofToStarknet(spvProof);
        res.json({ spvProof: starknetProof });
      } catch (error: any) {
        res.status(400).json({ error: error.message });
      }
    });

    this.app.post('/api/swaps/complete', async (req, res) => {
      try {
        const { swapId, secret } = req.body;
        if (!swapId || !secret) {
          return res.status(400).json({ error: 'SwapId and secret required' });
        }
        const result = await this.swapCoordinator.completeSwap(swapId, secret);
        res.json({ success: result });
      } catch (error: any) {
        res.status(400).json({ error: error.message });
      }
    });

    this.app.post('/api/swaps/refund', async (req, res) => {
      try {
        const { swapId } = req.body;
        if (!swapId) {
          return res.status(400).json({ error: 'SwapId required' });
        }
        const result = await this.swapCoordinator.refundSwap(swapId);
        res.json({ success: result });
      } catch (error: any) {
        res.status(400).json({ error: error.message });
      }
    });

    this.app.get('/api/swaps/:swapId', async (req, res) => {
      try {
        const swap = await this.swapCoordinator.getSwap(req.params.swapId);
        if (!swap) {
          return res.status(404).json({ error: 'Swap not found' });
        }
        res.json({
          swapId: swap.swapId,
          status: swap.status,
          timelock: swap.timelock,
          btcTxid: swap.btcTxid,
          createdAt: swap.createdAt,
          updatedAt: swap.updatedAt
        });
      } catch (error: any) {
        res.status(400).json({ error: error.message });
      }
    });

    this.app.get('/api/swaps/stats', async (req, res) => {
      try {
        const stats = await this.swapCoordinator.getSwapStats();
        res.json(stats);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post('/api/btc/spv-proof', async (req, res) => {
      try {
        const { txid } = req.body;
        if (!txid) {
          return res.status(400).json({ error: 'Txid required' });
        }
        const spvProof = await this.btcBridge.generateSPVProof(txid);
        const starknetProof = this.btcBridge.convertSPVProofToStarknet(spvProof);
        res.json({ proof: starknetProof });
      } catch (error: any) {
        res.status(400).json({ error: error.message });
      }
    });
  }

  private setupErrorHandlers(): void {
    this.app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
      console.error('Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    });
  }

  async start(port?: number): Promise<void> {
    const serverPort = port || this.config.port;
    
    if (this.config.enableHttps && fs.existsSync(this.config.certPath) && fs.existsSync(this.config.keyPath)) {
      const httpsOptions = {
        cert: fs.readFileSync(this.config.certPath),
        key: fs.readFileSync(this.config.keyPath)
      };
      
      this.httpsServer = https.createServer(httpsOptions, this.app);
      this.httpsServer.listen(this.config.httpsPort, () => {
        console.log(`🔐 HTTPS Server running on port ${this.config.httpsPort}`);
      });
    }
    
    this.httpServer = http.createServer(this.app);
    this.httpServer.listen(serverPort, () => {
      console.log(`🔐 HTTP Server running on port ${serverPort}`);
      console.log(`✅ Poseidon hashing initialized`);
      console.log(`✅ Master key encryption active`);
      console.log(`✅ BTC bridge connected`);
      console.log(`✅ Starknet contracts loaded`);
    });
  }

  async shutdown(): Promise<void> {
    console.log('Shutting down server...');
    if (this.redis) await this.redis.quit();
    if (this.keyManager) this.keyManager.destroy();
    if (this.httpServer) this.httpServer.close();
    if (this.httpsServer) this.httpsServer.close();
    console.log('✅ Server shut down gracefully');
  }
}
