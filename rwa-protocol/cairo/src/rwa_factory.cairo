// ============================================================
//  RWAFactory.cairo
//  Starknet RWA Factory — Asset Creation & Registry
//
//  Deploys new RWAToken + RWAVault contract pairs per asset.
//  Uses Starknet syscall deploy with stored class hashes.
//  Reads InflationOracle for real-time NAV calculations.
//
//  Supported asset types:
//    TreasuryBill  — T-Bills, T-Notes (yield from oracle T-Bill rate)
//    RealEstate    — Tokenized property (fixed yield + inflation adjust)
//    Commodity     — Gold/Oil (NAV tracks oracle price feed)
//    CorporateBond — Fixed yield, no inflation adjustment
//    InflationBond — TIPS-like: par value inflates with CPI
// ============================================================

#[starknet::contract]
mod RWAFactory {
    use starknet::{
        ContractAddress, ClassHash, get_caller_address, get_block_timestamp,
        syscalls::deploy_syscall,
        storage::{Map, StorageMapReadAccess, StorageMapWriteAccess},
    };
    use core::array::ArrayTrait;
    use core::traits::Into;
    use core::poseidon::poseidon_hash_span;

    use super::super::interfaces::{
        AssetType, RWAMetadata, IRWAFactory,
        IInflationOracleDispatcher, IInflationOracleDispatcherTrait,
        IERC20Dispatcher, IERC20DispatcherTrait,
    };

    // -------------------------------------------------------
    //  Constants
    // -------------------------------------------------------
    const DECIMALS: u128         = 100_000_000; // 1e8 for NAV math
    const USD_CENTS_PER_DOLLAR: u128 = 100;
    const BPS_DENOMINATOR: u128  = 10_000;
    const SECONDS_PER_YEAR: u64  = 31_536_000;

    // -------------------------------------------------------
    //  Storage
    // -------------------------------------------------------
    #[storage]
    struct Storage {
        // Admin & config
        admin: ContractAddress,
        pending_admin: ContractAddress,
        oracle_address: ContractAddress,
        rwa_token_class_hash: ClassHash,
        rwa_vault_class_hash: ClassHash,
        creation_fee: u256,
        fee_token: ContractAddress,     // ERC-20 for fee payment (STRK)
        collected_fees: u256,
        is_paused: bool,

        // RWA registry
        rwa_count: u64,
        // rwa_id → metadata
        rwa_name: Map<u64, felt252>,
        rwa_symbol: Map<u64, felt252>,
        rwa_isin: Map<u64, felt252>,
        rwa_issuer: Map<u64, felt252>,
        rwa_asset_type: Map<u64, u8>,       // AssetType serialized as u8
        rwa_maturity: Map<u64, u64>,
        rwa_par_value: Map<u64, u128>,
        rwa_yield_bps: Map<u64, u16>,
        rwa_inflation_indexed: Map<u64, bool>,
        rwa_token_addr: Map<u64, ContractAddress>,
        rwa_vault_addr: Map<u64, ContractAddress>,
        rwa_creator: Map<u64, ContractAddress>,
        rwa_created_at: Map<u64, u64>,
        rwa_supply_cap: Map<u64, u256>,
        rwa_is_active: Map<u64, bool>,
        rwa_base_cpi: Map<u64, u128>,       // CPI at deployment for TIPS math

        // Reverse lookups
        addr_to_rwa_id: Map<ContractAddress, u64>,

        // Type index for enumeration
        type_count_tbill: u64,
        type_count_realestate: u64,
        type_count_commodity: u64,
        type_count_corpbond: u64,
        type_count_inflationbond: u64,
        tbill_ids: Map<u64, u64>,
        realestate_ids: Map<u64, u64>,
        commodity_ids: Map<u64, u64>,
        corpbond_ids: Map<u64, u64>,
        inflationbond_ids: Map<u64, u64>,
    }

    // -------------------------------------------------------
    //  Events
    // -------------------------------------------------------
    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        RWACreated: RWACreated,
        RWADeactivated: RWADeactivated,
        OracleUpdated: OracleUpdated,
        ClassHashUpdated: ClassHashUpdated,
        AdminTransferInitiated: AdminTransferInitiated,
        AdminTransferAccepted: AdminTransferAccepted,
        FeeUpdated: FeeUpdated,
    }

    #[derive(Drop, starknet::Event)]
    struct RWACreated {
        #[key]
        rwa_id: u64,
        #[key]
        token_address: ContractAddress,
        #[key]
        vault_address: ContractAddress,
        creator: ContractAddress,
        asset_type: u8,
        name: felt252,
        symbol: felt252,
        isin: felt252,
    }

    #[derive(Drop, starknet::Event)]
    struct RWADeactivated {
        #[key]
        rwa_id: u64,
        by: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    struct OracleUpdated {
        old_oracle: ContractAddress,
        new_oracle: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    struct ClassHashUpdated {
        kind: felt252, // 'token' or 'vault'
        new_hash: ClassHash,
    }

    #[derive(Drop, starknet::Event)]
    struct AdminTransferInitiated {
        current_admin: ContractAddress,
        pending_admin: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    struct AdminTransferAccepted {
        new_admin: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    struct FeeUpdated {
        old_fee: u256,
        new_fee: u256,
    }

    // -------------------------------------------------------
    //  Constructor
    // -------------------------------------------------------
    #[constructor]
    fn constructor(
        ref self: ContractState,
        admin: ContractAddress,
        oracle_address: ContractAddress,
        rwa_token_class_hash: ClassHash,
        rwa_vault_class_hash: ClassHash,
        fee_token: ContractAddress,
        creation_fee: u256,
    ) {
        self.admin.write(admin);
        self.oracle_address.write(oracle_address);
        self.rwa_token_class_hash.write(rwa_token_class_hash);
        self.rwa_vault_class_hash.write(rwa_vault_class_hash);
        self.fee_token.write(fee_token);
        self.creation_fee.write(creation_fee);
        self.rwa_count.write(0);
        self.is_paused.write(false);
        self.collected_fees.write(0_u256);
    }

    // -------------------------------------------------------
    //  Implementation
    // -------------------------------------------------------
    #[abi(embed_v0)]
    impl RWAFactoryImpl of IRWAFactory<ContractState> {

        fn get_rwa_count(self: @ContractState) -> u64 {
            self.rwa_count.read()
        }

        fn get_rwa_metadata(self: @ContractState, rwa_id: u64) -> RWAMetadata {
            assert!(rwa_id > 0 && rwa_id <= self.rwa_count.read(), "Factory: invalid rwa_id");
            self._read_metadata(rwa_id)
        }

        fn get_rwa_by_address(self: @ContractState, token_address: ContractAddress) -> RWAMetadata {
            let rwa_id = self.addr_to_rwa_id.read(token_address);
            assert!(rwa_id > 0, "Factory: unknown token address");
            self._read_metadata(rwa_id)
        }

        fn get_rwa_nav(self: @ContractState, rwa_id: u64) -> u128 {
            assert!(rwa_id > 0 && rwa_id <= self.rwa_count.read(), "Factory: invalid rwa_id");
            self._calculate_nav(rwa_id)
        }

        fn get_inflation_adjusted_value(self: @ContractState, rwa_id: u64, principal: u128) -> u128 {
            let is_indexed = self.rwa_inflation_indexed.read(rwa_id);
            if !is_indexed {
                return principal;
            }

            let oracle = IInflationOracleDispatcher {
                contract_address: self.oracle_address.read()
            };
            let current_cpi = oracle.get_cpi().value;
            let base_cpi = self.rwa_base_cpi.read(rwa_id);

            if base_cpi == 0 { return principal; }

            // inflation_adjustment = current_cpi / base_cpi
            // result = principal * current_cpi / base_cpi
            // Both CPI values are in 1e2 format, so they cancel:
            (principal * current_cpi) / base_cpi
        }

        fn get_oracle_address(self: @ContractState) -> ContractAddress {
            self.oracle_address.read()
        }

        fn get_rwa_token_class_hash(self: @ContractState) -> ClassHash {
            self.rwa_token_class_hash.read()
        }

        fn get_rwa_vault_class_hash(self: @ContractState) -> ClassHash {
            self.rwa_vault_class_hash.read()
        }

        fn get_factory_admin(self: @ContractState) -> ContractAddress {
            self.admin.read()
        }

        fn get_creation_fee(self: @ContractState) -> u256 {
            self.creation_fee.read()
        }

        fn get_all_rwa_ids_by_type(self: @ContractState, asset_type: AssetType) -> Array<u64> {
            let mut result = ArrayTrait::new();
            match asset_type {
                AssetType::TreasuryBill => {
                    let count = self.type_count_tbill.read();
                    let mut i: u64 = 1;
                    loop {
                        if i > count { break; }
                        result.append(self.tbill_ids.read(i));
                        i += 1;
                    }
                },
                AssetType::RealEstate => {
                    let count = self.type_count_realestate.read();
                    let mut i: u64 = 1;
                    loop {
                        if i > count { break; }
                        result.append(self.realestate_ids.read(i));
                        i += 1;
                    }
                },
                AssetType::Commodity => {
                    let count = self.type_count_commodity.read();
                    let mut i: u64 = 1;
                    loop {
                        if i > count { break; }
                        result.append(self.commodity_ids.read(i));
                        i += 1;
                    }
                },
                AssetType::CorporateBond => {
                    let count = self.type_count_corpbond.read();
                    let mut i: u64 = 1;
                    loop {
                        if i > count { break; }
                        result.append(self.corpbond_ids.read(i));
                        i += 1;
                    }
                },
                AssetType::InflationBond => {
                    let count = self.type_count_inflationbond.read();
                    let mut i: u64 = 1;
                    loop {
                        if i > count { break; }
                        result.append(self.inflationbond_ids.read(i));
                        i += 1;
                    }
                },
            }
            result
        }

        fn is_rwa_active(self: @ContractState, rwa_id: u64) -> bool {
            self.rwa_is_active.read(rwa_id)
        }

        // -------------------------------------------------------
        //  create_rwa — deploys a new RWAToken + RWAVault pair
        // -------------------------------------------------------
        fn create_rwa(
            ref self: ContractState,
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
        ) -> (u64, ContractAddress, ContractAddress) {
            assert!(!self.is_paused.read(), "Factory: paused");

            let caller = get_caller_address();
            let now = get_block_timestamp();

            // Basic validation
            assert!(name != 0, "Factory: name required");
            assert!(symbol != 0, "Factory: symbol required");
            assert!(par_value > 0, "Factory: par_value must be > 0");
            assert!(yield_basis_points <= 5000, "Factory: yield > 50% not allowed");
            if maturity_timestamp > 0 {
                assert!(maturity_timestamp > now, "Factory: maturity must be in the future");
            }

            // Collect creation fee from caller (if fee > 0)
            // Caller must have approved this factory contract for creation_fee amount
            let fee = self.creation_fee.read();
            if fee > 0_u256 {
                let fee_tok = IERC20Dispatcher { contract_address: self.fee_token.read() };
                let ok = fee_tok.transfer_from(caller, starknet::get_contract_address(), fee);
                assert!(ok, "Factory: fee payment failed — approve factory for creation_fee first");
                let collected = self.collected_fees.read();
                self.collected_fees.write(collected + fee);
            }

            // Get new rwa_id
            let rwa_id = self.rwa_count.read() + 1;
            self.rwa_count.write(rwa_id);

            // Get current CPI as base for inflation indexing
            let oracle = IInflationOracleDispatcher {
                contract_address: self.oracle_address.read()
            };
            let current_cpi = oracle.get_cpi().value;

            // Deploy RWAToken contract
            // Constructor calldata: (rwa_id, factory, oracle, name, symbol, decimals, supply_cap)
            let token_salt = _compute_salt(rwa_id, 'token', now);
            let mut token_calldata = ArrayTrait::new();
            token_calldata.append(rwa_id.into());
            token_calldata.append(starknet::get_contract_address().into());
            token_calldata.append(self.oracle_address.read().into());
            token_calldata.append(name);
            token_calldata.append(symbol);
            token_calldata.append(18_felt252);
            // supply_cap (u256 = 2 felts)
            token_calldata.append(total_supply_cap.low.into());
            token_calldata.append(total_supply_cap.high.into());

            let (token_address, _) = deploy_syscall(
                self.rwa_token_class_hash.read(),
                token_salt,
                token_calldata.span(),
                false,
            ).expect('Factory: token deploy failed');

            // Deploy RWAVault contract
            // Constructor calldata: (rwa_id, factory, oracle, token_address, payment_token, base_cpi)
            let vault_salt = _compute_salt(rwa_id, 'vault', now);
            let mut vault_calldata = ArrayTrait::new();
            vault_calldata.append(rwa_id.into());
            vault_calldata.append(starknet::get_contract_address().into());
            vault_calldata.append(self.oracle_address.read().into());
            vault_calldata.append(token_address.into());
            vault_calldata.append(self.fee_token.read().into()); // payment token = STRK/USDC
            vault_calldata.append(current_cpi.into());           // base CPI snapshot

            let (vault_address, _) = deploy_syscall(
                self.rwa_vault_class_hash.read(),
                vault_salt,
                vault_calldata.span(),
                false,
            ).expect('Factory: vault deploy failed');

            // Write all metadata to storage
            self.rwa_name.write(rwa_id, name);
            self.rwa_symbol.write(rwa_id, symbol);
            self.rwa_isin.write(rwa_id, isin);
            self.rwa_issuer.write(rwa_id, issuer);
            self.rwa_asset_type.write(rwa_id, _asset_type_to_u8(asset_type));
            self.rwa_maturity.write(rwa_id, maturity_timestamp);
            self.rwa_par_value.write(rwa_id, par_value);
            self.rwa_yield_bps.write(rwa_id, yield_basis_points);
            self.rwa_inflation_indexed.write(rwa_id, inflation_indexed);
            self.rwa_token_addr.write(rwa_id, token_address);
            self.rwa_vault_addr.write(rwa_id, vault_address);
            self.rwa_creator.write(rwa_id, caller);
            self.rwa_created_at.write(rwa_id, now);
            self.rwa_supply_cap.write(rwa_id, total_supply_cap);
            self.rwa_is_active.write(rwa_id, true);
            self.rwa_base_cpi.write(rwa_id, current_cpi);

            // Reverse lookup
            self.addr_to_rwa_id.write(token_address, rwa_id);
            self.addr_to_rwa_id.write(vault_address, rwa_id);

            // Type index
            self._add_to_type_index(asset_type, rwa_id);

            let asset_type_u8 = _asset_type_to_u8(asset_type);
            self.emit(RWACreated {
                rwa_id,
                token_address,
                vault_address,
                creator: caller,
                asset_type: asset_type_u8,
                name,
                symbol,
                isin,
            });

            (rwa_id, token_address, vault_address)
        }

        fn deactivate_rwa(ref self: ContractState, rwa_id: u64) {
            self._only_admin();
            assert!(rwa_id > 0 && rwa_id <= self.rwa_count.read(), "Factory: invalid rwa_id");
            self.rwa_is_active.write(rwa_id, false);
            self.emit(RWADeactivated { rwa_id, by: get_caller_address() });
        }

        fn update_oracle(ref self: ContractState, new_oracle: ContractAddress) {
            self._only_admin();
            let old = self.oracle_address.read();
            self.oracle_address.write(new_oracle);
            self.emit(OracleUpdated { old_oracle: old, new_oracle });
        }

        fn update_rwa_token_class_hash(ref self: ContractState, class_hash: ClassHash) {
            self._only_admin();
            self.rwa_token_class_hash.write(class_hash);
            self.emit(ClassHashUpdated { kind: 'token', new_hash: class_hash });
        }

        fn update_rwa_vault_class_hash(ref self: ContractState, class_hash: ClassHash) {
            self._only_admin();
            self.rwa_vault_class_hash.write(class_hash);
            self.emit(ClassHashUpdated { kind: 'vault', new_hash: class_hash });
        }

        fn set_creation_fee(ref self: ContractState, fee: u256) {
            self._only_admin();
            let old = self.creation_fee.read();
            self.creation_fee.write(fee);
            self.emit(FeeUpdated { old_fee: old, new_fee: fee });
        }

        fn transfer_admin(ref self: ContractState, new_admin: ContractAddress) {
            self._only_admin();
            self.pending_admin.write(new_admin);
            self.emit(AdminTransferInitiated {
                current_admin: get_caller_address(),
                pending_admin: new_admin,
            });
        }

        fn withdraw_fees(ref self: ContractState, recipient: ContractAddress) {
            self._only_admin();
            let fees = self.collected_fees.read();
            assert!(fees > 0_u256, "Factory: no fees to withdraw");
            // Transfer all collected fees (in fee_token) to recipient
            let token = IERC20Dispatcher { contract_address: self.fee_token.read() };
            let ok = token.transfer(recipient, fees);
            assert!(ok, "Factory: fee transfer failed");
            self.collected_fees.write(0_u256);
        }
    }

    // -------------------------------------------------------
    //  Internal helpers
    // -------------------------------------------------------
    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn _only_admin(self: @ContractState) {
            assert!(get_caller_address() == self.admin.read(), "Factory: not admin");
        }

        fn _read_metadata(self: @ContractState, rwa_id: u64) -> RWAMetadata {
            RWAMetadata {
                asset_type: _u8_to_asset_type(self.rwa_asset_type.read(rwa_id)),
                name: self.rwa_name.read(rwa_id),
                symbol: self.rwa_symbol.read(rwa_id),
                isin: self.rwa_isin.read(rwa_id),
                issuer: self.rwa_issuer.read(rwa_id),
                maturity_timestamp: self.rwa_maturity.read(rwa_id),
                par_value: self.rwa_par_value.read(rwa_id),
                yield_basis_points: self.rwa_yield_bps.read(rwa_id),
                inflation_indexed: self.rwa_inflation_indexed.read(rwa_id),
                token_address: self.rwa_token_addr.read(rwa_id),
                vault_address: self.rwa_vault_addr.read(rwa_id),
                creator: self.rwa_creator.read(rwa_id),
                created_at: self.rwa_created_at.read(rwa_id),
                total_supply_cap: self.rwa_supply_cap.read(rwa_id),
                is_active: self.rwa_is_active.read(rwa_id),
            }
        }

        fn _calculate_nav(self: @ContractState, rwa_id: u64) -> u128 {
            let par = self.rwa_par_value.read(rwa_id);  // par value in USD cents
            let is_indexed = self.rwa_inflation_indexed.read(rwa_id);

            if !is_indexed {
                return par;
            }

            // Inflation-adjusted NAV = par * (current_cpi / base_cpi)
            let oracle = IInflationOracleDispatcher {
                contract_address: self.oracle_address.read()
            };
            let current_cpi = oracle.get_cpi().value;
            let base_cpi = self.rwa_base_cpi.read(rwa_id);

            if base_cpi == 0 { return par; }

            (par * current_cpi) / base_cpi
        }

        fn _add_to_type_index(ref self: ContractState, asset_type: AssetType, rwa_id: u64) {
            match asset_type {
                AssetType::TreasuryBill => {
                    let count = self.type_count_tbill.read() + 1;
                    self.type_count_tbill.write(count);
                    self.tbill_ids.write(count, rwa_id);
                },
                AssetType::RealEstate => {
                    let count = self.type_count_realestate.read() + 1;
                    self.type_count_realestate.write(count);
                    self.realestate_ids.write(count, rwa_id);
                },
                AssetType::Commodity => {
                    let count = self.type_count_commodity.read() + 1;
                    self.type_count_commodity.write(count);
                    self.commodity_ids.write(count, rwa_id);
                },
                AssetType::CorporateBond => {
                    let count = self.type_count_corpbond.read() + 1;
                    self.type_count_corpbond.write(count);
                    self.corpbond_ids.write(count, rwa_id);
                },
                AssetType::InflationBond => {
                    let count = self.type_count_inflationbond.read() + 1;
                    self.type_count_inflationbond.write(count);
                    self.inflationbond_ids.write(count, rwa_id);
                },
            }
        }
    }

    // -------------------------------------------------------
    //  Free functions
    // -------------------------------------------------------

    fn _asset_type_to_u8(asset_type: AssetType) -> u8 {
        match asset_type {
            AssetType::TreasuryBill    => 0_u8,
            AssetType::RealEstate      => 1_u8,
            AssetType::Commodity       => 2_u8,
            AssetType::CorporateBond   => 3_u8,
            AssetType::InflationBond   => 4_u8,
        }
    }

    fn _u8_to_asset_type(v: u8) -> AssetType {
        if v == 0      { AssetType::TreasuryBill }
        else if v == 1 { AssetType::RealEstate }
        else if v == 2 { AssetType::Commodity }
        else if v == 3 { AssetType::CorporateBond }
        else           { AssetType::InflationBond }
    }

    fn _compute_salt(rwa_id: u64, kind: felt252, timestamp: u64) -> felt252 {
        let mut arr = ArrayTrait::new();
        arr.append(rwa_id.into());
        arr.append(kind);
        arr.append(timestamp.into());
        poseidon_hash_span(arr.span())
    }

    // -------------------------------------------------------
    //  Extra entrypoints
    // -------------------------------------------------------
    #[external(v0)]
    fn accept_admin(ref self: ContractState) {
        let caller = get_caller_address();
        assert!(caller == self.pending_admin.read(), "Factory: not pending admin");
        self.admin.write(caller);
        self.pending_admin.write(starknet::contract_address_const::<0>());
        self.emit(AdminTransferAccepted { new_admin: caller });
    }

    #[external(v0)]
    fn pause(ref self: ContractState) {
        assert!(get_caller_address() == self.admin.read(), "Factory: not admin");
        self.is_paused.write(true);
    }

    #[external(v0)]
    fn unpause(ref self: ContractState) {
        assert!(get_caller_address() == self.admin.read(), "Factory: not admin");
        self.is_paused.write(false);
    }
}
