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
    //  Storage
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

        // Vault state
        total_deposited_usd: u128,        // running sum of deposits in USD cents
        total_tokens_issued: u256,
        deposit_count: u64,
        is_paused: bool,

        // Yield pool — funded by off-chain issuer transfers
        yield_pool: u128,                 // total yield available to distribute (USD cents)
        yield_per_token_stored: u128,     // cumulative yield per token (scaled 1e18)
        last_yield_update: u64,

        // Per-user positions
        user_token_balance: Map<ContractAddress, u256>,
        user_deposit_usd: Map<ContractAddress, u256>,
        user_entry_cpi: Map<ContractAddress, u128>,
        user_entry_time: Map<ContractAddress, u64>,
        user_yield_debt: Map<ContractAddress, u128>,   // yield already accounted for
        user_yield_claimed: Map<ContractAddress, u128>,
        user_last_action: Map<ContractAddress, u64>,
    }

    // -------------------------------------------------------
    //  Events
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
    }

    #[derive(Drop, starknet::Event)]
    struct Deposited {
        #[key]
        user: ContractAddress,
        usd_amount: u256,
        tokens_minted: u256,
        cpi_at_entry: u128,
        nav_per_token: u128,
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
        //  deposit — user sends USD (via payment_token), gets RWA tokens
        //
        //  Tokens minted = usd_amount / nav_per_token
        //  NAV per token = par_value * inflation_factor (if indexed)
        // -------------------------------------------------------
        fn deposit(ref self: ContractState, usd_amount: u256) -> u256 {
            assert!(!self.is_paused.read(), "Vault: paused");
            assert!(usd_amount > 0_u256, "Vault: zero deposit");

            let caller = get_caller_address();
            let now = get_block_timestamp();

            // Update yield accrual before changing balances
            self._update_yield_index();

            // Calculate tokens to mint
            let nav = self._current_nav();
            assert!(nav > 0, "Vault: nav is zero");

            // tokens = (usd_amount_in_cents / nav_per_token_in_cents) * 1e18
            // usd_amount is in u256 with 6 decimals (USDC standard)
            // nav is in USD cents (1e2)
            // We convert: amount_cents = usd_amount * 100 / 1e6 = usd_amount / 1e4
            let amount_cents = usd_amount / 10000_u256; // convert USDC 6dec to cents
            let tokens_18dec: u256 = (amount_cents * 1_000_000_000_000_000_000_u256) / nav.into();

            assert!(tokens_18dec > 0_u256, "Vault: deposit too small");

            // Snapshot oracle CPI at time of entry
            let oracle = IInflationOracleDispatcher {
                contract_address: self.oracle_address.read()
            };
            let entry_cpi = oracle.get_cpi().value;

            // Pull USDC from caller into this vault using ERC-20 transferFrom.
            // Caller must have approved this vault address for at least usd_amount.
            // payment_token is the USDC/STRK ERC-20 contract address set at vault deploy.
            let payment = IERC20Dispatcher { contract_address: self.payment_token.read() };
            let transfer_ok = payment.transfer_from(caller, starknet::get_contract_address(), usd_amount);
            assert!(transfer_ok, "Vault: payment transferFrom failed — check allowance");

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

            // Convert USD cents to USDC 6-decimal units: cents * 10000 = USDC micro-units
            // e.g. $100.50 = 10050 cents * 10000 = 100_500_000 USDC (6 dec)
            let usdc_amount = total_return * 10000_u256;

            // Transfer USDC from vault reserves back to caller
            let payment = IERC20Dispatcher { contract_address: self.payment_token.read() };
            let transfer_ok = payment.transfer(caller, usdc_amount);
            assert!(transfer_ok, "Vault: USDC transfer to redeemer failed — insufficient vault reserves");

            self.emit(Redeemed {
                user: caller,
                tokens_burned: token_amount,
                usd_returned: usdc_amount,
                inflation_adjustment_bps: inflation_adj_bps,
                yield_included: pending_yield,
            });

            usdc_amount  // USDC 6-decimal units transferred to caller
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

            // Transfer pending yield in USDC to caller
            // pending is in USD cents; convert to USDC 6-decimal: cents * 10000
            let usdc_yield = (pending * 10000_u128).into();
            let payment = IERC20Dispatcher { contract_address: self.payment_token.read() };
            let transfer_ok = payment.transfer(caller, usdc_yield);
            assert!(transfer_ok, "Vault: yield USDC transfer failed — pool may be underfunded");

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
