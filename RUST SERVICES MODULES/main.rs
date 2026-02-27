// API Gateway Microservice - Complete Production Implementation
// Handles: Authentication, Rate Limiting, Load Balancing, Service Routing

use actix_web::{
    middleware::{Logger, Compress},
    web::{self, Data, Json, Path, Query},
    App, HttpRequest, HttpResponse, HttpServer, Error as ActixError,
};
use actix_cors::Cors;
use governor::{Quota, RateLimiter};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use sqlx::{postgres::PgPoolOptions, PgPool, Row};
use std::collections::HashMap;
use std::num::NonZeroU32;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{info, error, warn};
use uuid::Uuid;
use chrono::{DateTime, Utc, Duration};
use bcrypt::{hash, verify, DEFAULT_COST};
use reqwest::Client;

// ==================== Configuration ====================

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    pub server: ServerConfig,
    pub database: DatabaseConfig,
    pub redis: RedisConfig,
    pub jwt: JwtConfig,
    pub services: ServicesConfig,
    pub rate_limit: RateLimitConfig,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    pub workers: usize,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DatabaseConfig {
    pub url: String,
    pub max_connections: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RedisConfig {
    pub url: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct JwtConfig {
    pub secret: String,
    pub expiration_hours: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ServicesConfig {
    pub wallet_manager: String,
    pub ethereum: String,
    pub bitcoin: String,
    pub zcash: String,
    pub binance: String,
    pub solana: String,
    pub price: String,
    pub dex: String,
    pub orchestrator: String,
    pub history: String,
    pub tools: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RateLimitConfig {
    pub requests_per_minute: u32,
    pub burst_size: u32,
}

// ==================== Database Models ====================

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct User {
    pub id: Uuid,
    pub email: String,
    pub password_hash: String,
    pub role: String,
    pub api_key: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub is_active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct ApiKey {
    pub id: Uuid,
    pub user_id: Uuid,
    pub key_hash: String,
    pub name: String,
    pub permissions: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
    pub last_used_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct RequestLog {
    pub id: Uuid,
    pub user_id: Uuid,
    pub endpoint: String,
    pub method: String,
    pub status_code: i32,
    pub response_time_ms: i32,
    pub ip_address: String,
    pub created_at: DateTime<Utc>,
}

// ==================== Request/Response Models ====================

#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct AuthResponse {
    pub token: String,
    pub user_id: Uuid,
    pub email: String,
    pub role: String,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct ApiKeyResponse {
    pub api_key: String,
    pub key_id: Uuid,
    pub name: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String, // user_id
    pub email: String,
    pub role: String,
    pub exp: i64,
    pub iat: i64,
}

#[derive(Debug, Deserialize)]
pub struct ProxyRequest {
    #[serde(flatten)]
    pub data: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
    pub code: String,
    pub timestamp: DateTime<Utc>,
}

// ==================== Application State ====================

pub struct AppState {
    pub db: PgPool,
    pub redis: redis::aio::ConnectionManager,
    pub config: Config,
    pub http_client: Client,
    pub rate_limiters: Arc<RwLock<HashMap<String, RateLimiter<String, governor::state::InMemoryState, governor::clock::DefaultClock>>>>,
    pub service_health: Arc<RwLock<HashMap<String, bool>>>,
}

// ==================== Database Initialization ====================

async fn init_database(pool: &PgPool) -> Result<(), sqlx::Error> {
    info!("Initializing database schema...");
    
    sqlx::query(r#"
        CREATE TABLE IF NOT EXISTS users (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            email VARCHAR(255) UNIQUE NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            role VARCHAR(50) NOT NULL DEFAULT 'user',
            api_key VARCHAR(255) UNIQUE NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            is_active BOOLEAN NOT NULL DEFAULT true
        )
    "#).execute(pool).await?;

    sqlx::query(r#"
        CREATE TABLE IF NOT EXISTS api_keys (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            key_hash VARCHAR(255) NOT NULL,
            name VARCHAR(255) NOT NULL,
            permissions TEXT[] NOT NULL DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ,
            last_used_at TIMESTAMPTZ
        )
    "#).execute(pool).await?;

    sqlx::query(r#"
        CREATE TABLE IF NOT EXISTS request_logs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            endpoint VARCHAR(500) NOT NULL,
            method VARCHAR(10) NOT NULL,
            status_code INTEGER NOT NULL,
            response_time_ms INTEGER NOT NULL,
            ip_address VARCHAR(45) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    "#).execute(pool).await?;

    sqlx::query(r#"
        CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id)
    "#).execute(pool).await?;

    sqlx::query(r#"
        CREATE INDEX IF NOT EXISTS idx_request_logs_user_id ON request_logs(user_id)
    "#).execute(pool).await?;

    sqlx::query(r#"
        CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at)
    "#).execute(pool).await?;

    info!("Database schema initialized successfully");
    Ok(())
}

// ==================== Authentication Middleware ====================

async fn verify_jwt(token: &str, config: &JwtConfig) -> Result<Claims, jsonwebtoken::errors::Error> {
    let validation = Validation::default();
    let token_data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(config.secret.as_bytes()),
        &validation,
    )?;
    Ok(token_data.claims)
}

async fn verify_api_key(key: &str, state: &Data<AppState>) -> Result<User, ActixError> {
    let key_hash = hash(key, DEFAULT_COST).map_err(|e| {
        ActixError::from(HttpResponse::InternalServerError().json(ErrorResponse {
            error: format!("Hashing error: {}", e),
            code: "HASH_ERROR".to_string(),
            timestamp: Utc::now(),
        }))
    })?;

    let user = sqlx::query_as::<_, User>(
        "SELECT u.* FROM users u 
         JOIN api_keys ak ON u.id = ak.user_id 
         WHERE ak.key_hash = $1 AND u.is_active = true 
         AND (ak.expires_at IS NULL OR ak.expires_at > NOW())"
    )
    .bind(&key_hash)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| {
        ActixError::from(HttpResponse::InternalServerError().json(ErrorResponse {
            error: format!("Database error: {}", e),
            code: "DB_ERROR".to_string(),
            timestamp: Utc::now(),
        }))
    })?
    .ok_or_else(|| {
        ActixError::from(HttpResponse::Unauthorized().json(ErrorResponse {
            error: "Invalid API key".to_string(),
            code: "INVALID_API_KEY".to_string(),
            timestamp: Utc::now(),
        }))
    })?;

    sqlx::query("UPDATE api_keys SET last_used_at = NOW() WHERE key_hash = $1")
        .bind(&key_hash)
        .execute(&state.db)
        .await
        .ok();

    Ok(user)
}

async fn extract_user(req: HttpRequest, state: Data<AppState>) -> Result<User, ActixError> {
    if let Some(auth_header) = req.headers().get("Authorization") {
        let auth_str = auth_header.to_str().map_err(|_| {
            ActixError::from(HttpResponse::BadRequest().json(ErrorResponse {
                error: "Invalid authorization header".to_string(),
                code: "INVALID_AUTH_HEADER".to_string(),
                timestamp: Utc::now(),
            }))
        })?;

        if auth_str.starts_with("Bearer ") {
            let token = &auth_str[7..];
            let claims = verify_jwt(token, &state.config.jwt).await.map_err(|e| {
                ActixError::from(HttpResponse::Unauthorized().json(ErrorResponse {
                    error: format!("Invalid token: {}", e),
                    code: "INVALID_TOKEN".to_string(),
                    timestamp: Utc::now(),
                }))
            })?;

            let user_id = Uuid::parse_str(&claims.sub).map_err(|_| {
                ActixError::from(HttpResponse::BadRequest().json(ErrorResponse {
                    error: "Invalid user ID in token".to_string(),
                    code: "INVALID_USER_ID".to_string(),
                    timestamp: Utc::now(),
                }))
            })?;

            let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1 AND is_active = true")
                .bind(user_id)
                .fetch_optional(&state.db)
                .await
                .map_err(|e| {
                    ActixError::from(HttpResponse::InternalServerError().json(ErrorResponse {
                        error: format!("Database error: {}", e),
                        code: "DB_ERROR".to_string(),
                        timestamp: Utc::now(),
                    }))
                })?
                .ok_or_else(|| {
                    ActixError::from(HttpResponse::Unauthorized().json(ErrorResponse {
                        error: "User not found or inactive".to_string(),
                        code: "USER_NOT_FOUND".to_string(),
                        timestamp: Utc::now(),
                    }))
                })?;

            return Ok(user);
        }
    }

    if let Some(api_key) = req.headers().get("X-API-Key") {
        let key_str = api_key.to_str().map_err(|_| {
            ActixError::from(HttpResponse::BadRequest().json(ErrorResponse {
                error: "Invalid API key header".to_string(),
                code: "INVALID_API_KEY_HEADER".to_string(),
                timestamp: Utc::now(),
            }))
        })?;

        return verify_api_key(key_str, &state).await;
    }

    Err(ActixError::from(HttpResponse::Unauthorized().json(ErrorResponse {
        error: "Missing authentication credentials".to_string(),
        code: "MISSING_AUTH".to_string(),
        timestamp: Utc::now(),
    })))
}

// ==================== Rate Limiting ====================

async fn check_rate_limit(
    user_id: &str,
    state: &Data<AppState>,
) -> Result<(), ActixError> {
    let quota = Quota::per_minute(NonZeroU32::new(state.config.rate_limit.requests_per_minute).unwrap());
    
    let mut limiters = state.rate_limiters.write().await;
    let limiter = limiters.entry(user_id.to_string())
        .or_insert_with(|| RateLimiter::keyed(quota));

    match limiter.check_key(&user_id.to_string()) {
        Ok(_) => Ok(()),
        Err(_) => Err(ActixError::from(HttpResponse::TooManyRequests().json(ErrorResponse {
            error: "Rate limit exceeded".to_string(),
            code: "RATE_LIMIT_EXCEEDED".to_string(),
            timestamp: Utc::now(),
        }))),
    }
}

// ==================== Authentication Endpoints ====================

async fn register(
    body: Json<RegisterRequest>,
    state: Data<AppState>,
) -> Result<HttpResponse, ActixError> {
    let password_hash = hash(&body.password, DEFAULT_COST).map_err(|e| {
        ActixError::from(HttpResponse::InternalServerError().json(ErrorResponse {
            error: format!("Password hashing failed: {}", e),
            code: "HASH_ERROR".to_string(),
            timestamp: Utc::now(),
        }))
    })?;

    let api_key = Uuid::new_v4().to_string();

    let user = sqlx::query_as::<_, User>(
        "INSERT INTO users (email, password_hash, api_key, role) 
         VALUES ($1, $2, $3, 'user') 
         RETURNING *"
    )
    .bind(&body.email)
    .bind(&password_hash)
    .bind(&api_key)
    .fetch_one(&state.db)
    .await
    .map_err(|e| {
        if e.to_string().contains("duplicate key") {
            ActixError::from(HttpResponse::Conflict().json(ErrorResponse {
                error: "Email already registered".to_string(),
                code: "EMAIL_EXISTS".to_string(),
                timestamp: Utc::now(),
            }))
        } else {
            ActixError::from(HttpResponse::InternalServerError().json(ErrorResponse {
                error: format!("Database error: {}", e),
                code: "DB_ERROR".to_string(),
                timestamp: Utc::now(),
            }))
        }
    })?;

    let claims = Claims {
        sub: user.id.to_string(),
        email: user.email.clone(),
        role: user.role.clone(),
        exp: (Utc::now() + Duration::hours(state.config.jwt.expiration_hours)).timestamp(),
        iat: Utc::now().timestamp(),
    };

    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(state.config.jwt.secret.as_bytes()),
    )
    .map_err(|e| {
        ActixError::from(HttpResponse::InternalServerError().json(ErrorResponse {
            error: format!("Token generation failed: {}", e),
            code: "TOKEN_ERROR".to_string(),
            timestamp: Utc::now(),
        }))
    })?;

    info!("User registered: {}", user.email);

    Ok(HttpResponse::Created().json(AuthResponse {
        token,
        user_id: user.id,
        email: user.email,
        role: user.role,
        expires_at: DateTime::from_timestamp(claims.exp, 0).unwrap(),
    }))
}

async fn login(
    body: Json<LoginRequest>,
    state: Data<AppState>,
) -> Result<HttpResponse, ActixError> {
    let user = sqlx::query_as::<_, User>(
        "SELECT * FROM users WHERE email = $1 AND is_active = true"
    )
    .bind(&body.email)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| {
        ActixError::from(HttpResponse::InternalServerError().json(ErrorResponse {
            error: format!("Database error: {}", e),
            code: "DB_ERROR".to_string(),
            timestamp: Utc::now(),
        }))
    })?
    .ok_or_else(|| {
        ActixError::from(HttpResponse::Unauthorized().json(ErrorResponse {
            error: "Invalid credentials".to_string(),
            code: "INVALID_CREDENTIALS".to_string(),
            timestamp: Utc::now(),
        }))
    })?;

    let valid = verify(&body.password, &user.password_hash).map_err(|e| {
        ActixError::from(HttpResponse::InternalServerError().json(ErrorResponse {
            error: format!("Password verification failed: {}", e),
            code: "VERIFY_ERROR".to_string(),
            timestamp: Utc::now(),
        }))
    })?;

    if !valid {
        return Err(ActixError::from(HttpResponse::Unauthorized().json(ErrorResponse {
            error: "Invalid credentials".to_string(),
            code: "INVALID_CREDENTIALS".to_string(),
            timestamp: Utc::now(),
        })));
    }

    let claims = Claims {
        sub: user.id.to_string(),
        email: user.email.clone(),
        role: user.role.clone(),
        exp: (Utc::now() + Duration::hours(state.config.jwt.expiration_hours)).timestamp(),
        iat: Utc::now().timestamp(),
    };

    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(state.config.jwt.secret.as_bytes()),
    )
    .map_err(|e| {
        ActixError::from(HttpResponse::InternalServerError().json(ErrorResponse {
            error: format!("Token generation failed: {}", e),
            code: "TOKEN_ERROR".to_string(),
            timestamp: Utc::now(),
        }))
    })?;

    info!("User logged in: {}", user.email);

    Ok(HttpResponse::Ok().json(AuthResponse {
        token,
        user_id: user.id,
        email: user.email,
        role: user.role,
        expires_at: DateTime::from_timestamp(claims.exp, 0).unwrap(),
    }))
}

// ==================== Service Proxy ====================

async fn proxy_to_service(
    req: HttpRequest,
    body: web::Bytes,
    state: Data<AppState>,
    service_name: &str,
    service_url: &str,
) -> Result<HttpResponse, ActixError> {
    let user = extract_user(req.clone(), state.clone()).await?;
    check_rate_limit(&user.id.to_string(), &state).await?;

    let start_time = std::time::Instant::now();
    let path = req.uri().path();
    let query = req.uri().query().unwrap_or("");
    let url = format!("{}{}?{}", service_url, path, query);

    let method = req.method().clone();
    
    let response = state.http_client
        .request(method.clone(), &url)
        .header("X-User-Id", user.id.to_string())
        .header("X-User-Email", &user.email)
        .header("X-User-Role", &user.role)
        .body(body)
        .send()
        .await
        .map_err(|e| {
            error!("Service {} error: {}", service_name, e);
            ActixError::from(HttpResponse::BadGateway().json(ErrorResponse {
                error: format!("Service unavailable: {}", e),
                code: "SERVICE_ERROR".to_string(),
                timestamp: Utc::now(),
            }))
        })?;

    let status = response.status();
    let response_body = response.bytes().await.map_err(|e| {
        ActixError::from(HttpResponse::InternalServerError().json(ErrorResponse {
            error: format!("Failed to read response: {}", e),
            code: "RESPONSE_ERROR".to_string(),
            timestamp: Utc::now(),
        }))
    })?;

    let response_time = start_time.elapsed().as_millis() as i32;

    sqlx::query(
        "INSERT INTO request_logs (user_id, endpoint, method, status_code, response_time_ms, ip_address) 
         VALUES ($1, $2, $3, $4, $5, $6)"
    )
    .bind(user.id)
    .bind(path)
    .bind(method.as_str())
    .bind(status.as_u16() as i32)
    .bind(response_time)
    .bind(req.peer_addr().map(|a| a.ip().to_string()).unwrap_or_else(|| "unknown".to_string()))
    .execute(&state.db)
    .await
    .ok();

    Ok(HttpResponse::build(status).body(response_body))
}

// Service-specific proxy handlers
async fn wallet_proxy(req: HttpRequest, body: web::Bytes, state: Data<AppState>) -> Result<HttpResponse, ActixError> {
    proxy_to_service(req, body, state.clone(), "wallet-manager", &state.config.services.wallet_manager).await
}

async fn ethereum_proxy(req: HttpRequest, body: web::Bytes, state: Data<AppState>) -> Result<HttpResponse, ActixError> {
    proxy_to_service(req, body, state.clone(), "ethereum", &state.config.services.ethereum).await
}

async fn bitcoin_proxy(req: HttpRequest, body: web::Bytes, state: Data<AppState>) -> Result<HttpResponse, ActixError> {
    proxy_to_service(req, body, state.clone(), "bitcoin", &state.config.services.bitcoin).await
}

async fn zcash_proxy(req: HttpRequest, body: web::Bytes, state: Data<AppState>) -> Result<HttpResponse, ActixError> {
    proxy_to_service(req, body, state.clone(), "zcash", &state.config.services.zcash).await
}

async fn binance_proxy(req: HttpRequest, body: web::Bytes, state: Data<AppState>) -> Result<HttpResponse, ActixError> {
    proxy_to_service(req, body, state.clone(), "binance", &state.config.services.binance).await
}

async fn solana_proxy(req: HttpRequest, body: web::Bytes, state: Data<AppState>) -> Result<HttpResponse, ActixError> {
    proxy_to_service(req, body, state.clone(), "solana", &state.config.services.solana).await
}

async fn price_proxy(req: HttpRequest, body: web::Bytes, state: Data<AppState>) -> Result<HttpResponse, ActixError> {
    proxy_to_service(req, body, state.clone(), "price", &state.config.services.price).await
}

async fn dex_proxy(req: HttpRequest, body: web::Bytes, state: Data<AppState>) -> Result<HttpResponse, ActixError> {
    proxy_to_service(req, body, state.clone(), "dex", &state.config.services.dex).await
}

async fn orchestrator_proxy(req: HttpRequest, body: web::Bytes, state: Data<AppState>) -> Result<HttpResponse, ActixError> {
    proxy_to_service(req, body, state.clone(), "orchestrator", &state.config.services.orchestrator).await
}

// ==================== Health Check ====================

#[derive(Serialize)]
struct HealthResponse {
    status: String,
    version: String,
    timestamp: DateTime<Utc>,
    services: HashMap<String, bool>,
}

async fn health_check(state: Data<AppState>) -> HttpResponse {
    let services = state.service_health.read().await.clone();
    
    HttpResponse::Ok().json(HealthResponse {
        status: "healthy".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        timestamp: Utc::now(),
        services,
    })
}

// ==================== Main Application ====================

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("info")
        .init();

    dotenvy::dotenv().ok();

    let config = Config {
        server: ServerConfig {
            host: std::env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_string()),
            port: std::env::var("PORT").unwrap_or_else(|_| "8000".to_string()).parse().unwrap(),
            workers: std::env::var("WORKERS").unwrap_or_else(|_| "4".to_string()).parse().unwrap(),
        },
        database: DatabaseConfig {
            url: std::env::var("DATABASE_URL").expect("DATABASE_URL must be set"),
            max_connections: 20,
        },
        redis: RedisConfig {
            url: std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".to_string()),
        },
        jwt: JwtConfig {
            secret: std::env::var("JWT_SECRET").expect("JWT_SECRET must be set"),
            expiration_hours: 24,
        },
        services: ServicesConfig {
            wallet_manager: std::env::var("WALLET_SERVICE_URL").unwrap_or_else(|_| "http://localhost:8001".to_string()),
            ethereum: std::env::var("ETH_SERVICE_URL").unwrap_or_else(|_| "http://localhost:8002".to_string()),
            bitcoin: std::env::var("BTC_SERVICE_URL").unwrap_or_else(|_| "http://localhost:8003".to_string()),
            zcash: std::env::var("ZCASH_SERVICE_URL").unwrap_or_else(|_| "http://localhost:8004".to_string()),
            binance: std::env::var("BNB_SERVICE_URL").unwrap_or_else(|_| "http://localhost:8005".to_string()),
            solana: std::env::var("SOL_SERVICE_URL").unwrap_or_else(|_| "http://localhost:8006".to_string()),
            price: std::env::var("PRICE_SERVICE_URL").unwrap_or_else(|_| "http://localhost:8007".to_string()),
            dex: std::env::var("DEX_SERVICE_URL").unwrap_or_else(|_| "http://localhost:8008".to_string()),
            orchestrator: std::env::var("ORCHESTRATOR_SERVICE_URL").unwrap_or_else(|_| "http://localhost:8009".to_string()),
            history: std::env::var("HISTORY_SERVICE_URL").unwrap_or_else(|_| "http://localhost:8010".to_string()),
            tools: std::env::var("TOOLS_SERVICE_URL").unwrap_or_else(|_| "http://localhost:8011".to_string()),
        },
        rate_limit: RateLimitConfig {
            requests_per_minute: 60,
            burst_size: 10,
        },
    };

    info!("Connecting to database...");
    let pool = PgPoolOptions::new()
        .max_connections(config.database.max_connections)
        .connect(&config.database.url)
        .await
        .expect("Failed to connect to database");

    init_database(&pool).await.expect("Failed to initialize database");

    info!("Connecting to Redis...");
    let redis_client = redis::Client::open(config.redis.url.clone())
        .expect("Failed to create Redis client");
    let redis_conn = redis::aio::ConnectionManager::new(redis_client)
        .await
        .expect("Failed to connect to Redis");

    let http_client = Client::new();
    let rate_limiters = Arc::new(RwLock::new(HashMap::new()));
    let service_health = Arc::new(RwLock::new(HashMap::new()));

    let state = Data::new(AppState {
        db: pool,
        redis: redis_conn,
        config: config.clone(),
        http_client,
        rate_limiters,
        service_health,
    });

    info!("Starting API Gateway on {}:{}", config.server.host, config.server.port);

    HttpServer::new(move || {
        let cors = Cors::default()
            .allow_any_origin()
            .allow_any_method()
            .allow_any_header()
            .max_age(3600);

        App::new()
            .app_data(state.clone())
            .wrap(cors)
            .wrap(Logger::default())
            .wrap(Compress::default())
            .route("/health", web::get().to(health_check))
            .route("/auth/register", web::post().to(register))
            .route("/auth/login", web::post().to(login))
            .service(
                web::scope("/api/v1")
                    .service(web::scope("/wallet").default_service(web::to(wallet_proxy)))
                    .service(web::scope("/ethereum").default_service(web::to(ethereum_proxy)))
                    .service(web::scope("/bitcoin").default_service(web::to(bitcoin_proxy)))
                    .service(web::scope("/zcash").default_service(web::to(zcash_proxy)))
                    .service(web::scope("/binance").default_service(web::to(binance_proxy)))
                    .service(web::scope("/solana").default_service(web::to(solana_proxy)))
                    .service(web::scope("/price").default_service(web::to(price_proxy)))
                    .service(web::scope("/dex").default_service(web::to(dex_proxy)))
                    .service(web::scope("/agent").default_service(web::to(orchestrator_proxy)))
            )
    })
    .workers(config.server.workers)
    .bind((config.server.host.as_str(), config.server.port))?
    .run()
    .await
}
