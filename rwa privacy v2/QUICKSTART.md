# ⚡ QUICKSTART - Deploy in 15 Minutes

## Prerequisites
- Linux or macOS
- 8GB RAM
- Internet connection

## Step 1: Setup (5 min)
```bash
cd shielded-rwa-vault
./setup.sh
```

This installs:
- Node.js & pnpm
- Scarb (Cairo compiler)
- Nargo (Noir compiler)
- All dependencies

## Step 2: Compile (3 min)
```bash
./compile.sh
```

This compiles:
- Noir ZK circuits
- Cairo contracts
- TypeScript backend

## Step 3: Deploy Oracle (2 min)
```bash
cd ../starknet-rwa-oracle
cp .env.example .env
nano .env  # Add your keys

# Get Alpha Vantage key: https://www.alphavantage.co/support/#api-key
# Add your Starknet account details

./deploy.sh
# Save the oracle address!
```

## Step 4: Deploy Shielded Vault (3 min)
```bash
cd ../shielded-rwa-vault
./deploy.sh
```

It will ask for:
- Starknet account address
- Private key
- Oracle address (from step 3)

## Step 5: Run (2 min)
```bash
# Terminal 1: Backend
cd backend
pnpm run dev

# Terminal 2: Frontend
cd ../frontend
python3 -m http.server 8000

# Open: http://localhost:8000
```

## Usage

### Deposit RWA
1. Select asset (AAPL, BTC, etc.)
2. Enter amount
3. Click "Deposit"
4. **SAVE THE NOTE!**

### Withdraw RWA
1. Paste your note
2. Enter destination address
3. Click "Withdraw"
4. Funds go to destination

**Privacy: Nobody can link deposit → withdrawal**

## Troubleshooting

### "Command not found: scarb"
```bash
curl --proto '=https' --tlsv1.2 -sSf https://docs.swmansion.com/scarb/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
```

### "Command not found: nargo"
```bash
curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash
export PATH="$HOME/.nargo/bin:$PATH"
noirup
```

### "Insufficient balance"
Get Sepolia ETH from faucet:
- https://starknet-faucet.vercel.app/
- https://faucet.goerli.starknet.io/

### "Backend not connecting"
Check `.env` in backend/ has correct CONTRACT_ADDRESS

## File Structure
```
shielded-rwa-vault/
├── setup.sh           ← Run first
├── compile.sh         ← Run second
├── deploy.sh          ← Run third
├── test-proofs.sh     ← Optional testing
├── circuits/          ← Noir ZK circuits
│   ├── input-examples.json
│   └── src/
├── contracts/         ← Cairo contracts
├── backend/           ← Event listener + API
│   └── .env.example
└── frontend/          ← HTML UI
    └── index.html
```

## Testing

### Test Proof Generation
```bash
./test-proofs.sh
```

### Test Backend
```bash
cd backend
pnpm run dev
curl http://localhost:3001/health
```

### Test Frontend
Open http://localhost:8000 and check console logs

## Production Checklist
- [ ] Oracle deployed and running
- [ ] Shielded vault deployed
- [ ] Backend listening to events
- [ ] Frontend configured with contract address
- [ ] Test deposit works
- [ ] Test withdrawal works
- [ ] Save example note for demo

## Support
- Scarb docs: https://docs.swmansion.com/scarb/
- Noir docs: https://noir-lang.org/docs/
- Starknet docs: https://docs.starknet.io/

---
**13 days left - LET'S WIN THIS! 🏆**
