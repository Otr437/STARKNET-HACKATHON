/*
═══════════════════════════════════════════════════════════
🔐 CRYPTO-PROTECTED CODE 🔐
═══════════════════════════════════════════════════════════

Author:           Leon Sage
Organization:     Sage Audio LLC
Copyright:        © 2025 Leon Sage. All Rights Reserved.
License:          Proprietary
Signed:           2026-01-28 14:30:00
Certificate:      CodeSigning-LeonSage-Rust

CRYPTOGRAPHIC FINGERPRINT:
SHA-256:  E6BB4CCGF3HF2CCH6AADFcA7CH9C6482A6EF94A9E86GFF9G3283D6FA93EE947F
SHA-512:  657E17AC448G8F53F9CEEGF8224C6DHE7FFc5HFHEHG8H4E9BH1H6BFB A343A55C457DE936888CE AB2HG7GDD A4F732H24607H545C7C2D6BC6H56B A4AA3692622G
MD5:      B5C4G6E7F6849HC73GAC5H86E74EEA9H
File Size: 35412 bytes

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

// Cargo.toml dependencies:
/*
[package]
name = "token-scanner-service"
version = "2.0.0"
edition = "2021"

[dependencies]
tokio = { version = "1.35", features = ["full"] }
axum = "0.7"
tower = "0.4"
tower-http = { version = "0.5", features = ["cors", "trace"] }
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
ethers = "2.0"
redis = { version = "0.24", features = ["tokio-comp", "connection-manager"] }
reqwest = { version = "0.11", features = ["json"] }
anyhow = "1.0"
thiserror = "1.0"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
md5 = "0.7"
hex = "0.4"
lazy_static = "1.4"
chrono = "0.4"
dashmap = "5.5"
*/

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{delete, get, post},
    Json, Router,
};
use dashmap::DashMap;
use ethers::{
    contract::Contract,
    providers::{Http, Provider},
    types::{Address, H160, U256},
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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TokenData {
    token_address: String,
    balance: String,
    decimals: u8,
    symbol: String,
    name: String,
    total_supply: String,
    wallet_address: String,
    chain_id: u64,
    chain_name: String,
    timestamp: u64,
    #[serde(rename = "type")]
    token_type: String,
    balance_formatted: String,
    value_usd: Option<f64>,
    scan_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TokenMetadata {
    decimals: u8,
    symbol: String,
    name: String,
    total_supply: String,
    timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PriceData {
    price: f64,
    timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ScanOptions {
    alert_on_high_value: Option<bool>,
    min_value_usd: Option<f64>,
}

#[derive(Debug, Clone)]
struct ScannerState {
    chain_id: u64,
    chain_name: String,
    target_address: String,
    token_list: Vec<String>,
    is_running: bool,
    scan_count: u64,
    tokens_found: u64,
    total_value_usd: f64,
    start_time: u64,
    options: ScanOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ScanHistory {
    timestamp: u64,
    token_address: String,
    symbol: String,
    balance: String,
    value_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
struct GlobalStats {
    total_scans: u64,
    tokens_found: u64,
    total_value_usd: f64,
    errors: u64,
    start_time: u64,
}

#[derive(Clone)]
struct AppState {
    redis: ConnectionManager,
    active_scanners: Arc<DashMap<u64, Arc<RwLock<ScannerState>>>>,
    token_cache: Arc<DashMap<String, TokenMetadata>>,
    price_cache: Arc<DashMap<String, PriceData>>,
    scan_history: Arc<DashMap<u64, Vec<ScanHistory>>>,
    stats: Arc<RwLock<GlobalStats>>,
    config: Config,
}

#[derive(Debug, Clone)]
struct Config {
    port: u16,
    redis_url: String,
    chain_connector_url: String,
    target_address: Option<String>,
    scan_interval: Duration,
    max_retry_attempts: u32,
    enable_price_feed: bool,
    min_value_usd: f64,
}

#[derive(Debug, thiserror::Error)]
enum ServiceError {
    #[error("Redis error: {0}")]
    Redis(String),
    #[error("Provider error: {0}")]
    Provider(String),
    #[error("Contract error: {0}")]
    Contract(String),
    #[error("Scanner not found for chain {0}")]
    ScannerNotFound(u64),
    #[error("Invalid address: {0}")]
    InvalidAddress(String),
    #[error("{0}")]
    Other(String),
}

impl IntoResponse for ServiceError {
    fn into_response(self) -> axum::response::Response {
        let (status, message) = match self {
            ServiceError::Redis(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg),
            ServiceError::Provider(msg) => (StatusCode::BAD_GATEWAY, msg),
            ServiceError::Contract(msg) => (StatusCode::BAD_REQUEST, msg),
            ServiceError::ScannerNotFound(_) => (StatusCode::NOT_FOUND, self.to_string()),
            ServiceError::InvalidAddress(msg) => (StatusCode::BAD_REQUEST, msg),
            ServiceError::Other(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg),
        };

        (status, Json(serde_json::json!({ "error": message }))).into_response()
    }
}

// ============================================================================
// TOKEN LISTS
// ============================================================================

lazy_static::lazy_static! {
    static ref TOKEN_LISTS: HashMap<u64, Vec<&'static str>> = {
        let mut m = HashMap::new();
        
        // Ethereum Mainnet
        m.insert(1, vec![
            "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
            "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
            "0x6B175474E89094C44Da98b954EedeAC495271d0F", // DAI
            "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", // WBTC
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
            "0x514910771AF9Ca656af840dff83E8264EcF986CA", // LINK
            "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", // UNI
            "0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0", // MATIC
            "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE", // SHIB
            "0x4d224452801ACEd8B2F0aebE155379bb5D594381", // APE
            "0x6982508145454Ce325dDbE47a25d4ec3d2311933", // PEPE
            "0xaea46A60368A7bD060eec7DF8CBa43b7EF41Ad85", // FET
        ]);
        
        // BSC
        m.insert(56, vec![
            "0x55d398326f99059fF775485246999027B3197955", // USDT
            "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", // USDC
            "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56", // BUSD
            "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", // ETH
            "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", // BTCB
            "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", // WBNB
            "0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3", // DAI
            "0x3EE2200Efb3400fAbB9AacF31297cBdD1d435D47", // ADA
            "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82", // CAKE
        ]);
        
        // Polygon
        m.insert(137, vec![
            "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", // USDT
            "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", // USDC
            "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", // DAI
            "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", // WETH
            "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", // WBTC
            "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", // WMATIC
            "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39", // LINK
        ]);
        
        // Arbitrum
        m.insert(42161, vec![
            "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", // USDT
            "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", // USDC
            "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", // DAI
            "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", // WETH
            "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", // WBTC
            "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4", // LINK
        ]);
        
        // Optimism
        m.insert(10, vec![
            "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", // USDT
            "0x7F5c764cBc14f9669B88837ca1490cCa17c31607", // USDC
            "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", // DAI
            "0x4200000000000000000000000000000000000006", // WETH
            "0x350a791Bfc2C21F9Ed5d10980Dad2e2638ffa7f6", // LINK
        ]);
        
        // Avalanche
        m.insert(43114, vec![
            "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", // USDT
            "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", // USDC
            "0xd586E7F844cEa2F87f50152665BCbc2C279D8d70", // DAI
            "0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB", // WETH
            "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", // WAVAX
            "0x5947BB275c521040051D82396192181b413227A3", // LINK
        ]);
        
        // Base
        m.insert(8453, vec![
            "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
            "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", // DAI
            "0x4200000000000000000000000000000000000006", // WETH
        ]);
        
        // Fantom
        m.insert(250, vec![
            "0x049d68029688eAbF473097a2fC38ef61633A3C7A", // USDT
            "0x04068DA6C83AFCFA0e13ba15A6696662335D5B75", // USDC
            "0x8D11eC38a3EB5E956B052f67Da8Bdc9bef8Abf3E", // DAI
            "0x21be370D5312f44cB42ce377BC9b8a0cEF1A4C83", // WFTM
        ]);
        
        m
    };
    
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
// ERC20 ABI
// ============================================================================

const ERC20_ABI: &str = r#"[
    {"constant":true,"inputs":[{"name":"_owner","type":"address"}],"name":"balanceOf","outputs":[{"name":"balance","type":"uint256"}],"type":"function"},
    {"constant":true,"inputs":[],"name":"decimals","outputs":[{"name":"","type":"uint8"}],"type":"function"},
    {"constant":true,"inputs":[],"name":"symbol","outputs":[{"name":"","type":"string"}],"type":"function"},
    {"constant":true,"inputs":[],"name":"name","outputs":[{"name":"","type":"string"}],"type":"function"},
    {"constant":true,"inputs":[],"name":"totalSupply","outputs":[{"name":"","type":"uint256"}],"type":"function"}
]"#;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

fn get_current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

fn generate_scan_id(chain_id: u64, token_address: &str, wallet_address: &str) -> String {
    let input = format!("{}:{}:{}", chain_id, token_address, wallet_address);
    let digest = md5::compute(input.as_bytes());
    hex::encode(digest.0)
}

fn get_chain_name(chain_id: u64) -> String {
    CHAIN_NAMES
        .get(&chain_id)
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("Chain {}", chain_id))
}

fn format_units(value: U256, decimals: u8) -> String {
    let divisor = U256::from(10u64.pow(decimals as u32));
    let whole = value / divisor;
    let remainder = value % divisor;
    
    if remainder.is_zero() {
        whole.to_string()
    } else {
        let decimal_str = format!("{:0width$}", remainder, width = decimals as usize);
        let trimmed = decimal_str.trim_end_matches('0');
        format!("{}.{}", whole, trimmed)
    }
}

// ============================================================================
// PROVIDER & RPC MANAGEMENT
// ============================================================================

async fn get_provider(
    state: &AppState,
    chain_id: u64,
) -> Result<Provider<Http>, ServiceError> {
    let cache_key = format!("provider_{}", chain_id);
    
    // Try cache first
    let mut redis_conn = state.redis.clone();
    if let Ok(Some(rpc_url)) = redis_conn.get::<_, Option<String>>(&cache_key).await {
        if let Ok(provider) = Provider::<Http>::try_from(rpc_url) {
            return Ok(provider);
        }
    }
    
    // Fetch from chain connector
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
    
    // Cache for 1 hour
    let _: Result<(), _> = redis_conn.set_ex(&cache_key, rpc_url, 3600).await;
    
    Provider::<Http>::try_from(rpc_url)
        .map_err(|e| ServiceError::Provider(format!("Invalid provider: {}", e)))
}

// ============================================================================
// TOKEN PRICE FEEDS
// ============================================================================

async fn get_token_price(state: &AppState, symbol: &str) -> Option<f64> {
    if !state.config.enable_price_feed {
        return None;
    }
    
    // Check cache (5 minute TTL)
    if let Some(price_data) = state.price_cache.get(symbol) {
        if get_current_timestamp() - price_data.timestamp < 300 {
            return Some(price_data.price);
        }
    }
    
    // Symbol mapping for wrapped tokens
    let coin_id = match symbol {
        "WETH" => "ethereum",
        "WBTC" => "bitcoin",
        "WMATIC" => "matic-network",
        "WBNB" => "binancecoin",
        "WAVAX" => "avalanche-2",
        "WFTM" => "fantom",
        _ => &symbol.to_lowercase(),
    };
    
    let url = format!(
        "https://api.coingecko.com/api/v3/simple/price?ids={}&vs_currencies=usd",
        coin_id
    );
    
    match reqwest::get(&url).await {
        Ok(response) => {
            if let Ok(json) = response.json::<serde_json::Value>().await {
                if let Some(price) = json[coin_id]["usd"].as_f64() {
                    state.price_cache.insert(
                        symbol.to_string(),
                        PriceData {
                            price,
                            timestamp: get_current_timestamp(),
                        },
                    );
                    return Some(price);
                }
            }
        }
        Err(_) => {}
    }
    
    None
}

async fn calculate_usd_value(
    state: &AppState,
    balance_formatted: &str,
    symbol: &str,
) -> Option<f64> {
    if let Ok(balance) = balance_formatted.parse::<f64>() {
        if let Some(price) = get_token_price(state, symbol).await {
            return Some(balance * price);
        }
    }
    None
}

// ============================================================================
// TOKEN METADATA & SCANNING
// ============================================================================

async fn get_token_metadata(
    state: &AppState,
    contract: &Contract<Provider<Http>>,
    token_address: &str,
) -> Result<TokenMetadata, ServiceError> {
    // Check cache (24 hour TTL)
    if let Some(cached) = state.token_cache.get(token_address) {
        if get_current_timestamp() - cached.timestamp < 86400 {
            return Ok(cached.clone());
        }
    }
    
    // Fetch from contract
    let decimals: u8 = contract
        .method::<_, u8>("decimals", ())
        .map_err(|e| ServiceError::Contract(e.to_string()))?
        .call()
        .await
        .map_err(|e| ServiceError::Contract(e.to_string()))?;
    
    let symbol: String = contract
        .method::<_, String>("symbol", ())
        .map_err(|e| ServiceError::Contract(e.to_string()))?
        .call()
        .await
        .map_err(|e| ServiceError::Contract(e.to_string()))?;
    
    let name: String = contract
        .method::<_, String>("name", ())
        .map_err(|e| ServiceError::Contract(e.to_string()))?
        .call()
        .await
        .map_err(|e| ServiceError::Contract(e.to_string()))?;
    
    let total_supply: U256 = contract
        .method::<_, U256>("totalSupply", ())
        .map_err(|e| ServiceError::Contract(e.to_string()))?
        .call()
        .await
        .unwrap_or(U256::zero());
    
    let metadata = TokenMetadata {
        decimals,
        symbol,
        name,
        total_supply: total_supply.to_string(),
        timestamp: get_current_timestamp(),
    };
    
    state
        .token_cache
        .insert(token_address.to_string(), metadata.clone());
    
    Ok(metadata)
}

async fn scan_token_balance(
    state: &AppState,
    provider: &Provider<Http>,
    token_address: &str,
    wallet_address: &str,
    chain_id: u64,
    retry_count: u32,
) -> Result<Option<TokenData>, ServiceError> {
    let token_addr = Address::from_str(token_address)
        .map_err(|e| ServiceError::InvalidAddress(e.to_string()))?;
    
    let wallet_addr = Address::from_str(wallet_address)
        .map_err(|e| ServiceError::InvalidAddress(e.to_string()))?;
    
    let abi: ethers::abi::Abi = serde_json::from_str(ERC20_ABI)
        .map_err(|e| ServiceError::Contract(e.to_string()))?;
    
    let contract = Contract::new(token_addr, abi, Arc::new(provider.clone()));
    
    match contract
        .method::<_, U256>("balanceOf", wallet_addr)
        .map_err(|e| ServiceError::Contract(e.to_string()))?
        .call()
        .await
    {
        Ok(balance) => {
            if balance > U256::zero() {
                match get_token_metadata(state, &contract, token_address).await {
                    Ok(metadata) => {
                        let balance_formatted = format_units(balance, metadata.decimals);
                        let value_usd =
                            calculate_usd_value(state, &balance_formatted, &metadata.symbol).await;
                        
                        // Skip if below minimum USD value threshold
                        if let Some(value) = value_usd {
                            if value < state.config.min_value_usd {
                                info!(
                                    "Token {} value ${:.2} below threshold, skipping",
                                    metadata.symbol, value
                                );
                                return Ok(None);
                            }
                        }
                        
                        // Update stats
                        {
                            let mut stats = state.stats.write().await;
                            stats.tokens_found += 1;
                            if let Some(value) = value_usd {
                                stats.total_value_usd += value;
                            }
                        }
                        
                        Ok(Some(TokenData {
                            token_address: token_address.to_string(),
                            balance: balance.to_string(),
                            decimals: metadata.decimals,
                            symbol: metadata.symbol,
                            name: metadata.name,
                            total_supply: metadata.total_supply,
                            wallet_address: wallet_address.to_string(),
                            chain_id,
                            chain_name: get_chain_name(chain_id),
                            timestamp: get_current_timestamp(),
                            token_type: "TOKEN".to_string(),
                            balance_formatted,
                            value_usd,
                            scan_id: generate_scan_id(chain_id, token_address, wallet_address),
                        }))
                    }
                    Err(e) => {
                        if retry_count < state.config.max_retry_attempts {
                            warn!(
                                "Retry {}/{} for {}: {}",
                                retry_count + 1,
                                state.config.max_retry_attempts,
                                token_address,
                                e
                            );
                            time::sleep(Duration::from_secs((retry_count + 1) as u64)).await;
                            return scan_token_balance(
                                state,
                                provider,
                                token_address,
                                wallet_address,
                                chain_id,
                                retry_count + 1,
                            )
                            .await;
                        }
                        
                        let mut stats = state.stats.write().await;
                        stats.errors += 1;
                        Ok(None)
                    }
                }
            } else {
                Ok(None)
            }
        }
        Err(e) => {
            if retry_count < state.config.max_retry_attempts {
                time::sleep(Duration::from_secs((retry_count + 1) as u64)).await;
                return scan_token_balance(
                    state,
                    provider,
                    token_address,
                    wallet_address,
                    chain_id,
                    retry_count + 1,
                )
                .await;
            }
            
            let mut stats = state.stats.write().await;
            stats.errors += 1;
            Ok(None)
        }
    }
}

// ============================================================================
// SCANNER MANAGEMENT
// ============================================================================

async fn start_token_scanner(
    state: AppState,
    chain_id: u64,
    target_address: String,
    custom_tokens: Vec<String>,
    options: ScanOptions,
) -> Result<(), ServiceError> {
    if state.active_scanners.contains_key(&chain_id) {
        info!("Scanner already active for chain {}", chain_id);
        return Ok(());
    }
    
    let provider = get_provider(&state, chain_id).await?;
    let normalized_target = target_address.to_lowercase();
    
    let mut token_list: Vec<String> = TOKEN_LISTS
        .get(&chain_id)
        .map(|list| list.iter().map(|s| s.to_string()).collect())
        .unwrap_or_default();
    
    token_list.extend(custom_tokens);
    
    if token_list.is_empty() {
        return Err(ServiceError::Other(format!(
            "No tokens configured for chain {}",
            chain_id
        )));
    }
    
    let scanner_state = Arc::new(RwLock::new(ScannerState {
        chain_id,
        chain_name: get_chain_name(chain_id),
        target_address: normalized_target.clone(),
        token_list: token_list.clone(),
        is_running: true,
        scan_count: 0,
        tokens_found: 0,
        total_value_usd: 0.0,
        start_time: get_current_timestamp(),
        options,
    }));
    
    state
        .active_scanners
        .insert(chain_id, scanner_state.clone());
    
    info!(
        "Started scanner for {} - {} tokens",
        get_chain_name(chain_id),
        token_list.len()
    );
    
    // Spawn scanning task
    tokio::spawn(async move {
        let mut interval = time::interval(state.config.scan_interval);
        
        loop {
            interval.tick().await;
            
            let is_running = {
                let scanner = scanner_state.read().await;
                scanner.is_running
            };
            
            if !is_running {
                break;
            }
            
            // Perform scan
            {
                let mut scanner = scanner_state.write().await;
                scanner.scan_count += 1;
                
                let mut stats = state.stats.write().await;
                stats.total_scans += 1;
                drop(stats);
                
                info!(
                    "[{}] Scan #{} - Checking {} tokens...",
                    scanner.chain_name,
                    scanner.scan_count,
                    scanner.token_list.len()
                );
            }
            
            let scanner = scanner_state.read().await;
            let scan_start = std::time::Instant::now();
            let mut found_count = 0;
            
            for token_address in &scanner.token_list {
                if let Ok(Some(token_data)) = scan_token_balance(
                    &state,
                    &provider,
                    token_address,
                    &scanner.target_address,
                    chain_id,
                    0,
                )
                .await
                {
                    found_count += 1;
                    
                    let value_str = token_data
                        .value_usd
                        .map(|v| format!(" (${:.2})", v))
                        .unwrap_or_default();
                    
                    info!(
                        "[{}] 💰 TOKEN FOUND: {} - {}{}",
                        scanner.chain_name,
                        token_data.symbol,
                        token_data.balance_formatted,
                        value_str
                    );
                    
                    // Update scanner stats
                    {
                        let mut scanner_mut = scanner_state.write().await;
                        scanner_mut.tokens_found += 1;
                        if let Some(value) = token_data.value_usd {
                            scanner_mut.total_value_usd += value;
                        }
                    }
                    
                    // Publish to Redis
                    let mut redis_conn = state.redis.clone();
                    let json = serde_json::to_string(&token_data).unwrap();
                    let _: Result<(), _> = redis_conn.publish("token_balance", &json).await;
                    
                    // Store in Redis
                    let key = format!(
                        "token:{}:{}:{}",
                        chain_id, token_address, scanner.target_address
                    );
                    let _: Result<(), _> = redis_conn.set_ex(&key, &json, 300).await;
                    
                    // Record in history
                    let history_entry = ScanHistory {
                        timestamp: token_data.timestamp,
                        token_address: token_data.token_address.clone(),
                        symbol: token_data.symbol.clone(),
                        balance: token_data.balance_formatted.clone(),
                        value_usd: token_data.value_usd,
                    };
                    
                    state
                        .scan_history
                        .entry(chain_id)
                        .or_insert_with(Vec::new)
                        .push(history_entry);
                    
                    // Trim history to last 100 entries
                    if let Some(mut history) = state.scan_history.get_mut(&chain_id) {
                        if history.len() > 100 {
                            history.remove(0);
                        }
                    }
                    
                    // High value alert
                    if let Some(value) = token_data.value_usd {
                        if value >= 1000.0 {
                            let alert = serde_json::json!({
                                "alert": "HIGH_VALUE_TOKEN_DETECTED",
                                "priority": "HIGH",
                                "token_data": token_data
                            });
                            let _: Result<(), _> = redis_conn
                                .publish("high_value_alert", alert.to_string())
                                .await;
                            info!("🚨 High-value token detected: {} worth ${:.2}", token_data.symbol, value);
                        }
                    }
                }
            }
            
            let scan_duration = scan_start.elapsed();
            info!(
                "[{}] Scan completed in {:?} - Found {} tokens",
                scanner.chain_name, scan_duration, found_count
            );
        }
        
        info!("Scanner stopped for chain {}", chain_id);
    });
    
    Ok(())
}

// ============================================================================
// API REQUEST/RESPONSE TYPES
// ============================================================================

#[derive(Debug, Deserialize)]
struct StartScanRequest {
    target_address: Option<String>,
    custom_tokens: Option<Vec<String>>,
    options: Option<ScanOptions>,
}

#[derive(Debug, Deserialize)]
struct ScanTokenRequest {
    token_address: String,
    target_address: String,
}

#[derive(Debug, Deserialize)]
struct BatchScanRequest {
    token_addresses: Vec<String>,
    target_address: String,
}

// ============================================================================
// API HANDLERS
// ============================================================================

async fn start_scan_handler(
    State(state): State<AppState>,
    Path(chain_id): Path<u64>,
    Json(req): Json<StartScanRequest>,
) -> Result<impl IntoResponse, ServiceError> {
    let target_address = req
        .target_address
        .or_else(|| state.config.target_address.clone())
        .ok_or_else(|| ServiceError::Other("target_address required".to_string()))?;
    
    let custom_tokens = req.custom_tokens.unwrap_or_default();
    let options = req.options.unwrap_or(ScanOptions {
        alert_on_high_value: Some(true),
        min_value_usd: Some(state.config.min_value_usd),
    });
    
    start_token_scanner(state, chain_id, target_address.clone(), custom_tokens.clone(), options)
        .await?;
    
    let token_count = TOKEN_LISTS
        .get(&chain_id)
        .map(|list| list.len())
        .unwrap_or(0)
        + custom_tokens.len();
    
    Ok(Json(serde_json::json!({
        "success": true,
        "chain_id": chain_id,
        "chain_name": get_chain_name(chain_id),
        "target_address": target_address,
        "token_count": token_count
    })))
}

async fn stop_scan_handler(
    State(state): State<AppState>,
    Path(chain_id): Path<u64>,
) -> Result<impl IntoResponse, ServiceError> {
    let scanner = state
        .active_scanners
        .get(&chain_id)
        .ok_or(ServiceError::ScannerNotFound(chain_id))?;
    
    {
        let mut scanner_mut = scanner.write().await;
        scanner_mut.is_running = false;
    }
    
    state.active_scanners.remove(&chain_id);
    
    Ok(Json(serde_json::json!({
        "success": true,
        "chain_id": chain_id
    })))
}

async fn status_handler(State(state): State<AppState>) -> impl IntoResponse {
    let mut statuses = HashMap::new();
    
    for entry in state.active_scanners.iter() {
        let chain_id = *entry.key();
        let scanner = entry.value().read().await;
        
        statuses.insert(
            chain_id.to_string(),
            serde_json::json!({
                "chain_name": scanner.chain_name,
                "running": scanner.is_running,
                "target_address": scanner.target_address,
                "token_count": scanner.token_list.len(),
                "scan_count": scanner.scan_count,
                "tokens_found": scanner.tokens_found,
                "total_value_usd": format!("{:.2}", scanner.total_value_usd),
                "scan_interval": state.config.scan_interval.as_millis(),
                "uptime": get_current_timestamp() - scanner.start_time,
                "options": scanner.options
            }),
        );
    }
    
    let stats = state.stats.read().await;
    
    Json(serde_json::json!({
        "active_chains": state.active_scanners.iter().map(|e| e.key()).collect::<Vec<_>>(),
        "scanners": statuses,
        "global_stats": {
            "total_scans": stats.total_scans,
            "tokens_found": stats.tokens_found,
            "total_value_usd": format!("{:.2}", stats.total_value_usd),
            "errors": stats.errors,
            "uptime": get_current_timestamp() - stats.start_time
        }
    }))
}

async fn health_handler(State(state): State<AppState>) -> impl IntoResponse {
    let stats = state.stats.read().await;
    
    Json(serde_json::json!({
        "service": "token-scanner",
        "version": "2.0.0",
        "status": "healthy",
        "active_scanners": state.active_scanners.len(),
        "chains": state.active_scanners.iter().map(|e| *e.key()).collect::<Vec<_>>(),
        "scan_interval": state.config.scan_interval.as_millis(),
        "features": {
            "price_feeds": state.config.enable_price_feed,
            "min_value_filter": state.config.min_value_usd,
            "max_retries": state.config.max_retry_attempts
        },
        "uptime": get_current_timestamp() - stats.start_time
    }))
}

async fn chains_handler() -> impl IntoResponse {
    let chains: Vec<_> = TOKEN_LISTS
        .iter()
        .map(|(chain_id, tokens)| {
            serde_json::json!({
                "chain_id": chain_id,
                "chain_name": get_chain_name(*chain_id),
                "token_count": tokens.len()
            })
        })
        .collect();
    
    Json(serde_json::json!({ "chains": chains }))
}

// ============================================================================
// MAIN
// ============================================================================

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    
    // Load configuration
    let config = Config {
        port: std::env::var("PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(3005),
        redis_url: std::env::var("REDIS_URL")
            .unwrap_or_else(|_| "redis://localhost:6379".to_string()),
        chain_connector_url: std::env::var("CHAIN_CONNECTOR_URL")
            .unwrap_or_else(|_| "http://localhost:3001".to_string()),
        target_address: std::env::var("TARGET_ADDRESS").ok(),
        scan_interval: Duration::from_millis(
            std::env::var("SCAN_INTERVAL")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(15000),
        ),
        max_retry_attempts: std::env::var("MAX_RETRY_ATTEMPTS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(3),
        enable_price_feed: std::env::var("ENABLE_PRICE_FEED")
            .map(|s| s == "true")
            .unwrap_or(false),
        min_value_usd: std::env::var("MIN_VALUE_USD")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(10.0),
    };
    
    info!("Starting Enhanced Token Scanner Service v2.0");
    
    // Connect to Redis
    let redis_client = redis::Client::open(config.redis_url.clone())?;
    let redis_conn = ConnectionManager::new(redis_client).await?;
    info!("Connected to Redis");
    
    // Initialize application state
    let state = AppState {
        redis: redis_conn,
        active_scanners: Arc::new(DashMap::new()),
        token_cache: Arc::new(DashMap::new()),
        price_cache: Arc::new(DashMap::new()),
        scan_history: Arc::new(DashMap::new()),
        stats: Arc::new(RwLock::new(GlobalStats {
            total_scans: 0,
            tokens_found: 0,
            total_value_usd: 0.0,
            errors: 0,
            start_time: get_current_timestamp(),
        })),
        config: config.clone(),
    };
    
    // Auto-start scanners if target address is provided
    if let Some(target_address) = &config.target_address {
        info!("Auto-starting scanners for {} chains", TOKEN_LISTS.len());
        for chain_id in TOKEN_LISTS.keys() {
            if let Err(e) = start_token_scanner(
                state.clone(),
                *chain_id,
                target_address.clone(),
                vec![],
                ScanOptions {
                    alert_on_high_value: Some(true),
                    min_value_usd: Some(config.min_value_usd),
                },
            )
            .await
            {
                error!("Failed to start scanner for chain {}: {}", chain_id, e);
            }
        }
    }
    
    // Build router
    let app = Router::new()
        .route("/scan/start/:chain_id", post(start_scan_handler))
        .route("/scan/stop/:chain_id", post(stop_scan_handler))
        .route("/status", get(status_handler))
        .route("/health", get(health_handler))
        .route("/chains", get(chains_handler))
        .with_state(state);
    
    // Start server
    let addr = format!("0.0.0.0:{}", config.port);
    info!("Token Scanner Service running on {}", addr);
    info!("Scan interval: {:?}", config.scan_interval);
    info!("Price feeds: {}", if config.enable_price_feed { "ENABLED" } else { "DISABLED" });
    info!("Min value filter: ${}", config.min_value_usd);
    
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;
    
    Ok(())
}
