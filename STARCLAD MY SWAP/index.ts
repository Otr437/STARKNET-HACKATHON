/**
 * Main Entry Point - COMPLETE CLI AND PROCESS MANAGEMENT
 */
import { PrivacySwapServer } from './server';
import { EnvironmentEncryptor } from './encryption';
import fs from 'fs';

async function startServer() {
  const masterPassword = process.env.MASTER_PASSWORD;
  if (!masterPassword) {
    console.error('❌ MASTER_PASSWORD environment variable required');
    process.exit(1);
  }

  const server = new PrivacySwapServer({
    port: parseInt(process.env.PORT || '3000'),
    httpsPort: parseInt(process.env.HTTPS_PORT || '3443'),
    corsOrigins: process.env.CORS_ORIGINS?.split(','),
    enableHttps: process.env.ENABLE_HTTPS === 'true',
    certPath: process.env.CERT_PATH,
    keyPath: process.env.KEY_PATH,
    maxRequestsPerMinute: parseInt(process.env.MAX_REQUESTS_PER_MINUTE || '100'),
    requireApiKey: process.env.REQUIRE_API_KEY === 'true'
  });

  try {
    await server.initialize(masterPassword);
    await server.start();

    process.on('SIGINT', async () => {
      console.log('\nReceived SIGINT, shutting down...');
      await server.shutdown();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('\nReceived SIGTERM, shutting down...');
      await server.shutdown();
      process.exit(0);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

function encryptEnv() {
  const masterPassword = process.argv[3] || process.env.MASTER_PASSWORD;
  if (!masterPassword) {
    console.error('❌ Master password required');
    console.log('Usage: npm run encrypt-env <master-password>');
    process.exit(1);
  }

  try {
    const encryptor = new EnvironmentEncryptor(masterPassword);
    encryptor.encryptEnvFile('.env', '.env.encrypted');
    console.log('✅ Environment file encrypted successfully');
  } catch (error: any) {
    console.error('❌ Encryption failed:', error.message);
    process.exit(1);
  }
}

function decryptEnv() {
  const masterPassword = process.argv[3] || process.env.MASTER_PASSWORD;
  if (!masterPassword) {
    console.error('❌ Master password required');
    console.log('Usage: npm run decrypt-env <master-password>');
    process.exit(1);
  }

  try {
    const encryptor = new EnvironmentEncryptor(masterPassword);
    encryptor.decryptEnvFile('.env.encrypted', '.env.decrypted');
    console.log('✅ Environment file decrypted successfully');
  } catch (error: any) {
    console.error('❌ Decryption failed:', error.message);
    process.exit(1);
  }
}

function showHelp() {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║           StarClad Privacy Swap Backend - v1.0.0              ║
╚═══════════════════════════════════════════════════════════════╝

USAGE:
  npm run start                          Start the server
  npm run encrypt-env <password>         Encrypt .env file
  npm run decrypt-env <password>         Decrypt .env file
  npm run init                           Create .env template

PRODUCTION FEATURES:
  ✓ Full HTTPS with TLS
  ✓ Redis-backed rate limiting
  ✓ API key authentication
  ✓ Poseidon hash-based privacy
  ✓ Bitcoin SPV proofs
  ✓ Atomic swap coordination
  ✓ Starknet integration
  ✓ AES-256-GCM encryption
  ✓ Comprehensive logging
  `);
}

function createEnvTemplate() {
  const template = `# StarClad Privacy Backend Configuration
MASTER_PASSWORD=your_secure_master_password_here
STARKNET_RPC_URL=https://starknet-mainnet.public.blastapi.io
SWAP_CONTRACT_ADDRESS=0x...
BRIDGE_CONTRACT_ADDRESS=0x...
RELAYER_ADDRESS=0x...
RELAYER_PRIVATE_KEY=0x...
BTC_RPC_URL=http://localhost:8332
BTC_RPC_USER=bitcoin
BTC_RPC_PASS=password
REDIS_URL=redis://localhost:6379
PORT=3000
HTTPS_PORT=3443
ENABLE_HTTPS=false
CERT_PATH=./certs/server.crt
KEY_PATH=./certs/server.key
NODE_ENV=production
ENABLE_RATE_LIMITING=true
MAX_REQUESTS_PER_MINUTE=100
REQUIRE_API_KEY=false
CORS_ORIGINS=http://localhost:3000,https://yourdomain.com
`;

  try {
    fs.writeFileSync('.env.template', template);
    console.log('✅ Created .env.template');
    console.log('📝 Copy to .env and fill in your values');
    console.log('🔐 Then run: npm run encrypt-env <master-password>');
  } catch (error: any) {
    console.error('❌ Failed to create template:', error.message);
    process.exit(1);
  }
}

function main() {
  const command = process.argv[2];

  switch (command) {
    case 'start':
      startServer().catch(console.error);
      break;
    case 'encrypt-env':
      encryptEnv();
      break;
    case 'decrypt-env':
      decryptEnv();
      break;
    case 'init':
      createEnvTemplate();
      break;
    case 'help':
    case '--help':
    case '-h':
      showHelp();
      break;
    default:
      showHelp();
      break;
  }
}

if (require.main === module) {
  main();
}

export { startServer, encryptEnv, decryptEnv, createEnvTemplate };
