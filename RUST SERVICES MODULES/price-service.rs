// PRICE SERVICE - COMPLETE PRODUCTION IMPLEMENTATION
// Handles: Real-time crypto prices, historical data, market caps, volume, CoinGecko API

use actix_web::{web, App, HttpResponse, HttpServer, middleware};
use serde::{Deserialize, Serialize};
use reqwest::Client;
use redis::AsyncCommands;
use std::collections::HashMap;
use std::time::Duration;

// ==================== CONFIGURATION ====================

#[derive(Clone)]
struct Config {
    redis_url: String,
    coingecko_api_key: Option<String>,
    port: u16,
    cache_ttl_seconds: u64,
}

impl Config {
    fn from_env() -> Self {
        Self {
            redis_url: std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".to_string()),
            coingecko_api_key: std::env::var("COINGECKO_API_KEY").ok(),
            port: std::env::var("PORT").unwrap_or_else(|_| "8007".to_string()).parse().unwrap(),
            cache_ttl_seconds: 60, // 1 minute cache
        }
    }
}

// ==================== DATA MODELS ====================

#[derive(Debug, Serialize, Deserialize, Clone)]
struct PriceData {
    symbol: String,
    price: f64,
    price_change_24h: Option<f64>,
    price_change_percentage_24h: Option<f64>,
    market_cap: Option<f64>,
    volume_24h: Option<f64>,
    circulating_supply: Option<f64>,
    total_supply: Option<f64>,
    last_updated: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct HistoricalPrice {
    timestamp: i64,
    price: f64,
}

#[derive(Debug, Serialize, Deserialize)]
struct MarketData {
    prices: Vec<HistoricalPrice>,
    market_caps: Vec<(i64, f64)>,
    total_volumes: Vec<(i64, f64)>,
}

// ==================== REQUEST/RESPONSE MODELS ====================

#[derive(Deserialize)]
struct GetPriceQuery {
    symbol: String,
    vs_currency: Option<String>,
}

#[derive(Deserialize)]
struct BatchPriceRequest {
    symbols: Vec<String>,
    vs_currency: Option<String>,
}

#[derive(Serialize)]
struct BatchPriceResponse {
    prices: HashMap<String, PriceData>,
    vs_currency: String,
}

#[derive(Deserialize)]
struct HistoricalQuery {
    symbol: String,
    vs_currency: Option<String>,
    days: Option<u32>,
}

#[derive(Serialize)]
struct HistoricalResponse {
    symbol: String,
    vs_currency: String,
    data: MarketData,
}

// ==================== APPLICATION STATE ====================

struct AppState {
    http_client: Client,
    redis_client: redis::aio::ConnectionManager,
    coin_id_map: HashMap<String, String>,
    coingecko_api_key: Option<String>,
    cache_ttl: u64,
}

// ==================== COIN ID MAPPING ====================

fn get_coin_id_map() -> HashMap<String, String> {
    let mut map = HashMap::new();
    map.insert("BTC".to_string(), "bitcoin".to_string());
    map.insert("ETH".to_string(), "ethereum".to_string());
    map.insert("SOL".to_string(), "solana".to_string());
    map.insert("BNB".to_string(), "binancecoin".to_string());
    map.insert("ZEC".to_string(), "zcash".to_string());
    map.insert("USDT".to_string(), "tether".to_string());
    map.insert("USDC".to_string(), "usd-coin".to_string());
    map.insert("ADA".to_string(), "cardano".to_string());
    map.insert("DOT".to_string(), "polkadot".to_string());
    map.insert("MATIC".to_string(), "matic-network".to_string());
    map.insert("AVAX".to_string(), "avalanche-2".to_string());
    map.insert("LINK".to_string(), "chainlink".to_string());
    map.insert("UNI".to_string(), "uniswap".to_string());
    map.insert("AAVE".to_string(), "aave".to_string());
    map.insert("ATOM".to_string(), "cosmos".to_string());
    map
}

// ==================== CACHE OPERATIONS ====================

async fn get_from_cache(
    redis: &mut redis::aio::ConnectionManager,
    key: &str,
) -> Result<Option<PriceData>, redis::RedisError> {
    let cached: Option<String> = redis.get(key).await?;
    
    if let Some(data) = cached {
        if let Ok(price_data) = serde_json::from_str::<PriceData>(&data) {
            return Ok(Some(price_data));
        }
    }
    
    Ok(None)
}

async fn set_in_cache(
    redis: &mut redis::aio::ConnectionManager,
    key: &str,
    data: &PriceData,
    ttl: u64,
) -> Result<(), redis::RedisError> {
    let json = serde_json::to_string(data).unwrap();
    redis.set_ex(key, json, ttl).await
}

// ==================== COINGECKO API OPERATIONS ====================

async fn fetch_price_from_coingecko(
    client: &Client,
    coin_id: &str,
    vs_currency: &str,
    api_key: &Option<String>,
) -> Result<PriceData, String> {
    let mut url = format!(
        "https://api.coingecko.com/api/v3/simple/price?ids={}&vs_currencies={}&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true",
        coin_id, vs_currency
    );
    
    if let Some(key) = api_key {
        url = format!("{}&x_cg_pro_api_key={}", url, key);
    }
    
    let response = client.get(&url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    
    if !response.status().is_success() {
        return Err(format!("API returned status: {}", response.status()));
    }
    
    let data: serde_json::Value = response.json()
        .await
        .map_err(|e| format!("JSON parse failed: {}", e))?;
    
    let coin_data = data.get(coin_id)
        .ok_or_else(|| "Coin data not found".to_string())?;
    
    let price = coin_data.get(vs_currency)
        .and_then(|v| v.as_f64())
        .ok_or_else(|| "Price not found".to_string())?;
    
    let price_change_24h = coin_data.get(format!("{}_24h_change", vs_currency))
        .and_then(|v| v.as_f64());
    
    let market_cap = coin_data.get(format!("{}_market_cap", vs_currency))
        .and_then(|v| v.as_f64());
    
    let volume_24h = coin_data.get(format!("{}_24h_vol", vs_currency))
        .and_then(|v| v.as_f64());
    
    Ok(PriceData {
        symbol: coin_id.to_uppercase(),
        price,
        price_change_24h,
        price_change_percentage_24h: None,
        market_cap,
        volume_24h,
        circulating_supply: None,
        total_supply: None,
        last_updated: chrono::Utc::now().to_rfc3339(),
    })
}

async fn fetch_historical_data(
    client: &Client,
    coin_id: &str,
    vs_currency: &str,
    days: u32,
    api_key: &Option<String>,
) -> Result<MarketData, String> {
    let mut url = format!(
        "https://api.coingecko.com/api/v3/coins/{}/market_chart?vs_currency={}&days={}",
        coin_id, vs_currency, days
    );
    
    if let Some(key) = api_key {
        url = format!("{}&x_cg_pro_api_key={}", url, key);
    }
    
    let response = client.get(&url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    
    if !response.status().is_success() {
        return Err(format!("API returned status: {}", response.status()));
    }
    
    let data: serde_json::Value = response.json()
        .await
        .map_err(|e| format!("JSON parse failed: {}", e))?;
    
    let prices_raw = data.get("prices")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "Prices not found".to_string())?;
    
    let prices = prices_raw.iter()
        .filter_map(|p| {
            let arr = p.as_array()?;
            let timestamp = arr.get(0)?.as_i64()?;
            let price = arr.get(1)?.as_f64()?;
            Some(HistoricalPrice { timestamp, price })
        })
        .collect();
    
    let market_caps_raw = data.get("market_caps")
        .and_then(|v| v.as_array())
        .unwrap_or(&vec![]);
    
    let market_caps = market_caps_raw.iter()
        .filter_map(|p| {
            let arr = p.as_array()?;
            let timestamp = arr.get(0)?.as_i64()?;
            let cap = arr.get(1)?.as_f64()?;
            Some((timestamp, cap))
        })
        .collect();
    
    let volumes_raw = data.get("total_volumes")
        .and_then(|v| v.as_array())
        .unwrap_or(&vec![]);
    
    let total_volumes = volumes_raw.iter()
        .filter_map(|p| {
            let arr = p.as_array()?;
            let timestamp = arr.get(0)?.as_i64()?;
            let vol = arr.get(1)?.as_f64()?;
            Some((timestamp, vol))
        })
        .collect();
    
    Ok(MarketData {
        prices,
        market_caps,
        total_volumes,
    })
}

// ==================== API HANDLERS ====================

async fn get_price(
    query: web::Query<GetPriceQuery>,
    state: web::Data<AppState>,
) -> HttpResponse {
    let vs_currency = query.vs_currency.as_deref().unwrap_or("usd");
    let symbol = query.symbol.to_uppercase();
    
    let coin_id = match state.coin_id_map.get(&symbol) {
        Some(id) => id,
        None => return HttpResponse::BadRequest().json(serde_json::json!({
            "error": format!("Unsupported symbol: {}", symbol)
        })),
    };
    
    let cache_key = format!("price:{}:{}", coin_id, vs_currency);
    let mut redis_conn = state.redis_client.clone();
    
    if let Ok(Some(cached_data)) = get_from_cache(&mut redis_conn, &cache_key).await {
        return HttpResponse::Ok().json(cached_data);
    }
    
    match fetch_price_from_coingecko(&state.http_client, coin_id, vs_currency, &state.coingecko_api_key).await {
        Ok(mut price_data) => {
            price_data.symbol = symbol.clone();
            
            if let Err(e) = set_in_cache(&mut redis_conn, &cache_key, &price_data, state.cache_ttl).await {
                eprintln!("Cache set failed: {}", e);
            }
            
            HttpResponse::Ok().json(price_data)
        }
        Err(e) => HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("Failed to fetch price: {}", e)
        })),
    }
}

async fn get_batch_prices(
    req: web::Json<BatchPriceRequest>,
    state: web::Data<AppState>,
) -> HttpResponse {
    let vs_currency = req.vs_currency.as_deref().unwrap_or("usd");
    let mut prices = HashMap::new();
    
    for symbol in &req.symbols {
        let symbol_upper = symbol.to_uppercase();
        
        if let Some(coin_id) = state.coin_id_map.get(&symbol_upper) {
            match fetch_price_from_coingecko(&state.http_client, coin_id, vs_currency, &state.coingecko_api_key).await {
                Ok(mut price_data) => {
                    price_data.symbol = symbol_upper.clone();
                    prices.insert(symbol_upper, price_data);
                }
                Err(e) => {
                    eprintln!("Failed to fetch price for {}: {}", symbol, e);
                }
            }
        }
    }
    
    HttpResponse::Ok().json(BatchPriceResponse {
        prices,
        vs_currency: vs_currency.to_string(),
    })
}

async fn get_historical(
    query: web::Query<HistoricalQuery>,
    state: web::Data<AppState>,
) -> HttpResponse {
    let vs_currency = query.vs_currency.as_deref().unwrap_or("usd");
    let symbol = query.symbol.to_uppercase();
    let days = query.days.unwrap_or(7);
    
    let coin_id = match state.coin_id_map.get(&symbol) {
        Some(id) => id,
        None => return HttpResponse::BadRequest().json(serde_json::json!({
            "error": format!("Unsupported symbol: {}", symbol)
        })),
    };
    
    match fetch_historical_data(&state.http_client, coin_id, vs_currency, days, &state.coingecko_api_key).await {
        Ok(market_data) => HttpResponse::Ok().json(HistoricalResponse {
            symbol,
            vs_currency: vs_currency.to_string(),
            data: market_data,
        }),
        Err(e) => HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("Failed to fetch historical data: {}", e)
        })),
    }
}

async fn list_supported_coins(
    state: web::Data<AppState>,
) -> HttpResponse {
    let supported: Vec<String> = state.coin_id_map.keys().cloned().collect();
    
    HttpResponse::Ok().json(serde_json::json!({
        "supported_symbols": supported,
        "total": supported.len()
    }))
}

async fn health_check() -> HttpResponse {
    HttpResponse::Ok().json(serde_json::json!({
        "status": "healthy",
        "service": "price-service",
        "version": "1.0.0"
    }))
}

// ==================== MAIN SERVER ====================

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    env_logger::init();
    dotenv::dotenv().ok();
    
    let config = Config::from_env();
    
    let redis_client = redis::Client::open(config.redis_url.clone())
        .expect("Failed to create Redis client");
    
    let redis_conn = redis::aio::ConnectionManager::new(redis_client)
        .await
        .expect("Failed to connect to Redis");
    
    let http_client = Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .expect("Failed to create HTTP client");
    
    let app_state = web::Data::new(AppState {
        http_client,
        redis_client: redis_conn,
        coin_id_map: get_coin_id_map(),
        coingecko_api_key: config.coingecko_api_key,
        cache_ttl: config.cache_ttl_seconds,
    });
    
    println!("🚀 Price Service running on port {}", config.port);
    
    HttpServer::new(move || {
        App::new()
            .app_data(app_state.clone())
            .wrap(middleware::Logger::default())
            .route("/health", web::get().to(health_check))
            .route("/price", web::get().to(get_price))
            .route("/price/batch", web::post().to(get_batch_prices))
            .route("/price/historical", web::get().to(get_historical))
            .route("/supported", web::get().to(list_supported_coins))
    })
    .bind(("0.0.0.0", config.port))?
    .run()
    .await
}
