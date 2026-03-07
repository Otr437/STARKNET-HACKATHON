# Complete Deployment Workflow

This guide covers the COMPLETE deployment process from compilation to live production.

## Prerequisites

- Node.js 18+
- Scarb (Cairo compiler) - https://docs.swmansion.com/scarb/download.html
- Starknet wallet with funds
- API keys configured in .env

## Step-by-Step Deployment

### 1. Environment Setup

```bash
# Copy environment template
cp .env.example .env

# Edit .env with your values
nano .env
```

Required variables:
```env
# Starknet
STARKNET_RPC_URL=https://starknet-sepolia.public.blastapi.io/rpc/v0_7
DEPLOYER_ADDRESS=0x...
DEPLOYER_PRIVATE_KEY=0x...
PUBLISHER_ADDRESS=0x...
PUBLISHER_PRIVATE_KEY=0x...

# API Keys (get free keys from each service)
BLS_API_KEY=...          # https://www.bls.gov/developers/
FRED_API_KEY=...         # https://fred.stlouisfed.org/docs/api/api_key.html
METALS_API_KEY=...       # https://metals-api.com (FREE: 50 req/month)
ALPHA_VANTAGE_KEY=...    # https://www.alphavantage.co (FREE: 25 req/day)
```

### 2. Install Dependencies

```bash
# Root dependencies (oracle publisher)
npm install

# Backend dependencies
cd backend && npm install && cd ..
```

### 3. Compile Cairo Contracts

```bash
# Build all contracts
npm run build:contracts

# This runs: scarb build
# Generates: contracts/target/dev/*.sierra.json and *.casm.json
```

Output:
```
✅ contracts/target/dev/starknet_rwa_InflationOracle.contract_class.json
✅ contracts/target/dev/starknet_rwa_InflationOracle.compiled_contract_class.json
✅ contracts/target/dev/starknet_rwa_RWAFactory.contract_class.json
✅ contracts/target/dev/starknet_rwa_RWAFactory.compiled_contract_class.json
✅ contracts/target/dev/starknet_rwa_RWAToken.contract_class.json
✅ contracts/target/dev/starknet_rwa_RWAToken.compiled_contract_class.json
✅ contracts/target/dev/starknet_rwa_RWAVault.contract_class.json
✅ contracts/target/dev/starknet_rwa_RWAVault.compiled_contract_class.json
```

### 4. Extract ABIs for Backend

```bash
# Extract ABIs from compiled contracts
npm run extract:abis

# This creates: backend/abis/*.json
```

The backend needs these ABIs to interact with deployed contracts.

### 5. Deploy Oracle Contract

```bash
npm run deploy:oracle
```

This will:
1. Declare InflationOracle contract class
2. Deploy instance with initial CPI data
3. Add `ORACLE_CONTRACT_ADDRESS` to your .env file

Output:
```
✅ Class hash: 0x1234...
✅ DEPLOYED!
Address: 0x5678...

Add to .env:
ORACLE_CONTRACT_ADDRESS=0x5678...
```

### 6. Deploy Factory Contract

```bash
npm run deploy:factory
```

This will:
1. Declare RWAToken contract class
2. Declare RWAVault contract class
3. Declare RWAFactory contract class
4. Deploy Factory with class hashes
5. Add `FACTORY_CONTRACT_ADDRESS` to your .env file

Output:
```
✅ Token class: 0xabc...
✅ Vault class: 0xdef...
✅ Factory class: 0x123...
✅ DEPLOYED!
Factory: 0x456...

Add to .env:
FACTORY_CONTRACT_ADDRESS=0x456...
```

### 7. Fetch Real-World Price Data

```bash
# Run oracle publisher once to fetch current prices
npm run once
```

This will:
1. Fetch CPI from BLS
2. Fetch T-Bill rates from FRED
3. Fetch metal prices from Metals-API
4. Fetch stock prices from Alpha Vantage
5. Publish macro data to Oracle contract
6. Save asset prices to backend API

Output:
```
[Oracle] Fetching macro data...
[BLS] CPI: 314.12 (2025-12)
[FRED] TB3MS: 4.30% (2026-02-28)
[FRED] DGS10: 4.56% (2026-02-28)
[Metals-API] Gold: $2,650.50/oz, Silver: $31.25/oz
[Alpha Vantage] AAPL: $220.75 (2026-02-28)
[Backend] Asset prices saved to API
✅ Published to Starknet
TX: 0x789...
```

### 8. Deploy REAL RWA Assets

```bash
npm run deploy:real-assets
```

This creates 6 real-world assets using live price data:

```
Creating: Tokenized_Gold (tGOLD)
Par Value: $132.53 (1/20 oz @ $2,650.50/oz)
✅ tGOLD deployed successfully!

Creating: Tokenized_Silver (tSILVER)
Par Value: $31.25 (1 oz)
✅ tSILVER deployed successfully!

Creating: US_Treasury_2Y (USTN2Y)
Par Value: $100.00
Yield: 4.30%
✅ USTN2Y deployed successfully!

Creating: US_TIPS_10Y (TIPS10Y)
Par Value: $100.00 (inflation-protected)
Yield: 2.00%
✅ TIPS10Y deployed successfully!

Creating: Apple_Inc_Stock (tAAPL)
Par Value: $220.75
✅ tAAPL deployed successfully!

Creating: Microsoft_Stock (tMSFT)
Par Value: $420.00
✅ tMSFT deployed successfully!
```

### 9. Start Backend Services

```bash
cd backend

# Start API server + Event listener
npm run dev
```

This starts:
- REST API on http://localhost:3001
- WebSocket server on ws://localhost:3002
- Event listener polling Starknet blocks

### 10. Open Frontend

```bash
# In frontend directory or serve via nginx
cd frontend
python3 -m http.server 8000

# Open browser
open http://localhost:8000
```

## Complete One-Command Deployment

```bash
# Build everything, deploy everything, create assets
npm run full-deploy
```

This runs:
1. `build:contracts` - Compile Cairo
2. `extract:abis` - Extract ABIs
3. `build` - Compile TypeScript
4. `deploy:oracle` - Deploy oracle
5. `deploy:factory` - Deploy factory
6. `deploy:real-assets` - Create 6 real assets

## Contract Addresses

After deployment, you'll have:

```
ORACLE_CONTRACT_ADDRESS=0x...      # InflationOracle
FACTORY_CONTRACT_ADDRESS=0x...     # RWAFactory

# Class hashes stored in factory:
RWAToken class hash: 0x...
RWAVault class hash: 0x...

# Deployed RWA assets (6):
tGOLD token:    0x...
tGOLD vault:    0x...
tSILVER token:  0x...
tSILVER vault:  0x...
USTN2Y token:   0x...
USTN2Y vault:   0x...
TIPS10Y token:  0x...
TIPS10Y vault:  0x...
tAAPL token:    0x...
tAAPL vault:    0x...
tMSFT token:    0x...
tMSFT vault:    0x...
```

## Fee Structure

When deploying RWA assets, the factory charges a creation fee:

- **Fee Amount**: Configurable (default: 100 USDC)
- **Fee Token**: USDC or STRK
- **Fee Recipient**: Factory contract
- **Fee Withdrawal**: Admin calls `withdraw_fees(recipient_address)`

You (the deployer) earn fees from:
1. **Creation fees** - Every time someone creates an RWA asset
2. **Vault fees** (if implemented) - Percentage of deposits/redemptions

## Ongoing Maintenance

### Oracle Publisher

Run every 6 hours to update prices:

```bash
# Scheduled mode (runs every 6 hours)
npm start

# Or use cron:
0 */6 * * * cd /path/to/project && npm run once
```

### Backend Services

Keep running 24/7:

```bash
# Use PM2 for production
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

### Update Asset Prices

Prices update automatically via oracle publisher → backend API → frontend

## Verification

### Check Deployed Contracts

```bash
# Mainnet explorer
https://starkscan.co/contract/0x...

# Testnet explorer
https://testnet.starkscan.co/contract/0x...
```

### Test API Endpoints

```bash
# Oracle data
curl http://localhost:3001/api/oracle/cpi

# All assets
curl http://localhost:3001/api/rwa/all

# Current prices
curl http://localhost:3001/api/prices/current

# Price for specific asset
curl http://localhost:3001/api/prices/XAU

# Blockchain format
curl "http://localhost:3001/api/prices/current?format=blockchain"

# Cairo format (ready for contract calls)
curl "http://localhost:3001/api/prices/current?format=cairo"
```

## Troubleshooting

### Contract compilation fails

```bash
# Update Scarb
curl --proto '=https' --tlsv1.2 -sSf https://docs.swmansion.com/scarb/install.sh | sh

# Clean and rebuild
cd contracts && rm -rf target && scarb build
```

### Deployment fails - insufficient funds

```bash
# Check balance
starkli balance 0x...your_address

# Fund account from faucet (testnet)
https://faucet.goerli.starknet.io
```

### API returns no price data

```bash
# Run oracle publisher first
npm run once

# Check backend is running
curl http://localhost:3001/health
```

### Frontend shows "Connect wallet"

```bash
# Make sure backend URL is configured
# In browser console:
setApiUrls('http://localhost:3001', 'ws://localhost:3002')
```

## Security Checklist

- [ ] Private keys stored securely (not in .env in production)
- [ ] API keys rotated regularly
- [ ] Fee withdrawal only by admin
- [ ] Contract ownership transferable
- [ ] Rate limiting on API endpoints
- [ ] WebSocket authentication for production
- [ ] HTTPS/WSS in production
- [ ] Database backups enabled

---

**🚀 You now have a complete, production-ready RWA tokenization platform!**
