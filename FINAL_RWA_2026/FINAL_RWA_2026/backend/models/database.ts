// Database models for RWA protocol
// Can be used with MongoDB, PostgreSQL, or any ORM

export interface RWAAsset {
  id: number;
  token_address: string;
  vault_address: string;
  name: string;
  symbol: string;
  asset_type: string;
  par_value: string;
  yield_bps: number;
  inflation_indexed: boolean;
  total_supply_cap: string;
  creator: string;
  created_at: number;
  is_active: boolean;
}

export interface UserPosition {
  user_address: string;
  vault_address: string;
  token_balance: string;
  deposit_usd_value: string;
  entry_cpi: string;
  yield_debt: string;
  total_yield_claimed: string;
  last_updated: number;
}

export interface Transaction {
  id: string;
  tx_hash: string;
  block_number: number;
  timestamp: number;
  type: 'deposit' | 'redeem' | 'claim_yield' | 'rwa_created';
  user_address?: string;
  vault_address?: string;
  amount?: string;
  data: any;
}

export interface OracleUpdate {
  round_id: number;
  publisher: string;
  cpi_value: string;
  cpi_yoy_bps: string;
  tbill_3m_bps: string;
  tbill_10y_bps: string;
  fed_funds_bps: string;
  data_timestamp: number;
  block_timestamp: number;
  tx_hash: string;
}

export interface VaultMetrics {
  vault_address: string;
  tvl: string;
  total_deposited: string;
  total_redeemed: string;
  unique_depositors: number;
  total_yield_distributed: string;
  last_updated: number;
}

// Database service interface
export interface DatabaseService {
  // RWA Assets
  saveRWAAsset(asset: RWAAsset): Promise<void>;
  getRWAAsset(id: number): Promise<RWAAsset | null>;
  getAllRWAAssets(): Promise<RWAAsset[]>;
  updateRWAAsset(id: number, updates: Partial<RWAAsset>): Promise<void>;

  // User Positions
  saveUserPosition(position: UserPosition): Promise<void>;
  getUserPosition(userAddress: string, vaultAddress: string): Promise<UserPosition | null>;
  getUserPositions(userAddress: string): Promise<UserPosition[]>;
  updateUserPosition(userAddress: string, vaultAddress: string, updates: Partial<UserPosition>): Promise<void>;

  // Transactions
  saveTransaction(tx: Transaction): Promise<void>;
  getTransaction(txHash: string): Promise<Transaction | null>;
  getUserTransactions(userAddress: string, limit?: number): Promise<Transaction[]>;
  getVaultTransactions(vaultAddress: string, limit?: number): Promise<Transaction[]>;

  // Oracle Updates
  saveOracleUpdate(update: OracleUpdate): Promise<void>;
  getLatestOracleUpdate(): Promise<OracleUpdate | null>;
  getOracleHistory(limit?: number): Promise<OracleUpdate[]>;

  // Vault Metrics
  saveVaultMetrics(metrics: VaultMetrics): Promise<void>;
  getVaultMetrics(vaultAddress: string): Promise<VaultMetrics | null>;
  getAllVaultMetrics(): Promise<VaultMetrics[]>;
}

// In-memory implementation (for development/testing)
export class InMemoryDatabase implements DatabaseService {
  private rwaAssets: Map<number, RWAAsset> = new Map();
  private userPositions: Map<string, UserPosition> = new Map();
  private transactions: Map<string, Transaction> = new Map();
  private oracleUpdates: OracleUpdate[] = [];
  private vaultMetrics: Map<string, VaultMetrics> = new Map();

  async saveRWAAsset(asset: RWAAsset): Promise<void> {
    this.rwaAssets.set(asset.id, asset);
  }

  async getRWAAsset(id: number): Promise<RWAAsset | null> {
    return this.rwaAssets.get(id) || null;
  }

  async getAllRWAAssets(): Promise<RWAAsset[]> {
    return Array.from(this.rwaAssets.values());
  }

  async updateRWAAsset(id: number, updates: Partial<RWAAsset>): Promise<void> {
    const asset = this.rwaAssets.get(id);
    if (asset) {
      this.rwaAssets.set(id, { ...asset, ...updates });
    }
  }

  async saveUserPosition(position: UserPosition): Promise<void> {
    const key = `${position.user_address}-${position.vault_address}`;
    this.userPositions.set(key, position);
  }

  async getUserPosition(userAddress: string, vaultAddress: string): Promise<UserPosition | null> {
    const key = `${userAddress}-${vaultAddress}`;
    return this.userPositions.get(key) || null;
  }

  async getUserPositions(userAddress: string): Promise<UserPosition[]> {
    return Array.from(this.userPositions.values())
      .filter(p => p.user_address === userAddress);
  }

  async updateUserPosition(userAddress: string, vaultAddress: string, updates: Partial<UserPosition>): Promise<void> {
    const key = `${userAddress}-${vaultAddress}`;
    const position = this.userPositions.get(key);
    if (position) {
      this.userPositions.set(key, { ...position, ...updates });
    }
  }

  async saveTransaction(tx: Transaction): Promise<void> {
    this.transactions.set(tx.tx_hash, tx);
  }

  async getTransaction(txHash: string): Promise<Transaction | null> {
    return this.transactions.get(txHash) || null;
  }

  async getUserTransactions(userAddress: string, limit: number = 50): Promise<Transaction[]> {
    return Array.from(this.transactions.values())
      .filter(tx => tx.user_address === userAddress)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  async getVaultTransactions(vaultAddress: string, limit: number = 50): Promise<Transaction[]> {
    return Array.from(this.transactions.values())
      .filter(tx => tx.vault_address === vaultAddress)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  async saveOracleUpdate(update: OracleUpdate): Promise<void> {
    this.oracleUpdates.push(update);
    this.oracleUpdates.sort((a, b) => b.round_id - a.round_id);
  }

  async getLatestOracleUpdate(): Promise<OracleUpdate | null> {
    return this.oracleUpdates[0] || null;
  }

  async getOracleHistory(limit: number = 100): Promise<OracleUpdate[]> {
    return this.oracleUpdates.slice(0, limit);
  }

  async saveVaultMetrics(metrics: VaultMetrics): Promise<void> {
    this.vaultMetrics.set(metrics.vault_address, metrics);
  }

  async getVaultMetrics(vaultAddress: string): Promise<VaultMetrics | null> {
    return this.vaultMetrics.get(vaultAddress) || null;
  }

  async getAllVaultMetrics(): Promise<VaultMetrics[]> {
    return Array.from(this.vaultMetrics.values());
  }
}

// PostgreSQL implementation (production)
import { Pool } from 'pg';

export class PostgreSQLDatabase implements DatabaseService {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async init(): Promise<void> {
    // Create tables if they don't exist
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS rwa_assets (
        id INTEGER PRIMARY KEY,
        token_address TEXT NOT NULL,
        vault_address TEXT NOT NULL,
        name TEXT NOT NULL,
        symbol TEXT NOT NULL,
        asset_type TEXT NOT NULL,
        par_value TEXT NOT NULL,
        yield_bps INTEGER NOT NULL,
        inflation_indexed BOOLEAN NOT NULL,
        total_supply_cap TEXT NOT NULL,
        creator TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        is_active BOOLEAN NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_positions (
        user_address TEXT NOT NULL,
        vault_address TEXT NOT NULL,
        token_balance TEXT NOT NULL,
        deposit_usd_value TEXT NOT NULL,
        entry_cpi TEXT NOT NULL,
        yield_debt TEXT NOT NULL,
        total_yield_claimed TEXT NOT NULL,
        last_updated BIGINT NOT NULL,
        PRIMARY KEY (user_address, vault_address)
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        tx_hash TEXT UNIQUE NOT NULL,
        block_number INTEGER NOT NULL,
        timestamp BIGINT NOT NULL,
        type TEXT NOT NULL,
        user_address TEXT,
        vault_address TEXT,
        amount TEXT,
        data JSONB
      );

      CREATE TABLE IF NOT EXISTS oracle_updates (
        round_id INTEGER PRIMARY KEY,
        publisher TEXT NOT NULL,
        cpi_value TEXT NOT NULL,
        cpi_yoy_bps TEXT NOT NULL,
        tbill_3m_bps TEXT NOT NULL,
        tbill_10y_bps TEXT NOT NULL,
        fed_funds_bps TEXT NOT NULL,
        data_timestamp BIGINT NOT NULL,
        block_timestamp BIGINT NOT NULL,
        tx_hash TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS vault_metrics (
        vault_address TEXT PRIMARY KEY,
        tvl TEXT NOT NULL,
        total_deposited TEXT NOT NULL,
        total_redeemed TEXT NOT NULL,
        unique_depositors INTEGER NOT NULL,
        total_yield_distributed TEXT NOT NULL,
        last_updated BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS analytics_events (
        id SERIAL PRIMARY KEY,
        event_type TEXT NOT NULL,
        event_data JSONB NOT NULL,
        timestamp BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        wallet_address TEXT PRIMARY KEY,
        email TEXT,
        email_verified BOOLEAN DEFAULT false,
        created_at BIGINT NOT NULL,
        last_login BIGINT
      );

      CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_address, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_transactions_vault ON transactions(vault_address, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_oracle_updates_round ON oracle_updates(round_id DESC);
      CREATE INDEX IF NOT EXISTS idx_analytics_events_type ON analytics_events(event_type, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;
    `);
  }

  async saveRWAAsset(asset: RWAAsset): Promise<void> {
    await this.pool.query(
      `INSERT INTO rwa_assets (id, token_address, vault_address, name, symbol, asset_type, par_value, yield_bps, inflation_indexed, total_supply_cap, creator, created_at, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (id) DO UPDATE SET
         token_address = EXCLUDED.token_address,
         vault_address = EXCLUDED.vault_address,
         name = EXCLUDED.name,
         symbol = EXCLUDED.symbol,
         asset_type = EXCLUDED.asset_type,
         par_value = EXCLUDED.par_value,
         yield_bps = EXCLUDED.yield_bps,
         inflation_indexed = EXCLUDED.inflation_indexed,
         total_supply_cap = EXCLUDED.total_supply_cap,
         creator = EXCLUDED.creator,
         created_at = EXCLUDED.created_at,
         is_active = EXCLUDED.is_active`,
      [asset.id, asset.token_address, asset.vault_address, asset.name, asset.symbol, asset.asset_type, asset.par_value, asset.yield_bps, asset.inflation_indexed, asset.total_supply_cap, asset.creator, asset.created_at, asset.is_active]
    );
  }

  async getRWAAsset(id: number): Promise<RWAAsset | null> {
    const result = await this.pool.query('SELECT * FROM rwa_assets WHERE id = $1', [id]);
    return result.rows[0] || null;
  }

  async getAllRWAAssets(): Promise<RWAAsset[]> {
    const result = await this.pool.query('SELECT * FROM rwa_assets ORDER BY created_at DESC');
    return result.rows;
  }

  async updateRWAAsset(id: number, updates: Partial<RWAAsset>): Promise<void> {
    const fields = Object.keys(updates).map((key, i) => `${key} = $${i + 2}`).join(', ');
    const values = Object.values(updates);
    await this.pool.query(`UPDATE rwa_assets SET ${fields} WHERE id = $1`, [id, ...values]);
  }

  async saveUserPosition(position: UserPosition): Promise<void> {
    await this.pool.query(
      `INSERT INTO user_positions (user_address, vault_address, token_balance, deposit_usd_value, entry_cpi, yield_debt, total_yield_claimed, last_updated)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_address, vault_address) DO UPDATE SET
         token_balance = EXCLUDED.token_balance,
         deposit_usd_value = EXCLUDED.deposit_usd_value,
         entry_cpi = EXCLUDED.entry_cpi,
         yield_debt = EXCLUDED.yield_debt,
         total_yield_claimed = EXCLUDED.total_yield_claimed,
         last_updated = EXCLUDED.last_updated`,
      [position.user_address, position.vault_address, position.token_balance, position.deposit_usd_value, position.entry_cpi, position.yield_debt, position.total_yield_claimed, position.last_updated]
    );
  }

  async getUserPosition(userAddress: string, vaultAddress: string): Promise<UserPosition | null> {
    const result = await this.pool.query(
      'SELECT * FROM user_positions WHERE user_address = $1 AND vault_address = $2',
      [userAddress, vaultAddress]
    );
    return result.rows[0] || null;
  }

  async getUserPositions(userAddress: string): Promise<UserPosition[]> {
    const result = await this.pool.query(
      'SELECT * FROM user_positions WHERE user_address = $1',
      [userAddress]
    );
    return result.rows;
  }

  async updateUserPosition(userAddress: string, vaultAddress: string, updates: Partial<UserPosition>): Promise<void> {
    const fields = Object.keys(updates).map((key, i) => `${key} = $${i + 3}`).join(', ');
    const values = Object.values(updates);
    await this.pool.query(
      `UPDATE user_positions SET ${fields} WHERE user_address = $1 AND vault_address = $2`,
      [userAddress, vaultAddress, ...values]
    );
  }

  async saveTransaction(tx: Transaction): Promise<void> {
    await this.pool.query(
      `INSERT INTO transactions (id, tx_hash, block_number, timestamp, type, user_address, vault_address, amount, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (tx_hash) DO NOTHING`,
      [tx.id, tx.tx_hash, tx.block_number, tx.timestamp, tx.type, tx.user_address, tx.vault_address, tx.amount, JSON.stringify(tx.data)]
    );
  }

  async getTransaction(txHash: string): Promise<Transaction | null> {
    const result = await this.pool.query('SELECT * FROM transactions WHERE tx_hash = $1', [txHash]);
    if (result.rows[0]) {
      result.rows[0].data = JSON.parse(result.rows[0].data);
    }
    return result.rows[0] || null;
  }

  async getUserTransactions(userAddress: string, limit: number = 50): Promise<Transaction[]> {
    const result = await this.pool.query(
      'SELECT * FROM transactions WHERE user_address = $1 ORDER BY timestamp DESC LIMIT $2',
      [userAddress, limit]
    );
    return result.rows.map(row => ({ ...row, data: JSON.parse(row.data) }));
  }

  async getVaultTransactions(vaultAddress: string, limit: number = 50): Promise<Transaction[]> {
    const result = await this.pool.query(
      'SELECT * FROM transactions WHERE vault_address = $1 ORDER BY timestamp DESC LIMIT $2',
      [vaultAddress, limit]
    );
    return result.rows.map(row => ({ ...row, data: JSON.parse(row.data) }));
  }

  async saveOracleUpdate(update: OracleUpdate): Promise<void> {
    await this.pool.query(
      `INSERT INTO oracle_updates (round_id, publisher, cpi_value, cpi_yoy_bps, tbill_3m_bps, tbill_10y_bps, fed_funds_bps, data_timestamp, block_timestamp, tx_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (round_id) DO NOTHING`,
      [update.round_id, update.publisher, update.cpi_value, update.cpi_yoy_bps, update.tbill_3m_bps, update.tbill_10y_bps, update.fed_funds_bps, update.data_timestamp, update.block_timestamp, update.tx_hash]
    );
  }

  async getLatestOracleUpdate(): Promise<OracleUpdate | null> {
    const result = await this.pool.query('SELECT * FROM oracle_updates ORDER BY round_id DESC LIMIT 1');
    return result.rows[0] || null;
  }

  async getOracleHistory(limit: number = 100): Promise<OracleUpdate[]> {
    const result = await this.pool.query('SELECT * FROM oracle_updates ORDER BY round_id DESC LIMIT $1', [limit]);
    return result.rows;
  }

  async saveVaultMetrics(metrics: VaultMetrics): Promise<void> {
    await this.pool.query(
      `INSERT INTO vault_metrics (vault_address, tvl, total_deposited, total_redeemed, unique_depositors, total_yield_distributed, last_updated)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (vault_address) DO UPDATE SET
         tvl = EXCLUDED.tvl,
         total_deposited = EXCLUDED.total_deposited,
         total_redeemed = EXCLUDED.total_redeemed,
         unique_depositors = EXCLUDED.unique_depositors,
         total_yield_distributed = EXCLUDED.total_yield_distributed,
         last_updated = EXCLUDED.last_updated`,
      [metrics.vault_address, metrics.tvl, metrics.total_deposited, metrics.total_redeemed, metrics.unique_depositors, metrics.total_yield_distributed, metrics.last_updated]
    );
  }

  async getVaultMetrics(vaultAddress: string): Promise<VaultMetrics | null> {
    const result = await this.pool.query('SELECT * FROM vault_metrics WHERE vault_address = $1', [vaultAddress]);
    return result.rows[0] || null;
  }

  async getAllVaultMetrics(): Promise<VaultMetrics[]> {
    const result = await this.pool.query('SELECT * FROM vault_metrics');
    return result.rows;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// Auto-select database based on environment
const DATABASE_URL = process.env.DATABASE_URL;
export const db: DatabaseService = DATABASE_URL && DATABASE_URL.startsWith('postgres')
  ? new PostgreSQLDatabase(DATABASE_URL)
  : new InMemoryDatabase();

// Initialize PostgreSQL if using it
if (db instanceof PostgreSQLDatabase) {
  (db as PostgreSQLDatabase).init().catch(console.error);
}
