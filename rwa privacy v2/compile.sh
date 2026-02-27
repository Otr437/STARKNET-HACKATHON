#!/bin/bash
: <<'COMMENT'
═══════════════════════════════════════════════════════════
🔐 CRYPTO-PROTECTED CODE 🔐
═══════════════════════════════════════════════════════════

Author:           Leon Sage
Organization:     Sage Audio LLC
Copyright:        © 2025 Leon Sage. All Rights Reserved.
License:          Proprietary
Signed:           2026-02-26 11:42:20
Certificate:      CodeSigning-LeonSage

CRYPTOGRAPHIC FINGERPRINT:
SHA-256:  EC1155FA76998B413E5B45343DB7401CC3E3D48BA56D89370362B26884044C50
SHA-512:  0D4E909F0E6134ECBA66BCD7998AA41BBDF1AA1AF37D28721A24A606BFDC5000833E72E67096132B1EC41A7784BC4B2F72D005E91F78A2E5916075BC597585D5
MD5:      7E9C2EC4D3A77789C5410976F96BBAD8
File Size: 2593 bytes

LICENSE:
PROPRIETARY LICENSE

Copyright (c) 2026 Leon Sage. All Rights Reserved.
Sage Audio LLC

This software is proprietary and confidential property of Leon Sage.
UNAUTHORIZED COPYING, MODIFICATION, DISTRIBUTION, OR USE IS STRICTLY PROHIBITED.

⚠️  ANTI-THEFT NOTICE:
This code is cryptographically signed and protected. Any
unauthorized modification, distribution, or removal of this
protection constitutes copyright infringement.
═══════════════════════════════════════════════════════════
COMMENT
set -e

echo "=========================================="
echo "🔨 COMPILING ALL COMPONENTS"
echo "=========================================="

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

success() {
    echo -e "${GREEN}✅ $1${NC}"
}

error() {
    echo -e "${RED}❌ $1${NC}"
    exit 1
}

# Check dependencies
command -v nargo >/dev/null 2>&1 || error "Nargo not installed"
command -v scarb >/dev/null 2>&1 || error "Scarb not installed"

echo ""
echo "📝 Step 1: Compiling Noir circuits..."
cd circuits

# Compile deposit circuit
echo "  - Compiling deposit circuit..."
nargo compile --package shielded_rwa || error "Deposit circuit compilation failed"
success "Deposit circuit compiled"

# Generate example proof inputs
cat > deposit_example.json << 'EOF'
{
  "secret": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd",
  "asset_id": "1",
  "amount": "100"
}
EOF

cat > withdraw_example.json << 'EOF'
{
  "secret": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd",
  "asset_id": "1",
  "amount": "100",
  "merkle_path": [
    "0x0", "0x0", "0x0", "0x0", "0x0", "0x0", "0x0", "0x0", "0x0", "0x0",
    "0x0", "0x0", "0x0", "0x0", "0x0", "0x0", "0x0", "0x0", "0x0", "0x0"
  ],
  "path_indices": [
    "0", "0", "0", "0", "0", "0", "0", "0", "0", "0",
    "0", "0", "0", "0", "0", "0", "0", "0", "0", "0"
  ],
  "merkle_root": "0x0",
  "nullifier": "0x0",
  "destination": "0x1234567890123456789012345678901234567890123456789012345678901234"
}
EOF

success "Example input JSONs created"
cd ..

echo ""
echo "🏗️  Step 2: Compiling Cairo contracts..."
cd contracts
scarb build || error "Cairo compilation failed"
success "Cairo contracts compiled"

# Check output files
if [ ! -f "target/dev/shielded_rwa_vault_ShieldedRWAVault.contract_class.json" ]; then
    error "Contract class file not found"
fi

success "Contract artifacts generated"
cd ..

echo ""
echo "📦 Step 3: Building TypeScript backend..."
cd backend
npm install || pnpm install || error "Backend dependencies installation failed"
npm run build || error "Backend build failed"
success "Backend compiled"
cd ..

echo ""
echo "=========================================="
echo "✅ ALL COMPILATION COMPLETE"
echo "=========================================="
echo ""
echo "📁 Output files:"
echo "  - circuits/target/*.json (Noir artifacts)"
echo "  - circuits/*_example.json (Test inputs)"
echo "  - contracts/target/dev/*.json (Cairo artifacts)"
echo "  - backend/dist/ (TypeScript compiled)"
echo ""
echo "🚀 Next: Run ./deploy.sh to deploy"
echo ""

