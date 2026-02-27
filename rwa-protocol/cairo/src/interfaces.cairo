// ============================================================
//  Starknet RWA Factory — Interface Definitions
//  All interfaces for the oracle, factory, token, and vault
// ============================================================

use starknet::ContractAddress;

// -----------------------------------------------------------
//  IERC20 — Standard ERC-20 interface
//  Used by RWAVault to call transferFrom/transfer on USDC/STRK
//  payment token for real on-chain fund movement
// -----------------------------------------------------------
#[starknet::interface]
pub trait IERC20<TContractState> {
    fn name(self: @TContractState) -> felt252;
    fn symbol(self: @TContractState) -> felt252;
    fn decimals(self: @TContractState) -> u8;
    fn total_supply(self: @TContractState) -> u256;
    fn balance_of(self: @TContractState, account: ContractAddress) -> u256;
    fn allowance(self: @TContractState, owner: ContractAddress, spender: ContractAddress) -> u256;
    fn transfer(ref self: TContractState, recipient: ContractAddress, amount: u256) -> bool;
    fn transfer_from(ref self: TContractState, sender: ContractAddress, recipient: ContractAddress, amount: u256) -> bool;
    fn approve(ref self: TContractState, spender: ContractAddress, amount: u256) -> bool;
}

// -----------------------------------------------------------
//  Macro-Economic Data Point
//  value is stored as fixed-point with ORACLE_DECIMALS (8)
//  e.g. CPI 314.12 = 31412000000 (314.12 * 1e8)
//       rate 4.25% = 425000000   (4.25 * 1e8)
// -----------------------------------------------------------
#[derive(Drop, Serde, starknet::Store, Clone)]
pub struct MacroDataPoint {
    pub value: u128,        // fixed-point 1e8
    pub timestamp: u64,     // unix seconds
    pub publisher: ContractAddress,
    pub round_id: u64,
}

// -----------------------------------------------------------
//  RWA Asset Categories
// -----------------------------------------------------------
#[derive(Drop, Serde, starknet::Store, PartialEq, Clone, Copy)]
pub enum AssetType {
    TreasuryBill,       // T-Bills, T-Notes, T-Bonds
    RealEstate,         // Tokenized real estate
    Commodity,          // Gold, silver, oil
    CorporateBond,      // Investment-grade corps
    InflationBond,      // TIPS-like, inflation-indexed
}

// -----------------------------------------------------------
//  RWA Token Metadata stored in factory
// -----------------------------------------------------------
#[derive(Drop, Serde, starknet::Store, Clone)]
pub struct RWAMetadata {
    pub asset_type: AssetType,
    pub name: felt252,
    pub symbol: felt252,
    pub isin: felt252,               // International Securities ID
    pub issuer: felt252,             // e.g. 'US_TREASURY'
    pub maturity_timestamp: u64,     // 0 = no maturity (perpetual)
    pub par_value: u128,             // par value in USD cents
    pub yield_basis_points: u16,     // annual yield e.g. 425 = 4.25%
    pub inflation_indexed: bool,     // true = NAV adjusts with CPI
    pub token_address: ContractAddress,
    pub vault_address: ContractAddress,
    pub creator: ContractAddress,
    pub created_at: u64,
    pub total_supply_cap: u256,      // max tokens issuable
    pub is_active: bool,
}

// -----------------------------------------------------------
//  IInflationOracle — On-chain macro data oracle
//  Publishers push signed data; contract aggregates median
// -----------------------------------------------------------
#[starknet::interface]
pub trait IInflationOracle<TContractState> {
    // ---- Read functions ----
    fn get_cpi(self: @TContractState) -> MacroDataPoint;
    fn get_cpi_yoy_bps(self: @TContractState) -> u128;  // year-over-year in basis points
    fn get_tbill_3m_rate_bps(self: @TContractState) -> MacroDataPoint;
    fn get_tbill_10y_rate_bps(self: @TContractState) -> MacroDataPoint;
    fn get_fed_funds_rate_bps(self: @TContractState) -> MacroDataPoint;
    fn get_latest_round_id(self: @TContractState) -> u64;
    fn is_data_fresh(self: @TContractState) -> bool;
    fn get_staleness_threshold(self: @TContractState) -> u64;  // seconds
    fn get_publisher_count(self: @TContractState) -> u32;
    fn is_publisher(self: @TContractState, address: ContractAddress) -> bool;
    fn get_oracle_admin(self: @TContractState) -> ContractAddress;

    // ---- Historical lookups ----
    fn get_cpi_at_round(self: @TContractState, round_id: u64) -> MacroDataPoint;
    fn get_cpi_index_base(self: @TContractState) -> u128;  // base CPI for inflation calc

    // ---- Publisher write functions ----
    fn publish_data(
        ref self: TContractState,
        cpi_value: u128,
        cpi_yoy_bps: u128,
        tbill_3m_bps: u128,
        tbill_10y_bps: u128,
        fed_funds_bps: u128,
        data_timestamp: u64,     // timestamp of source data
        signature_r: felt252,
        signature_s: felt252,
    );

    // ---- Admin functions ----
    fn add_publisher(ref self: TContractState, publisher: ContractAddress);
    fn remove_publisher(ref self: TContractState, publisher: ContractAddress);
    fn set_staleness_threshold(ref self: TContractState, seconds: u64);
    fn transfer_admin(ref self: TContractState, new_admin: ContractAddress);
}

// -----------------------------------------------------------
//  IRWAFactory — Deploys & tracks RWA token instances
// -----------------------------------------------------------
#[starknet::interface]
pub trait IRWAFactory<TContractState> {
    // ---- Read functions ----
    fn get_rwa_count(self: @TContractState) -> u64;
    fn get_rwa_metadata(self: @TContractState, rwa_id: u64) -> RWAMetadata;
    fn get_rwa_by_address(self: @TContractState, token_address: ContractAddress) -> RWAMetadata;
    fn get_rwa_nav(self: @TContractState, rwa_id: u64) -> u128;  // current NAV per token (USD cents)
    fn get_inflation_adjusted_value(self: @TContractState, rwa_id: u64, principal: u128) -> u128;
    fn get_oracle_address(self: @TContractState) -> ContractAddress;
    fn get_rwa_token_class_hash(self: @TContractState) -> starknet::ClassHash;
    fn get_rwa_vault_class_hash(self: @TContractState) -> starknet::ClassHash;
    fn get_factory_admin(self: @TContractState) -> ContractAddress;
    fn get_creation_fee(self: @TContractState) -> u256;  // fee in STRK/ETH
    fn get_all_rwa_ids_by_type(self: @TContractState, asset_type: AssetType) -> Array<u64>;
    fn is_rwa_active(self: @TContractState, rwa_id: u64) -> bool;

    // ---- Write functions ----
    fn create_rwa(
        ref self: TContractState,
        asset_type: AssetType,
        name: felt252,
        symbol: felt252,
        isin: felt252,
        issuer: felt252,
        maturity_timestamp: u64,
        par_value: u128,
        yield_basis_points: u16,
        inflation_indexed: bool,
        total_supply_cap: u256,
    ) -> (u64, ContractAddress, ContractAddress);  // (rwa_id, token_addr, vault_addr)

    fn deactivate_rwa(ref self: TContractState, rwa_id: u64);
    fn update_oracle(ref self: TContractState, new_oracle: ContractAddress);
    fn update_rwa_token_class_hash(ref self: TContractState, class_hash: starknet::ClassHash);
    fn update_rwa_vault_class_hash(ref self: TContractState, class_hash: starknet::ClassHash);
    fn set_creation_fee(ref self: TContractState, fee: u256);
    fn transfer_admin(ref self: TContractState, new_admin: ContractAddress);
    fn withdraw_fees(ref self: TContractState, recipient: ContractAddress);
}

// -----------------------------------------------------------
//  IRWAToken — ERC-20 with RWA compliance hooks
// -----------------------------------------------------------
#[starknet::interface]
pub trait IRWAToken<TContractState> {
    // ERC-20 standard
    fn name(self: @TContractState) -> felt252;
    fn symbol(self: @TContractState) -> felt252;
    fn decimals(self: @TContractState) -> u8;
    fn total_supply(self: @TContractState) -> u256;
    fn balance_of(self: @TContractState, account: ContractAddress) -> u256;
    fn allowance(self: @TContractState, owner: ContractAddress, spender: ContractAddress) -> u256;
    fn transfer(ref self: TContractState, recipient: ContractAddress, amount: u256) -> bool;
    fn transfer_from(ref self: TContractState, sender: ContractAddress, recipient: ContractAddress, amount: u256) -> bool;
    fn approve(ref self: TContractState, spender: ContractAddress, amount: u256) -> bool;

    // RWA-specific
    fn get_rwa_id(self: @TContractState) -> u64;
    fn get_factory_address(self: @TContractState) -> ContractAddress;
    fn get_oracle_address(self: @TContractState) -> ContractAddress;
    fn is_kyc_approved(self: @TContractState, account: ContractAddress) -> bool;
    fn get_current_nav_per_token(self: @TContractState) -> u128;  // USD cents
    fn get_accrued_yield(self: @TContractState, account: ContractAddress) -> u128;
    fn get_inflation_adjustment_factor(self: @TContractState) -> u128;  // current CPI / base CPI * 1e8
    fn is_matured(self: @TContractState) -> bool;
    fn get_metadata(self: @TContractState) -> RWAMetadata;

    // Compliance
    fn add_to_whitelist(ref self: TContractState, account: ContractAddress);
    fn remove_from_whitelist(ref self: TContractState, account: ContractAddress);
    fn freeze_account(ref self: TContractState, account: ContractAddress);
    fn unfreeze_account(ref self: TContractState, account: ContractAddress);
    fn is_frozen(self: @TContractState, account: ContractAddress) -> bool;

    // Vault-only mint/burn
    fn mint(ref self: TContractState, to: ContractAddress, amount: u256);
    fn burn(ref self: TContractState, from: ContractAddress, amount: u256);
    fn claim_yield(ref self: TContractState);
}

// -----------------------------------------------------------
//  IRWAVault — Manages deposits, redemptions, yield
// -----------------------------------------------------------
#[starknet::interface]
pub trait IRWAVault<TContractState> {
    // ---- Read functions ----
    fn get_rwa_id(self: @TContractState) -> u64;
    fn get_token_address(self: @TContractState) -> ContractAddress;
    fn get_oracle_address(self: @TContractState) -> ContractAddress;
    fn get_total_value_locked(self: @TContractState) -> u256;  // in USD cents
    fn get_nav_per_token(self: @TContractState) -> u128;       // USD cents, inflation-adjusted
    fn get_user_position(self: @TContractState, user: ContractAddress) -> VaultPosition;
    fn get_pending_yield(self: @TContractState, user: ContractAddress) -> u128;
    fn get_inflation_pnl(self: @TContractState, user: ContractAddress) -> i128;  // gain/loss vs inflation
    fn get_payment_token(self: @TContractState) -> ContractAddress;   // USDC / STRK
    fn get_base_cpi(self: @TContractState) -> u128;
    fn get_deposit_count(self: @TContractState) -> u64;

    // ---- Write functions ----
    fn deposit(ref self: TContractState, usd_amount: u256) -> u256;   // returns tokens minted
    fn redeem(ref self: TContractState, token_amount: u256) -> u256;  // returns USD returned
    fn claim_yield(ref self: TContractState) -> u128;
    fn compound_yield(ref self: TContractState);   // reinvest yield into more tokens
    fn emergency_pause(ref self: TContractState);
    fn unpause(ref self: TContractState);
    fn update_nav(ref self: TContractState);  // recalculate NAV from oracle data
    fn distribute_yield(ref self: TContractState, amount: u128);  // admin: add yield from off-chain
}

// -----------------------------------------------------------
//  Vault position struct
// -----------------------------------------------------------
#[derive(Drop, Serde, starknet::Store, Clone)]
pub struct VaultPosition {
    pub token_balance: u256,
    pub deposit_usd_value: u256,    // original deposit value in USD cents
    pub deposit_cpi_at_entry: u128, // CPI index when deposited
    pub yield_debt: u128,           // already-claimed yield accounting
    pub last_updated: u64,
    pub total_yield_claimed: u128,
}
