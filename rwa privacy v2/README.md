# 🏆 Starknet RWA Protocol - Re{define} Hackathon 2025

**Complete privacy protocol for trading real-world assets**

## 🚀 Quick Start

**Read:** [QUICKSTART.md](./QUICKSTART.md) - Deploy in 15 minutes

## 📦 What You Get

### 1. **RWA Price Oracle** (`starknet-rwa-oracle/`)
Production oracle providing real-time prices:
- ✅ Stocks: AAPL, TSLA, NVDA, MSFT, GOOGL
- ✅ Crypto: BTC, ETH  
- ✅ Commodities: Gold, Silver
- ✅ Forex: EUR/USD, GBP/USD
- ✅ Bonds: US 10Y Treasury

**Modules:**
- `fetchers/` - API clients for Alpha Vantage, FRED, CoinGecko
- `aggregator/` - Multi-source price validation
- `poster/` - Starknet transaction submitter
- `scheduler/` - Automated updates every 15min

### 2. **Shielded RWA Vault** (`shielded-rwa-vault/`)
Tornado Cash-style anonymous trading:
- ✅ Zero wallet tracking
- ✅ Noir ZK proofs (client-side)
- ✅ Merkle tree privacy
- ✅ Cross-address withdrawals

**Components:**
- `circuits/` - Noir deposit & withdraw with Merkle proofs
- `contracts/` - Cairo vault with Merkle tree
- `backend/` - Event listener + Merkle tree builder + API
- `frontend/` - Complete HTML UI with client-side proofs

## 📋 Setup Commands

```bash
# 1. Setup dependencies
cd shielded-rwa-vault
./setup.sh

# 2. Compile everything
./compile.sh

# 3. Deploy oracle
cd ../starknet-rwa-oracle
./deploy.sh

# 4. Deploy shielded vault
cd ../shielded-rwa-vault
./deploy.sh

# 5. Run system
cd backend && pnpm run dev  # Terminal 1
cd frontend && python3 -m http.server 8000  # Terminal 2
```

## 🔒 How Privacy Works

**Deposit:**
1. Generate secret CLIENT-SIDE
2. Create commitment = hash(secret, asset, amount)
3. Submit commitment to contract
4. Contract stores hash ONLY (no wallet info)

**Withdraw:**
1. Download Merkle tree from backend
2. Generate Noir proof CLIENT-SIDE
3. Proof shows "I know secret for a note in tree"
4. Withdraw to ANY address
5. Nobody can link deposit → withdrawal

## 📊 Architecture

```
User Browser (HTML)
    ↓ Client-side proof generation
Backend (Node.js + WebSocket)
    ↓ Event listening + Merkle tree
Shielded Contract (Cairo)
    ↓ Commitment storage + Proof verification
Oracle Contract (Cairo)
    ↓ Asset price feeds
```

## 🎯 Hackathon Submission

**Tracks:** Bitcoin + Privacy  
**Total Prizes:** $19,350

**Why This Wins:**
1. ✅ Real Noir ZK proofs (not mocked)
2. ✅ Production-ready deployment
3. ✅ Complete Tornado Cash architecture
4. ✅ Working oracle integration
5. ✅ Full UI/UX with client-side proofs
6. ✅ Event listeners + Merkle tree
7. ✅ No TODOs, no placeholders
8. ✅ Modular, extensible code

## 📁 Scripts Included

| Script | Purpose |
|--------|---------|
| `setup.sh` | Install all dependencies |
| `compile.sh` | Compile circuits + contracts + backend |
| `deploy.sh` | Deploy to Starknet |
| `test-proofs.sh` | Test proof generation |

## 🧪 Input Examples

- `circuits/input-examples.json` - Example proof inputs
- `circuits/*_example.json` - Auto-generated test data
- `backend/.env.example` - Configuration template

## 📖 Documentation

- [QUICKSTART.md](./QUICKSTART.md) - Fast deployment guide
- `starknet-rwa-oracle/README.md` - Oracle documentation
- `shielded-rwa-vault/README.md` - Privacy protocol docs

## 🛠️ Tech Stack

- **ZK Proofs:** Noir + Barretenberg
- **Smart Contracts:** Cairo 2.7+
- **Backend:** Node.js + TypeScript + WebSockets
- **Frontend:** Pure HTML + Starknet.js
- **Oracle Data:** Alpha Vantage, FRED, CoinGecko

---

**Built by Leon & Claude for Re{define} Hackathon 2025**  
**NO SLOP. PRODUCTION ONLY. 🚀**
