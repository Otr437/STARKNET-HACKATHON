#!/bin/bash

# Crypto Microservices Platform - Master Build Script
# Builds all 13 microservices in production mode

set -e

echo "========================================="
echo "Crypto Microservices - Production Build"
echo "========================================="

# Colors
RED='\033[0.31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check prerequisites
check_prerequisites() {
    echo -e "${YELLOW}Checking prerequisites...${NC}"
    
    if ! command -v cargo &> /dev/null; then
        echo -e "${RED}Error: Rust/Cargo not installed${NC}"
        echo "Install from: https://rustup.rs/"
        exit 1
    fi
    
    if ! command -v docker &> /dev/null; then
        echo -e "${RED}Error: Docker not installed${NC}"
        exit 1
    fi
    
    if ! command -v docker-compose &> /dev/null; then
        echo -e "${RED}Error: Docker Compose not installed${NC}"
        exit 1
    fi
    
    echo -e "${GREEN}✓ All prerequisites met${NC}"
}

# Build Rust service
build_rust_service() {
    local service_name=$1
    echo -e "${YELLOW}Building $service_name...${NC}"
    
    cd "$service_name"
    cargo build --release
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ $service_name built successfully${NC}"
    else
        echo -e "${RED}✗ $service_name build failed${NC}"
        exit 1
    fi
    
    cd ..
}

# Create Docker image
build_docker_image() {
    local service_name=$1
    echo -e "${YELLOW}Creating Docker image for $service_name...${NC}"
    
    cd "$service_name"
    docker build -t "crypto-microservices/$service_name:latest" .
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ Docker image created for $service_name${NC}"
    else
        echo -e "${RED}✗ Docker image creation failed for $service_name${NC}"
        exit 1
    fi
    
    cd ..
}

# Main build process
main() {
    check_prerequisites
    
    echo ""
    echo "Starting build process..."
    echo ""
    
    # Rust microservices
    RUST_SERVICES=(
        "api-gateway"
        "wallet-manager"
        "ethereum-service"
        "bitcoin-service"
        "zcash-service"
        "binance-service"
        "solana-service"
        "price-service"
        "dex-service"
        "agent-orchestrator"
        "message-history"
        "tool-executor"
    )
    
    # Build each Rust service
    for service in "${RUST_SERVICES[@]}"; do
        if [ -d "$service" ]; then
            build_rust_service "$service"
        else
            echo -e "${YELLOW}Warning: $service directory not found, skipping...${NC}"
        fi
    done
    
    echo ""
    echo -e "${YELLOW}Building Admin Dashboard (Node.js)...${NC}"
    
    if [ -d "admin-dashboard" ]; then
        cd admin-dashboard
        npm install
        npm run build
        echo -e "${GREEN}✓ Admin Dashboard built successfully${NC}"
        cd ..
    fi
    
    echo ""
    echo -e "${YELLOW}Creating Docker images...${NC}"
    
    # Build Docker images
    for service in "${RUST_SERVICES[@]}"; do
        if [ -d "$service" ]; then
            build_docker_image "$service"
        fi
    done
    
    if [ -d "admin-dashboard" ]; then
        build_docker_image "admin-dashboard"
    fi
    
    echo ""
    echo -e "${GREEN}=========================================${NC}"
    echo -e "${GREEN}Build completed successfully!${NC}"
    echo -e "${GREEN}=========================================${NC}"
    echo ""
    echo "Next steps:"
    echo "1. Configure .env file with your settings"
    echo "2. Run: docker-compose up -d"
    echo "3. Access API Gateway at: http://localhost:8000"
    echo "4. Access Admin Dashboard at: http://localhost:3000"
    echo ""
}

main
