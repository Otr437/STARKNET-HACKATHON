# 🚀 Quick Start Guide

Get all three Starknet services running in under 10 minutes!

## Prerequisites Check

```bash
# Check if you have the required tools
scarb --version    # Should be >= 2.8.2
starkli --version  # Should be installed
node --version     # Should be >= 18.x
```

If any are missing, install them:

```bash
# Install Scarb
curl --proto '=https' --tlsv1.2 -sSf https://docs.swmansion.com/scarb/install.sh | sh

# Install Starkli
curl https://get.starkli.sh | sh
starkliup

# Node.js - use nvm or download from nodejs.org
```

## Step 1: Setup

```bash
cd starknet-services

# Install backend dependencies
npm install

# Copy environment template
cp .env.example .env
```

## Step 2: Configure Wallet

Edit `.env` and add your Starknet account details:

```env
STARKNET_ACCOUNT=~/.starkli-wallets/deployer/account.json
STARKNET_KEYSTORE=~/.starkli-wallets/deployer/keystore.json
OWNER_ADDRESS=0x<your_address>
INITIAL_CURATOR=0x<your_address>
FEE_RECIPIENT=0x<your_address>
```

Don't have a Starknet wallet? Create one:

```bash
# Create keystore
starkli signer keystore new ~/.starkli-wallets/deployer/keystore.json

# Create account (on Sepolia testnet)
starkli account oz init ~/.starkli-wallets/deployer/account.json

# Fund it with testnet ETH from https://starknet-faucet.vercel.app/

# Deploy account
starkli account deploy ~/.starkli-wallets/deployer/account.json
```

## Step 3: Deploy Contracts

```bash
# Run the deployment script
./deploy.sh
```

This will:
1. ✅ Build all contracts
2. ✅ Declare them on Starknet
3. ✅ Deploy contract instances
4. ✅ Save addresses to `.env.deployed`

Copy the addresses from `.env.deployed` to your `.env` file.

## Step 4: Start Services

Start all three backends at once:

```bash
npm run start:all
```

Or individually:

```bash
# Terminal 1 - Vault Manager
npm run vault

# Terminal 2 - BTC Swap
npm run btc-swap

# Terminal 3 - Semaphore
npm run semaphore
```

## Step 5: Test the APIs

### Test Vault Manager
```bash
curl http://localhost:3001/health
curl http://localhost:3001/api/vault/tvl
```

### Test BTC Swap
```bash
curl http://localhost:3002/health
```

### Test Semaphore
```bash
curl http://localhost:3003/health

# Generate an identity
curl -X POST http://localhost:3003/api/identity/generate
```

## 🎉 You're Ready!

All services are now running. Check out:
- `README.md` - Full documentation
- `API_DOCS.md` - Complete API reference
- Contract source code in each `contracts/` folder

## Common Issues

### "Scarb not found"
Install Scarb: `curl --proto '=https' --tlsv1.2 -sSf https://docs.swmansion.com/scarb/install.sh | sh`

### "Account not deployed"
Fund your account with testnet ETH and deploy it using `starkli account deploy`

### "Port already in use"
Change ports in `.env`:
```env
PORT=3001
BTC_SWAP_PORT=3002
SEMAPHORE_PORT=3003
```

### "Module not found" in backend
Run `npm install` in the project root

## Next Steps

1. **Frontend Integration**: Build a frontend that connects to these APIs
2. **Testing**: Run `snforge test` in each contract directory
3. **Monitoring**: Set up logging and monitoring for production
4. **Security**: Get contracts audited before mainnet deployment

## Need Help?

- Check `README.md` for detailed documentation
- Review `API_DOCS.md` for API examples
- Open an issue on GitHub
- Join Starknet Discord for community support

Happy building! 🚀
