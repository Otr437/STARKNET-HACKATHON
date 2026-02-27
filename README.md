# RWA Protocol — Starknet

## How to run

### 1. Get your free API keys (takes 2 minutes)

- **FRED** (required for T-Bill + Fed Funds rates)
  → https://fred.stlouisfed.org/docs/api/api_key.html
  → Click "Request API Key", fill in the form, get key by email instantly

- **BLS** (optional — works without it at 10 req/day)
  → https://www.bls.gov/developers/home.htm
  → Click "Register", fill in form, get key by email

---

### 2. Configure the server

```bash
cd server
cp .env.example .env
```

Open `.env` and fill in:
```
BLS_API_KEY=your_bls_key
FRED_API_KEY=your_fred_key
```

---

### 3. Install and start the server

```bash
cd server
npm install
node server.js
```

You should see:
```
🚀 RWA Protocol server running at http://localhost:3000
   BLS key:  ✓ set
   FRED key: ✓ set
```

---

### 4. Open the dashboard

Open your browser to: **http://localhost:3000**

The dashboard will:
- Load live CPI data from BLS (real US government data)
- Load T-Bill, 10Y Treasury, Fed Funds from FRED (real Federal Reserve data)
- Display everything in the oracle cards and history table
- Read on-chain oracle and factory state once you enter contract addresses in ⚙ Settings

---

### 5. Connect your wallet (for write operations)

Install **Argent X** or **Braavos** browser extension, then click "CONNECT WALLET" in the dashboard.

Write operations available after wallet connection:
- **DEPLOY RWA TOKEN + VAULT** — calls `RWAFactory.create_rwa()`
- **DEPOSIT** — calls `RWAVault.deposit()`
- **REDEEM** — calls `RWAVault.redeem()`
- **CLAIM YIELD** — calls `RWAVault.claim_yield()`
- **COMPOUND** — calls `RWAVault.compound_yield()`

---

### 6. Deploy the Cairo contracts

```bash
cd cairo
scarb build
```

Deploy order:
1. `InflationOracle` — note the contract address
2. `RWAToken` (class hash only — factory deploys instances)
3. `RWAVault` (class hash only — factory deploys instances)
4. `RWAFactory` — pass in oracle address + RWAToken class hash + RWAVault class hash

Then in the dashboard → ⚙ Settings → enter Oracle and Factory addresses.

---

### 7. Run the oracle publisher (pushes real data on-chain)

```bash
cd oracle-publisher
cp .env.example .env    # fill in wallet + contract addresses
npm install
npx ts-node index.ts dry-run    # test without submitting tx
npx ts-node index.ts once       # submit one real update
npx ts-node index.ts            # run every 6 hours
```

---

## Project structure

```
starknet-rwa/
├── cairo/
│   ├── src/
│   │   ├── interfaces.cairo        — all types + interfaces
│   │   ├── inflation_oracle.cairo  — on-chain macro data oracle
│   │   ├── rwa_factory.cairo       — deploys token+vault pairs
│   │   ├── rwa_token.cairo         — ERC-20 + KYC compliance
│   │   └── rwa_vault.cairo         — deposit/redeem/yield engine
│   └── Scarb.toml
├── server/
│   ├── server.js          — Express proxy (BLS + FRED APIs, serves HTML)
│   ├── .env.example       — copy to .env, add your keys
│   └── package.json
├── oracle-publisher/
│   ├── index.ts           — fetches BLS+FRED, signs, publishes to Starknet
│   ├── .env.example
│   └── package.json
└── frontend/
    └── index.html         — dashboard (served by server.js at localhost:3000)
```

## Data sources

| Data | Source | Series |
|------|--------|--------|
| CPI-U (inflation index) | US Bureau of Labor Statistics | CUUR0000SA0 |
| 3-Month T-Bill rate | FRED | TB3MS |
| 10-Year Treasury rate | FRED | DGS10 |
| Federal Funds rate | FRED | FEDFUNDS |
