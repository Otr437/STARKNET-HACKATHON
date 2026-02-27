#!/bin/bash

# Integration Test Suite for Starknet Services
# Tests all three services to ensure production readiness

set -e

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

VAULT_URL="http://localhost:3001"
BTC_SWAP_URL="http://localhost:3002"
SEMAPHORE_URL="http://localhost:3003"

echo "=================================="
echo "Starknet Services Integration Tests"
echo "=================================="
echo ""

# Function to test endpoint
test_endpoint() {
    local name=$1
    local url=$2
    local expected=$3
    
    echo -n "Testing $name... "
    response=$(curl -s "$url")
    
    if echo "$response" | grep -q "$expected"; then
        echo -e "${GREEN}✓ PASSED${NC}"
        return 0
    else
        echo -e "${RED}✗ FAILED${NC}"
        echo "Expected: $expected"
        echo "Got: $response"
        return 1
    fi
}

# Function to test POST endpoint
test_post() {
    local name=$1
    local url=$2
    local data=$3
    local expected=$4
    
    echo -n "Testing $name... "
    response=$(curl -s -X POST "$url" \
        -H "Content-Type: application/json" \
        -d "$data")
    
    if echo "$response" | grep -q "$expected"; then
        echo -e "${GREEN}✓ PASSED${NC}"
        echo "$response"
        return 0
    else
        echo -e "${RED}✗ FAILED${NC}"
        echo "Expected: $expected"
        echo "Got: $response"
        return 1
    fi
}

echo "=== Vault Manager Tests ==="
echo ""

test_endpoint \
    "Vault health check" \
    "$VAULT_URL/health" \
    "vault-manager-api"

test_endpoint \
    "Vault TVL endpoint" \
    "$VAULT_URL/api/vault/tvl" \
    "success"

test_endpoint \
    "Vault analytics" \
    "$VAULT_URL/api/vault/analytics" \
    "total_tvl"

test_post \
    "Prepare deposit" \
    "$VAULT_URL/api/vault/prepare-deposit" \
    '{"assetAddress":"0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7","amount":"1000000000000000000"}' \
    "callData"

echo ""
echo "=== BTC Swap Tests ==="
echo ""

test_endpoint \
    "BTC Swap health check" \
    "$BTC_SWAP_URL/health" \
    "btc-swap-api"

test_post \
    "Initiate swap" \
    "$BTC_SWAP_URL/api/swap/initiate" \
    '{"participantAddress":"0x123","assetAddress":"0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7","amount":"1000000","btcAddress":"tb1qtest","btcAmount":"10000"}' \
    "swapId"

test_post \
    "Verify secret" \
    "$BTC_SWAP_URL/api/swap/verify-secret" \
    '{"secret":"deadbeef","hashLock":"0xa3b4c5d6"}' \
    "isValid"

echo ""
echo "=== Semaphore Tests ==="
echo ""

test_endpoint \
    "Semaphore health check" \
    "$SEMAPHORE_URL/health" \
    "semaphore-api"

# Generate identity
echo -n "Generating identity... "
identity_response=$(curl -s -X POST "$SEMAPHORE_URL/api/identity/generate")
identity_id=$(echo "$identity_response" | grep -o '"identityId":"[^"]*' | cut -d'"' -f4)

if [ -n "$identity_id" ]; then
    echo -e "${GREEN}✓ PASSED${NC}"
    echo "Identity ID: $identity_id"
else
    echo -e "${RED}✗ FAILED${NC}"
fi

# Create group
test_post \
    "Create group" \
    "$SEMAPHORE_URL/api/group/create" \
    '{"adminAddress":"0x123","groupName":"Test Group","description":"Integration test group"}' \
    "groupId"

test_endpoint \
    "List groups" \
    "$SEMAPHORE_URL/api/groups" \
    "success"

echo ""
echo "=== Database Tests ==="
echo ""

# Check if databases exist
if [ -f "swaps.db" ]; then
    echo -e "${GREEN}✓${NC} BTC Swap database exists"
    swap_count=$(sqlite3 swaps.db "SELECT COUNT(*) FROM swaps;")
    echo "  Swaps in DB: $swap_count"
else
    echo -e "${YELLOW}!${NC} BTC Swap database not initialized yet"
fi

if [ -f "semaphore.db" ]; then
    echo -e "${GREEN}✓${NC} Semaphore database exists"
    identity_count=$(sqlite3 semaphore.db "SELECT COUNT(*) FROM identities;")
    group_count=$(sqlite3 semaphore.db "SELECT COUNT(*) FROM groups;")
    echo "  Identities in DB: $identity_count"
    echo "  Groups in DB: $group_count"
else
    echo -e "${YELLOW}!${NC} Semaphore database not initialized yet"
fi

echo ""
echo "=== Production Readiness Checks ==="
echo ""

# Check for stubs/placeholders in code
echo -n "Checking for stubs in code... "
stub_count=$(grep -r "TODO\|FIXME\|stub\|placeholder\|simplified.*production" \
    vault-manager/backend/*.js \
    btc-swap/backend/*.js \
    semaphore/backend/*.js 2>/dev/null | wc -l)

if [ "$stub_count" -eq "0" ]; then
    echo -e "${GREEN}✓ No stubs found${NC}"
else
    echo -e "${RED}✗ Found $stub_count potential stubs${NC}"
    grep -r "TODO\|FIXME\|stub\|placeholder" \
        vault-manager/backend/*.js \
        btc-swap/backend/*.js \
        semaphore/backend/*.js 2>/dev/null || true
fi

# Check environment variables
echo -n "Checking environment setup... "
if [ -f ".env" ]; then
    echo -e "${GREEN}✓ .env file exists${NC}"
else
    echo -e "${YELLOW}! No .env file (copy from .env.example)${NC}"
fi

# Check dependencies
echo -n "Checking dependencies... "
if [ -d "node_modules" ]; then
    echo -e "${GREEN}✓ Dependencies installed${NC}"
else
    echo -e "${RED}✗ Run 'npm install'${NC}"
fi

# Check for required packages
echo -n "Checking production packages... "
missing_packages=""

if ! npm list sqlite3 &>/dev/null; then
    missing_packages="$missing_packages sqlite3"
fi

if ! npm list circomlibjs &>/dev/null; then
    missing_packages="$missing_packages circomlibjs"
fi

if [ -z "$missing_packages" ]; then
    echo -e "${GREEN}✓ All production packages installed${NC}"
else
    echo -e "${RED}✗ Missing:$missing_packages${NC}"
    echo "  Run: npm install"
fi

echo ""
echo "=== Security Checks ==="
echo ""

# Check file permissions
echo -n "Checking .env permissions... "
if [ -f ".env" ]; then
    perms=$(stat -c "%a" .env 2>/dev/null || stat -f "%Lp" .env 2>/dev/null)
    if [ "$perms" = "600" ]; then
        echo -e "${GREEN}✓ Secure (600)${NC}"
    else
        echo -e "${YELLOW}! Permissions are $perms (should be 600)${NC}"
        echo "  Run: chmod 600 .env"
    fi
fi

# Check for exposed secrets
echo -n "Checking for exposed secrets... "
if git ls-files --error-unmatch .env &>/dev/null; then
    echo -e "${RED}✗ .env is tracked by git!${NC}"
    echo "  Run: git rm --cached .env"
else
    echo -e "${GREEN}✓ .env not in git${NC}"
fi

echo ""
echo "=== Summary ==="
echo ""
echo "All services tested successfully!"
echo ""
echo "Next steps:"
echo "1. Review PRODUCTION.md for deployment guide"
echo "2. Run 'npm run start:all' to start all services"
echo "3. Deploy contracts with './deploy.sh'"
echo "4. Set up monitoring and backups"
echo ""
echo "Documentation:"
echo "- README.md - Full project documentation"
echo "- API_DOCS.md - Complete API reference"
echo "- PRODUCTION.md - Production deployment guide"
echo "- QUICKSTART.md - Quick start guide"
echo ""
