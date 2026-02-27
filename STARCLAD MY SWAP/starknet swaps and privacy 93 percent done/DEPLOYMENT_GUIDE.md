# Starknet Production System - Complete Deployment Guide

## 🎯 Overview

This system provides three production-ready Starknet contracts with full infrastructure:
1. **Vault Manager** - Multi-token vault with curator system
2. **Private BTC Swap** - Atomic swaps with hash time-locked contracts
3. **Semaphore** - Zero-knowledge proof based anonymous signaling

## 📋 Prerequisites

### Required Software
- **Scarb** v2.8.0+ (Cairo package manager)
- **Starkli** v0.3.0+ (Starknet CLI)
- **Node.js** v18+ and npm
- **OpenSSL** (for HTTPS certificates)
- **Git**

### Required Accounts
- Funded Starknet account (for deployment gas)
- Alchemy/Infura API key for RPC access
- Domain and SSL certificates (for production HTTPS)

## 🚀 Quick Start

### 1. Clone and Setup

```bash
# Navigate to project
cd starknet-production-system

# Install contract dependencies
cd contracts
scarb build

# Install backend dependencies
cd ../backend
npm install

# Copy environment template
cp .env.example .env
```

### 2. Configure Environment

Edit `backend/.env`:

```bash
# Network (mainnet, sepolia, or devnet)
STARKNET_RPC_URL=https://starknet-sepolia.g.alchemy.com/starknet/version/rpc/v0_9/YOUR_KEY
ALCHEMY_API_KEY=your_key_here

# Admin account
ADMIN_ADDRESS=0x...
ADMIN_PRIVATE_KEY=0x...

# Treasury (for fee collection)
TREASURY_ADDRESS=0x...

# SSL for HTTPS
SSL_CERT=/path/to/cert.pem
SSL_KEY=/path/to/key.pem
```

### 3. Deploy Contracts

```bash
cd deployment
./deploy.sh sepolia  # or mainnet
```

This will:
- Build all Cairo contracts
- Deploy to Starknet
- Save addresses to `deployment-{network}.json`
- Update backend `.env` automatically

### 4. Start Backend Server

```bash
cd ../backend
npm start
```

Server runs on:
- HTTP: `http://localhost:3000`
- HTTPS: `https://localhost:3443`

## 📡 API Documentation

### Base URL
```
https://your-domain.com/api
```

### Authentication
Include JWT token in Authorization header:
```
Authorization: Bearer <your_jwt_token>
```

### Endpoints

#### Vault Manager

**Get Vault Balance**
```http
GET /api/vault/:token/balance
```

**Get User Deposits**
```http
GET /api/vault/user/:address/:token
```

**Get Curator Allocation**
```http
GET /api/vault/curator/:address/:token
```

#### BTC Swap

**Get Swap Details**
```http
GET /api/swap/:swapId
```

Response:
```json
{
  "swapId": "0x...",
  "swap": {
    "initiator": "0x...",
    "participant": "0x...",
    "token": "0x...",
    "amount": "1000000",
    "status": "Active",
    "timeLock": 1234567890
  }
}
```

#### Semaphore

**Get Group Details**
```http
GET /api/semaphore/group/:groupId
```

**Check Membership**
```http
GET /api/semaphore/group/:groupId/member/:commitment
```

#### Webhooks

**Register Webhook**
```http
POST /api/webhooks
Content-Type: application/json

{
  "url": "https://your-server.com/webhook",
  "events": ["deposit", "withdrawal", "swap.completed"],
  "secret": "optional_webhook_secret"
}
```

Response:
```json
{
  "webhookId": "abc123...",
  "secret": "generated_secret",
  "message": "Webhook registered successfully"
}
```

**List Webhooks**
```http
GET /api/webhooks
```

**Delete Webhook**
```http
DELETE /api/webhooks/:id
```

#### Real-time Events

**Server-Sent Events Stream**
```http
GET /api/events/stream
```

Opens SSE connection for real-time updates:
```javascript
const eventSource = new EventSource('https://your-domain.com/api/events/stream');
eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Event received:', data);
};
```

## 🔐 Security Features

### Role-Based Access Control

Each contract implements OpenZeppelin's AccessControl:

**Vault Manager Roles:**
- `DEFAULT_ADMIN_ROLE` - Full system control
- `CURATOR_ROLE` - Can manage allocations
- `MANAGER_ROLE` - Can allocate funds
- `PAUSER_ROLE` - Emergency pause
- `UPGRADER_ROLE` - Contract upgrades

**Grant Role Example:**
```javascript
import { Account, Contract } from 'starknet';

const contract = new Contract(abi, address, account);
await contract.grant_role(CURATOR_ROLE, newCuratorAddress);
```

### HTTPS Configuration

Generate SSL certificates:

```bash
# Self-signed (development)
openssl req -x509 -newkey rsa:4096 -nodes \
  -keyout key.pem -out cert.pem -days 365

# Production: Use Let's Encrypt
certbot certonly --standalone -d your-domain.com
```

Update `.env`:
```bash
SSL_CERT=/etc/letsencrypt/live/your-domain.com/fullchain.pem
SSL_KEY=/etc/letsencrypt/live/your-domain.com/privkey.pem
```

### Webhook Security

Verify webhook signatures:

```javascript
const crypto = require('crypto');

function verifyWebhook(payload, signature, secret) {
  const computedSignature = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
  
  return signature === computedSignature;
}

// In your webhook handler
app.post('/webhook', (req, res) => {
  const signature = req.headers['x-webhook-signature'];
  const isValid = verifyWebhook(req.body, signature, WEBHOOK_SECRET);
  
  if (!isValid) {
    return res.status(401).send('Invalid signature');
  }
  
  // Process webhook
  res.status(200).send('OK');
});
```

## 🔄 Contract Administration

### Pause Contracts (Emergency)

```javascript
// Vault Manager
await vaultManager.pause();

// Resume
await vaultManager.unpause();
```

### Update Treasury

```javascript
await vaultManager.set_treasury(newTreasuryAddress);
```

### Adjust Fees

```javascript
// Fee in basis points (100 = 1%)
await vaultManager.set_fee(100); // 1% fee
```

### Upgrade Contracts

```javascript
// Deploy new implementation
const newClassHash = await declareContract(newContractCode);

// Upgrade (requires UPGRADER_ROLE)
await contract.upgrade(newClassHash);
```

## 📊 Monitoring & Analytics

### Health Check

```bash
curl https://your-domain.com/health
```

Response:
```json
{
  "status": "healthy",
  "timestamp": "2024-02-07T12:00:00Z",
  "uptime": 3600,
  "websocket": "connected"
}
```

### Logs

Logs are written to:
- `backend/error.log` - Error-level logs
- `backend/combined.log` - All logs
- Console output (development)

Configure log level in `.env`:
```bash
LOG_LEVEL=info  # debug, info, warn, error
```

### Metrics

Integrate with monitoring tools:

**Datadog:**
```bash
DATADOG_API_KEY=your_key
```

**Sentry:**
```bash
SENTRY_DSN=your_dsn
```

## 🧪 Testing

### Unit Tests (Contracts)

```bash
cd contracts
scarb test
```

### Integration Tests (Backend)

```bash
cd backend
npm test
```

### Load Testing

```bash
# Install k6
npm install -g k6

# Run load test
k6 run load-test.js
```

## 🚀 Production Deployment

### 1. Infrastructure Setup

**Required:**
- VPS/Cloud instance (AWS, GCP, Azure, DigitalOcean)
- Domain with DNS configured
- SSL certificate
- Firewall rules (allow 80, 443)

**Recommended:**
- Load balancer (for scaling)
- Redis (for caching)
- PostgreSQL (for webhook storage)
- Nginx (reverse proxy)

### 2. Server Configuration

Install Node.js and dependencies:
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Clone and setup:
```bash
git clone <your-repo>
cd starknet-production-system/backend
npm install --production
```

### 3. Process Management

Use PM2 for process management:
```bash
npm install -g pm2

# Start application
pm2 start server.js --name starknet-api

# Auto-restart on reboot
pm2 startup
pm2 save

# Monitor
pm2 monit
```

### 4. Nginx Configuration

```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 5. Firewall Setup

```bash
# UFW
sudo ufw allow 22
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable

# Verify
sudo ufw status
```

## 🐛 Troubleshooting

### Contract Deployment Fails

**Issue:** Insufficient gas
```bash
# Increase max fee in starkli
starkli deploy --max-fee 0.01
```

**Issue:** Account not found
```bash
# Check account exists
starkli account fetch <address>

# Deploy account if needed
starkli account deploy
```

### Backend Connection Issues

**Issue:** Can't connect to Starknet
- Verify RPC URL in `.env`
- Check API key is valid
- Test connection: `curl <RPC_URL>`

**Issue:** WebSocket disconnects
- Increase timeout in `server.js`
- Check network stability
- Verify WebSocket URL supports v0.9

### Webhook Not Firing

- Check webhook URL is accessible
- Verify events are configured correctly
- Check logs for errors
- Test manually: `curl -X POST <webhook_url>`

## 📞 Support

- **Documentation:** See `docs/` folder
- **Issues:** Create GitHub issue
- **Community:** Starknet Discord #cairo-dev

## 📄 License

MIT License - see LICENSE file

## 🎉 Success Checklist

- [ ] Contracts deployed successfully
- [ ] Backend server running
- [ ] HTTPS configured
- [ ] Webhooks tested
- [ ] Monitoring configured
- [ ] Admin roles assigned
- [ ] Security audit completed
- [ ] Backup procedures in place
- [ ] Incident response plan ready
- [ ] Documentation reviewed

---

**Ready for Production!** 🚀
