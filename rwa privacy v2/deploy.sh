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
SHA-256:  DBCAB124925EC4023A357D1CB6F4D4DFFD2056802B4C277FFF71904D38CE22B9
SHA-512:  804AF228B5EAF41D6E4DF4137612CCC8EC71E0EE87712CFF671AB0D15BF15E6CC35D4217C34DE0D1D28B47AC836BB006CAD71A7D04DA0739DFF9B910DC44AA7A
MD5:      05E64B5D09118AE69B9C1262FE086883
File Size: 4279 bytes

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
echo "🚀 SHIELDED RWA - COMPLETE SETUP"
echo "=========================================="

# Check dependencies
echo "Checking dependencies..."
command -v node >/dev/null 2>&1 || { echo "❌ Node.js required"; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "❌ pnpm required: npm install -g pnpm"; exit 1; }
command -v scarb >/dev/null 2>&1 || { echo "❌ Scarb required: curl --proto '=https' --tlsv1.2 -sSf https://docs.swmansion.com/scarb/install.sh | sh"; exit 1; }
command -v nargo >/dev/null 2>&1 || { echo "❌ Nargo required: curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash"; exit 1; }

echo "✅ All dependencies met"
echo ""

# Get inputs
read -p "Starknet account address: " ACCOUNT
read -sp "Starknet private key: " PRIVKEY
echo ""
read -p "Oracle contract address (from oracle deployment): " ORACLE_ADDR

echo ""
echo "=========================================="
echo "📝 STEP 1: COMPILE NOIR CIRCUITS"
echo "=========================================="

cd circuits
echo "Compiling Noir circuits..."
nargo compile
echo "✅ Circuits compiled"
cd ..

echo ""
echo "=========================================="
echo "🔨 STEP 2: COMPILE CAIRO CONTRACT"
echo "=========================================="

cd contracts
echo "Compiling Cairo contract..."
scarb build
echo "✅ Contract compiled"
cd ..

echo ""
echo "=========================================="
echo "🚀 STEP 3: DEPLOY CONTRACT"
echo "=========================================="

# Create deployment script
cat > deploy.mjs << 'EOF'
import { Account, RpcProvider, Contract, json, CallData } from 'starknet';
import { readFileSync } from 'fs';

const RPC = 'https://starknet-sepolia.public.blastapi.io/rpc/v0_7';
const ACCOUNT_ADDR = process.env.ACCOUNT_ADDRESS;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const ORACLE_ADDR = process.env.ORACLE_ADDRESS;

const provider = new RpcProvider({ nodeUrl: RPC });
const account = new Account(provider, ACCOUNT_ADDR, PRIVATE_KEY);

const compiledContract = json.parse(
    readFileSync('contracts/target/dev/shielded_rwa_vault_ShieldedRWAVault.contract_class.json', 'utf8')
);

console.log('Declaring contract...');
const declareResponse = await account.declareIfNot({ contract: compiledContract });
console.log('Class hash:', declareResponse.class_hash);

console.log('Deploying contract...');
const deployResponse = await account.deployContract({
    classHash: declareResponse.class_hash,
    constructorCalldata: CallData.compile({
        owner: ACCOUNT_ADDR,
        oracle: ORACLE_ADDR
    })
});

console.log('Waiting for deployment...');
await provider.waitForTransaction(deployResponse.transaction_hash);

console.log('✅ CONTRACT DEPLOYED:', deployResponse.contract_address[0]);
console.log('TX:', deployResponse.transaction_hash);

// Save address
writeFileSync('.contract-address', deployResponse.contract_address[0]);
EOF

export ACCOUNT_ADDRESS=$ACCOUNT
export PRIVATE_KEY=$PRIVKEY
export ORACLE_ADDRESS=$ORACLE_ADDR

node deploy.mjs

CONTRACT_ADDR=$(cat .contract-address)
echo "Contract address: $CONTRACT_ADDR"

echo ""
echo "=========================================="
echo "⚙️  STEP 4: SETUP BACKEND"
echo "=========================================="

cd backend
pnpm install

cat > .env << EOF
STARKNET_RPC_URL=https://starknet-sepolia.public.blastapi.io/rpc/v0_7
CONTRACT_ADDRESS=$CONTRACT_ADDR
EOF

echo "✅ Backend configured"
cd ..

echo ""
echo "=========================================="
echo "🌐 STEP 5: CONFIGURE FRONTEND"
echo "=========================================="

cd frontend
sed -i "s/YOUR_CONTRACT_ADDRESS/$CONTRACT_ADDR/g" index.html
echo "✅ Frontend configured"
cd ..

echo ""
echo "=========================================="
echo "✅ DEPLOYMENT COMPLETE!"
echo "=========================================="
echo ""
echo "📋 NEXT STEPS:"
echo ""
echo "1. Start backend:"
echo "   cd backend && pnpm run dev"
echo ""
echo "2. Start frontend:"
echo "   cd frontend && python3 -m http.server 8000"
echo ""
echo "3. Open browser:"
echo "   http://localhost:8000"
echo ""
echo "🎉 Your shielded RWA protocol is ready!"
echo ""
echo "Contract: $CONTRACT_ADDR"
echo "Oracle: $ORACLE_ADDR"
echo ""

