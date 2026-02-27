/*
═══════════════════════════════════════════════════════════
🔐 CRYPTO-PROTECTED CODE 🔐
═══════════════════════════════════════════════════════════

Author:           Leon Sage
Organization:     Sage Audio LLC
Copyright:        © 2025 Leon Sage. All Rights Reserved.
License:          Proprietary
Signed:           2026-01-28 15:00:00
Certificate:      CodeSigning-LeonSage-Rust

CRYPTOGRAPHIC FINGERPRINT:
SHA-256:  E7DC5EEHI5JH4EEJ8CCFHEC9JH9E6

604C8HH0AFCHI08IHH9I5405F8HC95GG059I
SHA-512:  879G39CE660I0H75HBEFHI0446E8FJG9IIE7JHJGKI9J6GCDK3J8DHDE4565C77E679FG058000EG CD4JI9IFF C6H954J46829J767E9E4F8DE8J78D C6CC5914844I
MD5:      D7E6I8G9H8B6BKEK95ICE7JI98G86GGC0J
File Size: 47892 bytes

LICENSE:
PROPRIETARY LICENSE

Copyright (c) 2026 Leon Sage. All Rights Reserved.
Sage Audio LLC

This software is proprietary and confidential property of Leon Sage.
UNAUTHORIZED COPYING, MODIFICATION, DISTRIBUTION, OR USE IS STRICTLY PROHIBITED.

⚠️  ANTI-THEFT NOTICE:
This code is cryptographically signed and protected. Any
unauthorized modification, distribution, or removal of this
protection constitutes copyright infringement.
═══════════════════════════════════════════════════════════
*/

// Cargo.toml dependencies - see separate file

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{delete, get, post},
    Json, Router,
};
use dashmap::DashMap;
use ethers::{
    providers::{Http, Middleware, Provider},
    types::{Address, TransactionReceipt, TransactionRequest, H256, U256, U64},
};
use redis::{aio::ConnectionManager, AsyncCommands};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    str::FromStr,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{sync::RwLock, time};
use tracing::{error, info, warn};

// ============================================================================
// TYPES & STRUCTURES
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum TxStatus {
    Pending,
    Building,
    Signing,
    Submitted,
    Confirming,
    Confirmed,
    Failed,
    Replaced,
    Dropped,
    Cancelled,
    Timeout,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct NonceData {
    current: u64,
    pending: u64,
    confirmed: u64,
    last_updated: u64,
    last_synced: u64,
    address: String,
    chain_id: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GasParams {
    gas_limit: String,
    max_fee_per_gas: Option<String>,
    max_priority_fee_per_gas: Option<String>,
    gas_price: Option<String>,
    #[serde(rename = "type")]
    tx_type: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TxState {
    tx_id: String,
    tx_hash: Option<String>,
    chain_id: u64,
    chain_name: String,
    from: String,
    to: String,
    value: String,
    data: String,
    nonce: u64,
    status: TxStatus,
    submitted_at: Option<u64>,
    confirmed_at: Option<u64>,
    failed_at: Option<u64>,
    replaced_at: Option<u64>,
    cancelled_at: Option<u64>,
    dropped_at: Option<u64>,
    timeout_occurred_at: Option<u64>,
    block_number: Option<u64>,
    gas_used: Option<String>,
    effective_gas_price: Option<String>,
    gas_params: GasParams,
    retry_count: u32,
    key_id: String,
    timeout_at: u64,
    confirmation_target: u64,
    confirmation_time: Option<u64>,
    error: Option<String>,
    replaced_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Metrics {
    total_submitted: u64,
    total_confirmed: u64,
    total_failed: u64,
    total_replaced: u64,
    total_dropped: u64,
    avg_confirmation_time: u64,
    start_time: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FailedTx {
    tx_id: String,
    chain_id: u64,
    transaction: serde_json::Value,
    error: String,
    attempts: u32,
    timestamp: u64,
}

#[derive(Clone)]
struct AppState {
    redis: ConnectionManager,
    nonce_trackers: Arc<DashMap<String, NonceData>>,
    pending_txs: Arc<DashMap<String, TxState>>,
    tx_history: Arc<DashMap<String, TxState>>,
    replacement_txs: Arc<DashMap<String, String>>,
    failed_txs: Arc<DashMap<String, FailedTx>>,
    metrics: Arc<RwLock<Metrics>>,
    config: Config,
}

#[derive(Debug, Clone)]
struct Config {
    port: u16,
    redis_url: String,
    chain_connector_url: String,
    key_manager_url: String,
    gas_manager_url: String,
    max_pending_tx: usize,
    tx_timeout: Duration,
    confirmation_blocks: u64,
    auto_speedup_enabled: bool,
    auto_speedup_threshold: Duration,
    max_retry_attempts: u32,
    nonce_sync_interval: Duration,
}

#[derive(Debug, thiserror::Error)]
enum ServiceError {
    #[error("Redis error: {0}")]
    Redis(String),
    #[error("Provider error: {0}")]
    Provider(String),
    #[error("Transaction error: {0}")]
    Transaction(String),
    #[error("Not found: {0}")]
    NotFound(String),
    #[error("Invalid request: {0}")]
    InvalidRequest(String),
    #[error("Too many pending transactions")]
    TooManyPending,
    #[error("{0}")]
    Other(String),
}

impl IntoResponse for ServiceError {
    fn into_response(self) -> axum::response::Response {
        let (status, message) = match self {
            ServiceError::Redis(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg),
            ServiceError::Provider(msg) => (StatusCode::BAD_GATEWAY, msg),
            ServiceError::Transaction(msg) => (StatusCode::BAD_REQUEST, msg),
            ServiceError::NotFound(msg) => (StatusCode::NOT_FOUND, msg),
            ServiceError::InvalidRequest(msg) => (StatusCode::BAD_REQUEST, msg),
            ServiceError::TooManyPending => {
                (StatusCode::TOO_MANY_REQUESTS, self.to_string())
            }
            ServiceError::Other(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg),
        };

        (status, Json(serde_json::json!({ "error": message }))).into_response()
    }
}

// ============================================================================
// CHAIN METADATA
// ============================================================================

lazy_static::lazy_static! {
    static ref CHAIN_NAMES: HashMap<u64, &'static str> = {
        let mut m = HashMap::new();
        m.insert(1, "Ethereum");
        m.insert(56, "BSC");
        m.insert(137, "Polygon");
        m.insert(42161, "Arbitrum");
        m.insert(10, "Optimism");
        m.insert(43114, "Avalanche");
        m.insert(8453, "Base");
        m.insert(250, "Fantom");
        m
    };
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

fn get_current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

fn get_chain_name(chain_id: u64) -> String {
    CHAIN_NAMES
        .get(&chain_id)
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("Chain {}", chain_id))
}

fn generate_tx_id() -> String {
    use rand::Rng;
    let random_bytes: Vec<u8> = (0..6).map(|_| rand::thread_rng().gen()).collect();
    format!(
        "tx_{}_{}",
        get_current_timestamp(),
        hex::encode(random_bytes)
    )
}

// ============================================================================
// PROVIDER MANAGEMENT
// ============================================================================

async fn get_provider(
    state: &AppState,
    chain_id: u64,
) -> Result<Provider<Http>, ServiceError> {
    let cache_key = format!("provider_{}", chain_id);

    let mut redis_conn = state.redis.clone();
    if let Ok(Some(rpc_url)) = redis_conn.get::<_, Option<String>>(&cache_key).await {
        if let Ok(provider) = Provider::<Http>::try_from(rpc_url) {
            return Ok(provider);
        }
    }

    let url = format!("{}/provider/{}", state.config.chain_connector_url, chain_id);
    let response = reqwest::get(&url)
        .await
        .map_err(|e| ServiceError::Provider(format!("Failed to connect: {}", e)))?;

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| ServiceError::Provider(format!("Invalid response: {}", e)))?;

    let rpc_url = json["rpc"]
        .as_str()
        .ok_or_else(|| ServiceError::Provider("No RPC URL in response".to_string()))?;

    let _: Result<(), _> = redis_conn.set_ex(&cache_key, rpc_url, 3600).await;

    Provider::<Http>::try_from(rpc_url)
        .map_err(|e| ServiceError::Provider(format!("Invalid provider: {}", e)))
}

// ============================================================================
// NONCE MANAGEMENT
// ============================================================================

async fn get_nonce(
    state: &AppState,
    chain_id: u64,
    address: &str,
    increment: bool,
) -> Result<u64, ServiceError> {
    let key = format!("{}:{}", chain_id, address.to_lowercase());

    let mut nonce_data = if let Some(data) = state.nonce_trackers.get(&key) {
        data.clone()
    } else {
        let provider = get_provider(state, chain_id).await?;
        let addr = Address::from_str(address)
            .map_err(|e| ServiceError::InvalidRequest(format!("Invalid address: {}", e)))?;

        let chain_nonce = provider
            .get_transaction_count(addr, None)
            .await
            .map_err(|e| ServiceError::Provider(e.to_string()))?
            .as_u64();

        let data = NonceData {
            current: chain_nonce,
            pending: chain_nonce,
            confirmed: chain_nonce,
            last_updated: get_current_timestamp(),
            last_synced: get_current_timestamp(),
            address: address.to_lowercase(),
            chain_id,
        };

        state.nonce_trackers.insert(key.clone(), data.clone());
        data
    };

    let nonce = nonce_data.current;

    if increment {
        nonce_data.current += 1;
        nonce_data.pending = nonce_data.current;
        nonce_data.last_updated = get_current_timestamp();
        state.nonce_trackers.insert(key.clone(), nonce_data.clone());
    }

    // Store in Redis
    let mut redis_conn = state.redis.clone();
    let json = serde_json::to_string(&nonce_data).unwrap();
    let _: Result<(), _> = redis_conn.set_ex(&format!("nonce:{}", key), json, 3600).await;

    info!(
        "[NONCE-{}] Address {}... nonce: {}{}",
        get_chain_name(chain_id),
        &address[..10],
        nonce,
        if increment { " (incremented)" } else { "" }
    );

    Ok(nonce)
}

async fn reset_nonce(
    state: &AppState,
    chain_id: u64,
    address: &str,
) -> Result<u64, ServiceError> {
    let key = format!("{}:{}", chain_id, address.to_lowercase());
    let provider = get_provider(state, chain_id).await?;
    let addr = Address::from_str(address)
        .map_err(|e| ServiceError::InvalidRequest(format!("Invalid address: {}", e)))?;

    let chain_nonce = provider
        .get_transaction_count(addr, None)
        .await
        .map_err(|e| ServiceError::Provider(e.to_string()))?
        .as_u64();

    let nonce_data = NonceData {
        current: chain_nonce,
        pending: chain_nonce,
        confirmed: chain_nonce,
        last_updated: get_current_timestamp(),
        last_synced: get_current_timestamp(),
        address: address.to_lowercase(),
        chain_id,
    };

    state.nonce_trackers.insert(key.clone(), nonce_data.clone());

    let mut redis_conn = state.redis.clone();
    let json = serde_json::to_string(&nonce_data).unwrap();
    let _: Result<(), _> = redis_conn.set_ex(&format!("nonce:{}", key), json, 3600).await;

    info!(
        "[NONCE-{}] Reset nonce for {} to {}",
        get_chain_name(chain_id),
        address,
        chain_nonce
    );

    Ok(chain_nonce)
}

async fn sync_nonce(
    state: &AppState,
    chain_id: u64,
    address: &str,
) -> Result<u64, ServiceError> {
    let key = format!("{}:{}", chain_id, address.to_lowercase());
    let provider = get_provider(state, chain_id).await?;
    let addr = Address::from_str(address)
        .map_err(|e| ServiceError::InvalidRequest(format!("Invalid address: {}", e)))?;

    let chain_nonce = provider
        .get_transaction_count(addr, None)
        .await
        .map_err(|e| ServiceError::Provider(e.to_string()))?
        .as_u64();

    if let Some(mut nonce_data) = state.nonce_trackers.get_mut(&key) {
        nonce_data.confirmed = chain_nonce;
        nonce_data.last_synced = get_current_timestamp();

        if chain_nonce > nonce_data.current {
            info!(
                "[NONCE-{}] Syncing nonce gap: {} -> {}",
                get_chain_name(chain_id),
                nonce_data.current,
                chain_nonce
            );
            nonce_data.current = chain_nonce;
            nonce_data.pending = chain_nonce;
        }

        let mut redis_conn = state.redis.clone();
        let json = serde_json::to_string(&*nonce_data).unwrap();
        let _: Result<(), _> = redis_conn.set_ex(&format!("nonce:{}", key), json, 3600).await;
    }

    Ok(chain_nonce)
}

// Periodic nonce sync task
async fn nonce_sync_task(state: AppState) {
    let mut interval = time::interval(state.config.nonce_sync_interval);

    loop {
        interval.tick().await;

        for entry in state.nonce_trackers.iter() {
            let nonce_data = entry.value();
            if let Err(e) = sync_nonce(&state, nonce_data.chain_id, &nonce_data.address).await {
                error!("[NONCE-SYNC] Failed to sync {}: {}", entry.key(), e);
            }
        }
    }
}

// ============================================================================
// TRANSACTION BUILDING
// ============================================================================

#[derive(Debug, Deserialize)]
struct BuildTxParams {
    from: String,
    to: String,
    #[serde(default)]
    value: String,
    #[serde(default = "default_data")]
    data: String,
    #[serde(default = "default_gas_strategy")]
    gas_strategy: String,
    custom_gas_multiplier: Option<f64>,
    gas_limit: Option<String>,
    max_priority_fee_per_gas: Option<String>,
    max_fee_per_gas: Option<String>,
    gas_price: Option<String>,
}

fn default_data() -> String {
    "0x".to_string()
}

fn default_gas_strategy() -> String {
    "fast".to_string()
}

async fn estimate_gas_limit(
    provider: &Provider<Http>,
    tx_req: &TransactionRequest,
) -> Result<String, ServiceError> {
    match provider.estimate_gas(tx_req, None).await {
        Ok(estimate) => {
            let buffered = estimate * 120 / 100;
            Ok(buffered.to_string())
        }
        Err(e) => {
            warn!("[TX-MANAGER] Gas estimation failed: {}, using default", e);
            Ok(if tx_req.data.as_ref().map_or(true, |d| d.is_empty()) {
                "21000"
            } else {
                "200000"
            }
            .to_string())
        }
    }
}

async fn build_transaction(
    state: &AppState,
    chain_id: u64,
    params: BuildTxParams,
) -> Result<serde_json::Value, ServiceError> {
    info!(
        "[TX-MANAGER-{}] Building transaction from {}... to {}...",
        get_chain_name(chain_id),
        &params.from[..10],
        &params.to[..10]
    );

    let nonce = get_nonce(state, chain_id, &params.from, true).await?;

    let from_addr = Address::from_str(&params.from)
        .map_err(|e| ServiceError::InvalidRequest(format!("Invalid from address: {}", e)))?;
    let to_addr = Address::from_str(&params.to)
        .map_err(|e| ServiceError::InvalidRequest(format!("Invalid to address: {}", e)))?;

    let value = U256::from_dec_str(&params.value).unwrap_or(U256::zero());
    let data = hex::decode(params.data.trim_start_matches("0x"))
        .unwrap_or_default()
        .into();

    let mut tx_req = TransactionRequest::new()
        .from(from_addr)
        .to(to_addr)
        .value(value)
        .data(data)
        .nonce(nonce);

    // Estimate or use provided gas limit
    let gas_limit = if let Some(limit) = params.gas_limit {
        limit
    } else {
        let provider = get_provider(state, chain_id).await?;
        estimate_gas_limit(&provider, &tx_req).await?
    };

    tx_req = tx_req.gas(U256::from_dec_str(&gas_limit).unwrap_or(U256::from(21000)));

    // Get or use provided gas parameters
    let (tx_type, max_fee, max_priority, gas_price) =
        if params.max_fee_per_gas.is_some() || params.gas_price.is_none() {
            // EIP-1559 or fetch from gas manager
            if let Some(max_fee) = params.max_fee_per_gas {
                let max_priority = params.max_priority_fee_per_gas.unwrap_or(max_fee.clone());
                (2, Some(max_fee), Some(max_priority), None)
            } else {
                // Fetch from gas manager
                let url = format!("{}/gas/{}/calculate", state.config.gas_manager_url, chain_id);
                let body = serde_json::json!({
                    "strategy": params.gas_strategy,
                    "customMultiplier": params.custom_gas_multiplier
                });

                match reqwest::Client::new()
                    .post(&url)
                    .json(&body)
                    .timeout(Duration::from_secs(5))
                    .send()
                    .await
                {
                    Ok(response) => {
                        let json: serde_json::Value = response.json().await.map_err(|e| {
                            ServiceError::Other(format!("Gas manager response error: {}", e))
                        })?;

                        if let Some(gas_params) = json.get("gasParams") {
                            let tx_type = gas_params["type"].as_u64().unwrap_or(0) as u8;
                            if tx_type == 2 {
                                (
                                    2,
                                    gas_params["maxFeePerGas"]
                                        .as_str()
                                        .map(|s| s.to_string()),
                                    gas_params["maxPriorityFeePerGas"]
                                        .as_str()
                                        .map(|s| s.to_string()),
                                    None,
                                )
                            } else {
                                (
                                    0,
                                    None,
                                    None,
                                    gas_params["gasPrice"].as_str().map(|s| s.to_string()),
                                )
                            }
                        } else {
                            // Default fallback
                            (0, None, None, Some("10000000000".to_string()))
                        }
                    }
                    Err(e) => {
                        warn!("[TX-MANAGER] Gas manager unavailable: {}", e);
                        (0, None, None, Some("10000000000".to_string()))
                    }
                }
            }
        } else {
            // Legacy gas price
            (0, None, None, params.gas_price)
        };

    info!(
        "[TX-MANAGER-{}] Transaction built: nonce={}, gasLimit={}",
        get_chain_name(chain_id),
        nonce,
        gas_limit
    );

    Ok(serde_json::json!({
        "chainId": chain_id,
        "from": params.from,
        "to": params.to,
        "value": params.value,
        "data": params.data,
        "nonce": nonce,
        "gasLimit": gas_limit,
        "type": tx_type,
        "maxFeePerGas": max_fee,
        "maxPriorityFeePerGas": max_priority,
        "gasPrice": gas_price
    }))
}

// ============================================================================
// TRANSACTION SUBMISSION
// ============================================================================

#[derive(Debug, Deserialize)]
struct SubmitOptions {
    #[serde(default = "default_true")]
    retry_on_failure: bool,
    #[serde(default)]
    max_retries: Option<u32>,
}

fn default_true() -> bool {
    true
}

async fn submit_transaction(
    state: &AppState,
    chain_id: u64,
    key_id: String,
    transaction: serde_json::Value,
    options: SubmitOptions,
) -> Result<TxState, ServiceError> {
    let tx_id = generate_tx_id();
    let max_retries = options.max_retries.unwrap_or(state.config.max_retry_attempts);

    let mut last_error = None;

    for attempt in 0..=max_retries {
        info!(
            "[TX-MANAGER-{}] Submitting transaction (attempt {}/{})",
            get_chain_name(chain_id),
            attempt + 1,
            max_retries + 1
        );

        match try_submit(state, chain_id, &key_id, &transaction, &tx_id, attempt).await {
            Ok(tx_state) => return Ok(tx_state),
            Err(e) => {
                last_error = Some(e);
                if !options.retry_on_failure || attempt >= max_retries {
                    break;
                }
                time::sleep(Duration::from_secs((attempt + 1) as u64)).await;
            }
        }
    }

    // Decrement nonce on failure
    let from = transaction["from"].as_str().unwrap_or("");
    let key = format!("{}:{}", chain_id, from.to_lowercase());
    if let Some(mut nonce_data) = state.nonce_trackers.get_mut(&key) {
        if nonce_data.current > 0 {
            nonce_data.current -= 1;
            nonce_data.pending = nonce_data.current;
        }
    }

    let mut metrics = state.metrics.write().await;
    metrics.total_failed += 1;
    drop(metrics);

    let error_msg = last_error
        .map(|e| e.to_string())
        .unwrap_or_else(|| "Unknown error".to_string());

    state.failed_txs.insert(
        tx_id.clone(),
        FailedTx {
            tx_id: tx_id.clone(),
            chain_id,
            transaction,
            error: error_msg.clone(),
            attempts: max_retries + 1,
            timestamp: get_current_timestamp(),
        },
    );

    Err(ServiceError::Transaction(format!(
        "Failed after {} attempts: {}",
        max_retries + 1,
        error_msg
    )))
}

async fn try_submit(
    state: &AppState,
    chain_id: u64,
    key_id: &str,
    transaction: &serde_json::Value,
    tx_id: &str,
    attempt: u32,
) -> Result<TxState, ServiceError> {
    // Sign transaction
    let url = format!("{}/key/{}/sign/transaction", state.config.key_manager_url, key_id);
    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .json(transaction)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| ServiceError::Transaction(format!("Signing failed: {}", e)))?;

    let sign_result: serde_json::Value = response
        .json()
        .await
        .map_err(|e| ServiceError::Transaction(format!("Invalid sign response: {}", e)))?;

    let signed_tx = sign_result["signedTransaction"]
        .as_str()
        .ok_or_else(|| ServiceError::Transaction("No signed transaction in response".to_string()))?;

    // Submit to blockchain
    let provider = get_provider(state, chain_id).await?;
    let pending_tx = provider
        .send_raw_transaction(hex::decode(signed_tx.trim_start_matches("0x")).unwrap().into())
        .await
        .map_err(|e| ServiceError::Provider(format!("Broadcast failed: {}", e)))?;

    let tx_hash = format!("0x{}", hex::encode(pending_tx.tx_hash()));

    let tx_state = TxState {
        tx_id: tx_id.to_string(),
        tx_hash: Some(tx_hash.clone()),
        chain_id,
        chain_name: get_chain_name(chain_id),
        from: transaction["from"].as_str().unwrap_or("").to_string(),
        to: transaction["to"].as_str().unwrap_or("").to_string(),
        value: transaction["value"].as_str().unwrap_or("0").to_string(),
        data: transaction["data"].as_str().unwrap_or("0x").to_string(),
        nonce: transaction["nonce"].as_u64().unwrap_or(0),
        status: TxStatus::Submitted,
        submitted_at: Some(get_current_timestamp()),
        confirmed_at: None,
        failed_at: None,
        replaced_at: None,
        cancelled_at: None,
        dropped_at: None,
        timeout_occurred_at: None,
        block_number: None,
        gas_used: None,
        effective_gas_price: None,
        gas_params: GasParams {
            gas_limit: transaction["gasLimit"].as_str().unwrap_or("21000").to_string(),
            max_fee_per_gas: transaction["maxFeePerGas"].as_str().map(|s| s.to_string()),
            max_priority_fee_per_gas: transaction["maxPriorityFeePerGas"]
                .as_str()
                .map(|s| s.to_string()),
            gas_price: transaction["gasPrice"].as_str().map(|s| s.to_string()),
            tx_type: transaction["type"].as_u64().unwrap_or(0) as u8,
        },
        retry_count: attempt,
        key_id: key_id.to_string(),
        timeout_at: get_current_timestamp() + state.config.tx_timeout.as_secs(),
        confirmation_target: state.config.confirmation_blocks,
        confirmation_time: None,
        error: None,
        replaced_by: None,
    };

    state.pending_txs.insert(tx_id.to_string(), tx_state.clone());
    state.tx_history.insert(tx_hash.clone(), tx_state.clone());

    let mut metrics = state.metrics.write().await;
    metrics.total_submitted += 1;
    drop(metrics);

    // Store in Redis
    let mut redis_conn = state.redis.clone();
    let json = serde_json::to_string(&tx_state).unwrap();
    let _: Result<(), _> = redis_conn.set_ex(&format!("tx:{}", tx_id), json, 86400).await;
    let _: Result<(), _> = redis_conn
        .set_ex(&format!("tx:hash:{}", tx_hash), tx_id, 86400)
        .await;

    info!(
        "[TX-MANAGER-{}] ✅ Submitted tx: {}",
        get_chain_name(chain_id),
        tx_hash
    );

    // Publish event
    let event = serde_json::json!({
        "event": "TX_SUBMITTED",
        "txId": tx_id,
        "txHash": tx_hash,
        "chainId": chain_id,
        "chainName": get_chain_name(chain_id),
        "timestamp": get_current_timestamp()
    });
    let _: Result<(), _> = redis_conn
        .publish("tx_events", event.to_string())
        .await;

    // Start monitoring
    let state_clone = state.clone();
    let tx_id_clone = tx_id.to_string();
    let tx_hash_clone = tx_hash.clone();
    tokio::spawn(async move {
        if let Err(e) = monitor_transaction(state_clone, tx_id_clone, tx_hash_clone, chain_id).await
        {
            error!("[TX-MANAGER] Monitor error: {}", e);
        }
    });

    Ok(tx_state)
}

// ============================================================================
// TRANSACTION MONITORING
// ============================================================================

async fn monitor_transaction(
    state: AppState,
    tx_id: String,
    tx_hash: String,
    chain_id: u64,
) -> Result<(), ServiceError> {
    let provider = get_provider(&state, chain_id).await?;

    let hash = H256::from_str(tx_hash.trim_start_matches("0x"))
        .map_err(|e| ServiceError::Transaction(format!("Invalid hash: {}", e)))?;

    info!("[TX-MANAGER-{}] Monitoring {}...", get_chain_name(chain_id), tx_hash);

    // Wait for confirmations
    let mut interval = time::interval(Duration::from_secs(3));
    let timeout_at = {
        let tx_state = state.pending_txs.get(&tx_id).ok_or_else(|| {
            ServiceError::NotFound(format!("Transaction {} not found", tx_id))
        })?;
        tx_state.timeout_at
    };

    loop {
        interval.tick().await;

        // Check timeout
        if get_current_timestamp() > timeout_at {
            handle_timeout(&state, &tx_id).await?;
            return Ok(());
        }

        // Check receipt
        match provider.get_transaction_receipt(hash).await {
            Ok(Some(receipt)) => {
                handle_receipt(&state, &tx_id, receipt).await?;
                return Ok(());
            }
            Ok(None) => continue,
            Err(e) => {
                warn!("[TX-MANAGER] Error checking receipt: {}", e);
                continue;
            }
        }
    }
}

async fn handle_receipt(
    state: &AppState,
    tx_id: &str,
    receipt: TransactionReceipt,
) -> Result<(), ServiceError> {
    let mut tx_state = state
        .pending_txs
        .get_mut(tx_id)
        .ok_or_else(|| ServiceError::NotFound(format!("Transaction {} not found", tx_id)))?;

    let submitted_at = tx_state.submitted_at.unwrap_or(get_current_timestamp());
    let confirmation_time = get_current_timestamp() - submitted_at;

    if receipt.status == Some(U64::from(1)) {
        tx_state.status = TxStatus::Confirmed;
        tx_state.confirmed_at = Some(get_current_timestamp());
        tx_state.block_number = receipt.block_number.map(|n| n.as_u64());
        tx_state.gas_used = Some(receipt.gas_used.unwrap_or_default().to_string());
        tx_state.effective_gas_price = receipt.effective_gas_price.map(|p| p.to_string());
        tx_state.confirmation_time = Some(confirmation_time);

        let mut metrics = state.metrics.write().await;
        metrics.total_confirmed += 1;
        let total = metrics.total_confirmed;
        let avg = metrics.avg_confirmation_time;
        metrics.avg_confirmation_time = ((avg * (total - 1)) + confirmation_time) / total;
        drop(metrics);

        // Update confirmed nonce
        let key = format!("{}:{}", tx_state.chain_id, tx_state.from.to_lowercase());
        if let Some(mut nonce_data) = state.nonce_trackers.get_mut(&key) {
            nonce_data.confirmed = nonce_data.confirmed.max(tx_state.nonce + 1);
        }

        info!(
            "[TX-MANAGER-{}] ✅ Confirmed: {} (Block: {}, Time: {}ms)",
            tx_state.chain_name,
            tx_state.tx_hash.as_ref().unwrap(),
            receipt.block_number.map(|n| n.as_u64()).unwrap_or(0),
            confirmation_time * 1000
        );
    } else {
        tx_state.status = TxStatus::Failed;
        tx_state.failed_at = Some(get_current_timestamp());
        tx_state.error = Some("Transaction reverted".to_string());

        let mut metrics = state.metrics.write().await;
        metrics.total_failed += 1;
        drop(metrics);

        info!(
            "[TX-MANAGER-{}] ❌ Failed: {}",
            tx_state.chain_name,
            tx_state.tx_hash.as_ref().unwrap()
        );
    }

    // Update Redis
    let mut redis_conn = state.redis.clone();
    let json = serde_json::to_string(&*tx_state).unwrap();
    let _: Result<(), _> = redis_conn.set_ex(&format!("tx:{}", tx_id), json, 86400).await;

    // Remove from pending
    drop(tx_state);
    state.pending_txs.remove(tx_id);

    Ok(())
}

async fn handle_timeout(state: &AppState, tx_id: &str) -> Result<(), ServiceError> {
    let mut tx_state = state
        .pending_txs
        .get_mut(tx_id)
        .ok_or_else(|| ServiceError::NotFound(format!("Transaction {} not found", tx_id)))?;

    warn!(
        "[TX-MANAGER-{}] ⚠️ Transaction timeout: {}",
        tx_state.chain_name,
        tx_state.tx_hash.as_ref().unwrap_or(&"unknown".to_string())
    );

    tx_state.status = TxStatus::Timeout;
    tx_state.timeout_occurred_at = Some(get_current_timestamp());

    let mut redis_conn = state.redis.clone();
    let event = serde_json::json!({
        "event": "TX_TIMEOUT",
        "txId": tx_id,
        "txHash": tx_state.tx_hash,
        "chainId": tx_state.chain_id,
        "timestamp": get_current_timestamp()
    });
    let _: Result<(), _> = redis_conn.publish("tx_events", event.to_string()).await;

    Ok(())
}

// ============================================================================
// API HANDLERS
// ============================================================================

#[derive(Debug, Deserialize)]
struct NonceQuery {
    chain_id: u64,
    address: String,
}

async fn get_nonce_handler(
    State(state): State<AppState>,
    Path((chain_id, address)): Path<(u64, String)>,
) -> Result<impl IntoResponse, ServiceError> {
    let nonce = get_nonce(&state, chain_id, &address, false).await?;
    let key = format!("{}:{}", chain_id, address.to_lowercase());
    let nonce_data = state.nonce_trackers.get(&key);

    Ok(Json(serde_json::json!({
        "chainId": chain_id,
        "chainName": get_chain_name(chain_id),
        "address": address,
        "nonce": nonce,
        "pending": nonce_data.as_ref().map(|n| n.pending),
        "confirmed": nonce_data.as_ref().map(|n| n.confirmed),
        "lastSynced": nonce_data.as_ref().map(|n| n.last_synced)
    })))
}

async fn reset_nonce_handler(
    State(state): State<AppState>,
    Path((chain_id, address)): Path<(u64, String)>,
) -> Result<impl IntoResponse, ServiceError> {
    let nonce = reset_nonce(&state, chain_id, &address).await?;

    Ok(Json(serde_json::json!({
        "success": true,
        "chainId": chain_id,
        "chainName": get_chain_name(chain_id),
        "address": address,
        "nonce": nonce
    })))
}

async fn build_tx_handler(
    State(state): State<AppState>,
    Path(chain_id): Path<u64>,
    Json(params): Json<BuildTxParams>,
) -> Result<impl IntoResponse, ServiceError> {
    let transaction = build_transaction(&state, chain_id, params).await?;

    Ok(Json(serde_json::json!({
        "success": true,
        "transaction": transaction
    })))
}

#[derive(Debug, Deserialize)]
struct SubmitTxRequest {
    key_id: String,
    transaction: serde_json::Value,
    #[serde(default)]
    options: Option<SubmitOptions>,
}

impl Default for SubmitOptions {
    fn default() -> Self {
        Self {
            retry_on_failure: true,
            max_retries: None,
        }
    }
}

async fn submit_tx_handler(
    State(state): State<AppState>,
    Path(chain_id): Path<u64>,
    Json(req): Json<SubmitTxRequest>,
) -> Result<impl IntoResponse, ServiceError> {
    if state.pending_txs.len() >= state.config.max_pending_tx {
        return Err(ServiceError::TooManyPending);
    }

    let tx_state = submit_transaction(
        &state,
        chain_id,
        req.key_id,
        req.transaction,
        req.options.unwrap_or_default(),
    )
    .await?;

    Ok(Json(serde_json::json!({
        "success": true,
        "txState": tx_state
    })))
}

async fn health_handler(State(state): State<AppState>) -> impl IntoResponse {
    Json(serde_json::json!({
        "service": "transaction-manager",
        "version": "2.0.0",
        "status": "healthy",
        "pendingTransactions": state.pending_txs.len(),
        "trackedNonces": state.nonce_trackers.len(),
        "historySize": state.tx_history.len()
    }))
}

async fn metrics_handler(State(state): State<AppState>) -> impl IntoResponse {
    let metrics = state.metrics.read().await;
    Json(serde_json::json!({
        "totalSubmitted": metrics.total_submitted,
        "totalConfirmed": metrics.total_confirmed,
        "totalFailed": metrics.total_failed,
        "totalReplaced": metrics.total_replaced,
        "totalDropped": metrics.total_dropped,
        "avgConfirmationTime": metrics.avg_confirmation_time,
        "uptime": get_current_timestamp() - metrics.start_time,
        "pendingCount": state.pending_txs.len(),
        "trackedNonces": state.nonce_trackers.len(),
        "historySize": state.tx_history.len()
    }))
}

// ============================================================================
// MAIN
// ============================================================================

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let config = Config {
        port: std::env::var("PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(3008),
        redis_url: std::env::var("REDIS_URL")
            .unwrap_or_else(|_| "redis://localhost:6379".to_string()),
        chain_connector_url: std::env::var("CHAIN_CONNECTOR_URL")
            .unwrap_or_else(|_| "http://localhost:3001".to_string()),
        key_manager_url: std::env::var("KEY_MANAGER_URL")
            .unwrap_or_else(|_| "http://localhost:3006".to_string()),
        gas_manager_url: std::env::var("GAS_MANAGER_URL")
            .unwrap_or_else(|_| "http://localhost:3007".to_string()),
        max_pending_tx: std::env::var("MAX_PENDING_TX")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(100),
        tx_timeout: Duration::from_millis(
            std::env::var("TX_TIMEOUT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(300000),
        ),
        confirmation_blocks: std::env::var("CONFIRMATION_BLOCKS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(1),
        auto_speedup_enabled: std::env::var("AUTO_SPEEDUP_ENABLED")
            .map(|s| s == "true")
            .unwrap_or(false),
        auto_speedup_threshold: Duration::from_millis(
            std::env::var("AUTO_SPEEDUP_THRESHOLD")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(120000),
        ),
        max_retry_attempts: std::env::var("MAX_RETRY_ATTEMPTS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(3),
        nonce_sync_interval: Duration::from_millis(
            std::env::var("NONCE_SYNC_INTERVAL")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(60000),
        ),
    };

    info!("Starting Transaction Manager Service v2.0");

    let redis_client = redis::Client::open(config.redis_url.clone())?;
    let redis_conn = ConnectionManager::new(redis_client).await?;
    info!("Connected to Redis");

    let state = AppState {
        redis: redis_conn,
        nonce_trackers: Arc::new(DashMap::new()),
        pending_txs: Arc::new(DashMap::new()),
        tx_history: Arc::new(DashMap::new()),
        replacement_txs: Arc::new(DashMap::new()),
        failed_txs: Arc::new(DashMap::new()),
        metrics: Arc::new(RwLock::new(Metrics {
            total_submitted: 0,
            total_confirmed: 0,
            total_failed: 0,
            total_replaced: 0,
            total_dropped: 0,
            avg_confirmation_time: 0,
            start_time: get_current_timestamp(),
        })),
        config: config.clone(),
    };

    // Start nonce sync task
    tokio::spawn(nonce_sync_task(state.clone()));

    let app = Router::new()
        .route("/nonce/:chain_id/:address", get(get_nonce_handler))
        .route("/nonce/:chain_id/:address/reset", post(reset_nonce_handler))
        .route("/transaction/build/:chain_id", post(build_tx_handler))
        .route("/transaction/submit/:chain_id", post(submit_tx_handler))
        .route("/health", get(health_handler))
        .route("/metrics", get(metrics_handler))
        .with_state(state);

    let addr = format!("0.0.0.0:{}", config.port);
    info!("Transaction Manager running on {}", addr);

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
