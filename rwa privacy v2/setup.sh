#!/bin/bash
: <<'COMMENT'
═══════════════════════════════════════════════════════════
🔐 CRYPTO-PROTECTED CODE 🔐
═══════════════════════════════════════════════════════════

Author:           Leon Sage
Organization:     Sage Audio LLC
Copyright:        © 2025 Leon Sage. All Rights Reserved.
License:          Proprietary
Signed:           2026-02-26 11:42:21
Certificate:      CodeSigning-LeonSage

CRYPTOGRAPHIC FINGERPRINT:
SHA-256:  CF3342EB99AB063D96BBDE119327765A392F374E9209123AF514DA3501811258
SHA-512:  08E2D37C333071A8B7C32C646F9D0E6D892BF634E6CD6E8F34BBD7E05EB40513020796E885FA03E83D4300B3B3AB5023CEED56403D9C859DB87A758CBD840894
MD5:      8248D61DE6DFDA3EE52FB36A1A213C33
File Size: 2450 bytes

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
echo "⚙️  SETUP - Installing Dependencies"
echo "=========================================="

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info() {
    echo -e "${YELLOW}ℹ️  $1${NC}"
}

success() {
    echo -e "${GREEN}✅ $1${NC}"
}

error() {
    echo -e "${RED}❌ $1${NC}"
    exit 1
}

# Check OS
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    OS="linux"
elif [[ "$OSTYPE" == "darwin"* ]]; then
    OS="mac"
else
    error "Unsupported OS: $OSTYPE"
fi

echo ""
echo "🔍 Checking dependencies..."

# Check Node.js
if ! command -v node &> /dev/null; then
    info "Node.js not found. Installing..."
    if [ "$OS" = "linux" ]; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        sudo apt-get install -y nodejs
    else
        error "Please install Node.js from https://nodejs.org/"
    fi
fi
success "Node.js $(node --version)"

# Check pnpm
if ! command -v pnpm &> /dev/null; then
    info "pnpm not found. Installing..."
    npm install -g pnpm
fi
success "pnpm $(pnpm --version)"

# Check Scarb
if ! command -v scarb &> /dev/null; then
    info "Scarb not found. Installing..."
    curl --proto '=https' --tlsv1.2 -sSf https://docs.swmansion.com/scarb/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
fi
success "Scarb $(scarb --version | head -n1)"

# Check Nargo
if ! command -v nargo &> /dev/null; then
    info "Nargo not found. Installing..."
    curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash
    export PATH="$HOME/.nargo/bin:$PATH"
    noirup
fi
success "Nargo $(nargo --version)"

# Check Starkli (optional but useful)
if ! command -v starkli &> /dev/null; then
    info "Starkli not found. Installing (optional)..."
    curl https://get.starkli.sh | sh
    export PATH="$HOME/.starkli/bin:$PATH"
    starkliup
fi

echo ""
echo "📦 Installing project dependencies..."

# Backend dependencies
info "Installing backend dependencies..."
cd backend
pnpm install
success "Backend dependencies installed"
cd ..

echo ""
echo "=========================================="
echo "✅ SETUP COMPLETE"
echo "=========================================="
echo ""
echo "📋 Next steps:"
echo "  1. Run: ./compile.sh"
echo "  2. Configure .env files"
echo "  3. Run: ./deploy.sh"
echo ""
echo "💡 Tip: Restart your terminal to ensure PATH is updated"
echo ""

