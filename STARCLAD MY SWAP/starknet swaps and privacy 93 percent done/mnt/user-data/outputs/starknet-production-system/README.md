# 🚀 Starknet Production System

**Production-ready Starknet smart contracts with full backend infrastructure**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Cairo](https://img.shields.io/badge/Cairo-2.8.0-orange)](https://www.cairo-lang.org/)
[![Node](https://img.shields.io/badge/Node-18+-green)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-ready-blue)](https://www.docker.com/)

## 📦 What's Included

### Smart Contracts (Cairo)

1. **Vault Manager** (`vault_manager.cairo`)
   - Multi-token deposit/withdrawal system
   - Curator allocation management
   - Role-based access control (Admin, Curator, Manager, Pauser)
   - Upgradeable pattern
   - Emergency pause functionality
   - Fee collection system

2. **Private BTC Swap** (`private_btc_swap.cairo`)
   - Hash Time-Locked Contracts (HTLC)
   - Atomic swap implementation
   - Poseidon hash for privacy
   - Configurable time locks
   - Role-based access control
   - Upgradeable pattern

3. **Semaphore** (`semaphore_starknet.cairo`)
   - Zero-knowledge proof based anonymous signaling
   - Merkle tree membership verification
   - Group management
   - Nullifier tracking
   - Role-based access control
   - Upgradeable pattern

### Backend Infrastructure (Node.js/Express)

- ✅ **HTTPS** support with SSL/TLS
- ✅ **REST API** with rate limiting
- ✅ **WebSocket** event streaming
- ✅ **Webhooks** with signature verification
- ✅ **Server-Sent Events** (SSE) for real-time updates
- ✅ **Role-based authentication**
- ✅ **Comprehensive logging** (Winston)
- ✅ **Health checks** and monitoring
- ✅ **Docker** support
- ✅ **Production-grade security** (Helmet, CORS, Rate limiting)

### DevOps & Deployment

- 🐳 **Docker Compose** setup with Redis, PostgreSQL, Nginx
- 🔐 **Nginx** reverse proxy with SSL termination
- 📊 **Prometheus & Grafana** for monitoring (optional)
- 🚀 **Automated deployment scripts**
- 📝 **Comprehensive documentation**

## 🎯 Architecture

```
┌─────────────────┐
│   Frontend      │
│   (Your App)    │
└────────┬────────┘
         │ HTTPS
         ▼
┌─────────────────┐
│   Nginx         │
│   (Reverse      │
│    Proxy)       │
└────────┬────────┘
         │
         ▼
┌─────────────────┐      ┌──────────────┐
│   Backend API   │◄────►│   Redis      │
│   (Node.js)     │      │   (Cache)    │
└────────┬────────┘      └──────────────┘
         │
         ├──────────────►┌──────────────┐
         │               │  PostgreSQL  │
         │               │  (Webhooks)  │
         │               └──────────────┘
         │
         ▼
┌─────────────────┐
│   Starknet      │
│   (Layer 2)     │
│                 │
│  ┌──────────┐  │
│  │  Vault   │  │
│  │ Manager  │  │
│  └──────────┘  │
│                 │
│  ┌──────────┐  │
│  │   BTC    │  │
│  │   Swap   │  │
│  └──────────┘  │
│                 │
│  ┌──────────┐  │
│  │Semaphore │  │
│  └──────────┘  │
└─────────────────┘
```

## 🚀 Quick Start

### Option 1: Docker (Recommended)

```bash
# Clone repository
git clone <your-repo>
cd starknet-production-system

# Configure environment
cp backend/.env.example backend/.env
# Edit backend/.env with your settings

# Start all services
docker-compose up -d

# Check status
docker-compose ps

# View logs
docker-compose logs -f starknet-api
```

### Option 2: Manual Setup

```bash
# 1. Install dependencies
cd contracts && scarb build
cd ../backend && npm install

# 2. Deploy contracts
cd ../deployment
./deploy.sh sepolia

# 3. Start backend
cd ../backend
npm start
```

## 📖 Documentation

- **[Complete Deployment Guide](docs/DEPLOYMENT_GUIDE.md)** - Full setup instructions
- **[API Reference](docs/API_REFERENCE.md)** - API endpoints and examples
- **[Contract Documentation](docs/CONTRACTS.md)** - Smart contract details
- **[Security Guide](docs/SECURITY.md)** - Security best practices
- **[Troubleshooting](docs/TROUBLESHOOTING.md)** - Common issues and solutions

## 🔑 Key Features

### Security

- ✅ Role-based access control on all contracts
- ✅ Reentrancy protection
- ✅ Pausable contracts for emergencies
- ✅ Upgradeable contract pattern
- ✅ Rate limiting on API endpoints
- ✅ HTTPS/TLS encryption
- ✅ Webhook signature verification
- ✅ Security headers (Helmet)

### Scalability

- ✅ WebSocket for real-time events
- ✅ Redis caching
- ✅ Connection pooling
- ✅ Horizontal scaling ready
- ✅ Load balancer support
- ✅ Event-driven architecture

### Developer Experience

- ✅ Comprehensive API documentation
- ✅ TypeScript support
- ✅ Docker containers
- ✅ Hot reload (development)
- ✅ Detailed logging
- ✅ Health check endpoints
- ✅ Example implementations

## 🌐 API Examples

### Deposit to Vault

```bash
curl -X POST https://your-domain.com/api/vault/deposit \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "token": "0x...",
    "amount": "1000000"
  }'
```

### Register Webhook

```bash
curl -X POST https://your-domain.com/api/webhooks \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-server.com/webhook",
    "events": ["deposit", "withdrawal", "swap.completed"]
  }'
```

### Real-time Events

```javascript
const eventSource = new EventSource('https://your-domain.com/api/events/stream');

eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Event:', data);
};
```

## 🛠️ Contract Interactions

### Using Starknet.js

```javascript
import { Contract, Account, RpcProvider } from 'starknet';

const provider = new RpcProvider({ nodeUrl: RPC_URL });
const account = new Account(provider, ADDRESS, PRIVATE_KEY);

// Interact with Vault Manager
const vaultManager = new Contract(abi, contractAddress, account);

// Deposit tokens
await vaultManager.deposit(tokenAddress, amount);

// Check balance
const balance = await vaultManager.get_user_balance(userAddress, tokenAddress);
console.log('Balance:', balance.toString());
```

### Using Cairo

```cairo
use vault_manager::{IVaultManagerDispatcher, IVaultManagerDispatcherTrait};

let vault = IVaultManagerDispatcher { contract_address: vault_address };
vault.deposit(token_address, amount);
```

## 🧪 Testing

```bash
# Test contracts
cd contracts
scarb test

# Test backend
cd backend
npm test

# Integration tests
npm run test:integration

# Load testing
npm run test:load
```

## 📊 Monitoring

Access monitoring dashboards:

- **Health**: `https://your-domain.com/health`
- **Prometheus**: `http://localhost:9090` (if enabled)
- **Grafana**: `http://localhost:3001` (if enabled)

## 🔧 Configuration

### Environment Variables

```bash
# Network
STARKNET_RPC_URL=https://starknet-sepolia.g.alchemy.com/...
ALCHEMY_API_KEY=your_key

# Contracts
VAULT_MANAGER_ADDRESS=0x...
BTC_SWAP_ADDRESS=0x...
SEMAPHORE_ADDRESS=0x...

# SSL
SSL_CERT=/path/to/cert.pem
SSL_KEY=/path/to/key.pem

# Features
ENABLE_WEBSOCKET=true
ENABLE_WEBHOOKS=true
ENABLE_METRICS=true
```

See [.env.example](backend/.env.example) for full configuration.

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🆘 Support

- 📧 Email: support@your-domain.com
- 💬 Discord: [Starknet Discord](https://discord.gg/starknet)
- 🐛 Issues: [GitHub Issues](https://github.com/your-repo/issues)
- 📚 Docs: [Full Documentation](docs/)

## 🙏 Acknowledgments

- [OpenZeppelin Cairo Contracts](https://github.com/OpenZeppelin/cairo-contracts)
- [Starknet.js](https://github.com/starknet-io/starknet.js)
- [Starknet Documentation](https://docs.starknet.io)

## 📈 Roadmap

- [x] Core contracts implementation
- [x] Backend API with HTTPS
- [x] WebSocket event streaming
- [x] Webhook system
- [x] Docker deployment
- [ ] Frontend dashboard
- [ ] Mobile SDK
- [ ] Advanced analytics
- [ ] Multi-chain support

---

**Built with ❤️ for the Starknet ecosystem**

**Ready for Production** ✅
