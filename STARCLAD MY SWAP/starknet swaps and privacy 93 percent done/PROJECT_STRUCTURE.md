# Starknet Production System - Project Structure

```
starknet-production-system/
├── README.md                          # Main project documentation
├── setup.sh                           # Quick setup script
├── Dockerfile                         # Docker container configuration
├── docker-compose.yml                 # Multi-container orchestration
│
├── contracts/                         # Cairo smart contracts
│   ├── Scarb.toml                    # Cairo project configuration
│   ├── vault_manager.cairo           # Vault management contract
│   ├── private_btc_swap.cairo        # BTC atomic swap contract
│   └── semaphore_starknet.cairo      # Zero-knowledge signaling
│
├── backend/                           # Node.js backend server
│   ├── package.json                  # Node.js dependencies
│   ├── server.js                     # Main API server
│   ├── .env.example                  # Environment template
│   └── abis/                         # Contract ABIs (generated)
│
├── deployment/                        # Deployment scripts & configs
│   ├── deploy.sh                     # Automated deployment script
│   ├── nginx.conf                    # Nginx reverse proxy config
│   ├── deployment-mainnet.json       # Mainnet addresses (generated)
│   └── deployment-sepolia.json       # Testnet addresses (generated)
│
├── docs/                             # Documentation
│   ├── DEPLOYMENT_GUIDE.md          # Complete deployment guide
│   ├── API_REFERENCE.md             # API documentation
│   ├── CONTRACTS.md                 # Smart contract details
│   ├── SECURITY.md                  # Security best practices
│   └── TROUBLESHOOTING.md           # Common issues & solutions
│
├── frontend/                         # Frontend application (optional)
│   ├── src/
│   ├── public/
│   └── package.json
│
└── ssl/                              # SSL certificates
    ├── cert.pem
    └── key.pem
```

## 📄 File Descriptions

### Root Level

- **README.md** - Project overview, quick start, and architecture
- **setup.sh** - Interactive setup script for quick deployment
- **Dockerfile** - Container definition for backend service
- **docker-compose.yml** - Full stack deployment with Redis, PostgreSQL, Nginx

### Contracts Directory

**vault_manager.cairo**
- Multi-token vault system
- Role-based access control: Admin, Curator, Manager, Pauser, Upgrader
- Features: Deposits, withdrawals, curator allocations, fee collection
- Security: Pausable, reentrancy guard, upgradeable

**private_btc_swap.cairo**
- Hash Time-Locked Contracts (HTLC) implementation
- Atomic swap functionality with privacy features
- Poseidon hash for commitment schemes
- Configurable time locks (min/max)
- Status tracking: Pending, Active, Completed, Refunded, Expired

**semaphore_starknet.cairo**
- Zero-knowledge proof based group signaling
- Merkle tree membership verification (up to 2^32 members)
- Group management with admin roles
- Nullifier tracking to prevent double-signaling
- Privacy-preserving identity commitments

### Backend Directory

**server.js** - Main API server with:
- Express.js REST API
- WebSocket event streaming
- Webhook system with signature verification
- Server-Sent Events (SSE) for real-time updates
- Rate limiting and security headers
- Health check endpoints
- Comprehensive logging (Winston)

**Key Features:**
- HTTPS/TLS support
- JWT authentication
- Role-based access control
- Redis caching integration
- PostgreSQL for webhook storage
- Prometheus metrics (optional)

### Deployment Directory

**deploy.sh** - Automated deployment script:
- Builds Cairo contracts with Scarb
- Declares and deploys to Starknet (mainnet/sepolia/devnet)
- Saves deployment addresses
- Updates backend configuration
- Generates verification URLs

**nginx.conf** - Production-grade reverse proxy:
- SSL termination
- Rate limiting
- CORS handling
- WebSocket/SSE support
- Security headers
- Gzip compression

## 🔧 Configuration Files

### Environment Variables (.env)

Required configuration:
```bash
# Network
STARKNET_RPC_URL           # Alchemy/Infura RPC endpoint
STARKNET_WS_URL            # WebSocket endpoint
ALCHEMY_API_KEY            # API key for Alchemy

# Contracts (auto-populated by deploy.sh)
VAULT_MANAGER_ADDRESS      # Deployed vault address
BTC_SWAP_ADDRESS           # Deployed swap address
SEMAPHORE_ADDRESS          # Deployed semaphore address

# Security
SSL_CERT                   # SSL certificate path
SSL_KEY                    # SSL private key path
JWT_SECRET                 # Secret for JWT tokens

# Admin
ADMIN_ADDRESS              # Contract admin address
TREASURY_ADDRESS           # Fee collection address

# Features
ENABLE_WEBSOCKET=true      # Real-time events
ENABLE_WEBHOOKS=true       # Webhook system
ENABLE_METRICS=true        # Prometheus metrics
```

### Docker Compose Services

1. **starknet-api** - Backend API server
2. **redis** - Caching layer
3. **postgres** - Webhook storage
4. **nginx** - Reverse proxy
5. **prometheus** - Metrics (optional)
6. **grafana** - Dashboards (optional)

## 📊 Generated Files

After deployment:

```
deployment/
├── deployment-mainnet.json    # Mainnet contract addresses
├── deployment-sepolia.json    # Testnet contract addresses
└── abis/                      # Generated contract ABIs
    ├── vault_manager.json
    ├── btc_swap.json
    └── semaphore.json

backend/
├── logs/
│   ├── error.log             # Error logs
│   └── combined.log          # All logs
└── .env                       # Updated with addresses
```

## 🚀 Quick Commands

```bash
# Setup
./setup.sh                     # Interactive setup

# Build contracts
cd contracts && scarb build

# Deploy contracts
cd deployment && ./deploy.sh sepolia

# Start backend (manual)
cd backend && npm start

# Start backend (Docker)
docker-compose up -d

# View logs
docker-compose logs -f starknet-api

# Run tests
cd contracts && scarb test
cd backend && npm test

# Health check
curl http://localhost:3000/health
```

## 📦 Dependencies

### Contracts
- Cairo 2.8.0+
- Scarb (package manager)
- OpenZeppelin Cairo Contracts

### Backend
- Node.js 18+
- Express.js
- Starknet.js
- Winston (logging)
- Redis (caching)
- PostgreSQL (storage)

### DevOps
- Docker & Docker Compose
- Nginx
- Let's Encrypt (SSL)

## 🔐 Security Features

- ✅ Role-based access control (all contracts)
- ✅ Reentrancy protection
- ✅ Pausable contracts
- ✅ Upgradeable pattern
- ✅ Rate limiting (API)
- ✅ HTTPS/TLS encryption
- ✅ Webhook signatures (HMAC-SHA256)
- ✅ Input validation
- ✅ Security headers (Helmet)
- ✅ CORS protection
- ✅ SQL injection prevention

## 📈 Monitoring & Logging

**Application Logs:**
- `backend/logs/error.log` - Errors only
- `backend/logs/combined.log` - All logs
- Console output (development)

**Health Checks:**
- API: `http://localhost:3000/health`
- Nginx: Built-in health checks
- Docker: Container health checks

**Metrics (Optional):**
- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3001`

## 🧪 Testing

```bash
# Unit tests (contracts)
cd contracts && scarb test

# Backend tests
cd backend && npm test

# Integration tests
npm run test:integration

# Load testing (k6)
k6 run load-test.js
```

## 📖 Documentation

See `docs/` directory for:
- Complete deployment guide
- API reference with examples
- Contract documentation
- Security best practices
- Troubleshooting guide
