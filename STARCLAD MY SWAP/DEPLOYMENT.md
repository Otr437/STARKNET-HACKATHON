# Deployment Guide

This guide covers deploying the StarClad Privacy Swap Backend to production.

## Prerequisites

- Ubuntu 20.04+ or similar Linux distribution
- Node.js 18+ installed
- Docker & Docker Compose (for containerized deployment)
- SSL certificates for HTTPS
- Registered domain name

## 🐳 Docker Deployment (Recommended)

### 1. Prepare Environment

```bash
# Clone repository
git clone https://github.com/starclad/privacy-swap-backend
cd privacy-swap-backend

# Create environment file
npm run init
nano .env

# Encrypt sensitive variables
npm run encrypt-env <strong-master-password>
```

### 2. Build and Start

```bash
# Build Docker image
docker-compose build

# Start services
docker-compose up -d

# Check logs
docker-compose logs -f app

# Check health
curl http://localhost:3000/health
```

### 3. Configure Nginx Reverse Proxy

Create `/etc/nginx/sites-available/starclad-backend`:

```nginx
server {
    listen 80;
    server_name api.yourdomain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name api.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/api.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.yourdomain.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    # Rate limiting
    limit_req_zone $binary_remote_addr zone=api_limit:10m rate=100r/m;
    limit_req zone=api_limit burst=20 nodelay;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    # Health check endpoint
    location /health {
        access_log off;
        proxy_pass http://localhost:3000/health;
    }
}
```

Enable and reload:

```bash
sudo ln -s /etc/nginx/sites-available/starclad-backend /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## 🖥️ Bare Metal Deployment

### 1. Install Dependencies

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Install Redis
sudo apt install -y redis-server
sudo systemctl enable redis-server
sudo systemctl start redis-server

# Install build tools
sudo apt install -y build-essential python3
```

### 2. Setup Application

```bash
# Create app user
sudo useradd -r -s /bin/bash -d /opt/starclad starclad

# Clone and setup
sudo mkdir -p /opt/starclad
sudo chown starclad:starclad /opt/starclad
sudo -u starclad git clone https://github.com/starclad/privacy-swap-backend /opt/starclad/app
cd /opt/starclad/app

# Install as app user
sudo -u starclad npm ci --only=production
sudo -u starclad npm run build

# Setup environment
sudo -u starclad npm run init
sudo -u starclad nano .env
sudo -u starclad npm run encrypt-env <master-password>

# Create secure directory
sudo mkdir -p /opt/starclad/secure
sudo chown starclad:starclad /opt/starclad/secure
sudo chmod 700 /opt/starclad/secure
```

### 3. Create Systemd Service

Create `/etc/systemd/system/starclad-backend.service`:

```ini
[Unit]
Description=StarClad Privacy Swap Backend
After=network.target redis.service

[Service]
Type=simple
User=starclad
Group=starclad
WorkingDirectory=/opt/starclad/app
Environment="NODE_ENV=production"
EnvironmentFile=/opt/starclad/app/.env
ExecStart=/usr/bin/node /opt/starclad/app/dist/index.js start
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=starclad-backend

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/starclad
CapabilityBoundingSet=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable starclad-backend
sudo systemctl start starclad-backend
sudo systemctl status starclad-backend

# View logs
sudo journalctl -u starclad-backend -f
```

## 🔒 Security Hardening

### 1. Firewall Configuration

```bash
# UFW firewall
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP
sudo ufw allow 443/tcp   # HTTPS
sudo ufw enable
```

### 2. Fail2Ban

```bash
sudo apt install -y fail2ban

# Create jail for API
sudo tee /etc/fail2ban/jail.local << 'EOF'
[starclad-api]
enabled = true
port = http,https
filter = starclad-api
logpath = /var/log/nginx/access.log
maxretry = 5
bantime = 3600
findtime = 600
EOF

# Create filter
sudo tee /etc/fail2ban/filter.d/starclad-api.conf << 'EOF'
[Definition]
failregex = ^<HOST> .* "(GET|POST) /api/.* HTTP.*" (401|403|429)
ignoreregex =
EOF

sudo systemctl restart fail2ban
```

### 3. Automated Backups

Create `/opt/starclad/backup.sh`:

```bash
#!/bin/bash
BACKUP_DIR="/opt/starclad/backups"
DATE=$(date +%Y%m%d_%H%M%S)

mkdir -p $BACKUP_DIR

# Backup Redis
redis-cli --rdb $BACKUP_DIR/redis_$DATE.rdb

# Backup secure directory
tar -czf $BACKUP_DIR/secure_$DATE.tar.gz /opt/starclad/secure

# Cleanup old backups (keep last 7 days)
find $BACKUP_DIR -name "*.rdb" -mtime +7 -delete
find $BACKUP_DIR -name "*.tar.gz" -mtime +7 -delete

echo "Backup completed: $DATE"
```

Add to crontab:

```bash
sudo crontab -e
# Add: 0 2 * * * /opt/starclad/backup.sh >> /var/log/starclad-backup.log 2>&1
```

## 📊 Monitoring

### 1. Health Checks

```bash
# Add to cron for alerts
*/5 * * * * curl -f http://localhost:3000/health || echo "API Down!" | mail -s "StarClad API Alert" admin@yourdomain.com
```

### 2. Log Monitoring

```bash
# Install logwatch
sudo apt install -y logwatch

# Configure for daily reports
sudo logwatch --detail high --mailto admin@yourdomain.com --service all --range today
```

### 3. Resource Monitoring

```bash
# Install monitoring tools
sudo apt install -y htop iotop nethogs

# Optional: Install Prometheus & Grafana for advanced monitoring
```

## 🔄 Updates & Maintenance

### Update Application

```bash
cd /opt/starclad/app
sudo -u starclad git pull
sudo -u starclad npm ci --only=production
sudo -u starclad npm run build
sudo systemctl restart starclad-backend
```

### Database Maintenance

```bash
# Redis cleanup (remove expired keys)
redis-cli --scan --pattern "swap:*" | xargs redis-cli del

# Redis persistence check
redis-cli BGSAVE
```

## 🚨 Troubleshooting

### Check Service Status

```bash
sudo systemctl status starclad-backend
sudo journalctl -u starclad-backend -n 100 --no-pager
```

### Check Logs

```bash
# Application logs
sudo journalctl -u starclad-backend -f

# Nginx logs
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log

# Redis logs
sudo tail -f /var/log/redis/redis-server.log
```

### Performance Issues

```bash
# Check memory usage
free -h
redis-cli INFO memory

# Check CPU usage
top -b -n 1 | head -20

# Check disk usage
df -h
```

### Connection Issues

```bash
# Test Redis
redis-cli ping

# Test Bitcoin RPC
curl --user bitcoin:password --data-binary '{"jsonrpc":"1.0","id":"test","method":"getblockcount","params":[]}' http://localhost:8332

# Test Starknet RPC
curl -X POST $STARKNET_RPC_URL \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"starknet_blockNumber","params":[],"id":1}'
```

## 📝 Checklist

- [ ] Environment variables encrypted
- [ ] SSL certificates installed
- [ ] Firewall configured
- [ ] Fail2Ban enabled
- [ ] Backups scheduled
- [ ] Monitoring alerts configured
- [ ] Log rotation setup
- [ ] Resource limits configured
- [ ] Security headers enabled
- [ ] Rate limiting active

## 🆘 Emergency Contacts

- Email: security@starclad.io
- Discord: https://discord.gg/starclad
- GitHub Issues: https://github.com/starclad/privacy-swap-backend/issues
