-- Privacy Swap System Database Schema

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(255) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- API keys table
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_hash VARCHAR(64) UNIQUE NOT NULL,
    rate_limit_per_minute INTEGER DEFAULT 60,
    active BOOLEAN DEFAULT true,
    last_used_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    INDEX idx_api_keys_key_hash (key_hash),
    INDEX idx_api_keys_user_id (user_id)
);

-- Swaps table
CREATE TABLE IF NOT EXISTS swaps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    swap_id VARCHAR(64) UNIQUE NOT NULL,
    source_chain VARCHAR(20) NOT NULL,
    dest_chain VARCHAR(20) NOT NULL,
    source_asset INTEGER NOT NULL,
    dest_asset INTEGER NOT NULL,
    amount NUMERIC(78, 0) NOT NULL,
    commitment VARCHAR(66) NOT NULL,
    commitment_hash VARCHAR(66) NOT NULL,
    nullifier_hash VARCHAR(66) NOT NULL,
    amount_commitment VARCHAR(66) NOT NULL,
    merkle_root VARCHAR(66),
    merkle_leaf_index INTEGER,
    recipient_address VARCHAR(255) NOT NULL,
    secret TEXT NOT NULL,
    nullifier_secret TEXT NOT NULL,
    status VARCHAR(20) NOT NULL,
    proof TEXT,
    verification_key TEXT,
    source_tx_hash VARCHAR(66),
    dest_tx_hash VARCHAR(66),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP NOT NULL,
    INDEX idx_swaps_swap_id (swap_id),
    INDEX idx_swaps_status (status),
    INDEX idx_swaps_nullifier_hash (nullifier_hash),
    INDEX idx_swaps_commitment_hash (commitment_hash),
    INDEX idx_swaps_expires_at (expires_at)
);

-- Merkle tree leaves
CREATE TABLE IF NOT EXISTS merkle_leaves (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    leaf_index INTEGER NOT NULL,
    leaf_value VARCHAR(66) NOT NULL,
    tree_id VARCHAR(50) NOT NULL DEFAULT 'main',
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (leaf_index, tree_id),
    INDEX idx_merkle_leaves_tree_id (tree_id),
    INDEX idx_merkle_leaves_leaf_index (leaf_index)
);

-- Merkle tree roots
CREATE TABLE IF NOT EXISTS merkle_roots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    root_hash VARCHAR(66) NOT NULL,
    leaf_count INTEGER NOT NULL,
    tree_id VARCHAR(50) NOT NULL DEFAULT 'main',
    created_at TIMESTAMP DEFAULT NOW(),
    INDEX idx_merkle_roots_tree_id (tree_id),
    INDEX idx_merkle_roots_created_at (created_at)
);

-- Bitcoin commitments
CREATE TABLE IF NOT EXISTS btc_commitments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    txid VARCHAR(64) UNIQUE NOT NULL,
    commitment VARCHAR(66) NOT NULL,
    block_height INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    INDEX idx_btc_commitments_txid (txid),
    INDEX idx_btc_commitments_commitment (commitment),
    INDEX idx_btc_commitments_block_height (block_height)
);

-- Bitcoin HTLCs
CREATE TABLE IF NOT EXISTS btc_htlcs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    txid VARCHAR(64) NOT NULL,
    vout INTEGER NOT NULL,
    script_hash VARCHAR(64) NOT NULL,
    value BIGINT NOT NULL,
    block_height INTEGER NOT NULL,
    claimed BOOLEAN DEFAULT false,
    claim_txid VARCHAR(64),
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (txid, vout),
    INDEX idx_btc_htlcs_script_hash (script_hash),
    INDEX idx_btc_htlcs_claimed (claimed)
);

-- Ethereum commitments
CREATE TABLE IF NOT EXISTS eth_commitments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tx_hash VARCHAR(66) UNIQUE NOT NULL,
    commitment VARCHAR(66) NOT NULL,
    leaf_index NUMERIC(78, 0) NOT NULL,
    merkle_root VARCHAR(66) NOT NULL,
    block_number BIGINT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    INDEX idx_eth_commitments_tx_hash (tx_hash),
    INDEX idx_eth_commitments_commitment (commitment),
    INDEX idx_eth_commitments_block_number (block_number)
);

-- StarkNet commitments
CREATE TABLE IF NOT EXISTS starknet_commitments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tx_hash VARCHAR(66) UNIQUE NOT NULL,
    commitment VARCHAR(66) NOT NULL,
    block_number BIGINT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    INDEX idx_starknet_commitments_tx_hash (tx_hash),
    INDEX idx_starknet_commitments_commitment (commitment)
);

-- Webhook subscriptions
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    url VARCHAR(512) NOT NULL,
    events TEXT[] NOT NULL,
    secret VARCHAR(64) NOT NULL,
    active BOOLEAN DEFAULT true,
    max_retries INTEGER DEFAULT 3,
    retry_delay INTEGER DEFAULT 5000,
    exponential_backoff BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    INDEX idx_webhook_subscriptions_active (active)
);

-- Webhook deliveries
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_id UUID NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
    delivery_id VARCHAR(64) UNIQUE NOT NULL,
    event VARCHAR(100) NOT NULL,
    payload TEXT NOT NULL,
    status_code INTEGER,
    success BOOLEAN NOT NULL,
    attempt INTEGER NOT NULL,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    INDEX idx_webhook_deliveries_subscription_id (subscription_id),
    INDEX idx_webhook_deliveries_delivery_id (delivery_id),
    INDEX idx_webhook_deliveries_created_at (created_at)
);

-- API request logs
CREATE TABLE IF NOT EXISTS api_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id VARCHAR(64) UNIQUE NOT NULL,
    method VARCHAR(10) NOT NULL,
    path VARCHAR(512) NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    status_code INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    INDEX idx_api_logs_request_id (request_id),
    INDEX idx_api_logs_user_id (user_id),
    INDEX idx_api_logs_created_at (created_at)
);

-- Proof generation requests
CREATE TABLE IF NOT EXISTS proof_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id VARCHAR(64) UNIQUE NOT NULL,
    circuit_type VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL,
    proof TEXT,
    public_inputs JSONB,
    verification_key TEXT,
    error_message TEXT,
    generation_time_ms INTEGER,
    created_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP,
    INDEX idx_proof_requests_request_id (request_id),
    INDEX idx_proof_requests_status (status)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_swaps_created_at ON swaps(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_swaps_source_dest ON swaps(source_chain, dest_chain);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_success ON webhook_deliveries(success);

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers for updated_at
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_swaps_updated_at BEFORE UPDATE ON swaps
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_webhook_subscriptions_updated_at BEFORE UPDATE ON webhook_subscriptions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
