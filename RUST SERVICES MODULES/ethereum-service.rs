// ETHEREUM SERVICE - COMPLETE PRODUCTION IMPLEMENTATION
// Handles: ETH wallets, transactions, signing, balance queries, gas estimation

use actix_web::{web, App, HttpRequest, HttpResponse, HttpServer, middleware};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::sync::Arc;
use tokio::sync::RwLock;
use web3::Web3;
use web3::transports::Http;
use web3::types::{Address, U256, TransactionParameters, H256, BlockNumber};
use secp256k1::{SecretKey, PublicKey, Secp256k1};
use sha3::{Digest, Keccak256};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use aes_gcm::aead::{Aead, NewAead};
use rand::Rng;

// ==================== CONFIGURATION ====================

#[derive(Clone)]
struct Config {
    database_url: String,
    eth_rpc_url: String,
    encryption_key: String,
    port: u16,
}

impl Config {
    fn from_env() -> Self {
        Self {
            database_url: std::env::var("DATABASE_URL").expect("DATABASE_URL required"),
            eth_rpc_url: std::env::var("ETH_RPC_URL").unwrap_or_else(|_| "https://eth.llamarpc.com".to_string()),
            encryption_key: std::env::var("ENCRYPTION_KEY").expect("ENCRYPTION_KEY required"),
            port: std::env::var("PORT").unwrap_or_else(|_| "8002".to_string()).parse().unwrap(),
        }
    }
}

// ==================== DATABASE MODELS ====================

#[derive(Debug, sqlx::FromRow, Serialize)]
struct EthWallet {
    id: uuid::Uuid,
    user_id: uuid::Uuid,
    address: String,
    encrypted_private_key: String,
    created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, sqlx::FromRow, Serialize)]
struct EthTransaction {
    id: uuid::Uuid,
    wallet_id: uuid::Uuid,
    tx_hash: String,
    from_address: String,
    to_address: String,
    amount: String,
    gas_price: String,
    gas_used: Option<String>,
    status: String,
    created_at: chrono::DateTime<chrono::Utc>,
    confirmed_at: Option<chrono::DateTime<chrono::Utc>>,
}

// ==================== REQUEST/RESPONSE MODELS ====================

#[derive(Deserialize)]
struct CreateWalletRequest {
    user_id: String,
}

#[derive(Serialize)]
struct CreateWalletResponse {
    wallet_id: String,
    address: String,
    created_at: String,
}

#[derive(Deserialize)]
struct GetBalanceRequest {
    address: String,
}

#[derive(Serialize)]
struct BalanceResponse {
    address: String,
    balance: String,
    balance_wei: String,
    currency: String,
}

#[derive(Deserialize)]
struct SendTransactionRequest {
    from_address: String,
    to_address: String,
    amount: String,
    gas_price_gwei: Option<String>,
}

#[derive(Serialize)]
struct SendTransactionResponse {
    tx_hash: String,
    from: String,
    to: String,
    amount: String,
    gas_price: String,
    status: String,
}

#[derive(Deserialize)]
struct SignMessageRequest {
    address: String,
    message: String,
}

#[derive(Serialize)]
struct SignMessageResponse {
    message: String,
    signature: String,
    address: String,
}

#[derive(Serialize)]
struct EstimateGasResponse {
    gas_estimate: String,
    gas_price_gwei: String,
    estimated_cost_eth: String,
}

#[derive(Serialize)]
struct TransactionStatusResponse {
    tx_hash: String,
    status: String,
    block_number: Option<u64>,
    confirmations: Option<u64>,
    from: String,
    to: String,
    value: String,
    gas_used: Option<String>,
}

// ==================== APPLICATION STATE ====================

struct AppState {
    db: PgPool,
    web3: Web3<Http>,
    encryption_key: [u8; 32],
}

// ==================== ENCRYPTION UTILITIES ====================

fn encrypt_private_key(private_key: &str, key: &[u8; 32]) -> Result<String, String> {
    let cipher = Aes256Gcm::new(Key::from_slice(key));
    let mut rng = rand::thread_rng();
    let nonce_bytes: [u8; 12] = rng.gen();
    let nonce = Nonce::from_slice(&nonce_bytes);
    
    let ciphertext = cipher.encrypt(nonce, private_key.as_bytes())
        .map_err(|e| format!("Encryption failed: {}", e))?;
    
    let mut result = nonce_bytes.to_vec();
    result.extend_from_slice(&ciphertext);
    Ok(hex::encode(result))
}

fn decrypt_private_key(encrypted: &str, key: &[u8; 32]) -> Result<String, String> {
    let data = hex::decode(encrypted).map_err(|e| format!("Hex decode failed: {}", e))?;
    
    if data.len() < 12 {
        return Err("Invalid encrypted data".to_string());
    }
    
    let (nonce_bytes, ciphertext) = data.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);
    let cipher = Aes256Gcm::new(Key::from_slice(key));
    
    let plaintext = cipher.decrypt(nonce, ciphertext)
        .map_err(|e| format!("Decryption failed: {}", e))?;
    
    String::from_utf8(plaintext).map_err(|e| format!("UTF8 conversion failed: {}", e))
}

// ==================== WALLET OPERATIONS ====================

fn generate_eth_wallet() -> Result<(String, String), String> {
    let secp = Secp256k1::new();
    let mut rng = rand::thread_rng();
    let secret_key = SecretKey::new(&mut rng);
    let public_key = PublicKey::from_secret_key(&secp, &secret_key);
    
    let public_key_bytes = public_key.serialize_uncompressed();
    let mut hasher = Keccak256::new();
    hasher.update(&public_key_bytes[1..]);
    let hash = hasher.finalize();
    
    let address = format!("0x{}", hex::encode(&hash[12..]));
    let private_key = hex::encode(secret_key.secret_bytes());
    
    Ok((address, private_key))
}

async fn create_wallet(
    req: web::Json<CreateWalletRequest>,
    state: web::Data<AppState>,
) -> HttpResponse {
    let user_id = match uuid::Uuid::parse_str(&req.user_id) {
        Ok(id) => id,
        Err(_) => return HttpResponse::BadRequest().json(serde_json::json!({
            "error": "Invalid user_id format"
        })),
    };
    
    let (address, private_key) = match generate_eth_wallet() {
        Ok(wallet) => wallet,
        Err(e) => return HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("Wallet generation failed: {}", e)
        })),
    };
    
    let encrypted_key = match encrypt_private_key(&private_key, &state.encryption_key) {
        Ok(enc) => enc,
        Err(e) => return HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("Encryption failed: {}", e)
        })),
    };
    
    let wallet_id = uuid::Uuid::new_v4();
    
    match sqlx::query(
        "INSERT INTO eth_wallets (id, user_id, address, encrypted_private_key) VALUES ($1, $2, $3, $4)"
    )
    .bind(wallet_id)
    .bind(user_id)
    .bind(&address)
    .bind(&encrypted_key)
    .execute(&state.db)
    .await {
        Ok(_) => HttpResponse::Created().json(CreateWalletResponse {
            wallet_id: wallet_id.to_string(),
            address,
            created_at: chrono::Utc::now().to_rfc3339(),
        }),
        Err(e) => HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("Database error: {}", e)
        })),
    }
}

async fn get_balance(
    query: web::Query<GetBalanceRequest>,
    state: web::Data<AppState>,
) -> HttpResponse {
    let address = match query.address.parse::<Address>() {
        Ok(addr) => addr,
        Err(_) => return HttpResponse::BadRequest().json(serde_json::json!({
            "error": "Invalid Ethereum address"
        })),
    };
    
    match state.web3.eth().balance(address, None).await {
        Ok(balance_wei) => {
            let balance_eth = balance_wei.as_u128() as f64 / 1_000_000_000_000_000_000.0;
            HttpResponse::Ok().json(BalanceResponse {
                address: query.address.clone(),
                balance: format!("{:.18}", balance_eth),
                balance_wei: balance_wei.to_string(),
                currency: "ETH".to_string(),
            })
        }
        Err(e) => HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("Failed to fetch balance: {}", e)
        })),
    }
}

async fn send_transaction(
    req: web::Json<SendTransactionRequest>,
    state: web::Data<AppState>,
) -> HttpResponse {
    let wallet = match sqlx::query_as::<_, EthWallet>(
        "SELECT * FROM eth_wallets WHERE address = $1"
    )
    .bind(&req.from_address)
    .fetch_optional(&state.db)
    .await {
        Ok(Some(w)) => w,
        Ok(None) => return HttpResponse::NotFound().json(serde_json::json!({
            "error": "Wallet not found"
        })),
        Err(e) => return HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("Database error: {}", e)
        })),
    };
    
    let private_key = match decrypt_private_key(&wallet.encrypted_private_key, &state.encryption_key) {
        Ok(key) => key,
        Err(e) => return HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("Decryption failed: {}", e)
        })),
    };
    
    let to_address: Address = match req.to_address.parse() {
        Ok(addr) => addr,
        Err(_) => return HttpResponse::BadRequest().json(serde_json::json!({
            "error": "Invalid recipient address"
        })),
    };
    
    let amount_eth: f64 = match req.amount.parse() {
        Ok(amt) => amt,
        Err(_) => return HttpResponse::BadRequest().json(serde_json::json!({
            "error": "Invalid amount"
        })),
    };
    
    let amount_wei = U256::from((amount_eth * 1_000_000_000_000_000_000.0) as u128);
    
    let gas_price = if let Some(gwei) = &req.gas_price_gwei {
        let gwei_f64: f64 = gwei.parse().unwrap_or(20.0);
        U256::from((gwei_f64 * 1_000_000_000.0) as u64)
    } else {
        match state.web3.eth().gas_price().await {
            Ok(price) => price,
            Err(_) => U256::from(20_000_000_000u64),
        }
    };
    
    let from_address: Address = req.from_address.parse().unwrap();
    let nonce = match state.web3.eth().transaction_count(from_address, None).await {
        Ok(n) => n,
        Err(e) => return HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("Failed to get nonce: {}", e)
        })),
    };
    
    let chain_id = match state.web3.eth().chain_id().await {
        Ok(id) => id.as_u64(),
        Err(_) => 1, // Mainnet default
    };
    
    let tx = TransactionParameters {
        nonce: Some(nonce),
        to: Some(to_address),
        value: amount_wei,
        gas_price: Some(gas_price),
        gas: U256::from(21000),
        data: web3::types::Bytes(vec![]),
        chain_id: Some(chain_id),
    };
    
    let private_key_bytes = match hex::decode(&private_key) {
        Ok(bytes) => bytes,
        Err(_) => return HttpResponse::InternalServerError().json(serde_json::json!({
            "error": "Invalid private key format"
        })),
    };
    
    let secret_key = match SecretKey::from_slice(&private_key_bytes) {
        Ok(key) => key,
        Err(_) => return HttpResponse::InternalServerError().json(serde_json::json!({
            "error": "Invalid secret key"
        })),
    };
    
    let signed = match web3::signing::Key::from(secret_key).sign_transaction(&tx).await {
        Ok(signed_tx) => signed_tx,
        Err(e) => return HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("Transaction signing failed: {}", e)
        })),
    };
    
    let tx_hash = match state.web3.eth().send_raw_transaction(signed.raw_transaction).await {
        Ok(hash) => hash,
        Err(e) => return HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("Transaction broadcast failed: {}", e)
        })),
    };
    
    let tx_id = uuid::Uuid::new_v4();
    sqlx::query(
        "INSERT INTO eth_transactions (id, wallet_id, tx_hash, from_address, to_address, amount, gas_price, status) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')"
    )
    .bind(tx_id)
    .bind(wallet.id)
    .bind(format!("{:?}", tx_hash))
    .bind(&req.from_address)
    .bind(&req.to_address)
    .bind(&req.amount)
    .bind(gas_price.to_string())
    .execute(&state.db)
    .await
    .ok();
    
    HttpResponse::Ok().json(SendTransactionResponse {
        tx_hash: format!("{:?}", tx_hash),
        from: req.from_address.clone(),
        to: req.to_address.clone(),
        amount: req.amount.clone(),
        gas_price: gas_price.to_string(),
        status: "pending".to_string(),
    })
}

async fn sign_message(
    req: web::Json<SignMessageRequest>,
    state: web::Data<AppState>,
) -> HttpResponse {
    let wallet = match sqlx::query_as::<_, EthWallet>(
        "SELECT * FROM eth_wallets WHERE address = $1"
    )
    .bind(&req.address)
    .fetch_optional(&state.db)
    .await {
        Ok(Some(w)) => w,
        Ok(None) => return HttpResponse::NotFound().json(serde_json::json!({
            "error": "Wallet not found"
        })),
        Err(e) => return HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("Database error: {}", e)
        })),
    };
    
    let private_key = match decrypt_private_key(&wallet.encrypted_private_key, &state.encryption_key) {
        Ok(key) => key,
        Err(e) => return HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("Decryption failed: {}", e)
        })),
    };
    
    let private_key_bytes = hex::decode(&private_key).unwrap();
    let secret_key = SecretKey::from_slice(&private_key_bytes).unwrap();
    
    let message_hash = {
        let prefix = format!("\x19Ethereum Signed Message:\n{}", req.message.len());
        let mut hasher = Keccak256::new();
        hasher.update(prefix.as_bytes());
        hasher.update(req.message.as_bytes());
        hasher.finalize()
    };
    
    let secp = Secp256k1::new();
    let message = secp256k1::Message::from_slice(&message_hash).unwrap();
    let signature = secp.sign_ecdsa(&message, &secret_key);
    
    HttpResponse::Ok().json(SignMessageResponse {
        message: req.message.clone(),
        signature: format!("0x{}", hex::encode(signature.serialize_compact())),
        address: req.address.clone(),
    })
}

async fn estimate_gas(
    req: web::Json<SendTransactionRequest>,
    state: web::Data<AppState>,
) -> HttpResponse {
    let gas_price = match state.web3.eth().gas_price().await {
        Ok(price) => price,
        Err(_) => U256::from(20_000_000_000u64),
    };
    
    let gas_estimate = U256::from(21000);
    let cost_wei = gas_estimate * gas_price;
    let cost_eth = cost_wei.as_u128() as f64 / 1_000_000_000_000_000_000.0;
    let gas_price_gwei = gas_price.as_u128() as f64 / 1_000_000_000.0;
    
    HttpResponse::Ok().json(EstimateGasResponse {
        gas_estimate: gas_estimate.to_string(),
        gas_price_gwei: format!("{:.2}", gas_price_gwei),
        estimated_cost_eth: format!("{:.18}", cost_eth),
    })
}

async fn get_transaction_status(
    tx_hash: web::Path<String>,
    state: web::Data<AppState>,
) -> HttpResponse {
    let hash: H256 = match tx_hash.parse() {
        Ok(h) => h,
        Err(_) => return HttpResponse::BadRequest().json(serde_json::json!({
            "error": "Invalid transaction hash"
        })),
    };
    
    let receipt = match state.web3.eth().transaction_receipt(hash).await {
        Ok(Some(r)) => r,
        Ok(None) => return HttpResponse::Ok().json(TransactionStatusResponse {
            tx_hash: tx_hash.to_string(),
            status: "pending".to_string(),
            block_number: None,
            confirmations: None,
            from: String::new(),
            to: String::new(),
            value: String::new(),
            gas_used: None,
        }),
        Err(e) => return HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("Failed to fetch receipt: {}", e)
        })),
    };
    
    let status = if receipt.status == Some(U256::from(1)) {
        "confirmed"
    } else {
        "failed"
    };
    
    let current_block = state.web3.eth().block_number().await.ok().map(|b| b.as_u64());
    let confirmations = if let (Some(current), Some(tx_block)) = (current_block, receipt.block_number) {
        Some(current.saturating_sub(tx_block.as_u64()))
    } else {
        None
    };
    
    HttpResponse::Ok().json(TransactionStatusResponse {
        tx_hash: tx_hash.to_string(),
        status: status.to_string(),
        block_number: receipt.block_number.map(|b| b.as_u64()),
        confirmations,
        from: format!("{:?}", receipt.from),
        to: receipt.to.map(|t| format!("{:?}", t)).unwrap_or_default(),
        value: String::new(),
        gas_used: receipt.gas_used.map(|g| g.to_string()),
    })
}

async fn health_check() -> HttpResponse {
    HttpResponse::Ok().json(serde_json::json!({
        "status": "healthy",
        "service": "ethereum-service",
        "version": "1.0.0"
    }))
}

// ==================== DATABASE INITIALIZATION ====================

async fn init_database(pool: &PgPool) -> Result<(), sqlx::Error> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS eth_wallets (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL,
            address VARCHAR(42) NOT NULL UNIQUE,
            encrypted_private_key TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )"
    ).execute(pool).await?;
    
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS eth_transactions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            wallet_id UUID NOT NULL REFERENCES eth_wallets(id),
            tx_hash VARCHAR(66) NOT NULL,
            from_address VARCHAR(42) NOT NULL,
            to_address VARCHAR(42) NOT NULL,
            amount VARCHAR(100) NOT NULL,
            gas_price VARCHAR(100) NOT NULL,
            gas_used VARCHAR(100),
            status VARCHAR(20) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            confirmed_at TIMESTAMPTZ
        )"
    ).execute(pool).await?;
    
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_eth_wallets_user_id ON eth_wallets(user_id)")
        .execute(pool).await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_eth_transactions_wallet_id ON eth_transactions(wallet_id)")
        .execute(pool).await?;
    
    Ok(())
}

// ==================== MAIN SERVER ====================

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    env_logger::init();
    dotenv::dotenv().ok();
    
    let config = Config::from_env();
    
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(&config.database_url)
        .await
        .expect("Failed to connect to database");
    
    init_database(&pool).await.expect("Failed to initialize database");
    
    let transport = Http::new(&config.eth_rpc_url).expect("Failed to create transport");
    let web3 = Web3::new(transport);
    
    let encryption_key = hex::decode(&config.encryption_key)
        .expect("Invalid encryption key")
        .try_into()
        .expect("Encryption key must be 32 bytes");
    
    let app_state = web::Data::new(AppState {
        db: pool,
        web3,
        encryption_key,
    });
    
    println!("🚀 Ethereum Service running on port {}", config.port);
    
    HttpServer::new(move || {
        App::new()
            .app_data(app_state.clone())
            .wrap(middleware::Logger::default())
            .route("/health", web::get().to(health_check))
            .route("/wallet/create", web::post().to(create_wallet))
            .route("/wallet/balance", web::get().to(get_balance))
            .route("/transaction/send", web::post().to(send_transaction))
            .route("/transaction/status/{tx_hash}", web::get().to(get_transaction_status))
            .route("/transaction/estimate-gas", web::post().to(estimate_gas))
            .route("/message/sign", web::post().to(sign_message))
    })
    .bind(("0.0.0.0", config.port))?
    .run()
    .await
}
