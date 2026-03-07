# Production Deployment Guide

Complete step-by-step guide to deploy the Starknet RWA Protocol to production.

## Prerequisites

- Node.js 18+
- PostgreSQL 14+
- Redis 7+
- Scarb (Cairo compiler)
- Domain with SSL certificate
- SMTP email service
- Starknet wallet with funds

## Phase 1: Database Setup

### PostgreSQL Installation

```bash
# Ubuntu/Debian
sudo apt update
sudo apt install postgresql postgresql-contrib

# macOS
brew install postgresql@14

# Start service
sudo systemctl start postgresql  # Linux
brew services start postgresql@14  # macOS
```

### Create Database

```bash
sudo -u postgres psql
```

```sql
CREATE DATABASE rwa_production;
CREATE USER rwa_user WITH ENCRYPTED PASSWORD 'your_secure_password';
GRANT ALL PRIVILEGES ON DATABASE rwa_production TO rwa_user;
\q
```

### Initialize Schema

The database schema is auto-created on first run by `backend/models/database.ts`.

## Phase 2: Redis Setup

### Redis Installation

```bash
# Ubuntu/Debian
sudo apt install redis-server

# macOS
brew install redis

# Start service
sudo systemctl start redis  # Linux
brew services start redis  # macOS
```

### Verify

```bash
redis-cli ping
# Should return: PONG
```

## Phase 3: Environment Configuration

### Copy Environment Template

```bash
cp .env.example .env
```

### Edit .env

```bash
nano .env
```

**Required Production Values:**

```env
# Starknet Mainnet
STARKNET_RPC_URL=https://starknet-mainnet.public.blastapi.io/rpc/v0_7

# Deployer Wallet (use secure key management in production)
DEPLOYER_ADDRESS=0x...your_deployer_address
DEPLOYER_PRIVATE_KEY=0x...your_private_key

# Oracle Publisher (separate wallet recommended)
PUBLISHER_ADDRESS=0x...your_publisher_address
PUBLISHER_PRIVATE_KEY=0x...your_publisher_private_key

# API Keys
BLS_API_KEY=your_actual_bls_key
FRED_API_KEY=your_actual_fred_key

# Backend
BACKEND_PORT=3001
DATABASE_URL=postgresql://rwa_user:your_secure_password@localhost:5432/rwa_production
REDIS_URL=redis://localhost:6379
WEBHOOK_SECRET=generate_32_char_random_string_here

# Email (Gmail example)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-specific-password
SMTP_FROM=RWA Platform <noreply@yourcompany.com>
```

**Security Notes:**
- Use app-specific passwords for Gmail (not your main password)
- Store private keys in secure vault (AWS Secrets Manager, HashiCorp Vault)
- Use separate wallets for deployer and publisher
- Generate webhook secret: `openssl rand -hex 32`

## Phase 4: Contract Deployment

### Build Contracts

```bash
cd contracts
scarb build
cd ..
```

### Install Dependencies

```bash
npm install
cd backend && npm install && cd ..
```

### Deploy Oracle

```bash
npm run deploy:oracle
```

This will:
1. Declare InflationOracle contract
2. Deploy with initial CPI data
3. Add `ORACLE_CONTRACT_ADDRESS` to .env

### Deploy Factory

```bash
npm run deploy:factory
```

This will:
1. Declare RWAToken and RWAVault
2. Deploy RWAFactory
3. Add `FACTORY_CONTRACT_ADDRESS` to .env

### Verify Deployment

```bash
# Check oracle
curl "https://api.starkscan.co/api/v0/contract/0x...YOUR_ORACLE_ADDRESS"

# Check factory
curl "https://api.starkscan.co/api/v0/contract/0x...YOUR_FACTORY_ADDRESS"
```

## Phase 5: Backend Deployment

### Option A: PM2 (Recommended)

```bash
# Install PM2
npm install -g pm2

# Start services
pm2 start ecosystem.config.js

# Enable startup script
pm2 startup
pm2 save
```

**Create ecosystem.config.js:**

```javascript
module.exports = {
  apps: [
    {
      name: 'rwa-api',
      script: 'cd backend && ts-node src/server.ts',
      instances: 2,
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'rwa-listener',
      script: 'cd backend && ts-node src/event-listener.ts',
      instances: 1,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'rwa-publisher',
      script: 'ts-node index.ts',
      instances: 1,
      cron_restart: '0 */6 * * *',  // Every 6 hours
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
```

### Option B: Docker

**Create Dockerfile:**

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
COPY backend/package*.json ./backend/
RUN npm install
RUN cd backend && npm install

COPY . .

EXPOSE 3001 3002

CMD ["npm", "run", "dev"]
```

**Create docker-compose.yml:**

```yaml
version: '3.8'
services:
  postgres:
    image: postgres:14
    environment:
      POSTGRES_DB: rwa_production
      POSTGRES_USER: rwa_user
      POSTGRES_PASSWORD: your_password
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine

  backend:
    build: .
    ports:
      - "3001:3001"
      - "3002:3002"
    depends_on:
      - postgres
      - redis
    env_file:
      - .env

volumes:
  postgres_data:
```

**Run:**

```bash
docker-compose up -d
```

## Phase 6: Nginx Reverse Proxy

### Install Nginx

```bash
sudo apt install nginx
```

### Configure SSL

```bash
# Install certbot
sudo apt install certbot python3-certbot-nginx

# Get certificate
sudo certbot --nginx -d api.yourcompany.com
```

### Nginx Configuration

**Create `/etc/nginx/sites-available/rwa-backend`:**

```nginx
upstream rwa_api {
    server localhost:3001;
}

upstream rwa_websocket {
    server localhost:3002;
}

server {
    listen 80;
    server_name api.yourcompany.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name api.yourcompany.com;

    ssl_certificate /etc/letsencrypt/live/api.yourcompany.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.yourcompany.com/privkey.pem;

    # API endpoints
    location /api {
        proxy_pass http://rwa_api;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # WebSocket
    location /ws {
        proxy_pass http://rwa_websocket;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }
}
```

**Enable and restart:**

```bash
sudo ln -s /etc/nginx/sites-available/rwa-backend /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

## Phase 7: Frontend Deployment

### Build Frontend

```bash
cd frontend
# Frontend is static HTML, no build needed
```

### Deploy Options

**Option A: Nginx Static**

```nginx
server {
    listen 443 ssl http2;
    server_name app.yourcompany.com;

    ssl_certificate /etc/letsencrypt/live/app.yourcompany.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/app.yourcompany.com/privkey.pem;

    root /var/www/rwa-frontend;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

```bash
sudo mkdir -p /var/www/rwa-frontend
sudo cp frontend/index.html /var/www/rwa-frontend/
sudo chown -R www-data:www-data /var/www/rwa-frontend
```

**Option B: Vercel/Netlify**

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
cd frontend
vercel --prod
```

## Phase 8: Monitoring Setup

### Install Monitoring Tools

```bash
# PM2 monitoring
pm2 install pm2-logrotate

# Sentry (error tracking)
npm install @sentry/node
```

**Add to backend/src/server.ts:**

```typescript
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: 'production',
});
```

### Setup Alerts

**Uptime monitoring:**
- Use UptimeRobot (free tier)
- Monitor: https://api.yourcompany.com/health

**Database monitoring:**
```bash
# Install pg_stat_statements
sudo -u postgres psql rwa_production
CREATE EXTENSION pg_stat_statements;
```

## Phase 9: Security Hardening

### Firewall Setup

```bash
# Allow only necessary ports
sudo ufw allow 22    # SSH
sudo ufw allow 80    # HTTP
sudo ufw allow 443   # HTTPS
sudo ufw enable
```

### Rate Limiting

**Add to backend/src/server.ts:**

```typescript
import rateLimit from 'express-rate-limit';

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
});

app.use('/api', limiter);
```

### Security Headers

```typescript
import helmet from 'helmet';
app.use(helmet());
```

## Phase 10: Backup Strategy

### Database Backups

```bash
# Create backup script
cat > /usr/local/bin/backup-rwa-db.sh << 'EOF'
#!/bin/bash
BACKUP_DIR="/var/backups/postgresql"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p $BACKUP_DIR
pg_dump -U rwa_user rwa_production | gzip > $BACKUP_DIR/rwa_$TIMESTAMP.sql.gz
# Keep only last 7 days
find $BACKUP_DIR -name "rwa_*.sql.gz" -mtime +7 -delete
EOF

chmod +x /usr/local/bin/backup-rwa-db.sh

# Add to crontab (daily at 2 AM)
(crontab -l 2>/dev/null; echo "0 2 * * * /usr/local/bin/backup-rwa-db.sh") | crontab -
```

### Redis Backups

Redis automatically creates RDB snapshots. Configure in `/etc/redis/redis.conf`:

```
save 900 1
save 300 10
save 60 10000
```

## Phase 11: Testing Production

### Health Checks

```bash
# API health
curl https://api.yourcompany.com/health

# Oracle data
curl https://api.yourcompany.com/api/oracle/cpi

# WebSocket
wscat -c wss://api.yourcompany.com/ws
```

### Load Testing

```bash
# Install k6
sudo apt-get install k6

# Run load test
k6 run loadtest.js
```

**Create loadtest.js:**

```javascript
import http from 'k6/http';
import { check } from 'k6';

export let options = {
  stages: [
    { duration: '30s', target: 20 },
    { duration: '1m', target: 20 },
    { duration: '20s', target: 0 },
  ],
};

export default function () {
  let res = http.get('https://api.yourcompany.com/api/rwa/all');
  check(res, { 'status was 200': (r) => r.status == 200 });
}
```

## Phase 12: Go Live Checklist

- [ ] All environment variables set correctly
- [ ] Database schema initialized
- [ ] Redis running and accessible
- [ ] Contracts deployed to mainnet
- [ ] Oracle publishing successfully
- [ ] Backend API responding
- [ ] WebSocket server working
- [ ] Event listener processing blocks
- [ ] Frontend deployed and accessible
- [ ] SSL certificates valid
- [ ] Backups configured and tested
- [ ] Monitoring and alerts active
- [ ] Rate limiting in place
- [ ] Security headers enabled
- [ ] Firewall configured
- [ ] Load testing passed
- [ ] Documentation updated

## Maintenance

### Daily Tasks
- Check PM2 logs: `pm2 logs`
- Monitor database size: `SELECT pg_database_size('rwa_production');`
- Verify oracle publishing: Check latest round_id

### Weekly Tasks
- Review error logs
- Check disk space: `df -h`
- Review database performance
- Test backup restoration

### Monthly Tasks
- Update dependencies: `npm update`
- Review access logs
- Security audit
- Performance optimization

## Troubleshooting

### API Not Responding
```bash
pm2 logs rwa-api
sudo systemctl status nginx
netstat -tulpn | grep :3001
```

### Database Connection Issues
```bash
sudo -u postgres psql rwa_production
# Check connections:
SELECT * FROM pg_stat_activity;
```

### WebSocket Not Working
```bash
pm2 logs
# Check Redis:
redis-cli ping
```

### Oracle Not Publishing
```bash
pm2 logs rwa-publisher
# Check wallet balance
# Verify API keys
```

## Support

For production issues:
- Email: support@yourcompany.com
- Slack: #rwa-production
- On-call: PagerDuty integration

---

**Production deployment complete! 🚀**
