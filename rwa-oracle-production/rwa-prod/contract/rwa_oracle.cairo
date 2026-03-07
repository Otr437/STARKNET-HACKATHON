// ============================================================
//  RWA Oracle Contract
//  Network  : StarkNet Mainnet
//  Language : Cairo 2.13.1
//  Compiler : Scarb 2.13.1
//  Sierra   : 1.7.0
//  Edition  : 2024_07
//
//  This is NOT a Solidity contract.
//  StarkNet uses Cairo → Sierra → CASM (not EVM/Solidity).
//  The equivalent of "pragma solidity ^0.8.x" in this ecosystem
//  is the [package] edition + starknet dependency pin in Scarb.toml.
//
//  Features:
//    - Multi-asset price feed (u256 price, u64 timestamp)
//    - Two-step ownership transfer (propose → accept)
//    - Multi-updater support with owner-controlled access
//    - Asset registration with metadata (symbol, decimals, asset_type)
//    - Staleness check with underflow-safe age calculation
//    - Native batch_update_price for gas efficiency
//    - Fully typed events for every state change
//    - Panic via assert! macro (Cairo 2.x best practice)
// ============================================================

// ─────────────────────────────────────────────────────────────
//  Public Interface
// ─────────────────────────────────────────────────────────────
#[starknet::interface]
pub trait IRwaOracle<TContractState> {
    // ── Two-step ownership transfer ───────────────────────────
    fn propose_owner(ref self: TContractState, new_owner: starknet::ContractAddress);
    fn accept_ownership(ref self: TContractState);
    fn renounce_ownership_proposal(ref self: TContractState);

    // ── Updater management ────────────────────────────────────
    fn add_updater(ref self: TContractState, updater: starknet::ContractAddress);
    fn remove_updater(ref self: TContractState, updater: starknet::ContractAddress);

    // ── Asset management ──────────────────────────────────────
    fn register_asset(
        ref self: TContractState,
        asset_id:   felt252,
        symbol:     felt252,
        decimals:   u8,
        asset_type: felt252,  // e.g. 'REAL_ESTATE', 'COMMODITY', 'EQUITY', 'MACRO'
    );
    fn reactivate_asset(ref self: TContractState, asset_id: felt252);
    fn deactivate_asset(ref self: TContractState, asset_id: felt252);

    // ── Price feed ────────────────────────────────────────────
    fn update_price(
        ref self: TContractState,
        asset_id:  felt252,
        price:     u256,   // price * 10^decimals
        timestamp: u64,    // unix seconds
    );

    /// Batch update — cheaper than individual calls when pushing many assets.
    /// asset_ids, prices, timestamps must be the same length.
    fn batch_update_price(
        ref self: TContractState,
        asset_ids:  Array<felt252>,
        prices:     Array<u256>,
        timestamps: Array<u64>,
    );

    // ── Views ──────────────────────────────────────────────────
    fn get_price(self: @TContractState, asset_id: felt252) -> (u256, u64);
    fn get_price_if_fresh(
        self: @TContractState,
        asset_id:           felt252,
        max_staleness_secs: u64,
    ) -> (u256, u64);
    fn get_asset_info(self: @TContractState, asset_id: felt252) -> RwaOracle::AssetInfo;
    fn is_updater(self: @TContractState, addr: starknet::ContractAddress) -> bool;
    fn get_owner(self: @TContractState) -> starknet::ContractAddress;
    fn get_pending_owner(self: @TContractState) -> starknet::ContractAddress;
}

// ─────────────────────────────────────────────────────────────
//  Contract
// ─────────────────────────────────────────────────────────────
#[starknet::contract]
pub mod RwaOracle {
    use starknet::{
        ContractAddress,
        get_caller_address,
        get_block_timestamp,
        contract_address_const,
    };
    use starknet::storage::{
        Map,
        StorageMapReadAccess,
        StorageMapWriteAccess,
        StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };

    // ── Zero address constant ─────────────────────────────────
    fn zero_address() -> ContractAddress {
        contract_address_const::<0>()
    }

    // ── Structs stored in mappings ────────────────────────────

    /// Price record for a single asset.
    #[derive(Drop, Copy, Serde, starknet::Store)]
    pub struct PriceData {
        pub price:     u256,
        pub timestamp: u64,
        pub updater:   ContractAddress,
    }

    /// Metadata registered once per asset.
    #[derive(Drop, Copy, Serde, starknet::Store)]
    pub struct AssetInfo {
        pub symbol:     felt252,
        pub decimals:   u8,
        pub asset_type: felt252,
        pub active:     bool,
    }

    // ── Storage ───────────────────────────────────────────────
    #[storage]
    struct Storage {
        // Access control
        owner:         ContractAddress,
        pending_owner: ContractAddress,  // two-step transfer
        updaters:      Map<ContractAddress, bool>,

        // Asset registry
        assets: Map<felt252, AssetInfo>,

        // Price feeds
        prices: Map<felt252, PriceData>,
    }

    // ── Events ────────────────────────────────────────────────
    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        OwnershipProposed:   OwnershipProposed,
        OwnershipTransferred: OwnershipTransferred,
        OwnershipProposalCancelled: OwnershipProposalCancelled,
        UpdaterAdded:        UpdaterAdded,
        UpdaterRemoved:      UpdaterRemoved,
        AssetRegistered:     AssetRegistered,
        AssetDeactivated:    AssetDeactivated,
        AssetReactivated:    AssetReactivated,
        PriceUpdated:        PriceUpdated,
    }

    #[derive(Drop, starknet::Event)]
    pub struct OwnershipProposed {
        #[key]
        pub current_owner:  ContractAddress,
        #[key]
        pub proposed_owner: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    pub struct OwnershipTransferred {
        #[key]
        pub previous_owner: ContractAddress,
        #[key]
        pub new_owner:      ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    pub struct OwnershipProposalCancelled {
        #[key]
        pub owner:           ContractAddress,
        pub cancelled_proposal: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    pub struct UpdaterAdded {
        #[key]
        pub updater: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    pub struct UpdaterRemoved {
        #[key]
        pub updater: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    pub struct AssetRegistered {
        #[key]
        pub asset_id:   felt252,
        pub symbol:     felt252,
        pub decimals:   u8,
        pub asset_type: felt252,
    }

    #[derive(Drop, starknet::Event)]
    pub struct AssetDeactivated {
        #[key]
        pub asset_id: felt252,
    }

    #[derive(Drop, starknet::Event)]
    pub struct AssetReactivated {
        #[key]
        pub asset_id: felt252,
    }

    #[derive(Drop, starknet::Event)]
    pub struct PriceUpdated {
        #[key]
        pub asset_id:  felt252,
        pub price:     u256,
        pub timestamp: u64,
        #[key]
        pub updater:   ContractAddress,
    }

    // ── Constructor ───────────────────────────────────────────
    #[constructor]
    fn constructor(ref self: ContractState, owner: ContractAddress) {
        assert!(owner != zero_address(), "RwaOracle: owner is zero address");
        self.owner.write(owner);
        self.pending_owner.write(zero_address());
        // Owner is also an updater by default
        self.updaters.write(owner, true);
        self.emit(UpdaterAdded { updater: owner });
    }

    // ── Internal helpers ──────────────────────────────────────
    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn assert_only_owner(self: @ContractState) {
            let caller = get_caller_address();
            let owner  = self.owner.read();
            assert!(caller == owner, "RwaOracle: caller is not owner");
        }

        fn assert_only_updater(self: @ContractState) {
            let caller  = get_caller_address();
            let is_auth = self.updaters.read(caller);
            assert!(is_auth, "RwaOracle: caller not updater");
        }

        fn assert_asset_active(self: @ContractState, asset_id: felt252) {
            let info = self.assets.read(asset_id);
            assert!(info.active, "RwaOracle: asset not active");
        }

        /// Internal single-price update — shared by update_price and batch_update_price.
        fn _update_price(
            ref self: ContractState,
            asset_id:  felt252,
            price:     u256,
            timestamp: u64,
            caller:    ContractAddress,
        ) {
            self.assert_asset_active(asset_id);

            let current = self.prices.read(asset_id);
            assert!(timestamp >= current.timestamp, "RwaOracle: stale timestamp");
            assert!(price > 0_u256, "RwaOracle: price must be > 0");

            let record = PriceData { price, timestamp, updater: caller };
            self.prices.write(asset_id, record);

            self.emit(PriceUpdated { asset_id, price, timestamp, updater: caller });
        }
    }

    // ── Public implementation ─────────────────────────────────
    #[abi(embed_v0)]
    impl RwaOracleImpl of super::IRwaOracle<ContractState> {

        // ── Two-step ownership ────────────────────────────────

        /// Step 1: Current owner proposes a new owner.
        fn propose_owner(ref self: ContractState, new_owner: ContractAddress) {
            self.assert_only_owner();
            assert!(new_owner != zero_address(), "RwaOracle: proposed owner is zero");
            let current = self.owner.read();
            assert!(new_owner != current, "RwaOracle: already the owner");

            self.pending_owner.write(new_owner);
            self.emit(OwnershipProposed { current_owner: current, proposed_owner: new_owner });
        }

        /// Step 2: Proposed owner accepts — completes the transfer.
        fn accept_ownership(ref self: ContractState) {
            let caller  = get_caller_address();
            let pending = self.pending_owner.read();
            assert!(pending != zero_address(), "RwaOracle: no pending owner");
            assert!(caller == pending, "RwaOracle: caller is not pending owner");

            let prev = self.owner.read();
            self.owner.write(caller);
            self.pending_owner.write(zero_address());

            // New owner becomes an updater automatically
            self.updaters.write(caller, true);
            self.emit(UpdaterAdded { updater: caller });
            self.emit(OwnershipTransferred { previous_owner: prev, new_owner: caller });
        }

        /// Current owner cancels a pending transfer proposal.
        fn renounce_ownership_proposal(ref self: ContractState) {
            self.assert_only_owner();
            let pending = self.pending_owner.read();
            assert!(pending != zero_address(), "RwaOracle: no pending proposal");
            self.pending_owner.write(zero_address());
            let owner = self.owner.read();
            self.emit(OwnershipProposalCancelled { owner, cancelled_proposal: pending });
        }

        // ── Updater management ────────────────────────────────

        fn add_updater(ref self: ContractState, updater: ContractAddress) {
            self.assert_only_owner();
            assert!(updater != zero_address(), "RwaOracle: updater is zero address");
            self.updaters.write(updater, true);
            self.emit(UpdaterAdded { updater });
        }

        fn remove_updater(ref self: ContractState, updater: ContractAddress) {
            self.assert_only_owner();
            // Owner cannot remove themselves — prevents locking the contract
            let owner = self.owner.read();
            assert!(updater != owner, "RwaOracle: cannot remove owner as updater");
            self.updaters.write(updater, false);
            self.emit(UpdaterRemoved { updater });
        }

        // ── Asset management ──────────────────────────────────

        fn register_asset(
            ref self: ContractState,
            asset_id:   felt252,
            symbol:     felt252,
            decimals:   u8,
            asset_type: felt252,
        ) {
            self.assert_only_owner();
            assert!(asset_id != 0, "RwaOracle: asset_id is zero");
            assert!(symbol != 0,   "RwaOracle: symbol is zero");
            assert!(decimals <= 18_u8, "RwaOracle: decimals too large");

            let existing = self.assets.read(asset_id);
            assert!(!existing.active, "RwaOracle: asset already active");

            let info = AssetInfo { symbol, decimals, asset_type, active: true };
            self.assets.write(asset_id, info);
            self.emit(AssetRegistered { asset_id, symbol, decimals, asset_type });
        }

        fn deactivate_asset(ref self: ContractState, asset_id: felt252) {
            self.assert_only_owner();
            let mut info = self.assets.read(asset_id);
            assert!(info.active, "RwaOracle: asset already inactive");
            info.active = false;
            self.assets.write(asset_id, info);
            self.emit(AssetDeactivated { asset_id });
        }

        fn reactivate_asset(ref self: ContractState, asset_id: felt252) {
            self.assert_only_owner();
            let mut info = self.assets.read(asset_id);
            assert!(!info.active, "RwaOracle: asset already active");
            assert!(info.symbol != 0, "RwaOracle: asset never registered");
            info.active = true;
            self.assets.write(asset_id, info);
            self.emit(AssetReactivated { asset_id });
        }

        // ── Single price update ───────────────────────────────

        fn update_price(
            ref self: ContractState,
            asset_id:  felt252,
            price:     u256,
            timestamp: u64,
        ) {
            self.assert_only_updater();
            let caller = get_caller_address();
            self._update_price(asset_id, price, timestamp, caller);
        }

        // ── Batch price update ────────────────────────────────
        // All three arrays must be the same length. More gas-efficient
        // than individual calls for pushing many assets per cycle.

        fn batch_update_price(
            ref self: ContractState,
            asset_ids:  Array<felt252>,
            prices:     Array<u256>,
            timestamps: Array<u64>,
        ) {
            self.assert_only_updater();
            let caller = get_caller_address();
            let n = asset_ids.len();
            assert!(n > 0,                "RwaOracle: empty batch");
            assert!(n == prices.len(),    "RwaOracle: array length mismatch");
            assert!(n == timestamps.len(),"RwaOracle: array length mismatch");
            assert!(n <= 50_u32,          "RwaOracle: batch too large (max 50)");

            let mut i: u32 = 0;
            loop {
                if i == n { break; }
                self._update_price(
                    *asset_ids.at(i),
                    *prices.at(i),
                    *timestamps.at(i),
                    caller,
                );
                i += 1;
            };
        }

        // ── Views ──────────────────────────────────────────────

        fn get_price(self: @ContractState, asset_id: felt252) -> (u256, u64) {
            self.assert_asset_active(asset_id);
            let record = self.prices.read(asset_id);
            assert!(record.timestamp > 0, "RwaOracle: no price yet");
            (record.price, record.timestamp)
        }

        fn get_price_if_fresh(
            self: @ContractState,
            asset_id:           felt252,
            max_staleness_secs: u64,
        ) -> (u256, u64) {
            self.assert_asset_active(asset_id);
            let record = self.prices.read(asset_id);
            assert!(record.timestamp > 0, "RwaOracle: no price yet");

            let now: u64 = get_block_timestamp();
            // Underflow-safe: if block time is somehow behind stored timestamp,
            // treat age as 0 (price is fresh).
            let age: u64 = if now >= record.timestamp {
                now - record.timestamp
            } else {
                0_u64
            };
            assert!(age <= max_staleness_secs, "RwaOracle: price is stale");

            (record.price, record.timestamp)
        }

        fn get_asset_info(self: @ContractState, asset_id: felt252) -> AssetInfo {
            self.assets.read(asset_id)
        }

        fn is_updater(self: @ContractState, addr: ContractAddress) -> bool {
            self.updaters.read(addr)
        }

        fn get_owner(self: @ContractState) -> ContractAddress {
            self.owner.read()
        }

        fn get_pending_owner(self: @ContractState) -> ContractAddress {
            self.pending_owner.read()
        }
    }
}


// ─────────────────────────────────────────────────────────────
//  Tests  (run with: scarb test  OR  snforge test)
// ─────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::RwaOracle;
    use super::IRwaOracleDispatcher;
    use super::IRwaOracleDispatcherTrait;

    use snforge_std::{
        declare,
        ContractClassTrait,
        DeclareResultTrait,
        start_cheat_caller_address,
        stop_cheat_caller_address,
        start_cheat_block_timestamp,
        stop_cheat_block_timestamp,
        spy_events,
        EventSpyAssertionsTrait,
    };
    use starknet::{ContractAddress, contract_address_const};

    // ── Helpers ───────────────────────────────────────────────
    fn owner() -> ContractAddress {
        contract_address_const::<'owner'>()
    }

    fn updater2() -> ContractAddress {
        contract_address_const::<'updater2'>()
    }

    fn stranger() -> ContractAddress {
        contract_address_const::<'stranger'>()
    }

    fn deploy() -> (IRwaOracleDispatcher, ContractAddress) {
        let contract = declare("RwaOracle").unwrap().contract_class();
        let calldata = array![owner().into()];
        let (addr, _) = contract.deploy(@calldata).unwrap();
        (IRwaOracleDispatcher { contract_address: addr }, addr)
    }

    // ── Ownership tests ───────────────────────────────────────

    #[test]
    fn test_owner_set_on_deploy() {
        let (oracle, _) = deploy();
        assert!(oracle.get_owner() == owner(), "Owner should match constructor");
    }

    #[test]
    fn test_owner_is_default_updater() {
        let (oracle, _) = deploy();
        assert!(oracle.is_updater(owner()), "Owner should be updater");
    }

    #[test]
    fn test_two_step_ownership_transfer() {
        let (oracle, addr) = deploy();
        let new_owner = contract_address_const::<'new_owner'>();

        // Step 1: owner proposes
        start_cheat_caller_address(addr, owner());
        oracle.propose_owner(new_owner);
        stop_cheat_caller_address(addr);

        assert!(oracle.get_pending_owner() == new_owner, "Pending owner should be set");
        assert!(oracle.get_owner() == owner(), "Owner should not change yet");

        // Step 2: new owner accepts
        start_cheat_caller_address(addr, new_owner);
        oracle.accept_ownership();
        stop_cheat_caller_address(addr);

        assert!(oracle.get_owner() == new_owner, "Ownership not transferred");
        assert!(oracle.get_pending_owner() == contract_address_const::<0>(), "Pending should be cleared");
        assert!(oracle.is_updater(new_owner), "New owner should be updater");
    }

    #[test]
    #[should_panic(expected: ("RwaOracle: caller is not pending owner",))]
    fn test_wrong_address_cannot_accept_ownership() {
        let (oracle, addr) = deploy();
        let new_owner = contract_address_const::<'new_owner'>();

        start_cheat_caller_address(addr, owner());
        oracle.propose_owner(new_owner);
        stop_cheat_caller_address(addr);

        // stranger tries to accept — should panic
        start_cheat_caller_address(addr, stranger());
        oracle.accept_ownership();
        stop_cheat_caller_address(addr);
    }

    #[test]
    fn test_cancel_ownership_proposal() {
        let (oracle, addr) = deploy();
        let new_owner = contract_address_const::<'new_owner'>();

        start_cheat_caller_address(addr, owner());
        oracle.propose_owner(new_owner);
        oracle.renounce_ownership_proposal();
        stop_cheat_caller_address(addr);

        assert!(oracle.get_pending_owner() == contract_address_const::<0>(), "Pending should be cleared");
    }

    // ── Asset tests ───────────────────────────────────────────

    #[test]
    fn test_register_and_get_asset() {
        let (oracle, addr) = deploy();

        start_cheat_caller_address(addr, owner());
        oracle.register_asset('PROP_001', 'PROP', 6, 'REAL_ESTATE');
        stop_cheat_caller_address(addr);

        let info = oracle.get_asset_info('PROP_001');
        assert!(info.symbol == 'PROP', "Symbol mismatch");
        assert!(info.decimals == 6, "Decimals mismatch");
        assert!(info.active, "Should be active");
    }

    #[test]
    fn test_deactivate_and_reactivate_asset() {
        let (oracle, addr) = deploy();

        start_cheat_caller_address(addr, owner());
        oracle.register_asset('GOLD_X', 'XAU', 8, 'COMMODITY');
        oracle.deactivate_asset('GOLD_X');
        stop_cheat_caller_address(addr);

        let info = oracle.get_asset_info('GOLD_X');
        assert!(!info.active, "Should be inactive");

        start_cheat_caller_address(addr, owner());
        oracle.reactivate_asset('GOLD_X');
        stop_cheat_caller_address(addr);

        let info2 = oracle.get_asset_info('GOLD_X');
        assert!(info2.active, "Should be active again");
    }

    #[test]
    #[should_panic(expected: ("RwaOracle: asset already active",))]
    fn test_cannot_register_same_asset_twice() {
        let (oracle, addr) = deploy();

        start_cheat_caller_address(addr, owner());
        oracle.register_asset('PROP_A', 'PROPA', 6, 'REAL_ESTATE');
        oracle.register_asset('PROP_A', 'PROPA', 6, 'REAL_ESTATE');
        stop_cheat_caller_address(addr);
    }

    // ── Price tests ───────────────────────────────────────────

    #[test]
    fn test_update_and_get_price() {
        let (oracle, addr) = deploy();

        start_cheat_caller_address(addr, owner());
        oracle.register_asset('GOLD_01', 'XAU', 8, 'COMMODITY');
        oracle.update_price('GOLD_01', 3_200_000_00000000_u256, 1_000_000_u64);
        stop_cheat_caller_address(addr);

        let (price, ts) = oracle.get_price('GOLD_01');
        assert!(price == 3_200_000_00000000_u256, "Price mismatch");
        assert!(ts == 1_000_000_u64, "Timestamp mismatch");
    }

    #[test]
    fn test_batch_update_price() {
        let (oracle, addr) = deploy();

        start_cheat_caller_address(addr, owner());
        oracle.register_asset('XAU_USD', 'XAU', 8, 'COMMODITY');
        oracle.register_asset('XAG_USD', 'XAG', 8, 'COMMODITY');
        oracle.register_asset('WTI_USD', 'WTI', 8, 'COMMODITY');

        oracle.batch_update_price(
            array!['XAU_USD', 'XAG_USD', 'WTI_USD'],
            array![3_200_000_00000000_u256, 32_00000000_u256, 78_00000000_u256],
            array![1_000_000_u64, 1_000_000_u64, 1_000_000_u64],
        );
        stop_cheat_caller_address(addr);

        let (gold_price, _) = oracle.get_price('XAU_USD');
        let (silver_price, _) = oracle.get_price('XAG_USD');
        let (wti_price, _) = oracle.get_price('WTI_USD');

        assert!(gold_price   == 3_200_000_00000000_u256, "Gold price mismatch");
        assert!(silver_price == 32_00000000_u256, "Silver price mismatch");
        assert!(wti_price    == 78_00000000_u256, "WTI price mismatch");
    }

    #[test]
    #[should_panic(expected: ("RwaOracle: array length mismatch",))]
    fn test_batch_mismatched_arrays_panics() {
        let (oracle, addr) = deploy();

        start_cheat_caller_address(addr, owner());
        oracle.register_asset('XAU_USD', 'XAU', 8, 'COMMODITY');
        oracle.batch_update_price(
            array!['XAU_USD', 'XAG_USD'],  // 2 ids
            array![1_u256],                 // 1 price — mismatch
            array![1000_u64],
        );
        stop_cheat_caller_address(addr);
    }

    #[test]
    fn test_get_price_if_fresh_passes() {
        let (oracle, addr) = deploy();

        start_cheat_caller_address(addr, owner());
        oracle.register_asset('TSLA', 'TSLA', 8, 'EQUITY');
        oracle.update_price('TSLA', 340_00000000_u256, 5000_u64);
        stop_cheat_caller_address(addr);

        start_cheat_block_timestamp(addr, 5100_u64);
        let (price, _ts) = oracle.get_price_if_fresh('TSLA', 200_u64);
        assert!(price == 340_00000000_u256, "Stale check should pass");
        stop_cheat_block_timestamp(addr);
    }

    #[test]
    #[should_panic(expected: ("RwaOracle: price is stale",))]
    fn test_get_price_if_fresh_fails_when_stale() {
        let (oracle, addr) = deploy();

        start_cheat_caller_address(addr, owner());
        oracle.register_asset('TSLA', 'TSLA', 8, 'EQUITY');
        oracle.update_price('TSLA', 340_00000000_u256, 1000_u64);
        stop_cheat_caller_address(addr);

        start_cheat_block_timestamp(addr, 2500_u64);
        oracle.get_price_if_fresh('TSLA', 500_u64);
        stop_cheat_block_timestamp(addr);
    }

    #[test]
    #[should_panic(expected: ("RwaOracle: caller not updater",))]
    fn test_stranger_cannot_update_price() {
        let (oracle, addr) = deploy();

        start_cheat_caller_address(addr, owner());
        oracle.register_asset('BTC_RWA', 'BTCRWA', 8, 'COMMODITY');
        stop_cheat_caller_address(addr);

        start_cheat_caller_address(addr, stranger());
        oracle.update_price('BTC_RWA', 100_000_00000000_u256, 9999_u64);
        stop_cheat_caller_address(addr);
    }

    #[test]
    fn test_add_and_use_new_updater() {
        let (oracle, addr) = deploy();

        start_cheat_caller_address(addr, owner());
        oracle.register_asset('ETH_RWA', 'ETHRWA', 8, 'COMMODITY');
        oracle.add_updater(updater2());
        stop_cheat_caller_address(addr);

        assert!(oracle.is_updater(updater2()), "Should be an updater now");

        start_cheat_caller_address(addr, updater2());
        oracle.update_price('ETH_RWA', 3_500_00000000_u256, 7777_u64);
        stop_cheat_caller_address(addr);

        let (p, _) = oracle.get_price('ETH_RWA');
        assert!(p == 3_500_00000000_u256, "Price from new updater failed");
    }

    #[test]
    #[should_panic(expected: ("RwaOracle: caller is not owner",))]
    fn test_stranger_cannot_add_updater() {
        let (oracle, addr) = deploy();
        start_cheat_caller_address(addr, stranger());
        oracle.add_updater(stranger());
        stop_cheat_caller_address(addr);
    }

    #[test]
    #[should_panic(expected: ("RwaOracle: cannot remove owner as updater",))]
    fn test_owner_cannot_remove_themselves_as_updater() {
        let (oracle, addr) = deploy();
        start_cheat_caller_address(addr, owner());
        oracle.remove_updater(owner());
        stop_cheat_caller_address(addr);
    }

    #[test]
    #[should_panic(expected: ("RwaOracle: stale timestamp",))]
    fn test_cannot_submit_older_timestamp() {
        let (oracle, addr) = deploy();

        start_cheat_caller_address(addr, owner());
        oracle.register_asset('HOUSE_1', 'HSE1', 0, 'REAL_ESTATE');
        oracle.update_price('HOUSE_1', 500_000_u256, 2000_u64);
        oracle.update_price('HOUSE_1', 480_000_u256, 1000_u64);
        stop_cheat_caller_address(addr);
    }

    #[test]
    #[should_panic(expected: ("RwaOracle: price must be > 0",))]
    fn test_cannot_submit_zero_price() {
        let (oracle, addr) = deploy();

        start_cheat_caller_address(addr, owner());
        oracle.register_asset('XAU_USD', 'XAU', 8, 'COMMODITY');
        oracle.update_price('XAU_USD', 0_u256, 1000_u64);
        stop_cheat_caller_address(addr);
    }

    #[test]
    #[should_panic(expected: ("RwaOracle: decimals too large",))]
    fn test_cannot_register_asset_with_decimals_over_18() {
        let (oracle, addr) = deploy();

        start_cheat_caller_address(addr, owner());
        oracle.register_asset('BAD_ASSET', 'BAD', 19, 'COMMODITY');
        stop_cheat_caller_address(addr);
    }
}
