// ============================================================
//  RWAToken.cairo
//  Starknet RWA Factory — Compliant ERC-20 Token
//
//  ERC-20 with RWA compliance layer:
//    - KYC whitelist: only approved addresses can hold/transfer
//    - Account freezing: compliance-ordered freeze
//    - Vault-only mint/burn: only the paired vault can issue
//    - Supply cap enforcement
//    - Maturity tracking: token signals when asset has matured
//    - Real-time NAV read from oracle via factory
// ============================================================

#[starknet::contract]
mod RWAToken {
    use starknet::{
        ContractAddress, get_caller_address, get_block_timestamp,
        storage::{Map, StorageMapReadAccess, StorageMapWriteAccess},
    };
    use core::num::traits::Zero;

    use super::super::interfaces::{
        IRWAToken, RWAMetadata,
        IRWAFactoryDispatcher, IRWAFactoryDispatcherTrait,
        IInflationOracleDispatcher, IInflationOracleDispatcherTrait,
    };

    // -------------------------------------------------------
    //  Storage
    // -------------------------------------------------------
    #[storage]
    struct Storage {
        // Identity
        rwa_id: u64,
        factory_address: ContractAddress,
        oracle_address: ContractAddress,
        vault_address: ContractAddress,       // set post-deploy by factory
        name_: felt252,
        symbol_: felt252,
        decimals_: u8,
        total_supply_cap: u256,

        // ERC-20 standard
        total_supply: u256,
        balances: Map<ContractAddress, u256>,
        allowances: Map<(ContractAddress, ContractAddress), u256>,

        // KYC/Compliance
        kyc_admin: ContractAddress,           // can approve KYC
        kyc_approved: Map<ContractAddress, bool>,
        frozen: Map<ContractAddress, bool>,
        transfer_restricted: bool,            // if true, only whitelist can transact

        // Yield tracking (synced with vault)
        last_yield_per_token: Map<ContractAddress, u128>,
    }

    // -------------------------------------------------------
    //  Events
    // -------------------------------------------------------
    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        Transfer: Transfer,
        Approval: Approval,
        WhitelistAdded: WhitelistAdded,
        WhitelistRemoved: WhitelistRemoved,
        AccountFrozen: AccountFrozen,
        AccountUnfrozen: AccountUnfrozen,
        Minted: Minted,
        Burned: Burned,
        VaultSet: VaultSet,
    }

    #[derive(Drop, starknet::Event)]
    struct Transfer {
        #[key] from: ContractAddress,
        #[key] to: ContractAddress,
        value: u256,
    }

    #[derive(Drop, starknet::Event)]
    struct Approval {
        #[key] owner: ContractAddress,
        #[key] spender: ContractAddress,
        value: u256,
    }

    #[derive(Drop, starknet::Event)]
    struct WhitelistAdded   { #[key] account: ContractAddress, by: ContractAddress }
    #[derive(Drop, starknet::Event)]
    struct WhitelistRemoved { #[key] account: ContractAddress, by: ContractAddress }
    #[derive(Drop, starknet::Event)]
    struct AccountFrozen    { #[key] account: ContractAddress, by: ContractAddress }
    #[derive(Drop, starknet::Event)]
    struct AccountUnfrozen  { #[key] account: ContractAddress, by: ContractAddress }
    #[derive(Drop, starknet::Event)]
    struct Minted           { #[key] to: ContractAddress, amount: u256 }
    #[derive(Drop, starknet::Event)]
    struct Burned           { #[key] from: ContractAddress, amount: u256 }
    #[derive(Drop, starknet::Event)]
    struct VaultSet         { vault: ContractAddress }

    // -------------------------------------------------------
    //  Constructor
    // -------------------------------------------------------
    #[constructor]
    fn constructor(
        ref self: ContractState,
        rwa_id: u64,
        factory_address: ContractAddress,
        oracle_address: ContractAddress,
        name: felt252,
        symbol: felt252,
        decimals: u8,
        supply_cap_low: u128,
        supply_cap_high: u128,
    ) {
        self.rwa_id.write(rwa_id);
        self.factory_address.write(factory_address);
        self.oracle_address.write(oracle_address);
        self.name_.write(name);
        self.symbol_.write(symbol);
        self.decimals_.write(decimals);
        self.total_supply_cap.write(u256 { low: supply_cap_low, high: supply_cap_high });
        self.total_supply.write(0_u256);
        self.transfer_restricted.write(true);  // KYC required by default
        self.kyc_admin.write(factory_address); // factory is initial KYC admin
    }

    // -------------------------------------------------------
    //  Implementation
    // -------------------------------------------------------
    #[abi(embed_v0)]
    impl RWATokenImpl of IRWAToken<ContractState> {

        // ---- ERC-20 ----

        fn name(self: @ContractState) -> felt252 { self.name_.read() }
        fn symbol(self: @ContractState) -> felt252 { self.symbol_.read() }
        fn decimals(self: @ContractState) -> u8 { self.decimals_.read() }
        fn total_supply(self: @ContractState) -> u256 { self.total_supply.read() }

        fn balance_of(self: @ContractState, account: ContractAddress) -> u256 {
            self.balances.read(account)
        }

        fn allowance(self: @ContractState, owner: ContractAddress, spender: ContractAddress) -> u256 {
            self.allowances.read((owner, spender))
        }

        fn transfer(ref self: ContractState, recipient: ContractAddress, amount: u256) -> bool {
            let sender = get_caller_address();
            self._check_transfer_allowed(sender, recipient);
            self._transfer(sender, recipient, amount);
            true
        }

        fn transfer_from(
            ref self: ContractState,
            sender: ContractAddress,
            recipient: ContractAddress,
            amount: u256,
        ) -> bool {
            let caller = get_caller_address();
            self._check_transfer_allowed(sender, recipient);
            let current_allowance = self.allowances.read((sender, caller));
            assert!(current_allowance >= amount, "ERC20: insufficient allowance");
            self.allowances.write((sender, caller), current_allowance - amount);
            self._transfer(sender, recipient, amount);
            true
        }

        fn approve(ref self: ContractState, spender: ContractAddress, amount: u256) -> bool {
            let owner = get_caller_address();
            self.allowances.write((owner, spender), amount);
            self.emit(Approval { owner, spender, value: amount });
            true
        }

        // ---- RWA-specific reads ----

        fn get_rwa_id(self: @ContractState) -> u64 { self.rwa_id.read() }
        fn get_factory_address(self: @ContractState) -> ContractAddress { self.factory_address.read() }
        fn get_oracle_address(self: @ContractState) -> ContractAddress { self.oracle_address.read() }

        fn is_kyc_approved(self: @ContractState, account: ContractAddress) -> bool {
            self.kyc_approved.read(account)
        }

        fn get_current_nav_per_token(self: @ContractState) -> u128 {
            let factory = IRWAFactoryDispatcher {
                contract_address: self.factory_address.read()
            };
            factory.get_rwa_nav(self.rwa_id.read())
        }

        fn get_accrued_yield(self: @ContractState, account: ContractAddress) -> u128 {
            // Delegate to vault for yield calculation
            // Vault is authoritative on yield — token just reads
            0 // vault holds authoritative yield state
        }

        fn get_inflation_adjustment_factor(self: @ContractState) -> u128 {
            let factory = IRWAFactoryDispatcher {
                contract_address: self.factory_address.read()
            };
            // Returns factor as 1e8: 1.0 = 100_000_000
            let nav = factory.get_rwa_nav(self.rwa_id.read());
            let metadata = factory.get_rwa_metadata(self.rwa_id.read());
            if metadata.par_value == 0 { return 100_000_000; }
            (nav * 100_000_000) / metadata.par_value
        }

        fn is_matured(self: @ContractState) -> bool {
            let factory = IRWAFactoryDispatcher {
                contract_address: self.factory_address.read()
            };
            let meta = factory.get_rwa_metadata(self.rwa_id.read());
            if meta.maturity_timestamp == 0 { return false; } // perpetual
            get_block_timestamp() >= meta.maturity_timestamp
        }

        fn get_metadata(self: @ContractState) -> RWAMetadata {
            let factory = IRWAFactoryDispatcher {
                contract_address: self.factory_address.read()
            };
            factory.get_rwa_metadata(self.rwa_id.read())
        }

        // ---- Compliance ----

        fn add_to_whitelist(ref self: ContractState, account: ContractAddress) {
            self._only_kyc_admin();
            self.kyc_approved.write(account, true);
            self.emit(WhitelistAdded { account, by: get_caller_address() });
        }

        fn remove_from_whitelist(ref self: ContractState, account: ContractAddress) {
            self._only_kyc_admin();
            self.kyc_approved.write(account, false);
            self.emit(WhitelistRemoved { account, by: get_caller_address() });
        }

        fn freeze_account(ref self: ContractState, account: ContractAddress) {
            self._only_kyc_admin();
            self.frozen.write(account, true);
            self.emit(AccountFrozen { account, by: get_caller_address() });
        }

        fn unfreeze_account(ref self: ContractState, account: ContractAddress) {
            self._only_kyc_admin();
            self.frozen.write(account, false);
            self.emit(AccountUnfrozen { account, by: get_caller_address() });
        }

        fn is_frozen(self: @ContractState, account: ContractAddress) -> bool {
            self.frozen.read(account)
        }

        // ---- Vault-only mint/burn ----

        fn mint(ref self: ContractState, to: ContractAddress, amount: u256) {
            self._only_vault();
            assert!(amount > 0_u256, "RWAToken: zero mint");

            let new_supply = self.total_supply.read() + amount;
            let cap = self.total_supply_cap.read();
            assert!(new_supply <= cap, "RWAToken: supply cap exceeded");

            self.total_supply.write(new_supply);
            let prev = self.balances.read(to);
            self.balances.write(to, prev + amount);

            self.emit(Transfer {
                from: starknet::contract_address_const::<0>(),
                to,
                value: amount,
            });
            self.emit(Minted { to, amount });
        }

        fn burn(ref self: ContractState, from: ContractAddress, amount: u256) {
            self._only_vault();
            assert!(amount > 0_u256, "RWAToken: zero burn");

            let balance = self.balances.read(from);
            assert!(balance >= amount, "RWAToken: burn exceeds balance");

            self.balances.write(from, balance - amount);
            let supply = self.total_supply.read();
            self.total_supply.write(supply - amount);

            self.emit(Transfer {
                from,
                to: starknet::contract_address_const::<0>(),
                value: amount,
            });
            self.emit(Burned { from, amount });
        }

        fn claim_yield(ref self: ContractState) {
            // Delegate to vault
            // Token doesn't hold yield — vault does
            // This is a convenience call that forwards to vault
            assert!(false, "RWAToken: call vault directly for yield");
        }
    }

    // -------------------------------------------------------
    //  Internal helpers
    // -------------------------------------------------------
    #[generate_trait]
    impl InternalImpl of InternalTrait {

        fn _only_vault(self: @ContractState) {
            let caller = get_caller_address();
            let vault = self.vault_address.read();
            assert!(!vault.is_zero(), "RWAToken: vault not set");
            assert!(caller == vault, "RWAToken: only vault");
        }

        fn _only_kyc_admin(self: @ContractState) {
            assert!(
                get_caller_address() == self.kyc_admin.read(),
                "RWAToken: not KYC admin"
            );
        }

        fn _check_transfer_allowed(
            self: @ContractState,
            from: ContractAddress,
            to: ContractAddress,
        ) {
            assert!(!self.frozen.read(from), "RWAToken: sender frozen");
            assert!(!self.frozen.read(to), "RWAToken: recipient frozen");

            if self.transfer_restricted.read() {
                assert!(
                    self.kyc_approved.read(from),
                    "RWAToken: sender not KYC approved"
                );
                assert!(
                    self.kyc_approved.read(to),
                    "RWAToken: recipient not KYC approved"
                );
            }
        }

        fn _transfer(
            ref self: ContractState,
            from: ContractAddress,
            to: ContractAddress,
            amount: u256,
        ) {
            assert!(!to.is_zero(), "ERC20: transfer to zero address");
            assert!(amount > 0_u256, "ERC20: zero transfer");

            let from_balance = self.balances.read(from);
            assert!(from_balance >= amount, "ERC20: insufficient balance");

            self.balances.write(from, from_balance - amount);
            let to_balance = self.balances.read(to);
            self.balances.write(to, to_balance + amount);

            self.emit(Transfer { from, to, value: amount });
        }
    }

    // -------------------------------------------------------
    //  Factory-called setup: register vault address after deploy
    // -------------------------------------------------------
    #[external(v0)]
    fn set_vault(ref self: ContractState, vault: ContractAddress) {
        // Only factory can set vault, only once
        assert!(
            get_caller_address() == self.factory_address.read(),
            "RWAToken: only factory"
        );
        assert!(
            self.vault_address.read().is_zero(),
            "RWAToken: vault already set"
        );
        self.vault_address.write(vault);
        self.emit(VaultSet { vault });
    }

    #[external(v0)]
    fn set_kyc_admin(ref self: ContractState, new_admin: ContractAddress) {
        assert!(
            get_caller_address() == self.kyc_admin.read(),
            "RWAToken: not KYC admin"
        );
        self.kyc_admin.write(new_admin);
    }

    #[external(v0)]
    fn set_transfer_restriction(ref self: ContractState, restricted: bool) {
        assert!(
            get_caller_address() == self.kyc_admin.read(),
            "RWAToken: not KYC admin"
        );
        self.transfer_restricted.write(restricted);
    }
}
