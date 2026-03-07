# Starknet RWA Protocol - Complete Production System

Tokenized Real World Assets with inflation protection on Starknet.

## 🔗 How Everything Connects

```
┌─────────────────────────────────────────────────────────────────┐
│                         DATA SOURCES                             │
│  BLS (CPI) → FRED (Rates) → Metals-API → Alpha Vantage         │
└────────────────┬────────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                    ORACLE PUBLISHER (index.ts)                   │
│  1. Fetches real prices from APIs                               │
│  2. Signs data with private key                                 │
│  3. Publishes to InflationOracle contract                       │
│  4. Sends prices to Backend API                                 │
└────────────┬──────────────────────┬─────────────────────────────┘
             │                      │
             ▼                      ▼
┌──────────────────────┐   ┌──────────────────────────────────────┐
│  STARKNET CONTRACTS  │   │        BACKEND API                   │
│                      │   │  - Receives prices                   │
│  InflationOracle ────┼──▶│  - Converts to blockchain format    │
│  RWAFactory          │   │  - Stores in database               │
│  RWAToken (×6)       │   │  - Serves via REST API              │
│  RWAVault (×6)       │   │  - Broadcasts via WebSocket         │
└──────────┬───────────┘   └──────────┬───────────────────────────┘
           │                          │
           │                          │
           ▼                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                         FRONTEND                                 │
│  1. Loads prices from Backend API                               │
│  2. Loads assets from Backend API                               │
│  3. Connects wallet (ArgentX/Braavos)                          │
│  4. Calls contracts (deposit/redeem)                           │
│  5. Real-time updates via WebSocket                            │
└─────────────────────────────────────────────────────────────────┘
```

## 📁 Project Structure

```
starknet-rwa/
├── contracts/              # Cairo smart contracts
│   ├── inflation_oracle.cairo
│   ├── rwa_factory.cairo
│   ├── rwa_token.cairo
│   ├── rwa_vault.cairo
│   ├── interfaces.cairo
│   ├── lib.cairo
│   └── Scarb.toml
│
├── backend/                # Backend API & services
│   ├── src/
│   │   ├── server.ts       # REST API
│   │   └── event-listener.ts # On-chain event monitor
│   ├── routes/
│   │   └── webhooks.ts     # Webhook handlers
│   ├── models/
│   │   └── database.ts     # Database models
│   ├── package.json
│   └── README.md
│
├── frontend/               # Web interface
│   └── index.html          # Complete UI
│
├── scripts/                # Deployment scripts
│   ├── deploy_oracle.ts
│   ├── deploy_factory.ts
│   └── create_rwa.ts
│
├── index.ts                # Oracle publisher
├── package.json            # Root dependencies
├── tsconfig.json
└── .env.example

```

## 🚀 Quick Start

### 1. Install Dependencies

```bash
# Root (oracle publisher)
npm install

# Backend
cd backend && npm install && cd ..

# Contracts
cd contracts && scarb build && cd ..
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your keys
```

### 3. Deploy Contracts

```bash
cd contracts
scarb build
cd ..

npm run deploy:oracle
npm run deploy:factory
npm run create:rwa
```

### 4. Start Services

```bash
# Terminal 1: Backend (API + WebSocket + Event Listener)
cd backend
npm run dev

# Terminal 2: Oracle Publisher
npm run once  # or npm start for scheduled

# Terminal 3: Frontend
cd frontend
python3 -m http.server 8000
```

## 📚 Documentation

- **Contracts**: See `contracts/` - Cairo smart contracts
- **Backend**: See `backend/README.md` - API documentation
- **Scripts**: See `scripts/` - Deployment automation
- **Oracle**: See `index.ts` - Oracle publisher service

## 🏗️ Architecture

```
┌─────────────┐
│  Frontend   │ ──HTTP──> ┌─────────────┐
│ (index.html)│ <─WS───── │   Backend   │
└─────────────┘            │   API       │
                           └──────┬──────┘
                                  │
                           ┌──────▼──────┐
                           │   Event     │
                           │  Listener   │
                           └──────┬──────┘
                                  │
                           ┌──────▼──────┐
┌─────────────┐           │  Starknet    │
│   Oracle    │ ─publish─>│  Contracts   │
│  Publisher  │           │              │
└─────────────┘           └──────────────┘
```

## 🔑 Environment Variables

```env
# Starknet
STARKNET_RPC_URL=https://starknet-sepolia.public.blastapi.io/rpc/v0_7
DEPLOYER_ADDRESS=0x...
DEPLOYER_PRIVATE_KEY=0x...

# Deployed Contracts
ORACLE_CONTRACT_ADDRESS=0x...
FACTORY_CONTRACT_ADDRESS=0x...

# Oracle Publisher
PUBLISHER_ADDRESS=0x...
PUBLISHER_PRIVATE_KEY=0x...
BLS_API_KEY=your_key
FRED_API_KEY=your_key

# Backend
BACKEND_PORT=3001
WEBHOOK_SECRET=your-secret
```

## 📦 What's Included

### Smart Contracts ✅
- **InflationOracle**: CPI, T-Bill rates, Fed Funds data feed
- **RWAFactory**: Deploy & manage RWA assets
- **RWAToken**: Compliant ERC-20 with KYC
- **RWAVault**: Deposits, redemptions, yield distribution

### Backend Services ✅
- **REST API**: Query assets, positions, oracle data
- **WebSocket**: Real-time event updates
- **Event Listener**: Monitor on-chain events
- **Webhooks**: External service notifications
- **Database Models**: Ready for PostgreSQL/MongoDB

### Frontend ✅
- **Complete UI**: Terminal-style interface
- **Wallet Connect**: ArgentX/Braavos integration
- **Asset Browser**: View all RWA assets
- **Deposit/Redeem**: Interact with vaults
- **Real-time Data**: Live oracle updates

### Oracle Publisher ✅
- **Data Fetching**: BLS CPI + FRED rates
- **Cryptographic Signing**: ECDSA signatures
- **Scheduled Publishing**: Every 6 hours
- **Retry Logic**: Automatic failure recovery

### Deployment Scripts ✅
- **deploy_oracle.ts**: Deploy oracle contract
- **deploy_factory.ts**: Deploy factory + class hashes
- **create_rwa.ts**: Create test Treasury Bill

## 🎯 Usage Examples

### Deploy Everything
```bash
npm run deploy:all
npm run create:rwa
```

### Start Backend
```bash
cd backend
npm run dev
```

### Publish Oracle Data
```bash
npm run once
```

### Query API
```bash
curl http://localhost:3001/api/rwa/all
curl http://localhost:3001/api/oracle/cpi
```

### Subscribe to Events
```javascript
const ws = new WebSocket('ws://localhost:3002');
ws.onmessage = (msg) => console.log(JSON.parse(msg.data));
```

## 🔒 Security

- ✅ Signature verification on all oracle data
- ✅ KYC/whitelist compliance
- ✅ Webhook signature verification
- ✅ Supply cap enforcement
- ✅ Overflow protection

## 📈 Production Deployment

1. Use PostgreSQL/MongoDB instead of in-memory DB
2. Add Redis for WebSocket pub/sub
3. Configure CORS for your domain
4. Set up monitoring (Sentry/DataDog)
5. Use PM2 or Docker for process management
6. Configure reverse proxy (Nginx)
7. Set up SSL/TLS certificates

## 🧪 Testing

```bash
# Contracts
cd contracts && scarb test

# Backend
cd backend && npm test

# Oracle publisher
npm run dry-run
```

## 📄 License

MIT

## 🤝 Support

For issues or questions, open a GitHub issue.

---

**Built for Starknet | Production Ready | February 2026**
