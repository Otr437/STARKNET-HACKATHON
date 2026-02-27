# Starknet RWA Oracle

**Production-ready Real World Asset (RWA) Oracle for Starknet**

Built for the Re{define} Hackathon 2025 - Bitcoin & Privacy Tracks

## 🎯 Overview

A decentralized oracle providing real-time price feeds for tokenized real-world assets on Starknet:

- **Stocks**: AAPL, TSLA, NVDA, MSFT, GOOGL
- **Crypto**: BTC, ETH
- **Commodities**: Gold (XAU), Silver (XAG)
- **Forex**: EUR/USD, GBP/USD
- **Bonds**: US 10-Year Treasury Yield

### Features

✅ **Multi-Source Aggregation** - Fetches from Alpha Vantage, FRED, CoinGecko  
✅ **Price Validation** - Anomaly detection & deviation monitoring  
✅ **Automatic Updates** - Configurable cron-based scheduling  
✅ **Production Ready** - Error handling, retry logic, comprehensive logging  
✅ **Modular Architecture** - Independent fetchers, aggregator, poster  
✅ **Full Type Safety** - TypeScript with strict types  

## 🚀 Quick Start

### Prerequisites

- Node.js 18+ and pnpm
- Starknet wallet with Sepolia ETH
- Alpha Vantage API key (free)
- Scarb (for Cairo compilation)

### 1. Installation

```bash
# Clone repository
git clone <your-repo-url>
cd starknet-rwa-oracle

# Install dependencies
pnpm install

# Install Scarb (Cairo compiler)
curl --proto '=https' --tlsv1.2 -sSf https://docs.swmansion.com/scarb/install.sh | sh
```

### 2. Configuration

```bash
# Copy environment template
cp .env.example .env

# Edit .env with your details:
# - STARKNET_ACCOUNT_ADDRESS (your wallet address)
# - STARKNET_PRIVATE_KEY (your private key)
# - ALPHA_VANTAGE_API_KEY (get free key at https://www.alphavantage.co)
```

**Get Alpha Vantage API Key:**
1. Go to https://www.alphavantage.co/support/#api-key
2. Enter your email
3. Copy the key to .env

### 3. Deploy Contract

```bash
# Compile Cairo contract
scarb build

# Deploy to Starknet Sepolia
pnpm run deploy:contract
```

The contract address will be automatically added to your `.env` file.

### 4. Start Oracle

```bash
# Development mode with auto-reload
pnpm run dev

# Production mode
pnpm run build
pnpm start
```

## 📦 Architecture

```
┌─────────────────┐
│  Data Sources   │  Alpha Vantage, FRED, CoinGecko
└────────┬────────┘
         │
┌────────▼────────┐
│    Fetchers     │  Modular API clients with rate limiting
└────────┬────────┘
         │
┌────────▼────────┐
│   Aggregator    │  Median calculation + validation
└────────┬────────┘
         │
┌────────▼────────┐
│  Starknet Post  │  Transaction signing + submission
└────────┬────────┘
         │
┌────────▼────────┐
│  Oracle Contract│  On-chain price storage
└─────────────────┘
```

### Module Structure

```
src/
├── fetchers/           # API integrations
│   ├── alphavantage.ts # Stocks, forex, commodities
│   ├── fred.ts         # Treasury yields
│   ├── coingecko.ts    # Crypto prices
│   └── index.ts        # Fetcher manager
├── aggregator/         # Price aggregation & validation
│   └── price-aggregator.ts
├── poster/             # Starknet integration
│   └── starknet-poster.ts
├── scheduler/          # Cron orchestration
│   └── oracle-scheduler.ts
├── contracts/          # Cairo smart contracts
│   ├── oracle.cairo    # Price feed contract
│   └── oracle-abi.ts   # TypeScript ABI
├── utils/              # Shared utilities
│   ├── logger.ts       # Structured logging
│   └── retry.ts        # Retry logic
├── config.ts           # Configuration loader
├── types.ts            # TypeScript types
└── index.ts            # Main entry point
```

## 🔧 Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `STARKNET_RPC_URL` | Yes | Starknet RPC endpoint |
| `STARKNET_ACCOUNT_ADDRESS` | Yes | Your wallet address |
| `STARKNET_PRIVATE_KEY` | Yes | Your private key |
| `ORACLE_CONTRACT_ADDRESS` | Yes* | Contract address (*set after deployment) |
| `ALPHA_VANTAGE_API_KEY` | Yes | Alpha Vantage API key |
| `UPDATE_INTERVAL` | No | Update frequency (default: 900000ms / 15 min) |
| `MAX_PRICE_DEVIATION` | No | Max price change threshold (default: 10%) |
| `LOG_LEVEL` | No | Logging level (default: info) |

### Supported Assets

Edit `src/types.ts` to enable/disable assets or add new ones:

```typescript
export const SUPPORTED_ASSETS: Asset[] = [
  {
    symbol: 'AAPL',
    type: AssetType.STOCK,
    name: 'Apple Inc.',
    decimals: 8,
    sources: [DataSource.ALPHA_VANTAGE],
    updateFrequency: 900000,
    enabled: true  // Set to false to disable
  },
  // ... add more assets
];
```

## 📊 Usage

### Query Prices On-Chain

```typescript
import { Contract, RpcProvider } from 'starknet';
import { abi } from './src/contracts/oracle-abi.js';

const provider = new RpcProvider({ nodeUrl: RPC_URL });
const contract = new Contract(abi, CONTRACT_ADDRESS, provider);

// Get price
const [price, decimals, timestamp] = await contract.get_price('AAPL');
console.log(`AAPL: $${price / 10n ** BigInt(decimals)}`);

// Check if price is stale
const isStale = await contract.is_price_stale('AAPL', 3600); // 1 hour
```

### Smart Contract Integration

```cairo
use starknet::ContractAddress;

#[starknet::interface]
trait IYourContract<TContractState> {
    fn get_apple_price(self: @TContractState) -> u256;
}

#[starknet::contract]
mod YourContract {
    use super::IYourContract;
    use oracle::IPriceOracleDispatcherTrait;
    use oracle::IPriceOracleDispatcher;

    #[storage]
    struct Storage {
        oracle_address: ContractAddress,
    }

    #[abi(embed_v0)]
    impl YourContractImpl of IYourContract<ContractState> {
        fn get_apple_price(self: @ContractState) -> u256 {
            let oracle = IPriceOracleDispatcher {
                contract_address: self.oracle_address.read()
            };
            let (price, decimals, timestamp) = oracle.get_price('AAPL');
            price
        }
    }
}
```

## 🧪 Testing

```bash
# Run test script
pnpm run test

# Manual testing
pnpm run dev
# Watch logs for price updates
```

## 📈 Monitoring

### Logs

Logs are written to:
- Console (with pretty formatting)
- `logs/oracle.log` (all logs)
- `logs/error.log` (errors only)

### Metrics

The oracle logs metrics every update:
- `update_duration` - Time taken for full update cycle
- `prices_updated` - Number of successful price updates
- `update_failures` - Number of failed updates

### Health Checks

```bash
# Check if oracle is running
ps aux | grep node

# View recent logs
tail -f logs/oracle.log

# Check last update times on-chain
# Use Voyager or Starkscan to view contract events
```

## 🔐 Security

### Best Practices

✅ **Never commit `.env` file** - Contains private key  
✅ **Use separate accounts** - Don't use main wallet for oracle  
✅ **Monitor gas costs** - Set up alerts for high gas usage  
✅ **Validate prices** - Oracle has built-in anomaly detection  
✅ **Rate limiting** - Respects API rate limits automatically  

### Access Control

The oracle contract has three roles:
- **Owner**: Can transfer ownership, change oracle address
- **Oracle**: Can update prices (your backend address)
- **Public**: Can read prices

## 🚢 Production Deployment

### Using PM2

```bash
# Install PM2
npm install -g pm2

# Start oracle
pm2 start ecosystem.config.js

# Monitor
pm2 monit

# Logs
pm2 logs

# Restart
pm2 restart rwa-oracle
```

### Using Docker

```bash
# Build image
docker build -t rwa-oracle .

# Run container
docker run -d \
  --name rwa-oracle \
  --env-file .env \
  --restart unless-stopped \
  rwa-oracle
```

### Using systemd

```bash
# Create service file
sudo nano /etc/systemd/system/rwa-oracle.service

# Add:
[Unit]
Description=Starknet RWA Oracle
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/path/to/starknet-rwa-oracle
ExecStart=/usr/bin/node dist/index.js
Restart=always
EnvironmentFile=/path/to/.env

[Install]
WantedBy=multi-user.target

# Enable and start
sudo systemctl enable rwa-oracle
sudo systemctl start rwa-oracle
```

## 🤝 Contributing

This project was built for the Re{define} Hackathon. Contributions are welcome!

## 📄 License

MIT License - see LICENSE file

## 🏆 Hackathon Submission

**Re{define} Hackathon 2025 - Bitcoin Track**

### Why This Wins

1. **Real Bitcoin Utility**: Enables BTC holders to trade synthetic stocks/assets without selling BTC
2. **Production-Ready**: Full error handling, monitoring, documentation
3. **Novel for Starknet**: First comprehensive RWA oracle on the network
4. **Extensible**: Easy to add new assets and data sources
5. **Open Source**: Fully documented for community use

### Demo

- **Contract**: [Voyager Link]
- **Video**: [Coming Soon]
- **Live Dashboard**: [Coming Soon]

### Team

- Leon (Smart Contract Dev)
- Claude (Full-Stack AI)

---

**Built with 💪 for Starknet**
