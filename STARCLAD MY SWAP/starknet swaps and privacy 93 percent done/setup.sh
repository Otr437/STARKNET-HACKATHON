#!/bin/bash

# Starknet Production System - Quick Setup Script
# This script helps you get started quickly

set -e

echo "🚀 Starknet Production System Setup"
echo "===================================="
echo ""

# Check if running as root
if [ "$EUID" -eq 0 ]; then 
    echo "⚠️  Please do not run this script as root"
    exit 1
fi

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Check prerequisites
echo "📋 Checking prerequisites..."
echo ""

MISSING_DEPS=()

if ! command_exists node; then
    MISSING_DEPS+=("Node.js 18+")
fi

if ! command_exists npm; then
    MISSING_DEPS+=("npm")
fi

if ! command_exists docker; then
    MISSING_DEPS+=("Docker")
fi

if ! command_exists docker-compose; then
    MISSING_DEPS+=("Docker Compose")
fi

if ! command_exists scarb; then
    MISSING_DEPS+=("Scarb (Cairo package manager)")
fi

if [ ${#MISSING_DEPS[@]} -ne 0 ]; then
    echo "❌ Missing dependencies:"
    for dep in "${MISSING_DEPS[@]}"; do
        echo "   - $dep"
    done
    echo ""
    echo "Please install missing dependencies and run this script again."
    echo "Visit: https://docs.starknet.io/documentation/getting_started/"
    exit 1
fi

echo "✅ All prerequisites satisfied"
echo ""

# Setup mode selection
echo "Choose setup mode:"
echo "1) Docker (Recommended - Easiest)"
echo "2) Manual Setup (Full control)"
echo "3) Development Mode (With hot reload)"
read -p "Enter choice (1-3): " SETUP_MODE

case $SETUP_MODE in
    1)
        echo ""
        echo "🐳 Setting up with Docker..."
        
        # Check if .env exists
        if [ ! -f backend/.env ]; then
            echo "Creating .env from template..."
            cp backend/.env.example backend/.env
            echo "⚠️  Please edit backend/.env with your configuration"
            read -p "Press Enter after editing .env file..."
        fi
        
        # Build and start containers
        echo "Building Docker images..."
        docker-compose build
        
        echo "Starting services..."
        docker-compose up -d
        
        echo ""
        echo "✅ Docker setup complete!"
        echo ""
        echo "Services running:"
        docker-compose ps
        echo ""
        echo "Access your services:"
        echo "- API: http://localhost:3000"
        echo "- Health: http://localhost:3000/health"
        echo ""
        echo "View logs: docker-compose logs -f"
        ;;
        
    2)
        echo ""
        echo "🔧 Manual setup..."
        
        # Setup contracts
        echo "Setting up contracts..."
        cd contracts
        if [ ! -f Scarb.toml ]; then
            echo "❌ Scarb.toml not found"
            exit 1
        fi
        scarb build
        cd ..
        
        # Setup backend
        echo "Setting up backend..."
        cd backend
        if [ ! -f .env ]; then
            cp .env.example .env
            echo "⚠️  Please edit backend/.env with your configuration"
            read -p "Press Enter after editing .env file..."
        fi
        
        npm install
        
        echo ""
        echo "✅ Manual setup complete!"
        echo ""
        echo "Next steps:"
        echo "1. Deploy contracts: cd deployment && ./deploy.sh sepolia"
        echo "2. Start backend: cd backend && npm start"
        ;;
        
    3)
        echo ""
        echo "👨‍💻 Development mode setup..."
        
        # Setup contracts
        cd contracts
        scarb build
        cd ..
        
        # Setup backend
        cd backend
        if [ ! -f .env ]; then
            cp .env.example .env
        fi
        npm install
        npm install -D nodemon
        
        echo ""
        echo "✅ Development setup complete!"
        echo ""
        echo "Start development server: cd backend && npm run dev"
        ;;
        
    *)
        echo "Invalid choice"
        exit 1
        ;;
esac

echo ""
echo "📚 Documentation available at: docs/DEPLOYMENT_GUIDE.md"
echo "🆘 Need help? Check docs/TROUBLESHOOTING.md"
echo ""
echo "🎉 Setup complete! Happy building!"
