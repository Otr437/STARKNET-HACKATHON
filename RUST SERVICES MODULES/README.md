# Crypto Microservices Platform - Complete Production System

**High-performance cryptocurrency management platform built with Rust microservices**

## 🏗️ Architecture Overview

### Microservices (All in Rust)

| Service | Port | Description |
|---------|------|-------------|
| **API Gateway** | 8000 | Authentication, rate limiting, request routing |
| **Wallet Manager** | 8001 | Multi-chain wallet orchestration |
| **Ethereum Service** | 8002 | ETH wallet operations & transactions |
| **Bitcoin Service** | 8003 | BTC wallet operations & transactions |
| **Zcash Service** | 8004 | ZEC wallet operations & transactions |
| **Binance Service** | 8005 | BNB Smart Chain operations |
| **Solana Service** | 8006 | SOL wallet operations & transactions |
| **Price Service** | 8007 | Real-time crypto price data (CoinGecko) |
| **DEX Service** | 8008 | Uniswap/PancakeSwap/Jupiter swaps |
| **Agent Orchestrator** | 8009 | Claude AI integration & multi-agent coordination |
| **Message History** | 8010 | Conversation state management |
| **Tool Executor** | 8011 | Claude tool calling framework |
| **Admin Dashboard** | 3000 | React/TypeScript management UI |

### Infrastructure

- **PostgreSQL 16**: Primary data store
- **Redis 7**: Caching & rate limiting
- **Docker**: Containerization
- **gRPC**: Inter-service communication
- **REST**: External APIs

## 🚀 Quick Start

### Prerequisites

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install Docker & Docker Compose
curl -fsSL https://get.docker.com | sh

# Install Node.js (for admin dashboard)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### Environment Setup

```bash
# Clone repository
git clone <repo-url>
cd crypto-microservices-rust

# Create .env file
cp .env.example .env

# Edit .env with your configuration
nano .env
```

### Required Environment Variables

```bash
# Database
POSTGRES_PASSWORD=your_secure_password
DATABASE_URL=postgresql://crypto_user:your_secure_password@postgres:5432/crypto_platform

# Security
JWT_SECRET=your_jwt_secret_min_32_chars
ENCRYPTION_KEY=your_encryption_key_32_bytes_hex

# Blockchain RPCs
ETH_RPC_URL=https://eth.llamarpc.com
BTC_RPC_URL=https://your-btc-node
ZCASH_RPC_URL=http://your-zcash-node:8232
ZCASH_RPC_USER=your_rpc_user
ZCASH_RPC_PASS=your_rpc_pass
BNB_RPC_URL=https://bsc-dataseed1.binance.org
SOL_RPC_URL=https://api.mainnet-beta.solana.com

# APIs
ANTHROPIC_API_KEY=your_anthropic_api_key
COINGECKO_API_KEY=your_coingecko_api_key
```

### Build & Deploy

```bash
# Build all services
docker-compose build

# Start infrastructure
docker-compose up -d postgres redis

# Wait for databases to be ready (10-15 seconds)
sleep 15

# Start all microservices
docker-compose up -d

# View logs
docker-compose logs -f

# Check service health
curl http://localhost:8000/health
```

## 📚 API Documentation

### Authentication

#### Register User
```bash
curl -X POST http://localhost:8000/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "SecurePassword123!"
  }'
```

Response:
```json
{
  "token": "eyJhbGc...",
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "email": "user@example.com",
  "role": "user",
  "expires_at": "2026-01-28T10:00:00Z"
}
```

#### Login
```bash
curl -X POST http://localhost:8000/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "SecurePassword123!"
  }'
```

### Wallet Operations

#### Get All Wallet Balances
```bash
curl -X GET http://localhost:8000/api/v1/wallet/balances \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

Response:
```json
{
  "ethereum": {
    "address": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
    "balance": "1.23456789",
    "currency": "ETH"
  },
  "bitcoin": {
    "address": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
    "balance": "0.5",
    "currency": "BTC"
  },
  "solana": {
    "address": "7EqQdEUqgKPM2xNq8fJFfHdWq5e8K2FcJjG6Y2aXYkVp",
    "balance": "10.5",
    "currency": "SOL"
  }
}
```

#### Send Transaction
```bash
curl -X POST http://localhost:8000/api/v1/ethereum/send \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
    "amount": "0.1",
    "gas_price_gwei": "20"
  }'
```

Response:
```json
{
  "tx_hash": "0xabc123...",
  "from": "0x123...",
  "to": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
  "value": "0.1",
  "status": "pending"
}
```

### Price Data

#### Get Crypto Price
```bash
curl -X GET "http://localhost:8000/api/v1/price/quote?symbol=ETH&vs_currency=usd" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

Response:
```json
{
  "symbol": "ETH",
  "price": 2345.67,
  "24h_change": 2.5,
  "24h_volume": 15000000000,
  "market_cap": 280000000000,
  "currency": "USD"
}
```

#### Get Multiple Prices
```bash
curl -X POST http://localhost:8000/api/v1/price/batch \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "symbols": ["ETH", "BTC", "SOL"],
    "vs_currency": "usd"
  }'
```

### DEX Operations

#### Uniswap Swap
```bash
curl -X POST http://localhost:8000/api/v1/dex/swap \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "dex": "uniswap",
    "token_in": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    "token_out": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    "amount": "1.0",
    "slippage": 0.5
  }'
```

### AI Agent Operations

#### Chat with Agent
```bash
curl -X POST http://localhost:8000/api/v1/agent/chat \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "What is my ETH balance and current price?",
    "agent_name": "CryptoAssistant"
  }'
```

Response:
```json
{
  "agent": "CryptoAssistant",
  "response": [
    {
      "type": "text",
      "text": "Your Ethereum balance is 1.23 ETH. The current price is $2,345.67, so your holdings are worth approximately $2,890.32."
    }
  ],
  "conversation_id": "conv_123",
  "metadata": {
    "tools_used": ["get_wallet_balance", "get_crypto_price"],
    "processing_time_ms": 1250
  }
}
```

## 🏛️ Database Schema

### Users Table
```sql
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'user',
    api_key VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_active BOOLEAN NOT NULL DEFAULT true
);
```

### Wallets Table
```sql
CREATE TABLE wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chain VARCHAR(50) NOT NULL,
    address VARCHAR(255) NOT NULL,
    encrypted_private_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, chain)
);
```

### Transactions Table
```sql
CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
    tx_hash VARCHAR(255) NOT NULL,
    chain VARCHAR(50) NOT NULL,
    from_address VARCHAR(255) NOT NULL,
    to_address VARCHAR(255) NOT NULL,
    amount DECIMAL(36, 18) NOT NULL,
    fee DECIMAL(36, 18),
    status VARCHAR(50) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    confirmed_at TIMESTAMPTZ
);
```

## 🔒 Security Features

### Authentication
- JWT-based authentication with configurable expiration
- API key support for service-to-service communication
- Role-based access control (RBAC)
- Bcrypt password hashing with salt

### Encryption
- AES-256-GCM for private key encryption at rest
- TLS/SSL for all external communications
- Environment variable-based secrets management
- Encrypted database backups

### Rate Limiting
- Per-user rate limiting (60 req/min default)
- Distributed rate limiting via Redis
- Burst protection
- IP-based throttling

## 📊 Monitoring & Observability

### Metrics
- Prometheus-compatible metrics endpoint: `/metrics`
- Request latency histograms
- Error rate tracking
- Active connection monitoring

### Logging
- Structured JSON logging
- Log levels: ERROR, WARN, INFO, DEBUG, TRACE
- Request/response logging
- Correlation IDs for distributed tracing

### Health Checks
```bash
# Gateway health
curl http://localhost:8000/health

# Individual service health
curl http://localhost:8001/health  # Wallet Manager
curl http://localhost:8002/health  # Ethereum
# ... etc
```

## 🧪 Testing

### Unit Tests
```bash
# Test all services
./scripts/test-all.sh

# Test specific service
cd ethereum-service
cargo test
```

### Integration Tests
```bash
# Run integration test suite
./scripts/integration-tests.sh
```

### Load Testing
```bash
# Install k6
sudo apt install k6

# Run load tests
k6 run tests/load/api-gateway.js
```

## 🚢 Production Deployment

### Kubernetes
```bash
# Deploy to Kubernetes
kubectl apply -f k8s/

# Scale services
kubectl scale deployment ethereum-service --replicas=3

# Rolling update
kubectl rollout restart deployment/api-gateway
```

### Performance Tuning
- Connection pooling: 20 max connections per service
- Query optimization with indexes
- Redis caching for frequently accessed data
- Async/await throughout for non-blocking I/O
- Zero-copy optimizations in Rust

### Backup Strategy
```bash
# Automated PostgreSQL backups
0 2 * * * /scripts/backup-db.sh

# Encrypted wallet backup
0 3 * * * /scripts/backup-wallets.sh
```

## 📈 Scalability

### Horizontal Scaling
- Stateless services enable easy horizontal scaling
- Load balancing via API Gateway
- Database read replicas for query offloading
- Microservices can scale independently

### Vertical Scaling
- Optimized Rust code with minimal memory footprint
- Connection pooling prevents resource exhaustion
- Efficient async runtime (Tokio)

## 🛠️ Development

### Adding a New Service

1. Create service directory:
```bash
mkdir new-service
cd new-service
cargo init
```

2. Add to `docker-compose.yml`
3. Implement gRPC interface
4. Update API Gateway routing
5. Add tests
6. Deploy

### Code Standards
- Use `rustfmt` for formatting
- Use `clippy` for linting
- 80%+ test coverage minimum
- Document all public APIs

## 📝 License

MIT License - See LICENSE file

## 🤝 Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit changes (`git commit -m 'Add AmazingFeature'`)
4. Push to branch (`git push origin feature/AmazingFeature`)
5. Open Pull Request

## 🆘 Support

- Documentation: https://docs.example.com
- Issues: https://github.com/your-org/crypto-microservices/issues
- Discord: https://discord.gg/your-server

## 🗺️ Roadmap

- [ ] WebSocket support for real-time updates
- [ ] GraphQL API layer
- [ ] Mobile SDKs (iOS/Android)
- [ ] Additional blockchain support (Polygon, Avalanche, Cardano)
- [ ] Advanced trading strategies with AI
- [ ] Multi-signature wallet support
- [ ] Hardware wallet integration
- [ ] Compliance reporting tools

---

**Built with ❤️ using Rust for maximum performance and safety**
