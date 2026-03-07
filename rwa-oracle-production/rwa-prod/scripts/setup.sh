#!/usr/bin/env bash
# scripts/setup.sh
# ─────────────────────────────────────────────────────────────
#  First-time production setup script
#  Run once after deploying to a new server.
# ─────────────────────────────────────────────────────────────

set -euo pipefail

echo "=== RWA Oracle Production Setup ==="

# Check .env exists
if [ ! -f .env ]; then
  echo "ERROR: .env not found. Copy .env.example to .env and fill in values."
  exit 1
fi

# Load env
set -a; source .env; set +a

echo "1. Installing dependencies..."
npm ci

echo "2. Generating Prisma client..."
npm run db:generate

echo "3. Running database migrations..."
npm run db:migrate

echo "4. Seeding initial admin user and assets..."
npm run db:seed

echo "5. Building TypeScript..."
npm run build

echo ""
echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "  1. Log in at http://localhost:4000/api/auth/login"
echo "     Email:    ${SEED_ADMIN_EMAIL:-admin@rwa-oracle.local}"
echo "     Password: (see SEED_ADMIN_PASSWORD in .env)"
echo ""
echo "  2. Create a feeder API key:"
echo "     POST /api/apikeys  { name: 'prod-feeder', scopes: ['price:write'] }"
echo ""
echo "  3. Add the API key to .env as FEEDER_API_KEY=rwa_..."
echo ""
echo "  4. Start all services:"
echo "     npm run start:all"
echo ""
echo "  Or with Docker:"
echo "     docker-compose up -d"
