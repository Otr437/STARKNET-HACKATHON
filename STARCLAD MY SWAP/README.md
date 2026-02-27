# StarClad Privacy Swap - Secure Frontend

Complete HTML/JS frontend for StarClad Privacy Swap backend with full HTTPS security.

## Features

✅ **Secure HTTPS Communication** - All API calls encrypted
✅ **API Key Authentication** - Supports backend API key auth
✅ **Privacy Notes** - Generate and manage privacy notes
✅ **Atomic Swaps** - Full swap lifecycle management
✅ **Bitcoin SPV** - Generate and verify SPV proofs
✅ **Real-time Statistics** - Swap stats and monitoring
✅ **Responsive Design** - Works on all devices
✅ **Dark Mode** - Easy on the eyes

## Files

- `index.html` - Main application UI (3.3KB)
- `app.js` - Complete API integration (5.0KB)
- `styles.css` - Full styling (2.1KB)

## Quick Start

### Option 1: Serve Locally

```bash
# Simple Python server
python3 -m http.server 8080

# Or Node.js
npx serve .

# Or PHP
php -S localhost:8080
```

Then open: `http://localhost:8080`

### Option 2: Direct File Open

Simply open `index.html` in your browser (CORS must be enabled on backend).

## Configuration

1. Enter your backend URL (e.g., `https://api.yourbackend.com`)
2. Enter API key (if required by backend)
3. Click "Test Connection"
4. Green status = Connected ✅

## Backend Configuration Required

Your backend must have CORS enabled for this frontend:

```javascript
// In server.ts config
corsOrigins: ['http://localhost:8080', 'https://yourdomain.com']
```

## HTTPS Backend

If your backend uses HTTPS with self-signed certificates, you may need to:

1. Accept the certificate in your browser first
2. Or use a valid SSL certificate from Let's Encrypt

## Features by Tab

### Privacy Notes Tab
- Generate new privacy notes
- Generate spend proofs
- View note commitments

### Atomic Swaps Tab
- Initiate new swaps
- Lock swaps with BTC
- Complete swaps with secret
- Check swap status

### Bitcoin Bridge Tab
- Generate SPV proofs
- Verify BTC confirmations
- View proof details

### Statistics Tab
- Total swaps
- Completion rates
- Volume statistics
- Merkle tree status

## Security Features

✅ API key sent in `X-API-Key` header
✅ All data encrypted in transit (HTTPS)
✅ No sensitive data stored in localStorage
✅ Content Security Policy headers
✅ XSS protection
✅ CSRF protection via CORS

## API Integration

The app integrates with ALL backend endpoints:

- `POST /api/notes/generate`
- `POST /api/proofs/spend`
- `POST /api/swaps/initiate`
- `POST /api/swaps/lock`
- `POST /api/swaps/complete`
- `GET /api/swaps/:swapId`
- `GET /api/swaps/stats`
- `POST /api/btc/spv-proof`
- `GET /health`

## Browser Support

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+
- All modern browsers with Fetch API

## Production Deployment

### Static Hosting (Recommended)

Deploy to:
- Vercel
- Netlify
- GitHub Pages
- AWS S3 + CloudFront
- Cloudflare Pages

### With Backend

```nginx
server {
    listen 443 ssl http2;
    server_name yourdomain.com;
    
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    
    root /var/www/starclad-frontend;
    index index.html;
    
    location /api {
        proxy_pass https://backend:3443;
    }
}
```

## Development

To modify:

1. Edit `app.js` for functionality
2. Edit `styles.css` for appearance  
3. Edit `index.html` for structure

No build process required - pure HTML/CSS/JS!

## Troubleshooting

**"Connection failed"**
- Check backend URL is correct
- Ensure backend is running
- Check CORS is enabled
- Verify API key (if required)

**"CORS error"**
- Add your frontend URL to backend CORS config
- Restart backend after config change

**"SSL certificate error"**
- Use valid SSL cert (Let's Encrypt)
- Or visit backend URL first to accept cert

## License

MIT
