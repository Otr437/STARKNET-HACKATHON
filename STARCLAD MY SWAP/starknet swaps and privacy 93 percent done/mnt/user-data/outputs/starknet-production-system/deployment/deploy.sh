#!/bin/bash

# Starknet Production Deployment Script
# Deploys all contracts with proper configuration

set -e

echo "🚀 Starting Starknet Production Deployment"
echo "==========================================="

# Load environment variables
if [ -f .env ]; then
    export $(cat .env | grep -v '#' | xargs)
else
    echo "❌ .env file not found. Please create one from .env.example"
    exit 1
fi

# Check required environment variables
required_vars=("STARKNET_ACCOUNT" "STARKNET_PRIVATE_KEY" "STARKNET_RPC_URL" "ADMIN_ADDRESS" "TREASURY_ADDRESS")
for var in "${required_vars[@]}"; do
    if [ -z "${!var}" ]; then
        echo "❌ Missing required environment variable: $var"
        exit 1
    fi
done

# Network selection
if [ -z "$1" ]; then
    echo "Usage: ./deploy.sh [mainnet|sepolia|devnet]"
    exit 1
fi

NETWORK=$1
echo "📡 Deploying to network: $NETWORK"

# Build contracts
echo ""
echo "📦 Building contracts..."
cd ../contracts
scarb build

if [ $? -ne 0 ]; then
    echo "❌ Contract build failed"
    exit 1
fi

echo "✅ Contracts built successfully"

# Deploy Vault Manager
echo ""
echo "1️⃣ Deploying Vault Manager..."
VAULT_MANAGER_CLASS_HASH=$(starkli declare \
    --account $STARKNET_ACCOUNT \
    --private-key $STARKNET_PRIVATE_KEY \
    --rpc $STARKNET_RPC_URL \
    target/dev/starknet_production_contracts_VaultManager.contract_class.json \
    2>&1 | grep "Class hash declared" | awk '{print $NF}')

echo "Vault Manager Class Hash: $VAULT_MANAGER_CLASS_HASH"

# Deploy instance with constructor args
VAULT_MANAGER_ADDRESS=$(starkli deploy \
    --account $STARKNET_ACCOUNT \
    --private-key $STARKNET_PRIVATE_KEY \
    --rpc $STARKNET_RPC_URL \
    $VAULT_MANAGER_CLASS_HASH \
    $ADMIN_ADDRESS \
    $TREASURY_ADDRESS \
    100 \
    2>&1 | grep "Contract deployed" | awk '{print $NF}')

echo "✅ Vault Manager deployed at: $VAULT_MANAGER_ADDRESS"

# Deploy BTC Swap
echo ""
echo "2️⃣ Deploying Private BTC Swap..."
BTC_SWAP_CLASS_HASH=$(starkli declare \
    --account $STARKNET_ACCOUNT \
    --private-key $STARKNET_PRIVATE_KEY \
    --rpc $STARKNET_RPC_URL \
    target/dev/starknet_production_contracts_PrivateBTCSwap.contract_class.json \
    2>&1 | grep "Class hash declared" | awk '{print $NF}')

echo "BTC Swap Class Hash: $BTC_SWAP_CLASS_HASH"

BTC_SWAP_ADDRESS=$(starkli deploy \
    --account $STARKNET_ACCOUNT \
    --private-key $STARKNET_PRIVATE_KEY \
    --rpc $STARKNET_RPC_URL \
    $BTC_SWAP_CLASS_HASH \
    $ADMIN_ADDRESS \
    $TREASURY_ADDRESS \
    3600 \
    86400 \
    50 \
    2>&1 | grep "Contract deployed" | awk '{print $NF}')

echo "✅ BTC Swap deployed at: $BTC_SWAP_ADDRESS"

# Deploy Semaphore
echo ""
echo "3️⃣ Deploying Semaphore..."
SEMAPHORE_CLASS_HASH=$(starkli declare \
    --account $STARKNET_ACCOUNT \
    --private-key $STARKNET_PRIVATE_KEY \
    --rpc $STARKNET_RPC_URL \
    target/dev/starknet_production_contracts_SemaphoreStarknet.contract_class.json \
    2>&1 | grep "Class hash declared" | awk '{print $NF}')

echo "Semaphore Class Hash: $SEMAPHORE_CLASS_HASH"

SEMAPHORE_ADDRESS=$(starkli deploy \
    --account $STARKNET_ACCOUNT \
    --private-key $STARKNET_PRIVATE_KEY \
    --rpc $STARKNET_RPC_URL \
    $SEMAPHORE_CLASS_HASH \
    $ADMIN_ADDRESS \
    2>&1 | grep "Contract deployed" | awk '{print $NF}')

echo "✅ Semaphore deployed at: $SEMAPHORE_ADDRESS"

# Save deployment addresses
echo ""
echo "💾 Saving deployment addresses..."

cat > deployment-$NETWORK.json <<EOF
{
  "network": "$NETWORK",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "contracts": {
    "vaultManager": {
      "address": "$VAULT_MANAGER_ADDRESS",
      "classHash": "$VAULT_MANAGER_CLASS_HASH"
    },
    "btcSwap": {
      "address": "$BTC_SWAP_ADDRESS",
      "classHash": "$BTC_SWAP_CLASS_HASH"
    },
    "semaphore": {
      "address": "$SEMAPHORE_ADDRESS",
      "classHash": "$SEMAPHORE_CLASS_HASH"
    }
  },
  "configuration": {
    "admin": "$ADMIN_ADDRESS",
    "treasury": "$TREASURY_ADDRESS"
  }
}
EOF

echo "✅ Deployment addresses saved to deployment-$NETWORK.json"

# Update backend .env file
echo ""
echo "🔧 Updating backend configuration..."
cd ../backend

cat >> .env <<EOF

# Deployed Contract Addresses ($NETWORK - $(date))
VAULT_MANAGER_ADDRESS=$VAULT_MANAGER_ADDRESS
BTC_SWAP_ADDRESS=$BTC_SWAP_ADDRESS
SEMAPHORE_ADDRESS=$SEMAPHORE_ADDRESS
EOF

echo "✅ Backend .env updated"

# Verify contracts on Voyager/Starkscan
echo ""
echo "🔍 Contract Verification URLs:"
if [ "$NETWORK" = "mainnet" ]; then
    BASE_URL="https://voyager.online/contract"
else
    BASE_URL="https://sepolia.voyager.online/contract"
fi

echo "Vault Manager: $BASE_URL/$VAULT_MANAGER_ADDRESS"
echo "BTC Swap: $BASE_URL/$BTC_SWAP_ADDRESS"
echo "Semaphore: $BASE_URL/$SEMAPHORE_ADDRESS"

echo ""
echo "✅ Deployment completed successfully!"
echo "==========================================="
echo ""
echo "Next steps:"
echo "1. Verify contracts on block explorer"
echo "2. Grant necessary roles to operators"
echo "3. Configure backend webhooks"
echo "4. Set up monitoring and alerts"
echo "5. Run integration tests"
echo ""
echo "📝 Review deployment details in: deployment-$NETWORK.json"
