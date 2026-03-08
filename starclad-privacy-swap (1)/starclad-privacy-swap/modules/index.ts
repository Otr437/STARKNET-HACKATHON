/**
 * StarClad Privacy Swap - Entry Point
 * Commands: start | encrypt-env | decrypt-env | init | create-key
 */
import { PrivacySwapServer } from './server';
import { EnvironmentEncryptor } from './encryption';
import fs from 'fs';

// ── start ─────────────────────────────────────────────────────────────────────
async function start() {
  const pass = process.env.MASTER_PASSWORD;
  if (!pass) { console.error('❌ MASTER_PASSWORD required'); process.exit(1); }

  const server = new PrivacySwapServer({
    port: parseInt(process.env.PORT ?? '3000'),
    httpsPort: parseInt(process.env.HTTPS_PORT ?? '3443'),
    corsOrigins: process.env.CORS_ORIGINS?.split(','),
    enableHttps: process.env.ENABLE_HTTPS === 'true',
    certPath: process.env.CERT_PATH,
    keyPath: process.env.KEY_PATH,
    maxRpm: parseInt(process.env.MAX_RPM ?? '100'),
    requireApiKey: process.env.REQUIRE_API_KEY === 'true',
    enableStarknet: process.env.ENABLE_STARKNET !== 'false',
  });

  try {
    await server.initialize(pass);
    await server.start();

    const shutdown = async (sig: string) => {
      console.log(`\n[${sig}] shutting down...`);
      await server.shutdown();
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('uncaughtException', (err) => { console.error('Uncaught exception:', err); });
    process.on('unhandledRejection', (reason) => { console.error('Unhandled rejection:', reason); });
  } catch (err) {
    console.error('❌ Startup failed:', err);
    process.exit(1);
  }
}

// ── encrypt-env ───────────────────────────────────────────────────────────────
function encryptEnv() {
  const pass = process.argv[3] ?? process.env.MASTER_PASSWORD;
  if (!pass) { console.error('Usage: npm run encrypt-env <master-password>'); process.exit(1); }
  const enc = new EnvironmentEncryptor(pass);
  enc.encryptEnvFile('.env', '.env.encrypted');
  console.log('✅ .env encrypted → .env.encrypted');
  enc.destroy();
}

// ── decrypt-env ───────────────────────────────────────────────────────────────
function decryptEnv() {
  const pass = process.argv[3] ?? process.env.MASTER_PASSWORD;
  if (!pass) { console.error('Usage: npm run decrypt-env <master-password>'); process.exit(1); }
  const enc = new EnvironmentEncryptor(pass);
  enc.decryptEnvFile('.env.encrypted', '.env.decrypted');
  console.log('✅ .env.encrypted decrypted → .env.decrypted');
  enc.destroy();
}

// ── init ──────────────────────────────────────────────────────────────────────
function init() {
  const template = `# StarClad Privacy Swap - Environment Configuration
# Production: run "npm run encrypt-env <password>" after filling in secrets

MASTER_PASSWORD=change_me_to_at_least_32_chars_long_random_string

# Starknet
STARKNET_RPC_URL=https://starknet-mainnet.public.blastapi.io
SWAP_CONTRACT_ADDRESS=0x0000000000000000000000000000000000000000000000000000000000000000
BRIDGE_CONTRACT_ADDRESS=0x0000000000000000000000000000000000000000000000000000000000000000
RELAYER_ADDRESS=0x0
RELAYER_PRIVATE_KEY=0x0

# Bitcoin
BTC_RPC_URL=http://localhost:8332
BTC_RPC_USER=bitcoin
BTC_RPC_PASS=change_me

# Redis
REDIS_URL=redis://localhost:6379

# Server
PORT=3000
HTTPS_PORT=3443
ENABLE_HTTPS=false
CERT_PATH=./certs/server.crt
KEY_PATH=./certs/server.key
NODE_ENV=production
MAX_RPM=100
REQUIRE_API_KEY=false
ENABLE_STARKNET=true
CORS_ORIGINS=http://localhost:3000
`;
  fs.writeFileSync('.env.template', template);
  console.log('✅ .env.template created — copy to .env and fill in values');
}

// ── help ──────────────────────────────────────────────────────────────────────
function help() {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║          StarClad Privacy Swap Backend  v1.0.0                ║
╚═══════════════════════════════════════════════════════════════╝

COMMANDS
  npm start                          Start production server
  npm run dev                        Start dev server (ts-node)
  npm run encrypt-env [password]     Encrypt .env → .env.encrypted
  npm run decrypt-env [password]     Decrypt .env.encrypted → .env.decrypted
  npm run init                       Create .env.template
  npm test                           Run test suite

FEATURES
  ✓ HTTPS/HTTP with helmet security headers
  ✓ Redis-backed rate limiting per API key / IP
  ✓ Argon2id master key derivation
  ✓ AES-256-GCM note encryption at rest
  ✓ Poseidon hash commitments (BN254 field)
  ✓ Privacy notes with nullifier tracking
  ✓ Sparse Merkle tree (depth 20)
  ✓ Bitcoin SPV proof generation & verification
  ✓ HTLC P2WSH scripts
  ✓ Atomic swap lifecycle (pending→locked→completed|refunded)
  ✓ Starknet contract interaction
  ✓ Zod input validation on all routes
  ✓ Graceful SIGTERM/SIGINT shutdown
  ✓ Audit log for all crypto operations
  ✓ Key rotation support
`);
}

// ── dispatch ──────────────────────────────────────────────────────────────────
const cmd = process.argv[2];
switch (cmd) {
  case 'start': start().catch(console.error); break;
  case 'encrypt-env': encryptEnv(); break;
  case 'decrypt-env': decryptEnv(); break;
  case 'init': init(); break;
  default: help(); break;
}

export { start, encryptEnv, decryptEnv, init };
