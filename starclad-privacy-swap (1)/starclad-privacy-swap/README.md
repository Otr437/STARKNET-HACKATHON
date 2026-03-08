# StarClad Privacy Swap

Production-grade privacy-preserving atomic swap system across Bitcoin, Ethereum, and StarkNet.

## Architecture

```
starclad-privacy-swap/
├── modules/              # TypeScript backend
│   ├── index.ts          # CLI entry point
│   ├── server.ts         # Express server (all routes)
│   ├── server-middleware.ts  # Rate limiting, API keys, Zod validation
│   ├── poseidon.ts       # BN254 Poseidon hasher with caching
│   ├── encryption.ts     # AES-256-GCM + Argon2id key manager
│   ├── note-manager.ts   # Privacy notes + Merkle tree + spend proofs
│   ├── bitcoin-bridge.ts # SPV client, HTLC P2WSH, header chain
│   ├── atomic-swap.ts    # Swap lifecycle coordinator (Redis)
│   └── starknet-contract.ts  # Contract calls + event polling
├── contracts/
│   ├── cairo/            # swap_contract.cairo, btc_bridge.cairo
│   ├── noir/             # swap_proof.nr, spend_proof.nr, merkle_tree.nr
│   ├── evm/              # PrivacySwap.sol
│   └── bitcoin/          # htlc.ts
├── frontend/             # Vanilla JS dashboard (index.html)
├── secure/               # Runtime: salt.bin, audit.log, key_meta.json
├── docker-compose.yml
├── Dockerfile
└── .env.example
```

## Quick Start

```bash
# 1. Clone and install
npm install

# 2. Setup environment
npm run init           # creates .env.template
cp .env.template .env  # fill in your values

# 3. Start Redis
docker compose up redis -d

# 4. Run dev server
npm run dev

# 5. Open frontend
open frontend/index.html
```

## Production Deploy

```bash
# Encrypt secrets
npm run encrypt-env <master-password>

# Build + run
docker compose up --build -d
```

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Service health + Redis ping |
| GET | `/metrics` | Poseidon + note stats |
| POST | `/api/notes/generate` | Generate privacy note |
| GET | `/api/notes/merkle-root` | Current Merkle root |
| POST | `/api/proofs/spend` | Generate spend proof |
| POST | `/api/swaps/initiate` | Start atomic swap |
| POST | `/api/swaps/lock` | Lock with BTC SPV proof |
| POST | `/api/swaps/complete` | Complete with HTLC secret |
| POST | `/api/swaps/refund` | Refund after timelock |
| GET | `/api/swaps/:id` | Get swap state |
| GET | `/api/swaps/stats` | Aggregate stats |
| POST | `/api/btc/spv-proof` | Generate BTC SPV proof |
| GET | `/api/btc/fee-estimate` | BTC fee rate |
| GET | `/api/starknet/merkle-root` | On-chain Merkle root |
| GET | `/api/starknet/nullifier/:n` | Check nullifier spent |

## Privacy Model

1. **Commitment**: `Poseidon(amount, recipient, secret)` — hides all fields
2. **Nullifier**: `Poseidon(secret, recipient)` — prevents double-spend
3. **Amount commitment**: `Poseidon(amount, secret)` — for range proofs
4. **Merkle tree**: depth-20, Poseidon hashing, tracks all commitments
5. **Spend proof**: ZK signature from Poseidon over (nullifier, root, spender)
6. **Notes at rest**: AES-256-GCM encrypted, stored in Redis

## Swap Lifecycle

```
pending → [lock with BTC SPV + 6 confirmations] → locked
locked  → [reveal HTLC secret before timelock]  → completed
locked  → [timelock expires]                    → refunded / expired
```

## Security

- Argon2id master key derivation (64 MB mem, 3 iterations)
- HKDF for purpose-separated derived keys
- AES-256-GCM authenticated encryption
- Redis distributed rate limiting
- Zod input validation on all routes
- Helmet security headers
- Audit log for all crypto operations
- Key rotation with version tracking
- Secure memory wipe on shutdown
