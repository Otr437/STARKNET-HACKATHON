# RWA Oracle — Production Feeder & Admin API

Real-world asset price oracle for **StarkNet Mainnet**.  
Fetches real prices from multiple APIs, aggregates them, submits on-chain, and persists everything to PostgreSQL.

**No mocks. No demos. No simulations. Real blockchain. Real data.**

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     Price Sources                            │
│  GoldAPI  ·  MetalpriceAPI  ·  Metals.Dev  ·  AlphaVantage  │
└────────────────────────┬─────────────────────────────────────┘
                         │ raw prices
                         ▼
┌──────────────────────────────────────────────────────────────┐
│                  Feeder Process                              │
│   Aggregator (median + outlier removal)                      │
│   CircuitBreaker (protects against RPC outages)             │
│   AlertEngine (staleness / deviation / source down)         │
└──────┬──────────────────────────┬────────────────────────────┘
       │ update_price multicall   │ persist raw + history
       ▼                          ▼
┌──────────────────┐   ┌──────────────────────────────────────┐
│  StarkNet Oracle │   │    Admin API (Express + PostgreSQL)  │
│  Cairo Contract  │   │  JWT auth · RBAC · API keys · Audit  │
└──────────────────┘   └──────────────────────────────────────┘
```

---

## Quick Start

### 1. Prerequisites
- Node.js ≥ 20
- PostgreSQL 16+
- A funded StarkNet account (for paying gas)
- The RWA Oracle Cairo contract deployed on StarkNet Mainnet

### 2. Configure
```bash
cp .env.example .env
# Edit .env with your real keys and addresses
```

### 3. Setup
```bash
make setup
# This installs deps, runs migrations, seeds the DB, and builds TypeScript
```

### 4. Create Feeder API Key
After setup, log in and create an API key for the feeder:
```bash
# POST /api/auth/login
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@your-domain.com","password":"YOUR_PASSWORD"}'

# POST /api/apikeys (use the access token from login)
curl -X POST http://localhost:4000/api/apikeys \
  -H "Authorization: Bearer ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"prod-feeder","scopes":["price:write","price:read","asset:read"]}'
```

Copy the returned `key` field into `.env` as `FEEDER_API_KEY=rwa_...`

### 5. Start
```bash
make start          # feeder + admin server
# or
make docker-up      # everything in Docker
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `STARKNET_ACCOUNT_ADDRESS` | ✅ | Your StarkNet account address |
| `STARKNET_PRIVATE_KEY` | ✅ | Private key (hex with 0x) |
| `ORACLE_CONTRACT_ADDRESS` | ✅ | Deployed RWA Oracle contract |
| `STARKNET_RPC_URL` | ✅ | StarkNet Mainnet RPC endpoint |
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `JWT_ACCESS_SECRET` | ✅ | 64-byte hex random secret |
| `JWT_REFRESH_SECRET` | ✅ | 64-byte hex random secret (different) |
| `GOLDAPI_KEY` | — | GoldAPI.io (XAU, XAG real-time) |
| `METALPRICEAPI_KEY` | — | MetalpriceAPI.com (XAU,XAG,XPT,XPD) |
| `METALS_DEV_KEY` | — | Metals.Dev (precious + industrial) |
| `ALPHAVANTAGE_API_KEY` | — | Alpha Vantage (commodities + macro) |
| `FEEDER_API_KEY` | — | API key for feeder DB writes |
| `FEED_CRON` | — | Default: `*/15 * * * *` |
| `MIN_SOURCES` | — | Default: `2` |
| `MAX_DEVIATION_PCT` | — | Default: `5` |
| `SMTP_HOST` | — | Email alerts SMTP host |

---

## Admin API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/login` | — | Email + password → tokens |
| POST | `/api/auth/refresh` | — | Rotate refresh token |
| POST | `/api/auth/logout` | — | Revoke session |
| GET  | `/api/auth/me` | JWT | Current user |
| GET  | `/api/health` | — | Deep health check |
| GET  | `/api/assets` | JWT | List all assets |
| POST | `/api/assets` | ADMIN | Register new asset |
| GET  | `/api/prices` | JWT | Latest price per asset |
| GET  | `/api/prices/:assetId` | JWT | Price history |
| GET  | `/api/prices/:assetId/feeds` | JWT | Raw source readings |
| POST | `/api/prices/record` | ApiKey | Feeder: write price history |
| POST | `/api/prices/feeds` | ApiKey | Feeder: write raw feeds |
| GET  | `/api/users` | ADMIN | List users |
| POST | `/api/users` | SUPER_ADMIN | Create user |
| GET  | `/api/apikeys` | ADMIN | List API keys |
| POST | `/api/apikeys` | ADMIN | Create API key |
| GET  | `/api/audit` | ADMIN | System audit log |

---

## Docker Deployment

```bash
# Build images
make docker-build

# Start postgres + admin-api + feeder
make docker-up

# With nginx reverse proxy
make docker-up-prod

# Tail logs
make docker-logs
```

---

## StarkNet Contract

The Cairo contract (`contract/rwa_oracle.cairo`) is Cairo 2.13.1 (Scarb 2.13.1).

### Deploy to Mainnet
```bash
# Install Scarb: https://docs.swmansion.com/scarb/
cd contract
scarb build

# Deploy with starkli
starkli deploy target/dev/rwa_oracle_RwaOracle.contract_class.json \
  --account YOUR_ACCOUNT \
  --rpc YOUR_RPC_URL \
  OWNER_ADDRESS
```

---

## Alert Rules

Create alert rules via Prisma Studio (`make db-studio`) or direct DB insert:

```sql
INSERT INTO "AlertRule" (id, "assetId", type, threshold, "webhookUrl", "emailRecipients", active)
VALUES (
  gen_random_uuid(),
  'XAU_USD',
  'PRICE_STALE',
  3600,                          -- alert if no update in 1 hour
  'https://hooks.slack.com/...',  -- Slack webhook
  ARRAY['ops@your-domain.com'],
  true
);
```

Alert types: `PRICE_STALE` · `DEVIATION_HIGH` · `SOURCE_DOWN` · `SUBMISSION_FAILED`

---

## Security

- All passwords: bcrypt rounds=12
- JWT access tokens: 15-minute TTL, rotated refresh tokens
- API keys: SHA-256 hashed in DB, never stored plain
- Account lockout: 5 failed attempts → 30 minute lockout
- Rate limiting: 200 req/15min global, 10 req/15min on auth endpoints
- Audit log: immutable, every mutating action recorded
- CORS: production-only origin allowlist
- Helmet: CSP, HSTS (1 year), X-Frame-Options: DENY
