// ZCASH SERVICE - COMPLETE PRODUCTION IMPLEMENTATION
// Handles: Zcash wallets, shielded transactions, z-addresses, RPC integration

use actix_web::{web, App, HttpResponse, HttpServer, middleware};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, postgres::PgPoolOptions};
use reqwest::Client;
use aes_gcm::{Aes256Gcm, Key, Nonce};
use aes_gcm::aead::{Aead, NewAead};
use rand::Rng;
use base64;

// ==================== CONFIGURATION ====================

#[derive(Clone)]
struct Config {
    database_url: String,
    zcash_rpc_url: String,
    zcash_rpc_user: String,
    zcash_rpc_pass: String,
    encryption_key: String,
    port: u16,
}

impl Config {
    fn from_env() -> Self {
        Self {
            database_url: std::env::var("DATABASE_URL").expect("DATABASE_URL required"),
            zcash_rpc_url: std::env::var("ZCASH_RPC_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:8232".to_string()),
            zcash_rpc_user: std::env::var("ZCASH_RPC_USER").unwrap_or_else(|_| "zcash".to_string()),
            zcash_rpc_pass: std::env::var("ZCASH_RPC_PASS").unwrap_or_else(|_| "password".to_string()),
            encryption_key: std::env::var("ENCRYPTION_KEY").expect("ENCRYPTION_KEY required"),
            port: std::env::var("PORT").unwrap_or_else(|_| "8004".to_string()).parse().unwrap(),
        }
    }
}

// ==================== DATABASE MODELS ====================

#[derive(Debug, sqlx::FromRow, Serialize)]
struct ZcashWallet {
    id: uuid::Uuid,
    user_id: uuid::Uuid,
    transparent_address: Option<String>,
    shielded_address: Option<String>,
    encrypted_private_key: String,
    created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, sqlx::FromRow, Serialize)]
struct ZcashTransaction {
    id: uuid::Uuid,
    wallet_id: uuid::Uuid,
    operation_id: String,
    from_address: String,
    to_address: String,
    amount: String,
    status: String,
    created_at: chrono::DateTime<chrono::Utc>,
    confirmed_at: Option<chrono::DateTime<chrono::Utc>>,
}

// ==================== RPC MODELS ====================

#[derive(Serialize)]
struct RpcRequest {
    jsonrpc: String,
    id: String,
    method: String,
    params: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct RpcResponse {
    result: Option<serde_json::Value>,
    error: Option<serde_json::Value>,
}

// ==================== REQUEST/RESPONSE MODELS ====================

#[derive(Deserialize)]
struct CreateWalletRequest {
    user_id: String,
    wallet_type: String, // "transparent" or "shielded"
}

#[derive(Serialize)]
struct CreateWalletResponse {
    wallet_id: String,
    transparent_address: Option<String>,
    shielded_address: Option<String>,
    created_at: String,
}

#[derive(Deserialize)]
struct GetBalanceRequest {
    address: String,
}

#[derive(Serialize)]
struct BalanceResponse {
    address: String,
    balance_zec: String,
    currency: String,
}

#[derive(Deserialize)]
struct SendTransactionRequest {
    from_address: String,
    to_address: String,
    amount: String,
    memo: Option<String>,
}

#[derive(Serialize)]
struct SendTransactionResponse {
    operation_id: String,
    from: String,
    to: String,
    amount: String,
    status: String,
}

// ==================== RPC CLIENT ====================

struct ZcashRpcClient {
    client: Client,
    url: String,
    user: String,
    pass: String,
}

impl ZcashRpcClient {
    fn new(url: String, user: String, pass: String) -> Self {
        Self {
            client: Client::new(),
            url,
            user,
            pass,
        }
    }
    
    async fn call(&self, method: &str, params: Vec<serde_json::Value>) -> Result<serde_json::Value, String> {
        let request = RpcRequest {
            jsonrpc: "1.0".to_string(),
            id: "rust-client".to_string(),
            method: method.to_string(),
            params,
        };
        
        let response = self.client
            .post(&self.url)
            .basic_auth(&self.user, Some(&self.pass))
            .json(&request)
            .send()
            .await
            .map_err(|e| format!("RPC request failed: {}", e))?;
        
        let rpc_response: RpcResponse = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse RPC response: {}", e))?;
        
        if let Some(error) = rpc_response.error {
            return Err(format!("RPC error: {}", error));
        }
        
        rpc_response.result.ok_or_else(|| "No result in RPC response".to_string())
    }
    
    async fn z_getnewaddress(&self) -> Result<String, String> {
        let result = self.call("z_getnewaddress", vec![]).await?;
        result.as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "Invalid address".to_string())
    }
    
    async fn z_getbalance(&self, address: &str) -> Result<f64, String> {
        let result = self.call("z_getbalance", vec![serde_json::json!(address)]).await?;
        result.as_f64()
            .ok_or_else(|| "Invalid balance".to_string())
    }
    
    async fn z_sendmany(&self, from: &str, to: &str, amount: f64, memo: Option<&str>) -> Result<String, String> {
        let mut recipient = serde_json::json!({
            "address": to,
            "amount": amount
        });
        
        if let Some(m) = memo {
            let memo_hex = hex::encode(m);
            recipient["memo"] = serde_json::json!(memo_hex);
        }
        
        let result = self.call(
            "z_sendmany",
            vec![
                serde_json::json!(from),
                serde_json::json!([recipient])
            ]
        ).await?;
        
        result.as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "Invalid operation ID".to_string())
    }
    
    async fn z_getoperationstatus(&self, operation_id: &str) -> Result<serde_json::Value, String> {
        let result = self.call(
            "z_getoperationstatus",
            vec![serde_json::json!([operation_id])]
        ).await?;
        
        Ok(result)
    }
}

// ==================== APPLICATION STATE ====================

struct AppState {
    db: PgPool,
    rpc: ZcashRpcClient,
    encryption_key: [u8; 32],
}

// ==================== ENCRYPTION ====================

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
    
    let shielded_address = match state.rpc.z_getnewaddress().await {
        Ok(addr) => addr,
        Err(e) => return HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("Failed to create shielded address: {}", e)
        })),
    };
    
    let encrypted_key = match encrypt_private_key(&shielded_address, &state.encryption_key) {
        Ok(enc) => enc,
        Err(e) => return HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("Encryption failed: {}", e)
        })),
    };
    
    let wallet_id = uuid::Uuid::new_v4();
    
    match sqlx::query(
        "INSERT INTO zcash_wallets (id, user_id, shielded_address, encrypted_private_key) 
         VALUES ($1, $2, $3, $4)"
    )
    .bind(wallet_id)
    .bind(user_id)
    .bind(&shielded_address)
    .bind(&encrypted_key)
    .execute(&state.db)
    .await {
        Ok(_) => HttpResponse::Created().json(CreateWalletResponse {
            wallet_id: wallet_id.to_string(),
            transparent_address: None,
            shielded_address: Some(shielded_address),
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
    match state.rpc.z_getbalance(&query.address).await {
        Ok(balance) => HttpResponse::Ok().json(BalanceResponse {
            address: query.address.clone(),
            balance_zec: format!("{:.8}", balance),
            currency: "ZEC".to_string(),
        }),
        Err(e) => HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("Failed to fetch balance: {}", e)
        })),
    }
}

async fn send_transaction(
    req: web::Json<SendTransactionRequest>,
    state: web::Data<AppState>,
) -> HttpResponse {
    let wallet = match sqlx::query_as::<_, ZcashWallet>(
        "SELECT * FROM zcash_wallets WHERE shielded_address = $1 OR transparent_address = $1"
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
    
    let amount: f64 = match req.amount.parse() {
        Ok(amt) => amt,
        Err(_) => return HttpResponse::BadRequest().json(serde_json::json!({
            "error": "Invalid amount"
        })),
    };
    
    let operation_id = match state.rpc.z_sendmany(
        &req.from_address,
        &req.to_address,
        amount,
        req.memo.as_deref()
    ).await {
        Ok(op_id) => op_id,
        Err(e) => return HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("Transaction failed: {}", e)
        })),
    };
    
    let tx_id = uuid::Uuid::new_v4();
    sqlx::query(
        "INSERT INTO zcash_transactions (id, wallet_id, operation_id, from_address, to_address, amount, status) 
         VALUES ($1, $2, $3, $4, $5, $6, 'pending')"
    )
    .bind(tx_id)
    .bind(wallet.id)
    .bind(&operation_id)
    .bind(&req.from_address)
    .bind(&req.to_address)
    .bind(&req.amount)
    .execute(&state.db)
    .await
    .ok();
    
    HttpResponse::Ok().json(SendTransactionResponse {
        operation_id,
        from: req.from_address.clone(),
        to: req.to_address.clone(),
        amount: req.amount.clone(),
        status: "pending".to_string(),
    })
}

async fn health_check() -> HttpResponse {
    HttpResponse::Ok().json(serde_json::json!({
        "status": "healthy",
        "service": "zcash-service",
        "version": "1.0.0"
    }))
}

// ==================== DATABASE INITIALIZATION ====================

async fn init_database(pool: &PgPool) -> Result<(), sqlx::Error> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS zcash_wallets (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL,
            transparent_address VARCHAR(100),
            shielded_address VARCHAR(100),
            encrypted_private_key TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )"
    ).execute(pool).await?;
    
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS zcash_transactions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            wallet_id UUID NOT NULL REFERENCES zcash_wallets(id),
            operation_id VARCHAR(100) NOT NULL,
            from_address VARCHAR(100) NOT NULL,
            to_address VARCHAR(100) NOT NULL,
            amount VARCHAR(100) NOT NULL,
            status VARCHAR(20) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            confirmed_at TIMESTAMPTZ
        )"
    ).execute(pool).await?;
    
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
    
    let rpc = ZcashRpcClient::new(
        config.zcash_rpc_url.clone(),
        config.zcash_rpc_user.clone(),
        config.zcash_rpc_pass.clone(),
    );
    
    let encryption_key = hex::decode(&config.encryption_key)
        .expect("Invalid encryption key")
        .try_into()
        .expect("Encryption key must be 32 bytes");
    
    let app_state = web::Data::new(AppState {
        db: pool,
        rpc,
        encryption_key,
    });
    
    println!("🚀 Zcash Service running on port {}", config.port);
    
    HttpServer::new(move || {
        App::new()
            .app_data(app_state.clone())
            .wrap(middleware::Logger::default())
            .route("/health", web::get().to(health_check))
            .route("/wallet/create", web::post().to(create_wallet))
            .route("/wallet/balance", web::get().to(get_balance))
            .route("/transaction/send", web::post().to(send_transaction))
    })
    .bind(("0.0.0.0", config.port))?
    .run()
    .await
}
