#!/bin/bash
# Compile Circom Circuits - February 2026
# Production build script for all zero-knowledge circuits

set -e

echo "====================================="
echo "CIRCOM CIRCUIT COMPILATION"
echo "====================================="

# Check circom is installed
if ! command -v circom &> /dev/null; then
    echo "Error: circom not found. Install from: https://docs.circom.io/getting-started/installation/"
    exit 1
fi

# Check snarkjs is installed
if ! command -v snarkjs &> /dev/null; then
    echo "Error: snarkjs not found. Install: npm install -g snarkjs"
    exit 1
fi

# Create build directories
mkdir -p build/semaphore
mkdir -p build/tongo_range
mkdir -p build/tongo_poe
mkdir -p powers_of_tau

echo ""
echo "[1/4] Setting up Powers of Tau ceremony..."
echo ""

# Check if powers of tau exists
if [ ! -f "powers_of_tau/pot20_final.ptau" ]; then
    echo "Generating Powers of Tau (this may take a while)..."
    
    # Start ceremony for 2^20 constraints
    snarkjs powersoftau new bn128 20 powers_of_tau/pot20_0000.ptau -v
    
    # Contribute to ceremony
    echo "random entropy for powers of tau" | snarkjs powersoftau contribute \
        powers_of_tau/pot20_0000.ptau \
        powers_of_tau/pot20_0001.ptau \
        --name="First contribution" -v
    
    # Prepare phase 2
    snarkjs powersoftau prepare phase2 \
        powers_of_tau/pot20_0001.ptau \
        powers_of_tau/pot20_final.ptau -v
    
    echo "Powers of Tau ceremony complete!"
else
    echo "Using existing Powers of Tau file"
fi

echo ""
echo "[2/4] Compiling Semaphore circuit..."
echo ""

# Compile Semaphore circuit
circom circuits/semaphore.circom \
    --r1cs \
    --wasm \
    --sym \
    --c \
    -o build/semaphore

echo "Semaphore circuit compiled:"
echo "  - R1CS: build/semaphore/semaphore.r1cs"
echo "  - WASM: build/semaphore/semaphore_js/semaphore.wasm"

# Generate proving and verification keys for Semaphore
echo "Generating Semaphore keys..."

snarkjs groth16 setup \
    build/semaphore/semaphore.r1cs \
    powers_of_tau/pot20_final.ptau \
    build/semaphore/semaphore_0000.zkey

echo "semaphore key contribution entropy" | snarkjs zkey contribute \
    build/semaphore/semaphore_0000.zkey \
    build/semaphore/semaphore_final.zkey \
    --name="Semaphore contribution" -v

# Export verification key
snarkjs zkey export verificationkey \
    build/semaphore/semaphore_final.zkey \
    build/semaphore/verification_key.json

# Export Solidity/Cairo verifier
snarkjs zkey export solidityverifier \
    build/semaphore/semaphore_final.zkey \
    build/semaphore/verifier.sol

echo "Semaphore keys generated!"

echo ""
echo "[3/4] Compiling Tongo Range Proof circuit..."
echo ""

# Compile Tongo Range Proof
circom circuits/tongo_range_proof.circom \
    --r1cs \
    --wasm \
    --sym \
    -o build/tongo_range

echo "Tongo Range Proof circuit compiled"

# Generate keys
snarkjs groth16 setup \
    build/tongo_range/tongo_range_proof.r1cs \
    powers_of_tau/pot20_final.ptau \
    build/tongo_range/tongo_range_0000.zkey

echo "tongo range key entropy" | snarkjs zkey contribute \
    build/tongo_range/tongo_range_0000.zkey \
    build/tongo_range/tongo_range_final.zkey \
    --name="Range proof contribution" -v

snarkjs zkey export verificationkey \
    build/tongo_range/tongo_range_final.zkey \
    build/tongo_range/verification_key.json

echo "Tongo Range Proof keys generated!"

echo ""
echo "[4/4] Compiling Tongo POE circuit..."
echo ""

# Compile Tongo POE
circom circuits/tongo_poe.circom \
    --r1cs \
    --wasm \
    --sym \
    -o build/tongo_poe

echo "Tongo POE circuit compiled"

# Generate keys
snarkjs groth16 setup \
    build/tongo_poe/tongo_poe.r1cs \
    powers_of_tau/pot20_final.ptau \
    build/tongo_poe/tongo_poe_0000.zkey

echo "tongo poe key entropy" | snarkjs zkey contribute \
    build/tongo_poe/tongo_poe_0000.zkey \
    build/tongo_poe/tongo_poe_final.zkey \
    --name="POE contribution" -v

snarkjs zkey export verificationkey \
    build/tongo_poe/tongo_poe_final.zkey \
    build/tongo_poe/verification_key.json

echo "Tongo POE keys generated!"

echo ""
echo "====================================="
echo "COMPILATION COMPLETE!"
echo "====================================="
echo ""
echo "Circuit Info:"
echo "  Semaphore: build/semaphore/"
echo "  Tongo Range: build/tongo_range/"
echo "  Tongo POE: build/tongo_poe/"
echo ""
echo "To generate proofs, use the test scripts."
echo ""

# Print circuit statistics
echo "Circuit Statistics:"
echo ""

for circuit in semaphore tongo_range_proof tongo_poe; do
    if [ "$circuit" = "tongo_range_proof" ]; then
        dir="tongo_range"
    elif [ "$circuit" = "tongo_poe" ]; then
        dir="tongo_poe"
    else
        dir="$circuit"
    fi
    
    if [ -f "build/$dir/$circuit.r1cs" ]; then
        echo "  $circuit:"
        snarkjs r1cs info "build/$dir/$circuit.r1cs" | grep -E "Constraints|Private|Public|Labels"
        echo ""
    fi
done

echo "Build complete! All circuits ready for production use."
