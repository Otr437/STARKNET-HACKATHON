# StarClad Privacy Swap Backend - PRODUCTION READY

Complete production backend for privacy-preserving atomic swaps between Starknet and Bitcoin.

## Features

- **HTTPS/TLS** - Full SSL/TLS support for production
- **Rate Limiting** - Redis-backed distributed rate limiting
- **API Authentication** - API key-based auth with permissions
- **Poseidon Hashing** - Privacy-preserving commitments
- **Bitcoin SPV** - Full SPV proof generation and verification
- **Atomic Swaps** - HTLC-based cross-chain swaps
- **Starknet Integration** - Full contract interaction
- **AES-256-GCM** - Enterprise encryption
- **Argon2id** - Password hashing (OWASP recommended)
- **Redis Persistence** - Distributed state management
- **Docker Support** - Production containerization
- **Comprehensive Logging** - Full audit trail

## Quick Start

```bash
npm install
npm run init
# Edit .env with your configuration
npm run encrypt-env <master-password>
npm run build
npm start
```

## Docker Deployment

```bash
docker-compose up -d
```

## API Endpoints

- `POST /api/notes/generate` - Generate privacy note
- `POST /api/proofs/spend` - Generate spend proof
- `POST /api/swaps/initiate` - Initiate atomic swap
- `POST /api/swaps/lock` - Lock with BTC transaction
- `POST /api/swaps/complete` - Complete swap
- `GET /api/swaps/:swapId` - Get swap status
- `GET /api/swaps/stats` - Swap statistics
- `POST /api/btc/spv-proof` - Generate SPV proof

## Security

- Argon2id key derivation (64MB memory, 3 iterations)
- AES-256-GCM authenticated encryption
- Key rotation support (90-day default)
- Comprehensive audit logging
- Rate limiting (100 req/min default)
- API key authentication
- HTTPS/TLS encryption
- Secure environment variables

## License

MIT
