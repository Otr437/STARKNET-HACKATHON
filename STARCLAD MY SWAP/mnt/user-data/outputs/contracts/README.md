# StarClad Contracts & Privacy Circuits

Complete smart contracts and zero-knowledge circuits for privacy-preserving atomic swaps.

## Contents

### Starknet Contracts (Cairo)
- **swap_contract.cairo** (372 lines) - Privacy swap with Poseidon commitments
- **btc_bridge.cairo** (244 lines) - Bitcoin SPV verification

### Noir Privacy Circuits
- **spend_proof.nr** (94 lines) - Prove note ownership & spend
- **swap_proof.nr** (170 lines) - Atomic swap with HTLC
- **merkle_tree.nr** (102 lines) - Merkle proof utilities

## Requirements

### For Starknet Contracts
```bash
# Install Scarb (Starknet build tool)
curl --proto '=https' --tlsv1.2 -sSf https://docs.swmansion.com/scarb/install.sh | sh

# Install Starkli (deployment tool)
curl https://get.starkli.sh | sh
starkliup
```

### For Noir Circuits
```bash
# Install Nargo (Noir compiler)
curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash
noirup
```

## Build

Build everything:
```bash
./build.sh
```

Build individually:
```bash
# Starknet contracts
cd starknet && scarb build

# Noir circuits
cd noir && nargo compile
```

## Deploy Starknet Contracts

```bash
# Set up environment
export STARKNET_ACCOUNT=~/.starkli-wallets/deployer/account.json
export STARKNET_KEYSTORE=~/.starkli-wallets/deployer/keystore.json
export NETWORK=testnet  # or mainnet

# Deploy
./deploy.sh
```

Contract addresses will be saved to `deployed_addresses.json`.

## Generate & Verify Proofs

### Spend Proof
```bash
cd noir
nargo prove spend_proof
nargo verify spend_proof
```

### Swap Proof
```bash
cd noir
nargo prove swap_proof
nargo verify swap_proof
```

## Contract Features

### Privacy Swap Contract
✅ Privacy notes with Poseidon commitments
✅ Nullifier registry (prevent double-spend)
✅ Merkle tree for note verification
✅ HTLC-based atomic swaps
✅ Bitcoin SPV integration
✅ Timelock refunds

### Bitcoin Bridge
✅ Block header submission
✅ SPV proof verification
✅ Transaction verification
✅ Relayer system
✅ Chain continuity checks

### Privacy Circuits
✅ Zero-knowledge spend proofs
✅ Atomic swap proofs
✅ Merkle proof verification
✅ Poseidon hashing
✅ Range checks

## Integration with Backend

Update your backend `.env`:
```bash
SWAP_CONTRACT_ADDRESS=0x...    # From deployed_addresses.json
BRIDGE_CONTRACT_ADDRESS=0x...  # From deployed_addresses.json
```

The backend automatically:
- Submits notes to contract
- Generates ZK proofs
- Verifies SPV proofs
- Executes swaps

## Testing

### Starknet Contracts
```bash
cd starknet
scarb test
```

### Noir Circuits
```bash
cd noir
nargo test
```

## Security Considerations

🔒 **Starknet Contracts**
- All state changes emit events
- Nullifiers prevent double-spending
- Timelock protection for refunds
- Relayer access control

🔒 **Noir Circuits**
- Zero-knowledge privacy
- Range checks on amounts
- Merkle proof verification
- HTLC secret verification

## Production Checklist

- [ ] Audit contracts (Starknet)
- [ ] Audit circuits (Noir)
- [ ] Test on testnet
- [ ] Generate production proofs
- [ ] Deploy to mainnet
- [ ] Verify on block explorer
- [ ] Update backend config
- [ ] Monitor events

## File Sizes

```
Starknet Contracts:  616 lines
Noir Circuits:       366 lines
Total:               982 lines
```

## License

MIT
