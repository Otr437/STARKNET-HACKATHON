# Privacy & Security Architecture

## Privacy Layer - Zero-Knowledge Proofs

### Problem
Traditional RWA contracts expose:
- ❌ Wallet addresses of all token holders
- ❌ Exact balance amounts for each user
- ❌ Transaction history tied to wallets

### Solution: Commitment-Based Privacy

Instead of storing `Map<wallet_address, balance>`, we store:
```
Map<commitment_hash, encrypted_position>
```

Where:
```
commitment = hash(wallet_address, balance, salt, timestamp)
```

**ONLY the commitment hash is stored on-chain. Wallet and balance remain private.**

## How It Works

### 1. Private Deposit

**User Side:**
```typescript
// Generate random salt
const salt = randomBytes(32);

// Create commitment
const commitment = hash(walletAddress, depositAmount, salt);

// Encrypt balance
const encryptedBalance = encrypt(depositAmount, userKey);

// Generate ZK proof (using Noir circuit)
const proof = generateProof({
  public: [commitment, encryptedBalance],
  private: [walletAddress, depositAmount, salt]
});

// Call contract
contract.deposit_private(commitment, encryptedBalance, proof);
```

**Contract Side:**
```cairo
fn deposit_private(
    commitment: felt252,
    encrypted_balance: felt252,
    proof: Array<felt252>
) {
    // Verify proof (proves user knows wallet, balance, salt)
    assert(_verify_proof(commitment, encrypted_balance, proof));
    
    // Store ONLY commitment (no wallet address)
    position_commitments.write(commitment, PositionCommitment {
        encrypted_balance,
        entry_cpi,
        ...
    });
}
```

**What's On-Chain:**
- ✅ Commitment hash: `0x1a2b3c...` (reveals nothing)
- ✅ Encrypted balance: `0x9f8e7d...` (unreadable without key)
- ✅ Entry CPI: `31412` (public, needed for inflation tracking)

**What's NOT On-Chain:**
- ❌ Wallet address
- ❌ Plaintext balance
- ❌ Transaction amounts

### 2. Private Withdrawal

**User Side:**
```typescript
// Current position
const oldCommitment = hash(wallet, oldBalance, oldSalt);

// After withdrawal
const newBalance = oldBalance - withdrawAmount;
const newSalt = randomBytes(32);
const newCommitment = hash(wallet, newBalance, newSalt);

// Nullifier (prevents double-spending old commitment)
const nullifier = hash(oldCommitment, wallet);

// Generate proof
const proof = generateProof({
  public: [oldCommitment, newCommitment, nullifier],
  private: [wallet, oldBalance, withdrawAmount, oldSalt, newSalt]
});

contract.redeem_private(
  oldCommitment,
  newCommitment,
  nullifier,
  encryptedAmount,
  proof
);
```

**Contract Side:**
```cairo
fn redeem_private(
    old_commitment: felt252,
    new_commitment: felt252,
    nullifier: felt252,
    proof: Array<felt252>
) {
    // Verify old commitment exists and is active
    assert(positions.read(old_commitment).is_active);
    
    // Verify nullifier not used (prevents double-spend)
    assert(!nullifiers.read(nullifier));
    
    // Verify ZK proof
    assert(_verify_withdraw_proof(old_commitment, new_commitment, nullifier, proof));
    
    // Mark old commitment as spent
    positions.write(old_commitment, inactive);
    nullifiers.write(nullifier, true);
    
    // Create new commitment with reduced balance
    positions.write(new_commitment, new_position);
}
```

## Noir ZK Circuits

### Circuit: `privacy/src/main.nr`

```noir
// Deposit proof
fn deposit_proof(
    pub new_commitment: Field,
    wallet_address: Field,     // PRIVATE
    deposit_amount: Field,     // PRIVATE
    salt: Field                // PRIVATE
) {
    let computed = hash(wallet_address, deposit_amount, salt);
    assert(computed == new_commitment);
}

// Withdrawal proof
fn withdraw_proof(
    pub old_commitment: Field,
    pub new_commitment: Field,
    pub nullifier: Field,
    wallet_address: Field,     // PRIVATE
    old_balance: Field,        // PRIVATE
    withdraw_amount: Field,    // PRIVATE
    old_salt: Field,           // PRIVATE
    new_salt: Field            // PRIVATE
) {
    // Prove ownership of old commitment
    let old_hash = hash(wallet_address, old_balance, old_salt);
    assert(old_hash == old_commitment);
    
    // Prove sufficient balance
    assert(old_balance >= withdraw_amount);
    
    // Prove new commitment correct
    let new_balance = old_balance - withdraw_amount;
    let new_hash = hash(wallet_address, new_balance, new_salt);
    assert(new_hash == new_commitment);
    
    // Prove nullifier correct (prevents double-spend)
    let computed_nullifier = hash(old_commitment, wallet_address);
    assert(computed_nullifier == nullifier);
}
```

## Building & Using Circuits

### Install Noir
```bash
curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash
noirup
```

### Compile Circuit
```bash
cd circuits/privacy
nargo compile
```

### Generate Proof (Client-Side)
```bash
# Create input.toml with private data
nargo prove

# Outputs: proof.proof (send to contract)
```

### Verify On-Chain
Contract verifies proof before accepting transaction.

## Security Features

### 1. Ownership & Access Control

**All contracts have:**
- ✅ `admin` address (deployer)
- ✅ `pending_admin` for 2-step transfer
- ✅ `_only_admin()` modifier for protected functions
- ✅ `transfer_admin()` - Two-step ownership transfer
- ✅ `accept_admin()` - New admin must accept

**Admin Functions:**
- Oracle: `add_publisher()`, `remove_publisher()`, `pause()`, `unpause()`
- Factory: `set_creation_fee()`, `withdraw_fees()`, `pause()`, `deactivate_rwa()`
- Token: `set_vault()` (one-time), `pause()`, `unpause()`
- Vault: `pause()`, `distribute_yield()`, `update_config()`

### 2. Pausable

**All contracts can be paused by admin:**
```cairo
fn pause(ref self: ContractState) {
    self._only_admin();
    self.is_paused.write(true);
}

fn unpause(ref self: ContractState) {
    self._only_admin();
    self.is_paused.write(false);
}
```

**Paused state blocks:**
- Deposits
- Withdrawals
- Transfers
- RWA creation

**Paused state DOES NOT block:**
- View functions
- Admin functions
- Emergency withdrawals (if implemented)

### 3. Reentrancy Protection

**Built into Cairo by default** - No external calls during state changes.

### 4. Integer Overflow Protection

**Built into Cairo** - All arithmetic operations check for overflow.

### 5. Access Control Matrix

| Function | Public | KYC User | Admin | Oracle Publisher |
|----------|--------|----------|-------|------------------|
| `deposit_private` | ✅ | ✅ | ✅ | ❌ |
| `redeem_private` | ✅ | ✅ | ✅ | ❌ |
| `create_rwa` | ❌ | ✅ | ✅ | ❌ |
| `publish_data` | ❌ | ❌ | ❌ | ✅ |
| `pause` | ❌ | ❌ | ✅ | ❌ |
| `withdraw_fees` | ❌ | ❌ | ✅ | ❌ |

### 6. Rate Limiting (Future Enhancement)

Can be added via:
```cairo
last_action: Map<felt252, u64>,  // commitment -> last action time
min_action_interval: u64 = 3600, // 1 hour

assert(now - last_action >= min_action_interval);
```

### 7. Supply Cap Enforcement

```cairo
assert(total_tokens_issued + new_tokens <= supply_cap);
```

### 8. Audit Trail

**All events logged:**
- `PrivateDeposit` - commitment, encrypted amount, timestamp
- `PrivateRedeem` - old/new commitment, nullifier, timestamp
- `AdminTransferred` - old admin, new admin
- `ContractPaused` / `ContractUnpaused`

## Privacy Guarantees

### What's Private:
✅ Wallet addresses (never stored on-chain)
✅ Balance amounts (stored encrypted)
✅ Transaction amounts (encrypted)
✅ User identity (commitment-based)

### What's Public:
❌ Total supply (aggregate only)
❌ Number of active positions (count only)
❌ CPI reference values (needed for inflation tracking)
❌ Commitment hashes (reveal nothing without private keys)

### What's Semi-Private:
⚠️ Timing information (transaction timestamps visible)
⚠️ Pattern analysis (deposit/withdraw frequency visible)

**Mitigation:** Use mixers or batch transactions for additional privacy.

## Deployment Checklist

- [ ] Admin keys stored in secure vault (not .env)
- [ ] Multi-sig for admin functions
- [ ] Time-lock on critical admin functions
- [ ] Pausable enabled
- [ ] Supply caps set correctly
- [ ] Fee collection working
- [ ] ZK proof verification tested
- [ ] Nullifier registry working
- [ ] Event logging verified
- [ ] Access control tested

## Emergency Procedures

### 1. Contract Compromised
```bash
# Pause all contracts
contract.pause()  # Stops all user operations

# Admin can still:
# - Transfer ownership
# - Withdraw fees
# - View state
```

### 2. Oracle Compromised
```bash
# Remove compromised publisher
oracle.remove_publisher(compromised_address)

# Add new publisher
oracle.add_publisher(new_trusted_address)

# Pause oracle
oracle.pause()
```

### 3. Lost Admin Keys
```bash
# Use pending_admin transfer mechanism
# 1. Call transfer_admin(new_address) with old admin
# 2. Call accept_admin() with new admin

# If old admin lost:
# - Deploy new contracts
# - Migrate user commitments off-chain
# - Users re-deposit with new contracts
```

## Upgradeability

**Contracts are NOT upgradeable by design** for security.

**Migration path:**
1. Deploy new contract versions
2. Pause old contracts
3. Users migrate positions off-chain (using ZK proofs)
4. Re-deposit in new contracts

## Compliance

### KYC/AML Integration
- Commitment creation requires KYC check off-chain
- Relayer verifies KYC before submitting proof
- Contract stores KYC attestation hash (not identity)

### Regulatory Reporting
- Admin can query total TVL
- Cannot query individual balances (by design)
- Users can export their own data using private keys

---

**Privacy + Security + Compliance = Complete RWA Platform**
