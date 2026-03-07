#!/bin/bash
# Build all Cairo contracts for Starknet

set -e

echo "=========================================="
echo "Building Cairo Contracts"
echo "=========================================="

cd "$(dirname "$0")/../contracts"

# Check if Scarb is installed
if ! command -v scarb &> /dev/null; then
    echo "❌ Scarb not found. Install from: https://docs.swmansion.com/scarb/download.html"
    exit 1
fi

echo "Scarb version: $(scarb --version)"
echo ""

# Clean previous builds
echo "[1/3] Cleaning previous builds..."
rm -rf target/
echo "✅ Clean complete"
echo ""

# Build contracts
echo "[2/3] Building contracts..."
scarb build

if [ $? -eq 0 ]; then
    echo "✅ Build successful"
else
    echo "❌ Build failed"
    exit 1
fi
echo ""

# List generated artifacts
echo "[3/3] Generated artifacts:"
echo ""
find target/dev -name "*.sierra.json" -o -name "*.casm.json" | while read file; do
    size=$(du -h "$file" | cut -f1)
    echo "  📄 $(basename $file) ($size)"
done

echo ""
echo "=========================================="
echo "✅ All contracts built successfully!"
echo "=========================================="
echo ""
echo "Artifacts located in: contracts/target/dev/"
echo ""
echo "Next steps:"
echo "  1. Deploy oracle:  npm run deploy:oracle"
echo "  2. Deploy factory: npm run deploy:factory"
echo "  3. Create assets:  npm run deploy:real-assets"
