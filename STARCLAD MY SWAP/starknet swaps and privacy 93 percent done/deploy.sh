#!/bin/bash

# Starknet Contract Deployment Script
# This script builds and deploys all three contracts

set -e

echo "🚀 Starting Starknet Contract Deployment"
echo "========================================"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if Scarb is installed
if ! command -v scarb &> /dev/null; then
    echo "❌ Scarb is not installed. Please install from https://docs.swmansion.com/scarb/"
    exit 1
fi

# Check if Starkli is installed
if ! command -v starkli &> /dev/null; then
    echo "❌ Starkli is not installed. Please install from https://github.com/xJonathanLEI/starkli"
    exit 1
fi

echo -e "${GREEN}✓${NC} Prerequisites checked"

# Load environment variables
if [ -f .env ]; then
    export $(cat .env | xargs)
fi

# Network selection
NETWORK=${STARKNET_NETWORK:-"testnet"}
echo "📡 Deploying to: $NETWORK"

# 1. Deploy Vault Manager
echo ""
echo "1️⃣  Deploying Vault Manager Contract..."
echo "----------------------------------------"
cd vault-manager

# Build contract
scarb build

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓${NC} Vault Manager built successfully"
    
    # Deploy contract
    VAULT_HASH=$(starkli declare target/dev/vault_manager_VaultManager.contract_class.json \
        --rpc $STARKNET_RPC_URL \
        --account $STARKNET_ACCOUNT \
        --keystore $STARKNET_KEYSTORE 2>&1 | grep "Class hash declared" | awk '{print $NF}')
    
    if [ ! -z "$VAULT_HASH" ]; then
        echo -e "${GREEN}✓${NC} Vault Manager declared: $VAULT_HASH"
        
        # Deploy instance
        VAULT_ADDRESS=$(starkli deploy $VAULT_HASH \
            $OWNER_ADDRESS \
            $INITIAL_CURATOR \
            100 200 \
            $FEE_RECIPIENT \
            --rpc $STARKNET_RPC_URL \
            --account $STARKNET_ACCOUNT \
            --keystore $STARKNET_KEYSTORE 2>&1 | grep "Contract deployed" | awk '{print $NF}')
        
        echo -e "${GREEN}✓${NC} Vault Manager deployed: $VAULT_ADDRESS"
        echo "VAULT_MANAGER_ADDRESS=$VAULT_ADDRESS" >> ../.env.deployed
    fi
else
    echo "❌ Vault Manager build failed"
fi

cd ..

# 2. Deploy BTC Swap
echo ""
echo "2️⃣  Deploying Private BTC Swap Contract..."
echo "-------------------------------------------"
cd btc-swap

# Build contract
scarb build

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓${NC} BTC Swap built successfully"
    
    # Deploy contract
    BTC_HASH=$(starkli declare target/dev/private_btc_swap_PrivateBTCSwap.contract_class.json \
        --rpc $STARKNET_RPC_URL \
        --account $STARKNET_ACCOUNT \
        --keystore $STARKNET_KEYSTORE 2>&1 | grep "Class hash declared" | awk '{print $NF}')
    
    if [ ! -z "$BTC_HASH" ]; then
        echo -e "${GREEN}✓${NC} BTC Swap declared: $BTC_HASH"
        
        # Deploy instance
        BTC_ADDRESS=$(starkli deploy $BTC_HASH \
            --rpc $STARKNET_RPC_URL \
            --account $STARKNET_ACCOUNT \
            --keystore $STARKNET_KEYSTORE 2>&1 | grep "Contract deployed" | awk '{print $NF}')
        
        echo -e "${GREEN}✓${NC} BTC Swap deployed: $BTC_ADDRESS"
        echo "BTC_SWAP_ADDRESS=$BTC_ADDRESS" >> ../.env.deployed
    fi
else
    echo "❌ BTC Swap build failed"
fi

cd ..

# 3. Deploy Semaphore
echo ""
echo "3️⃣  Deploying Semaphore Contract..."
echo "-----------------------------------"
cd semaphore

# Build contract
scarb build

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓${NC} Semaphore built successfully"
    
    # Deploy contract
    SEMAPHORE_HASH=$(starkli declare target/dev/semaphore_starknet_SemaphoreStarknet.contract_class.json \
        --rpc $STARKNET_RPC_URL \
        --account $STARKNET_ACCOUNT \
        --keystore $STARKNET_KEYSTORE 2>&1 | grep "Class hash declared" | awk '{print $NF}')
    
    if [ ! -z "$SEMAPHORE_HASH" ]; then
        echo -e "${GREEN}✓${NC} Semaphore declared: $SEMAPHORE_HASH"
        
        # Deploy instance
        SEMAPHORE_ADDRESS=$(starkli deploy $SEMAPHORE_HASH \
            --rpc $STARKNET_RPC_URL \
            --account $STARKNET_ACCOUNT \
            --keystore $STARKNET_KEYSTORE 2>&1 | grep "Contract deployed" | awk '{print $NF}')
        
        echo -e "${GREEN}✓${NC} Semaphore deployed: $SEMAPHORE_ADDRESS"
        echo "SEMAPHORE_ADDRESS=$SEMAPHORE_ADDRESS" >> ../.env.deployed
    fi
else
    echo "❌ Semaphore build failed"
fi

cd ..

# Summary
echo ""
echo "=========================================="
echo "📋 Deployment Summary"
echo "=========================================="
echo ""

if [ -f .env.deployed ]; then
    cat .env.deployed
    echo ""
    echo -e "${GREEN}✓${NC} All contracts deployed successfully!"
    echo "Contract addresses saved to .env.deployed"
    echo ""
    echo "Next steps:"
    echo "1. Copy addresses to your .env file"
    echo "2. Run 'npm install' to install backend dependencies"
    echo "3. Start backend services with 'npm run start:all'"
else
    echo "❌ Some deployments failed. Check the output above."
fi

echo ""
