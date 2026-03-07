# RWA Backend Infrastructure

Complete backend API, event listener, and webhook system for the Starknet RWA protocol.

## Features

- **REST API** - Query RWA assets, vault positions, oracle data
- **WebSocket Server** - Real-time event updates
- **Event Listener** - Monitors on-chain events and broadcasts to clients
- **Webhooks** - Receive notifications for deposits, redemptions, new assets
- **Database Models** - Ready for PostgreSQL/MongoDB integration

## Architecture

```
┌─────────────┐
│  Starknet   │
│  Contracts  │
└──────┬──────┘
       │
       │ (events)
       │
┌──────▼─────────┐
│ Event Listener │ ←─── Polls blocks every 10s
└──────┬─────────┘
       │
       │ (broadcasts)
       │
┌──────▼─────────┐
│  WebSocket     │ ───→ Frontend clients
│  Server        │
└────────────────┘

┌────────────────┐
│   REST API     │ ←─── Frontend/mobile apps
│   (Express)    │
└────────────────┘

┌────────────────┐
│   Webhooks     │ ←─── External services
└────────────────┘
```

## Setup

```bash
cd backend
npm install
```

## Configuration

Add to your `.env`:

```env
# Backend
BACKEND_PORT=3001
WEBHOOK_SECRET=your-webhook-secret-here

# Starknet (same as root)
STARKNET_RPC_URL=https://starknet-sepolia.public.blastapi.io/rpc/v0_7
ORACLE_CONTRACT_ADDRESS=0x...
FACTORY_CONTRACT_ADDRESS=0x...
```

## Running

### Development (all services)
```bash
npm run dev
```

This starts:
- REST API on `http://localhost:3001`
- WebSocket on `ws://localhost:3002`
- Event listener (polling)

### Production

```bash
# API only
npm start

# Event listener only
npm run listen

# Both (recommended)
npm run dev
```

## API Endpoints

### Oracle Data
```
GET /api/oracle/cpi
```
Returns current CPI data from oracle.

### RWA Assets
```
GET /api/rwa/all
GET /api/rwa/:id
```
Get all assets or specific asset by ID.

### Vault Positions
```
GET /api/vault/:vaultAddress/position/:userAddress
GET /api/vault/:vaultAddress/tvl
```
Get user position or total value locked.

### WebSocket Events
```
POST /api/subscribe/events
Body: { contractAddress, eventName }
```
Subscribe to on-chain events via WebSocket.

## WebSocket Usage

```javascript
const ws = new WebSocket('ws://localhost:3002');

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  
  if (data.event.type === 'Deposited') {
    console.log('User deposited:', data.event.user);
    console.log('Amount:', data.event.usd_amount);
  }
};
```

## Webhooks

### Setup Webhook
```bash
curl -X POST http://localhost:3001/webhook/deposit \
  -H "Content-Type: application/json" \
  -H "x-webhook-signature: YOUR_SIGNATURE" \
  -d '{
    "user": "0x123...",
    "vault_address": "0x456...",
    "amount": "1000000000",
    "tokens_minted": "100000000000000000000"
  }'
```

### Signature Verification
Webhooks are secured with HMAC-SHA256 signatures. Generate:
```javascript
const crypto = require('crypto');
const signature = crypto
  .createHmac('sha256', WEBHOOK_SECRET)
  .update(JSON.stringify(payload))
  .digest('hex');
```

## Event Listener

Automatically listens for:
- **RWACreated** - New asset deployed
- **Deposited** - User deposits into vault
- **Redeemed** - User redeems from vault
- **DataPublished** - Oracle publishes new data
- **YieldClaimed** - User claims yield

Events are:
1. Detected via block polling
2. Parsed and enriched
3. Broadcast to WebSocket clients
4. Stored in database

## Database Integration

Currently uses in-memory database. To use PostgreSQL/MongoDB:

1. Install driver:
```bash
npm install pg  # PostgreSQL
# or
npm install mongodb  # MongoDB
```

2. Implement `DatabaseService` interface in `models/database.ts`

3. Update environment variables:
```env
DATABASE_URL=postgresql://user:pass@localhost:5432/rwa
```

## Scaling

For production:

1. **Use Redis for pub/sub** instead of in-memory WebSocket
2. **Add database connection pooling**
3. **Deploy multiple API instances** behind load balancer
4. **Use message queue** (RabbitMQ/Kafka) for event processing
5. **Add caching layer** (Redis) for frequently accessed data

## Monitoring

Add logging service:
```bash
npm install winston
```

Add APM:
```bash
npm install @sentry/node
```

## Testing

```bash
# Install test deps
npm install --save-dev jest @types/jest supertest

# Run tests
npm test
```

## Security

- ✅ CORS enabled (configure for production)
- ✅ Webhook signature verification
- ✅ Rate limiting recommended (use express-rate-limit)
- ✅ Helmet.js recommended for security headers
- ✅ Input validation recommended (use joi or zod)

## Production Checklist

- [ ] Use PostgreSQL/MongoDB instead of in-memory DB
- [ ] Add Redis for WebSocket pub/sub
- [ ] Configure CORS for your domain
- [ ] Add rate limiting
- [ ] Set up monitoring (Sentry/DataDog)
- [ ] Use PM2 or Docker for process management
- [ ] Configure reverse proxy (Nginx)
- [ ] Set up SSL/TLS certificates
- [ ] Add health check endpoint to load balancer
- [ ] Implement backup strategy for database

## Support

For issues or questions, see main project README.
