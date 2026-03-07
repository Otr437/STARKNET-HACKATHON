# Starknet RWA Protocol v2.0 (2026)
## Privacy-Preserving Real World Asset Tokenization

[![Built with Cairo](https://img.shields.io/badge/Built%20with-Cairo-orange)](https://www.cairo-lang.org/)
[![Privacy Layer](https://img.shields.io/badge/Privacy-Noir%20ZK-purple)](https://noir-lang.org/)
[![Starknet](https://img.shields.io/badge/Network-Starknet-blue)](https://starknet.io/)

Complete production-ready platform for tokenizing real-world assets with zero-knowledge privacy.

---

## 📂 Project Structure (2026 Standard)

```
starknet-rwa-2026/
├── contracts/                 # Cairo smart contracts
│   ├── src/
│   │   ├── inflation_oracle.cairo
│   │   ├── rwa_factory.cairo
│   │   ├── rwa_token.cairo
│   │   ├── rwa_vault.cairo
│   │   ├── interfaces.cairo
│   │   └── lib.cairo
│   ├── Scarb.toml
│   └── target/               # Compiled artifacts (generated)
│
├── circuits/                 # Noir ZK circuits
│   └── privacy/
│       ├── src/
│       │   └── main.nr
│       ├── Nargo.toml
│       └── Prover.toml
│
├── backend/                  # Node.js API server
│   ├── src/
│   │   ├── server.ts
│   │   └── event-listener.ts
│   ├── routes/
│   │   └── webhooks.ts
│   ├── services/
│   │   └── price-converter.ts
│   ├── models/
│   │   └── database.ts
│   ├── abis/                 # Contract ABIs (generated)
│   ├── package.json
│   └── tsconfig.json
│
├── frontend/                 # Web interface
│   └── index.html
│
├── scripts/                  # Deployment & utilities
│   ├── build.sh
│   ├── extract-abis.js
│   ├── deploy_oracle.ts
│   ├── deploy_factory.ts
│   ├── deploy_real_assets.ts
│   └── test-connections.js
│
├── docs/                     # Documentation
│   ├── README.md
│   ├── PRIVACY_SECURITY.md
│   ├── DEPLOYMENT_WORKFLOW.md
│   └── PRODUCTION_DEPLOYMENT.md
│
├── index.ts                  # Oracle publisher (root service)
├── package.json              # Root dependencies
├── tsconfig.json
├── .env.example
├── .gitignore
└── README.md                 # This file
```

---

## 🚀 Quick Start

### Prerequisites
```bash
# Install Scarb (Cairo compiler)
curl --proto '=https' --tlsv1.2 -sSf https://docs.swmansion.com/scarb/install.sh | sh

# Install Noir (ZK circuit compiler)
curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash
noirup

# Node.js 18+
node --version
```

### Installation
```bash
# Clone repository
git clone <repo-url>
cd starknet-rwa-2026

# Install dependencies
npm install
cd backend && npm install && cd ..

# Configure environment
cp .env.example .env
nano .env  # Add your API keys
```

### Build Everything
```bash
# Compile Cairo contracts
npm run build:contracts

# Extract ABIs for backend
npm run extract:abis

# Compile Noir circuits
cd circuits/privacy && nargo compile && cd ../..

# Compile TypeScript
npm run build
```

### Deploy to Starknet
```bash
# Deploy core contracts
npm run deploy:all

# Fetch real-world prices
npm run once

# Deploy real assets (Gold, Silver, AAPL, etc.)
npm run deploy:real-assets
```

### Start Services
```bash
# Terminal 1: Backend API
cd backend && npm run dev

# Terminal 2: Oracle Publisher (scheduled)
npm start

# Terminal 3: Frontend
cd frontend && python3 -m http.server 8000
```

---

## 🔐 Privacy Features

### Zero-Knowledge Proofs
- **NO wallet addresses stored on-chain**
- **NO balance amounts visible**
- Only commitment hashes: `hash(wallet + balance + salt)`

### How It Works
```typescript
// User creates commitment (off-chain)
const commitment = hash(myWallet, myBalance, randomSalt);

// Generates ZK proof
const proof = generateProof({
  public: [commitment],
  private: [myWallet, myBalance, randomSalt]
});

// Deposits privately
contract.deposit_private(commitment, encrypted_balance, proof);

// On-chain: Only commitment hash visible
// 0x7a3f2c... ← Reveals nothing about wallet or amount
```

### What's Private
✅ Wallet addresses  
✅ Balance amounts  
✅ Transaction amounts  
✅ User identities  

### What's Public
❌ Total supply (aggregate)  
❌ Number of positions (count)  
❌ Commitment hashes (meaningless without private keys)  

---

## 🏗️ Architecture

```
┌─────────────┐
│ Data Sources│ (BLS, FRED, Metals-API, Alpha Vantage)
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   Oracle    │ Fetches prices → Signs → Publishes
│  Publisher  │ 
└──────┬──────┘
       │
       ├──────────────────┐
       ▼                  ▼
┌─────────────┐    ┌─────────────┐
│  Starknet   │    │   Backend   │
│  Contracts  │    │     API     │
│             │    │             │
│ • Oracle    │    │ • Converts  │
│ • Factory   │    │ • Stores    │
│ • Tokens    │    │ • Serves    │
│ • Vaults    │    │ • WebSocket │
└──────┬──────┘    └──────┬──────┘
       │                  │
       └────────┬─────────┘
                ▼
         ┌─────────────┐
         │  Frontend   │
         │             │
         │ • Wallet    │
         │ • ZK Proofs │
         │ • Real-time │
         └─────────────┘
```

---

## 📊 Real World Assets

Platform supports 6 real tokenized assets with live pricing:

| Asset | Symbol | Type | Price Source |
|-------|--------|------|--------------|
| Gold | tGOLD | Commodity | Metals-API (LBMA spot) |
| Silver | tSILVER | Commodity | Metals-API (LBMA spot) |
| US 2Y Treasury | USTN2Y | TreasuryBill | FRED (TB3MS) |
| US 10Y TIPS | TIPS10Y | InflationBond | FRED (CPI-indexed) |
| Apple Stock | tAAPL | Equity | Alpha Vantage |
| Microsoft Stock | tMSFT | Equity | Alpha Vantage |

All prices update every 6 hours via oracle publisher.

---

## 🔒 Security

### Contract Security
- ✅ Ownership & access control
- ✅ Pausable (emergency stop)
- ✅ Reentrancy protection (built-in Cairo)
- ✅ Overflow protection (built-in Cairo)
- ✅ Fee collection & withdrawal
- ✅ Supply cap enforcement

### Privacy Security
- ✅ Commitment-based storage
- ✅ Nullifier registry (prevents double-spend)
- ✅ ZK proof verification
- ✅ Encrypted balances
- ✅ No wallet address leakage

---

## 🧪 Testing

```bash
# Test all connections
npm run test:connections

# Test contracts (requires deployed contracts)
cd contracts && scarb test

# Test backend
cd backend && npm test

# Dry run oracle (no transaction)
npm run dry-run
```

---

## 📚 Documentation

- **[Privacy & Security](docs/PRIVACY_SECURITY.md)** - Zero-knowledge architecture
- **[Deployment Workflow](docs/DEPLOYMENT_WORKFLOW.md)** - Step-by-step deployment
- **[Production Guide](docs/PRODUCTION_DEPLOYMENT.md)** - Production setup
- **[Backend API](backend/README.md)** - API documentation

---

## 🔑 Environment Variables

Required in `.env`:

```env
# Starknet
STARKNET_RPC_URL=https://starknet-sepolia.public.blastapi.io/rpc/v0_7
DEPLOYER_ADDRESS=0x...
DEPLOYER_PRIVATE_KEY=0x...
PUBLISHER_ADDRESS=0x...
PUBLISHER_PRIVATE_KEY=0x...

# Deployed Contracts (filled after deployment)
ORACLE_CONTRACT_ADDRESS=0x...
FACTORY_CONTRACT_ADDRESS=0x...

# API Keys (all have FREE tiers)
BLS_API_KEY=...          # https://www.bls.gov/developers/
FRED_API_KEY=...         # https://fred.stlouisfed.org
METALS_API_KEY=...       # https://metals-api.com (50 req/month free)
ALPHA_VANTAGE_KEY=...    # https://www.alphavantage.co (25 req/day free)

# Backend
BACKEND_PORT=3001
DATABASE_URL=postgresql://...
REDIS_URL=redis://localhost:6379

# Email (optional)
SMTP_HOST=smtp.gmail.com
SMTP_USER=...
SMTP_PASS=...
```

---

## 💰 Revenue Model

### Platform Revenue Streams

1. **Creation Fees**
   - Charged when creating new RWA assets
   - Collected by Factory contract
   - Admin withdraws via `withdraw_fees()`

2. **Vault Fees** (Optional)
   - Percentage of deposits/redemptions
   - Configurable per vault
   - Can be set to 0 for free vaults

3. **Yield Pool**
   - Platform can fund yield pools
   - Distributed to token holders
   - Marketing/user acquisition

### Who Gets Paid

- **You (Deployer/Admin)**: Creation fees + vault fees
- **Oracle Publishers**: Can charge for data feeds
- **Asset Issuers**: Can set their own yield rates

---

## 🛠️ Commands Reference

```bash
# Build
npm run build:contracts          # Compile Cairo
npm run extract:abis            # Extract ABIs
npm run build:all               # Build everything

# Deploy
npm run deploy:oracle           # Deploy oracle
npm run deploy:factory          # Deploy factory
npm run deploy:all              # Deploy contracts
npm run deploy:real-assets      # Deploy 6 real assets
npm run full-deploy             # Build + deploy everything

# Run
npm start                       # Oracle publisher (scheduled)
npm run once                    # Fetch prices once
npm run dry-run                 # Test without publishing
cd backend && npm run dev       # Backend API + listener

# Test
npm run test:connections        # Test all connections
```

---

## 📦 Dependencies

### Root
- `starknet` - Starknet SDK
- `dotenv` - Environment config
- `node-fetch` - HTTP client

### Backend
- `express` - API server
- `ws` - WebSocket server
- `pg` - PostgreSQL client
- `ioredis` - Redis client
- `nodemailer` - Email sending

### Circuits
- `noir` - ZK circuit compiler
- `nargo` - Noir package manager

---

## 🤝 Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing`)
5. Open Pull Request

---

## 📄 License

MIT License - See LICENSE file

---

## 🆘 Support

- **Issues**: Open GitHub issue
- **Docs**: See `docs/` directory
- **Security**: Report vulnerabilities to security@yourcompany.com

---

## 🎯 Roadmap

- [x] Privacy layer with ZK proofs
- [x] Real-world asset integration
- [x] Multi-asset oracle
- [x] Backend API
- [x] Frontend interface
- [ ] Mobile apps (iOS/Android)
- [ ] Governance token
- [ ] Cross-chain bridges
- [ ] Additional asset classes

---

**Built with ❤️ for privacy-preserving DeFi**

**Version**: 2.0.0  
**Last Updated**: March 2026
