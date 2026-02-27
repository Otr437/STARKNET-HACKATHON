#!/bin/bash
# BUILD ALL CONTRACTS AND CIRCUITS

set -e

echo "🔨 Building StarClad Contracts & Circuits"
echo "=========================================="

# Build Starknet contracts
echo ""
echo "📦 Building Starknet Contracts..."
cd starknet
if command -v scarb &> /dev/null; then
    scarb build
    echo "✅ Starknet contracts built successfully"
    echo "   Output: target/dev/"
else
    echo "⚠️  Scarb not found. Install from: https://docs.swmansion.com/scarb/"
fi
cd ..

# Build Noir circuits
echo ""
echo "🔐 Building Noir Circuits..."
cd noir

if command -v nargo &> /dev/null; then
    # Build spend proof circuit
    echo "  → Building spend_proof..."
    nargo compile --package spend_proof
    
    # Build swap proof circuit
    echo "  → Building swap_proof..."
    nargo compile --package swap_proof
    
    echo "✅ Noir circuits compiled successfully"
    echo "   Output: target/*.json"
else
    echo "⚠️  Nargo not found. Install from: https://noir-lang.org/"
fi
cd ..

echo ""
echo "✅ BUILD COMPLETE"
echo ""
echo "Next steps:"
echo "  1. Deploy Starknet contracts: ./deploy.sh"
echo "  2. Generate proofs: nargo prove"
echo "  3. Verify proofs: nargo verify"
