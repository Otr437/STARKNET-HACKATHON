// ============================================================
//  RWAVault.cairo
//  Starknet RWA Factory — Asset Vault
//
//  Each RWA token has exactly one vault. The vault:
//    1. Accepts USDC/STRK deposits, mints RWA tokens at current NAV
//    2. Tracks per-user position with CPI snapshot at entry
//    3. Accrues yield based on oracle yield rate + time elapsed
//    4. On redemption: returns inflation-adjusted principal + yield
//    5. Exposes real-time inflation P&L per position
//
//  Yield formula (continuous approximation):
//    accrued = principal * rate_bps/10000 * seconds_elapsed/31536000
//
//  Inflation-adjusted redemption:
//    return = principal * (current_cpi / entry_cpi) + accrued_yield
// ============================================================

#[starknet::contract]
mod RWAVault {
    use starknet::{
        ContractAddress, get_caller_address, get_block_timestamp,
        storage::{Map, StorageMapReadAccess, StorageMapWriteAccess},
    };
    use core::array::ArrayTrait;
    use core::integer::{u256_from_felt252};

    use super::super::interfaces::{
        IRWAVault, VaultPosition,
        IInflationOracleDispatcher, IInflationOracleDispatcherTrait,
        IRWATokenDispatcher, IRWATokenDispatcherTrait,
        IERC20Dispatcher, IERC20DispatcherTrait,
    };

    // -------------------------------------------------------
    //  Constants
    // -------------------------------------------------------
    const SECONDS_PER_YEAR: u128 = 31_536_000;
    const BPS_DENOM: u128        = 10_000;
    const PRECISION: u128        = 1_000_000; // 1e6 intermediate precision

    // -------------------------------------------------------
    //  Storage - PRIVACY PRESERVING
    //  NO wallet addresses stored, only commitments
    // -------------------------------------------------------
    #[storage]
    struct Storage {
        // Identity
        rwa_id: u64,
        factory_address: ContractAddress,
        oracle_address: ContractAddress,
        token_address: ContractAddress,
        payment_token: ContractAddress,   // USDC or STRK
        base_cpi: u128,                   // CPI when vault was deployed

        // Config from factory
        yield_basis_points: u16,          // annual yield rate
        par_value: u128,                  // par value in USD cents
        inflation_indexed: bool,

        // Vault state (aggregated, no privacy concerns)
        total_deposited_usd: u128,        // running sum of deposits in USD cents
        total_tokens_issued: u256,
        deposit_count: u64,
        is_paused: bool,

        // Yield pool — funded by off-chain issuer transfers
        yield_pool: u128,                 // total yield available to distribute (USD cents)
        yield_per_token_stored: u128,     // cumulative yield per token (scaled 1e18)
        last_yield_update: u64,

        // PRIVACY: Position commitments (NOT wallet addresses)
        // commitment = hash(wallet_address, balance, salt, timestamp)
        // commitment -> position data (encrypted amounts)
        position_commitments: Map<felt252, PositionCommitment>,
        
        // Nullifier registry - prevents double-spending
        nullifiers: Map<felt252, bool>,
        
        // Total active commitments (for iteration if needed)
        commitment_count: u64,
    }

    // Position data stored by commitment hash (NOT by wallet address)
    #[derive(Drop, Serde, starknet::Store)]
    struct PositionCommitment {
        encrypted_balance: felt252,        // Encrypted token balance
        encrypted_usd_value: felt252,      // Encrypted USD value
        entry_cpi: u128,                   // CPI at entry (can be public)
        entry_time: u64,                   // Entry timestamp (can be public)
        yield_debt: felt252,               // Encrypted yield debt
        yield_claimed: felt252,            // Encrypted total claimed
        last_action: u64,                  // Last action timestamp
        is_active: bool,                   // Position active flag
    }

    // -------------------------------------------------------
    //  Events - PRIVACY PRESERVING (no wallet addresses)
    // -------------------------------------------------------
    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        Deposited: Deposited,
        Redeemed: Redeemed,
        YieldClaimed: YieldClaimed,
        YieldDistributed: YieldDistributed,
        VaultPaused: VaultPaused,
        VaultUnpaused: VaultUnpaused,
        PrivateDeposit: PrivateDeposit,
        PrivateRedeem: PrivateRedeem,
    }

    // Legacy public events (for backwards compatibility)
    #[derive(Drop, starknet::Event)]
    struct Deposited {
        #[key]
        user: ContractAddress,
        usd_amount: u256,
        tokens_minted: u256,
        cpi_at_entry: u128,
        nav_per_token: u128,
    }

    // PRIVATE events - Only commitment hash, no wallet or amount
    #[derive(Drop, starknet::Event)]
    struct PrivateDeposit {
        #[key]
        commitment: felt252,           // hash(wallet, balance, salt) - NO wallet exposed
        encrypted_balance: felt252,    // Encrypted amount - NO plaintext amount
        entry_cpi: u128,               // CPI reference (can be public)
        timestamp: u64,
    }
    
    #[derive(Drop, starknet::Event)]
    struct PrivateRedeem {
        #[key]
        old_commitment: felt252,       // Commitment being spent
        new_commitment: felt252,       // New commitment (remaining balance)
        nullifier: felt252,            // Prevents double-spend
        timestamp: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct Redeemed {
        #[key]
        user: ContractAddress,
        tokens_burned: u256,
        usd_returned: u256,
        inflation_adjustment_bps: u128,  // how much inflation benefit (bps above par)
        yield_included: u128,
    }

    #[derive(Drop, starknet::Event)]
    struct YieldClaimed {
        #[key]
        user: ContractAddress,
        amount_usd: u128,
    }

    #[derive(Drop, starknet::Event)]
    struct YieldDistributed {
        amount_usd: u128,
        new_yield_per_token: u128,
    }

    #[derive(Drop, starknet::Event)]
    struct VaultPaused { by: ContractAddress }
    #[derive(Drop, starknet::Event)]
    struct VaultUnpaused { by: ContractAddress }

    // -------------------------------------------------------
    //  Constructor
    // -------------------------------------------------------
    #[constructor]
    fn constructor(
        ref self: ContractState,
        rwa_id: u64,
        factory_address: ContractAddress,
        oracle_address: ContractAddress,
        token_address: ContractAddress,
        payment_token: ContractAddress,
        base_cpi: u128,
    ) {
        self.rwa_id.write(rwa_id);
        self.factory_address.write(factory_address);
        self.oracle_address.write(oracle_address);
        self.token_address.write(token_address);
        self.payment_token.write(payment_token);
        self.base_cpi.write(base_cpi);
        self.is_paused.write(false);
        self.total_deposited_usd.write(0);
        self.total_tokens_issued.write(0_u256);
        self.deposit_count.write(0);
        self.yield_pool.write(0);
        self.yield_per_token_stored.write(0);
        self.last_yield_update.write(get_block_timestamp());
    }

    // -------------------------------------------------------
    //  Implementation
    // -------------------------------------------------------
    #[abi(embed_v0)]
    impl RWAVaultImpl of IRWAVault<ContractState> {

        fn get_rwa_id(self: @ContractState) -> u64 {
            self.rwa_id.read()
        }

        fn get_token_address(self: @ContractState) -> ContractAddress {
            self.token_address.read()
        }

        fn get_oracle_address(self: @ContractState) -> ContractAddress {
            self.oracle_address.read()
        }

        fn get_total_value_locked(self: @ContractState) -> u256 {
            // TVL = total_deposited * inflation_adjustment_factor
            let total = self.total_deposited_usd.read();
            let adjusted = self._inflation_adjusted_value(total);
            adjusted.into()
        }

        fn get_nav_per_token(self: @ContractState) -> u128 {
            self._current_nav()
        }

        fn get_user_position(self: @ContractState, user: ContractAddress) -> VaultPosition {
            VaultPosition {
                token_balance: self.user_token_balance.read(user),
                deposit_usd_value: self.user_deposit_usd.read(user),
                deposit_cpi_at_entry: self.user_entry_cpi.read(user),
                yield_debt: self.user_yield_debt.read(user),
                last_updated: self.user_last_action.read(user),
                total_yield_claimed: self.user_yield_claimed.read(user),
            }
        }

        fn get_pending_yield(self: @ContractState, user: ContractAddress) -> u128 {
            self._pending_yield(user)
        }

        fn get_inflation_pnl(self: @ContractState, user: ContractAddress) -> i128 {
            let entry_cpi = self.user_entry_cpi.read(user);
            if entry_cpi == 0 { return 0_i128; }

            let oracle = IInflationOracleDispatcher {
                contract_address: self.oracle_address.read()
            };
            let current_cpi = oracle.get_cpi().value;
            let deposit = self.user_deposit_usd.read(user);

            // inflation_pnl = deposit * (current_cpi - entry_cpi) / entry_cpi
            if current_cpi >= entry_cpi {
                let gain = (deposit.low * (current_cpi - entry_cpi)) / entry_cpi;
                gain.try_into().unwrap_or(0_i128)
            } else {
                let loss = (deposit.low * (entry_cpi - current_cpi)) / entry_cpi;
                -(loss.try_into().unwrap_or(0_i128))
            }
        }

        fn get_payment_token(self: @ContractState) -> ContractAddress {
            self.payment_token.read()
        }

        fn get_base_cpi(self: @ContractState) -> u128 {
            self.base_cpi.read()
        }

        fn get_deposit_count(self: @ContractState) -> u64 {
            self.deposit_count.read()
        }

        // -------------------------------------------------------
        //  deposit_private — PRIVACY PRESERVING deposit
        //
        //  User provides:
        //  - ZK proof that commitment = hash(wallet, balance, salt)
        //  - Encrypted balance
        //  - Payment transferred off-chain or via relayer
        //  
        //  NO wallet address or balance stored on-chain
        // -------------------------------------------------------
        fn deposit_private(
            ref self: ContractState,
            commitment: felt252,           // hash(wallet, balance, salt)
            encrypted_balance: felt252,    // encrypted token amount
            encrypted_usd_value: felt252,  // encrypted USD value
            proof: Array<felt252>,         // ZK proof from Noir circuit
        ) {
            assert!(!self.is_paused.read(), "Vault: paused");
            
            // Verify ZK proof (proves user knows wallet, balance, salt for this commitment)
            assert!(self._verify_deposit_proof(commitment, encrypted_balance, proof), "Invalid proof");
            
            let now = get_block_timestamp();
            
            // Get current CPI for inflation tracking
            let oracle = IInflationOracleDispatcher {
                contract_address: self.oracle_address.read()
            };
            let entry_cpi = oracle.get_cpi().value;

            // Store position by commitment (NOT by wallet address)
            let position = PositionCommitment {
                encrypted_balance: encrypted_balance,
                encrypted_usd_value: encrypted_usd_value,
                entry_cpi: entry_cpi,
                entry_time: now,
                yield_debt: 0, // Will be encrypted in production
                yield_claimed: 0,
                last_action: now,
                is_active: true,
            };
            
            self.position_commitments.write(commitment, position);
            
            // Increment commitment count
            let count = self.commitment_count.read();
            self.commitment_count.write(count + 1);
            
            // Emit event with commitment (NO wallet address exposed)
            self.emit(PrivateDeposit {
                commitment: commitment,
                encrypted_balance: encrypted_balance,
                entry_cpi: entry_cpi,
                timestamp: now,
            });
        }

        // -------------------------------------------------------
        //  redeem_private — PRIVACY PRESERVING withdrawal
        //
        //  User provides:
        //  - Old commitment (current position)
        //  - New commitment (remaining balance after withdrawal)
        //  - Nullifier (prevents double-spend of old commitment)
        //  - ZK proof
        // -------------------------------------------------------
        fn redeem_private(
            ref self: ContractState,
            old_commitment: felt252,         // Current position commitment
            new_commitment: felt252,         // New commitment after withdrawal  
            nullifier: felt252,              // Prevents reusing old_commitment
            encrypted_withdraw_amount: felt252,
            proof: Array<felt252>,
        ) {
            assert!(!self.is_paused.read(), "Vault: paused");
            
            // Check commitment exists and is active
            let old_position = self.position_commitments.read(old_commitment);
            assert!(old_position.is_active, "Position inactive");
            
            // Check nullifier not used (prevents double-spend)
            assert!(!self.nullifiers.read(nullifier), "Nullifier already used");
            
            // Verify ZK proof (proves ownership and sufficient balance)
            assert!(
                self._verify_withdraw_proof(
                    old_commitment,
                    new_commitment,
                    nullifier,
                    encrypted_withdraw_amount,
                    proof
                ),
                "Invalid withdrawal proof"
            );
            
            let now = get_block_timestamp();
            
            // Mark old commitment as inactive
            let mut updated_old = old_position;
            updated_old.is_active = false;
            self.position_commitments.write(old_commitment, updated_old);
            
            // Store nullifier to prevent reuse
            self.nullifiers.write(nullifier, true);
            
            // Create new position with reduced balance
            // (encrypted balance computed off-chain by user)
            let new_position = PositionCommitment {
                encrypted_balance: old_position.encrypted_balance, // Will be updated off-chain
                encrypted_usd_value: old_position.encrypted_usd_value,
                entry_cpi: old_position.entry_cpi,
                entry_time: old_position.entry_time,
                yield_debt: old_position.yield_debt,
                yield_claimed: old_position.yield_claimed,
                last_action: now,
                is_active: true,
            };
            
            self.position_commitments.write(new_commitment, new_position);
            
            // Emit event (NO wallet or amount exposed)
            self.emit(PrivateRedeem {
                old_commitment: old_commitment,
                new_commitment: new_commitment,
                nullifier: nullifier,
                timestamp: now,
            });
        }

        // -------------------------------------------------------
        //  Verify ZK proofs (placeholder - requires Starknet verify_proof)
        // -------------------------------------------------------
        fn _verify_deposit_proof(
            self: @ContractState,
            commitment: felt252,
            encrypted_balance: felt252,
            proof: Array<felt252>,
        ) -> bool {
            // TODO: Integrate Starknet ZK proof verification
            // For now: always return true (INSECURE - for development only)
            // Production: verify Noir proof on-chain
            true
        }
        
        fn _verify_withdraw_proof(
            self: @ContractState,
            old_commitment: felt252,
            new_commitment: felt252,
            nullifier: felt252,
            encrypted_amount: felt252,
            proof: Array<felt252>,
        ) -> bool {
            // TODO: Integrate Starknet ZK proof verification
            true
        }

            // Snapshot oracle CPI at time of entry
            let oracle = IInflationOracleDispatcher {
                contract_address: self.oracle_address.read()
            };
            let entry_cpi = oracle.get_cpi().value;

            // Transfer payment token from user to vault
            let payment_token = IERC20Dispatcher { 
                contract_address: self.payment_token.read() 
            };
            let success = payment_token.transfer_from(caller, get_contract_address(), usd_amount);
            assert!(success, "Vault: payment transfer failed");

            // Update user position
            let prev_balance = self.user_token_balance.read(caller);
            let prev_deposit = self.user_deposit_usd.read(caller);

            // Weighted average CPI for existing + new position
            let new_balance = prev_balance + tokens_18dec;
            let new_deposit = prev_deposit + amount_cents;

            // Settle pending yield before updating balance
            let pending = self._pending_yield(caller);
            if pending > 0 {
                let claimed = self.user_yield_claimed.read(caller);
                self.user_yield_claimed.write(caller, claimed + pending);
            }

            self.user_token_balance.write(caller, new_balance);
            self.user_deposit_usd.write(caller, new_deposit);

            // CPI tracking: simple overwrite (new entry takes current CPI for simplicity)
            // Production: weighted average based on position size
            if prev_balance == 0_u256 {
                self.user_entry_cpi.write(caller, entry_cpi);
                self.user_entry_time.write(caller, now);
            }

            // Update yield debt to current index (prevents double-claiming)
            let yield_index = self.yield_per_token_stored.read();
            let new_debt = (new_balance.low * yield_index) / 1_000_000_000_000_000_000_u128;
            self.user_yield_debt.write(caller, new_debt);
            self.user_last_action.write(caller, now);

            // Update vault totals
            let total_dep = self.total_deposited_usd.read();
            self.total_deposited_usd.write(total_dep + amount_cents.low);
            let total_tok = self.total_tokens_issued.read();
            self.total_tokens_issued.write(total_tok + tokens_18dec);

            let count = self.deposit_count.read();
            self.deposit_count.write(count + 1);

            // Mint tokens via RWAToken contract
            let token = IRWATokenDispatcher { contract_address: self.token_address.read() };
            token.mint(caller, tokens_18dec);

            self.emit(Deposited {
                user: caller,
                usd_amount,
                tokens_minted: tokens_18dec,
                cpi_at_entry: entry_cpi,
                nav_per_token: nav,
            });

            tokens_18dec
        }

        // -------------------------------------------------------
        //  redeem — burns tokens, returns inflation-adjusted USD
        // -------------------------------------------------------
        fn redeem(ref self: ContractState, token_amount: u256) -> u256 {
            assert!(!self.is_paused.read(), "Vault: paused");
            assert!(token_amount > 0_u256, "Vault: zero amount");

            let caller = get_caller_address();
            let user_balance = self.user_token_balance.read(caller);
            assert!(user_balance >= token_amount, "Vault: insufficient balance");

            self._update_yield_index();

            let oracle = IInflationOracleDispatcher {
                contract_address: self.oracle_address.read()
            };
            let current_cpi = oracle.get_cpi().value;
            let entry_cpi = self.user_entry_cpi.read(caller);

            // Calculate proportion being redeemed
            let total_user_deposit = self.user_deposit_usd.read(caller);
            let proportion = (token_amount * 1_000_000_u256) / user_balance; // scaled 1e6
            let proportional_deposit = (total_user_deposit * proportion) / 1_000_000_u256;

            // Inflation-adjusted return
            let return_usd_cents: u256 = if self.inflation_indexed.read() && entry_cpi > 0 {
                (proportional_deposit * current_cpi.into()) / entry_cpi.into()
            } else {
                proportional_deposit
            };

            let inflation_adj_bps: u128 = if entry_cpi > 0 && current_cpi > entry_cpi {
                ((current_cpi - entry_cpi) * BPS_DENOM) / entry_cpi
            } else {
                0
            };

            // Collect pending yield
            let pending_yield = self._pending_yield(caller);
            let yield_usd = pending_yield.into();

            // Update user state
            let new_balance = user_balance - token_amount;
            self.user_token_balance.write(caller, new_balance);

            let deposit_reduction = if new_balance == 0_u256 {
                total_user_deposit
            } else {
                proportional_deposit
            };
            let remaining_deposit = if total_user_deposit > deposit_reduction {
                total_user_deposit - deposit_reduction
            } else {
                0_u256
            };
            self.user_deposit_usd.write(caller, remaining_deposit);

            // Clear yield debt proportionally
            let yield_debt = self.user_yield_debt.read(caller);
            let debt_reduction = (yield_debt.into() * proportion) / 1_000_000_u256;
            let new_debt: u128 = if yield_debt.into() > debt_reduction {
                (yield_debt.into() - debt_reduction).try_into().unwrap_or(0)
            } else { 0 };
            self.user_yield_debt.write(caller, new_debt);

            if new_balance == 0_u256 {
                self.user_entry_cpi.write(caller, 0);
                self.user_entry_time.write(caller, 0);
            }

            let claimed = self.user_yield_claimed.read(caller);
            self.user_yield_claimed.write(caller, claimed + pending_yield);
            self.user_last_action.write(caller, get_block_timestamp());

            // Burn tokens
            let token = IRWATokenDispatcher { contract_address: self.token_address.read() };
            token.burn(caller, token_amount);

            // Update vault totals
            let total_tok = self.total_tokens_issued.read();
            let new_total = if total_tok > token_amount { total_tok - token_amount } else { 0_u256 };
            self.total_tokens_issued.write(new_total);

            let total_dep = self.total_deposited_usd.read();
            let dep_reduction = deposit_reduction.low;
            let new_dep = if total_dep > dep_reduction { total_dep - dep_reduction } else { 0 };
            self.total_deposited_usd.write(new_dep);

            let total_return = return_usd_cents + yield_usd;

            // Transfer payment token back to user
            let payment_token = IERC20Dispatcher { 
                contract_address: self.payment_token.read() 
            };
            let return_amount_6dec = total_return * 10000_u256;
            let success = payment_token.transfer(caller, return_amount_6dec);
            assert!(success, "Vault: payment transfer failed");

            self.emit(Redeemed {
                user: caller,
                tokens_burned: token_amount,
                usd_returned: total_return,
                inflation_adjustment_bps: inflation_adj_bps,
                yield_included: pending_yield,
            });

            total_return * 10000_u256  // return in USDC 6dec units
        }

        // -------------------------------------------------------
        //  claim_yield — extract accrued yield without redeeming
        // -------------------------------------------------------
        fn claim_yield(ref self: ContractState) -> u128 {
            assert!(!self.is_paused.read(), "Vault: paused");
            let caller = get_caller_address();
            self._update_yield_index();

            let pending = self._pending_yield(caller);
            assert!(pending > 0, "Vault: no yield to claim");

            // Update accounting
            let yield_index = self.yield_per_token_stored.read();
            let balance = self.user_token_balance.read(caller);
            let new_debt = (balance.low * yield_index) / 1_000_000_000_000_000_000_u128;
            self.user_yield_debt.write(caller, new_debt);

            let claimed = self.user_yield_claimed.read(caller);
            self.user_yield_claimed.write(caller, claimed + pending);
            self.user_last_action.write(caller, get_block_timestamp());

            // Deduct from yield pool
            let pool = self.yield_pool.read();
            let new_pool = if pool >= pending { pool - pending } else { 0 };
            self.yield_pool.write(new_pool);

            // Transfer yield payment to user
            let payment_token = IERC20Dispatcher { 
                contract_address: self.payment_token.read() 
            };
            let yield_amount_6dec = pending.into() * 10000_u256;
            let success = payment_token.transfer(caller, yield_amount_6dec);
            assert!(success, "Vault: yield payment failed");

            self.emit(YieldClaimed { user: caller, amount_usd: pending });

            pending
        }

        // -------------------------------------------------------
        //  compound_yield — reinvests pending yield into more tokens
        // -------------------------------------------------------
        fn compound_yield(ref self: ContractState) {
            assert!(!self.is_paused.read(), "Vault: paused");
            let caller = get_caller_address();
            self._update_yield_index();

            let pending = self._pending_yield(caller);
            assert!(pending > 0, "Vault: no yield to compound");

            // Clear yield
            let yield_index = self.yield_per_token_stored.read();
            let balance = self.user_token_balance.read(caller);
            let new_debt = (balance.low * yield_index) / 1_000_000_000_000_000_000_u128;
            self.user_yield_debt.write(caller, new_debt);

            let claimed = self.user_yield_claimed.read(caller);
            self.user_yield_claimed.write(caller, claimed + pending);

            // Mint new tokens for yield amount
            let nav = self._current_nav();
            if nav > 0 {
                let new_tokens = (pending.into() * 1_000_000_000_000_000_000_u256) / nav.into();
                if new_tokens > 0_u256 {
                    let new_balance = balance + new_tokens;
                    self.user_token_balance.write(caller, new_balance);
                    let total_tok = self.total_tokens_issued.read();
                    self.total_tokens_issued.write(total_tok + new_tokens);

                    let token = IRWATokenDispatcher { contract_address: self.token_address.read() };
                    token.mint(caller, new_tokens);
                }
            }

            self.user_last_action.write(caller, get_block_timestamp());
        }

        fn emergency_pause(ref self: ContractState) {
            assert!(
                get_caller_address() == self.factory_address.read(),
                "Vault: only factory"
            );
            self.is_paused.write(true);
            self.emit(VaultPaused { by: get_caller_address() });
        }

        fn unpause(ref self: ContractState) {
            assert!(
                get_caller_address() == self.factory_address.read(),
                "Vault: only factory"
            );
            self.is_paused.write(false);
            self.emit(VaultUnpaused { by: get_caller_address() });
        }

        fn update_nav(ref self: ContractState) {
            // Permissionless NAV refresh — reads oracle and updates yield index
            self._update_yield_index();
        }

        // -------------------------------------------------------
        //  distribute_yield — called by issuer/admin to fund yield pool
        //  amount in USD cents
        // -------------------------------------------------------
        fn distribute_yield(ref self: ContractState, amount: u128) {
            assert!(
                get_caller_address() == self.factory_address.read(),
                "Vault: only factory"
            );
            assert!(amount > 0, "Vault: zero yield");

            let total_tokens = self.total_tokens_issued.read();
            if total_tokens == 0_u256 { return; }

            // Update global yield-per-token index
            // yield_per_token_stored += amount * 1e18 / total_tokens
            let delta = (amount.into() * 1_000_000_000_000_000_000_u256) / total_tokens;
            let current_index = self.yield_per_token_stored.read();
            let new_index = current_index + delta.try_into().unwrap_or(0_u128);
            self.yield_per_token_stored.write(new_index);

            // Add to pool
            let pool = self.yield_pool.read();
            self.yield_pool.write(pool + amount);

            self.emit(YieldDistributed {
                amount_usd: amount,
                new_yield_per_token: new_index,
            });
        }
    }

    // -------------------------------------------------------
    //  Internal helpers
    // -------------------------------------------------------
    #[generate_trait]
    impl InternalImpl of InternalTrait {

        fn _current_nav(self: @ContractState) -> u128 {
            let par = self.par_value.read();
            if !self.inflation_indexed.read() { return par; }

            let oracle = IInflationOracleDispatcher {
                contract_address: self.oracle_address.read()
            };
            let current_cpi = oracle.get_cpi().value;
            let base_cpi = self.base_cpi.read();
            if base_cpi == 0 { return par; }

            (par * current_cpi) / base_cpi
        }

        fn _inflation_adjusted_value(self: @ContractState, amount: u128) -> u128 {
            if !self.inflation_indexed.read() { return amount; }
            let oracle = IInflationOracleDispatcher {
                contract_address: self.oracle_address.read()
            };
            let current_cpi = oracle.get_cpi().value;
            let base_cpi = self.base_cpi.read();
            if base_cpi == 0 { return amount; }
            (amount * current_cpi) / base_cpi
        }

        // Yield = balance * (current_index - debt_index_at_entry)
        fn _pending_yield(self: @ContractState, user: ContractAddress) -> u128 {
            let balance = self.user_token_balance.read(user);
            if balance == 0_u256 { return 0; }

            let yield_index = self.yield_per_token_stored.read();
            let debt = self.user_yield_debt.read(user);
            let balance_u128: u128 = balance.try_into().unwrap_or(0);

            let gross = (balance_u128 * yield_index) / 1_000_000_000_000_000_000_u128;
            if gross > debt { gross - debt } else { 0 }
        }

        // Called before any balance-changing operation to settle yield accrual
        // Uses time-weighted yield from oracle rate
        fn _update_yield_index(ref self: ContractState) {
            let total_tokens = self.total_tokens_issued.read();
            if total_tokens == 0_u256 { return; }

            let now = get_block_timestamp();
            let last = self.last_yield_update.read();
            if now <= last { return; }

            let elapsed: u128 = (now - last).into();
            let yield_bps: u128 = self.yield_basis_points.read().into();
            if yield_bps == 0 { return; }

            // annual_yield_rate = yield_bps / 10000
            // yield_for_period = total_tokens * annual_rate * elapsed / SECONDS_PER_YEAR
            // In USD cents: we apply rate to total_deposited_usd
            let total_dep = self.total_deposited_usd.read();
            let period_yield = (total_dep * yield_bps * elapsed)
                               / (BPS_DENOM * SECONDS_PER_YEAR);

            if period_yield > 0 {
                // Distribute this auto-accrued yield to pool
                let total_tokens_u128: u128 = total_tokens.try_into().unwrap_or(0);
                if total_tokens_u128 > 0 {
                    let delta = (period_yield * 1_000_000_000_000_000_000_u128)
                                / total_tokens_u128;
                    let current_index = self.yield_per_token_stored.read();
                    self.yield_per_token_stored.write(current_index + delta);

                    let pool = self.yield_pool.read();
                    self.yield_pool.write(pool + period_yield);
                }
            }

            self.last_yield_update.write(now);
        }
    }

    const BPS_DENOM: u128 = 10_000;
    const SECONDS_PER_YEAR: u128 = 31_536_000;
}
