# Starknet Services Suite

A comprehensive suite of three production-ready Starknet applications:

1. **Vault Manager** - Asset curator/manager system with fee structure
2. **Private BTC Swap** - Cross-chain atomic swaps with Bitcoin using HTLCs
3. **Semaphore** - Zero-knowledge group membership and anonymous signaling

## 📁 Project Structure

```
starknet-services/
├── vault-manager/
│   ├── contracts/
│   │   └── vault_manager.cairo
│   ├── backend/
│   │   └── server.js
│   ├── tests/
│   └── Scarb.toml
├── btc-swap/
│   ├── contracts/
│   │   └── private_btc_swap.cairo
│   ├── backend/
│   │   └── server.js
│   ├── tests/
│   └── Scarb.toml
├── semaphore/
│   ├── contracts/
│   │   └── semaphore_starknet.cairo
│   ├── backend/
│   │   └── server.js
│   ├── tests/
│   └── Scarb.toml
├── package.json
├── deploy.sh
└── README.md
```

## 🔧 Prerequisites

### For Contracts:
- **Scarb** (>=2.8.2) - Cairo package manager
  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://docs.swmansion.com/scarb/install.sh | sh
  ```

- **Starkli** - Starknet CLI tool
  ```bash
  curl https://get.starkli.sh | sh
  starkliup
  ```

- **Starknet Foundry** (optional, for testing)
  ```bash
  curl -L https://raw.githubusercontent.com/foundry-rs/starknet-foundry/master/scripts/install.sh | sh
  ```

### For Backends:
- **Node.js** (>=18.x)
- **npm** or **yarn**

## 🚀 Quick Start

### 1. Clone and Install Dependencies

```bash
cd starknet-services
npm install
```

### 2. Configure Environment

Create a `.env` file:

```env
# Starknet Configuration
STARKNET_RPC_URL=https://starknet-sepolia.public.blastapi.io
STARKNET_NETWORK=sepolia
STARKNET_ACCOUNT=~/.starkli-wallets/deployer/account.json
STARKNET_KEYSTORE=~/.starkli-wallets/deployer/keystore.json

# Contract Addresses (will be filled after deployment)
VAULT_MANAGER_ADDRESS=
BTC_SWAP_ADDRESS=
SEMAPHORE_ADDRESS=

# Vault Manager Settings
OWNER_ADDRESS=0x...
INITIAL_CURATOR=0x...
FEE_RECIPIENT=0x...

# Bitcoin Configuration (for BTC Swap)
BITCOIN_NETWORK=testnet

# Backend Ports
PORT=3001
```

### 3. Build Contracts

Each contract can be built individually:

```bash
# Build Vault Manager
cd vault-manager && scarb build

# Build BTC Swap
cd btc-swap && scarb build

# Build Semaphore
cd semaphore && scarb build
```

### 4. Deploy Contracts

Make the deployment script executable and run it:

```bash
chmod +x deploy.sh
./deploy.sh
```

This will:
- Build all three contracts
- Declare them on Starknet
- Deploy instances
- Save addresses to `.env.deployed`

### 5. Start Backend Services

Start all three backends simultaneously:

```bash
npm run start:all
```

Or start them individually:

```bash
npm run vault          # Vault Manager API on port 3001
npm run btc-swap       # BTC Swap API on port 3002
npm run semaphore      # Semaphore API on port 3003
```

## 📚 Service Documentation

### 1. Vault Manager

**Purpose:** Manage DeFi vaults with curator permissions and fee structures.

**Key Features:**
- Multi-asset vault management
- Curator-based governance
- Management and performance fees
- TVL tracking

**API Endpoints:**

```bash
# Get total TVL
GET /api/vault/tvl

# Get user balance
GET /api/vault/balance/:userAddress/:assetAddress

# Check if address is curator
GET /api/vault/curator/:address

# Prepare deposit transaction
POST /api/vault/prepare-deposit
{
  "assetAddress": "0x...",
  "amount": "1000000"
}

# Get analytics
GET /api/vault/analytics
```

**Smart Contract Functions:**
- `deposit(asset, amount)` - Deposit assets
- `withdraw(asset, amount)` - Withdraw with fees
- `add_curator(curator)` - Add curator (owner only)
- `rebalance_asset(asset, allocation)` - Rebalance (curator only)
- `update_fees(mgmt_fee, perf_fee)` - Update fees (owner only)

### 2. Private BTC Swap

**Purpose:** Enable trustless atomic swaps between Bitcoin and Starknet assets.

**Key Features:**
- Hash Time-Locked Contracts (HTLC)
- Cross-chain atomic swaps
- Zero trust required
- Time-lock refunds

**API Endpoints:**

```bash
# Initiate swap
POST /api/swap/initiate
{
  "participantAddress": "0x...",
  "assetAddress": "0x...",
  "amount": "1000000",
  "btcAddress": "tb1q...",
  "btcAmount": "10000",
  "timeLockHours": 24
}

# Get swap details
GET /api/swap/:swapId

# Complete swap with secret
POST /api/swap/complete
{
  "swapId": "123",
  "btcTxHash": "abc123..."
}

# Generate Bitcoin HTLC script
POST /api/swap/btc-script

# Get user's swaps
GET /api/swap/user/:address
```

**Smart Contract Functions:**
- `initiate_swap()` - Start atomic swap
- `complete_swap(swap_id, secret)` - Complete with secret
- `refund_swap(swap_id)` - Refund after timelock
- `verify_secret()` - Verify secret matches hash

**Swap Flow:**
1. Alice initiates swap on Starknet with hash-locked secret
2. Bob creates Bitcoin HTLC with same hash
3. Alice reveals secret to claim BTC
4. Bob uses revealed secret to claim Starknet assets
5. If timeout, both parties can refund

### 3. Semaphore

**Purpose:** Anonymous group membership and signaling using zero-knowledge proofs.

**Key Features:**
- Zero-knowledge group membership
- Anonymous signaling
- Nullifier tracking (prevent double-signaling)
- Merkle tree based groups

**API Endpoints:**

```bash
# Generate new identity
POST /api/identity/generate

# Create group
POST /api/group/create
{
  "adminAddress": "0x...",
  "groupName": "DAO Members",
  "description": "Anonymous voting group"
}

# Add member to group
POST /api/group/add-member
{
  "groupId": "123",
  "identityId": "uuid..."
}

# Generate proof
POST /api/proof/generate
{
  "identityId": "uuid...",
  "groupId": "123",
  "signal": "I vote YES",
  "externalNullifier": "poll-123"
}

# Get group info
GET /api/group/:groupId

# Check nullifier usage
GET /api/nullifier/:nullifierHash

# List all groups
GET /api/groups
```

**Smart Contract Functions:**
- `create_group(admin)` - Create new group
- `add_member(group_id, identity_commitment)` - Add member
- `verify_proof()` - Verify ZK proof and accept signal
- `get_merkle_root(group_id)` - Get group Merkle root

**Usage Flow:**
1. Generate identity (commitment = hash(trapdoor, nullifier))
2. Admin adds identity commitment to group
3. User generates ZK proof of membership
4. User sends anonymous signal with proof
5. Contract verifies proof without revealing identity

## 🧪 Testing

Run tests for each contract:

```bash
# Vault Manager
cd vault-manager
snforge test

# BTC Swap
cd btc-swap
snforge test

# Semaphore
cd semaphore
snforge test
```

## 📊 Architecture

### Vault Manager Architecture
```
User → Frontend → Backend API → Starknet Contract
                      ↓
              Analytics/Indexer
```

### BTC Swap Architecture
```
User A (Starknet) ←→ Backend API ←→ Starknet Contract
                          ↓
                    Bitcoin Node
                          ↓
User B (Bitcoin)  ←→ Bitcoin HTLC
```

### Semaphore Architecture
```
User → Identity Generation → Group Membership
                 ↓
       Proof Generation (ZKP)
                 ↓
       Backend API → Starknet Contract
                 ↓
       Anonymous Signal Verified
```

## 🔐 Security Considerations

### Vault Manager
- Only owner can add/remove curators
- Fee limits enforced (max 10% management, 30% performance)
- User funds tracked separately

### BTC Swap
- Atomic swaps guarantee both sides or neither
- Time-lock prevents infinite locks
- Hash-lock ensures secret required
- Refund available after timeout

### Semaphore
- Zero-knowledge proofs hide identity
- Nullifiers prevent double-signaling
- Merkle tree ensures membership
- Admin-only group management

## 🚧 Production Checklist

- [ ] Use secure key management (Hardware wallets, MPC)
- [ ] Set up proper monitoring/alerting
- [ ] Implement rate limiting on APIs
- [ ] Use Redis/Database instead of in-memory storage
- [ ] Set up indexer (Apibara) for event tracking
- [ ] Implement proper Bitcoin node integration
- [ ] Add comprehensive test coverage
- [ ] Security audit all contracts
- [ ] Set up CI/CD pipeline
- [ ] Configure proper CORS and authentication
- [ ] Implement proper ZK proof generation for Semaphore
- [ ] Set up backup and disaster recovery

## 📖 Additional Resources

- [Starknet Documentation](https://docs.starknet.io)
- [Cairo Book](https://book.cairo-lang.org)
- [Scarb Documentation](https://docs.swmansion.com/scarb)
- [Bitcoin HTLC Guide](https://en.bitcoin.it/wiki/Hash_Time_Locked_Contracts)
- [Semaphore Protocol](https://semaphore.pse.dev)

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## 📄 License

MIT License - see LICENSE file for details

## 🆘 Support

For issues and questions:
- Open an issue on GitHub
- Check Starknet Discord
- Review documentation

## 🎯 Roadmap

- [ ] Add frontend interfaces for all services
- [ ] Implement full ZK proof generation
- [ ] Add more comprehensive tests
- [ ] Create deployment guides for mainnet
- [ ] Add monitoring dashboards
- [ ] Implement advanced features (flash loans, multi-sig, etc.)
