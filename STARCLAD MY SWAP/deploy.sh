#!/bin/bash
# DEPLOY STARKNET CONTRACTS

set -e

echo "🚀 Deploying StarClad Contracts to Starknet"
echo "============================================"

# Check for required tools
if ! command -v starkli &> /dev/null; then
    echo "❌ Error: starkli not found"
    echo "Install: curl https://get.starkli.sh | sh"
    exit 1
fi

# Configuration
NETWORK=${NETWORK:-"testnet"}
ACCOUNT=${STARKNET_ACCOUNT:-"~/.starkli-wallets/deployer/account.json"}
KEYSTORE=${STARKNET_KEYSTORE:-"~/.starkli-wallets/deployer/keystore.json"}

echo "Network: $NETWORK"
echo "Account: $ACCOUNT"
echo ""

# Deploy BTC Bridge Contract
echo "📝 Deploying BTC Bridge Contract..."
BRIDGE_CLASS_HASH=$(starkli declare \
    target/dev/starclad_contracts_BitcoinBridge.contract_class.json \
    --account $ACCOUNT \
    --keystore $KEYSTORE \
    --network $NETWORK)

BRIDGE_ADDRESS=$(starkli deploy \
    $BRIDGE_CLASS_HASH \
    --account $ACCOUNT \
    --keystore $KEYSTORE \
    --network $NETWORK)

echo "✅ BTC Bridge deployed at: $BRIDGE_ADDRESS"
echo ""

# Deploy Swap Contract
echo "📝 Deploying Privacy Swap Contract..."
SWAP_CLASS_HASH=$(starkli declare \
    target/dev/starclad_contracts_PrivacySwapContract.contract_class.json \
    --account $ACCOUNT \
    --keystore $KEYSTORE \
    --network $NETWORK)

SWAP_ADDRESS=$(starkli deploy \
    $SWAP_CLASS_HASH \
    --account $ACCOUNT \
    --keystore $KEYSTORE \
    --network $NETWORK)

echo "✅ Swap Contract deployed at: $SWAP_ADDRESS"
echo ""

# Save addresses
cat > deployed_addresses.json << EOF
{
  "network": "$NETWORK",
  "btc_bridge": "$BRIDGE_ADDRESS",
  "swap_contract": "$SWAP_ADDRESS",
  "deployed_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF

echo "✅ DEPLOYMENT COMPLETE"
echo ""
echo "Contract Addresses:"
echo "  BTC Bridge:    $BRIDGE_ADDRESS"
echo "  Swap Contract: $SWAP_ADDRESS"
echo ""
echo "Addresses saved to: deployed_addresses.json"
echo ""
echo "Update your .env file with these addresses:"
echo "  BRIDGE_CONTRACT_ADDRESS=$BRIDGE_ADDRESS"
echo "  SWAP_CONTRACT_ADDRESS=$SWAP_ADDRESS"
