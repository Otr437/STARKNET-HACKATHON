// SPDX-License-Identifier: MIT
// Private BTC Swap Contract - HTLC with Privacy Features
// Implements atomic swaps with hash time-locked contracts

#[starknet::contract]
mod PrivateBTCSwap {
    use openzeppelin::access::accesscontrol::AccessControlComponent;
    use openzeppelin::security::pausable::PausableComponent;
    use openzeppelin::security::reentrancyguard::ReentrancyGuardComponent;
    use openzeppelin::upgrades::UpgradeableComponent;
    use openzeppelin::upgrades::interface::IUpgradeable;
    use openzeppelin::introspection::src5::SRC5Component;
    use openzeppelin::token::erc20::interface::{IERC20Dispatcher, IERC20DispatcherTrait};
    use starknet::{ContractAddress, get_caller_address, get_contract_address, ClassHash};
    use starknet::storage::{
        StoragePointerReadAccess, StoragePointerWriteAccess, StoragePathEntry, Map
    };
    use core::poseidon::poseidon_hash_span;

    // Role definitions
    const DEFAULT_ADMIN_ROLE: felt252 = 0;
    const OPERATOR_ROLE: felt252 = selector!("OPERATOR_ROLE");
    const PAUSER_ROLE: felt252 = selector!("PAUSER_ROLE");
    const UPGRADER_ROLE: felt252 = selector!("UPGRADER_ROLE");

    // Swap status enum
    #[derive(Drop, Serde, Copy, PartialEq, starknet::Store)]
    enum SwapStatus {
        Pending,
        Active,
        Completed,
        Refunded,
        Expired
    }

    // Swap struct
    #[derive(Drop, Serde, Copy, starknet::Store)]
    struct Swap {
        initiator: ContractAddress,
        participant: ContractAddress,
        token: ContractAddress,
        amount: u256,
        hash_lock: felt252,
        secret_hash: felt252,
        time_lock: u64,
        status: SwapStatus,
        created_at: u64,
    }

    // Components
    component!(path: AccessControlComponent, storage: accesscontrol, event: AccessControlEvent);
    component!(path: PausableComponent, storage: pausable, event: PausableEvent);
    component!(
        path: ReentrancyGuardComponent, storage: reentrancy, event: ReentrancyGuardEvent
    );
    component!(path: UpgradeableComponent, storage: upgradeable, event: UpgradeableEvent);
    component!(path: SRC5Component, storage: src5, event: SRC5Event);

    // Component implementations
    #[abi(embed_v0)]
    impl AccessControlImpl =
        AccessControlComponent::AccessControlImpl<ContractState>;
    impl AccessControlInternalImpl = AccessControlComponent::InternalImpl<ContractState>;

    #[abi(embed_v0)]
    impl PausableImpl = PausableComponent::PausableImpl<ContractState>;
    impl PausableInternalImpl = PausableComponent::InternalImpl<ContractState>;

    impl ReentrancyGuardInternalImpl =
        ReentrancyGuardComponent::InternalImpl<ContractState>;

    impl UpgradeableInternalImpl = UpgradeableComponent::InternalImpl<ContractState>;

    #[abi(embed_v0)]
    impl SRC5Impl = SRC5Component::SRC5Impl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        accesscontrol: AccessControlComponent::Storage,
        #[substorage(v0)]
        pausable: PausableComponent::Storage,
        #[substorage(v0)]
        reentrancy: ReentrancyGuardComponent::Storage,
        #[substorage(v0)]
        upgradeable: UpgradeableComponent::Storage,
        #[substorage(v0)]
        src5: SRC5Component::Storage,
        // Swap state
        swaps: Map<felt252, Swap>, // swap_id => Swap
        swap_counter: u256,
        min_time_lock: u64, // minimum time lock in seconds
        max_time_lock: u64, // maximum time lock in seconds
        fee_percentage: u256, // basis points
        treasury: ContractAddress,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        AccessControlEvent: AccessControlComponent::Event,
        #[flat]
        PausableEvent: PausableComponent::Event,
        #[flat]
        ReentrancyGuardEvent: ReentrancyGuardComponent::Event,
        #[flat]
        UpgradeableEvent: UpgradeableComponent::Event,
        #[flat]
        SRC5Event: SRC5Component::Event,
        SwapInitiated: SwapInitiated,
        SwapCompleted: SwapCompleted,
        SwapRefunded: SwapRefunded,
        SwapExpired: SwapExpired,
    }

    #[derive(Drop, starknet::Event)]
    struct SwapInitiated {
        #[key]
        swap_id: felt252,
        #[key]
        initiator: ContractAddress,
        participant: ContractAddress,
        token: ContractAddress,
        amount: u256,
        time_lock: u64,
        timestamp: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct SwapCompleted {
        #[key]
        swap_id: felt252,
        #[key]
        participant: ContractAddress,
        secret: felt252,
        timestamp: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct SwapRefunded {
        #[key]
        swap_id: felt252,
        #[key]
        initiator: ContractAddress,
        timestamp: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct SwapExpired {
        #[key]
        swap_id: felt252,
        timestamp: u64,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        admin: ContractAddress,
        treasury: ContractAddress,
        min_time_lock: u64,
        max_time_lock: u64,
        fee_percentage: u256
    ) {
        // Initialize components
        self.accesscontrol.initializer();
        self.pausable.initializer();
        self.reentrancy.initializer();

        // Grant roles
        self.accesscontrol._grant_role(DEFAULT_ADMIN_ROLE, admin);
        self.accesscontrol._grant_role(OPERATOR_ROLE, admin);
        self.accesscontrol._grant_role(PAUSER_ROLE, admin);
        self.accesscontrol._grant_role(UPGRADER_ROLE, admin);

        // Initialize state
        self.swap_counter.write(0);
        self.min_time_lock.write(min_time_lock);
        self.max_time_lock.write(max_time_lock);
        self.fee_percentage.write(fee_percentage);
        self.treasury.write(treasury);
    }

    #[abi(embed_v0)]
    impl PrivateBTCSwapImpl of IPrivateBTCSwap<ContractState> {
        fn initiate_swap(
            ref self: ContractState,
            participant: ContractAddress,
            token: ContractAddress,
            amount: u256,
            secret_hash: felt252,
            time_lock: u64
        ) -> felt252 {
            self.pausable.assert_not_paused();
            self.reentrancy.start();

            let caller = get_caller_address();
            let this = get_contract_address();
            let current_time = starknet::get_block_timestamp();

            // Validate time lock
            assert(time_lock >= self.min_time_lock.read(), 'Time lock too short');
            assert(time_lock <= self.max_time_lock.read(), 'Time lock too long');

            // Generate unique swap ID using Poseidon hash
            let counter = self.swap_counter.read();
            let swap_id_data = array![
                caller.into(), participant.into(), counter.low.into(), current_time.into()
            ];
            let swap_id = poseidon_hash_span(swap_id_data.span());

            // Create swap
            let swap = Swap {
                initiator: caller,
                participant,
                token,
                amount,
                hash_lock: 0, // To be filled when secret is revealed
                secret_hash,
                time_lock: current_time + time_lock,
                status: SwapStatus::Active,
                created_at: current_time,
            };

            self.swaps.entry(swap_id).write(swap);
            self.swap_counter.write(counter + 1);

            // Transfer tokens to contract
            let token_dispatcher = IERC20Dispatcher { contract_address: token };
            token_dispatcher.transfer_from(caller, this, amount);

            self
                .emit(
                    SwapInitiated {
                        swap_id,
                        initiator: caller,
                        participant,
                        token,
                        amount,
                        time_lock: current_time + time_lock,
                        timestamp: current_time
                    }
                );

            self.reentrancy.end();
            swap_id
        }

        fn complete_swap(ref self: ContractState, swap_id: felt252, secret: felt252) {
            self.pausable.assert_not_paused();
            self.reentrancy.start();

            let caller = get_caller_address();
            let mut swap = self.swaps.entry(swap_id).read();

            // Validate swap
            assert(swap.status == SwapStatus::Active, 'Swap not active');
            assert(caller == swap.participant, 'Not participant');

            // Verify secret hash using Poseidon
            let secret_hash_computed = poseidon_hash_span(array![secret].span());
            assert(secret_hash_computed == swap.secret_hash, 'Invalid secret');

            // Check time lock
            let current_time = starknet::get_block_timestamp();
            assert(current_time < swap.time_lock, 'Swap expired');

            // Calculate fee
            let fee = (swap.amount * self.fee_percentage.read()) / 10000;
            let amount_after_fee = swap.amount - fee;

            // Update swap status
            swap.status = SwapStatus::Completed;
            swap.hash_lock = secret;
            self.swaps.entry(swap_id).write(swap);

            // Transfer tokens to participant
            let token_dispatcher = IERC20Dispatcher { contract_address: swap.token };
            token_dispatcher.transfer(swap.participant, amount_after_fee);

            // Transfer fee to treasury
            if fee > 0 {
                token_dispatcher.transfer(self.treasury.read(), fee);
            }

            self
                .emit(
                    SwapCompleted {
                        swap_id, participant: caller, secret, timestamp: current_time
                    }
                );

            self.reentrancy.end();
        }

        fn refund_swap(ref self: ContractState, swap_id: felt252) {
            self.reentrancy.start();

            let caller = get_caller_address();
            let mut swap = self.swaps.entry(swap_id).read();

            // Validate swap
            assert(swap.status == SwapStatus::Active, 'Swap not active');
            assert(caller == swap.initiator, 'Not initiator');

            // Check time lock expired
            let current_time = starknet::get_block_timestamp();
            assert(current_time >= swap.time_lock, 'Time lock not expired');

            // Update swap status
            swap.status = SwapStatus::Refunded;
            self.swaps.entry(swap_id).write(swap);

            // Refund tokens to initiator
            let token_dispatcher = IERC20Dispatcher { contract_address: swap.token };
            token_dispatcher.transfer(swap.initiator, swap.amount);

            self.emit(SwapRefunded { swap_id, initiator: caller, timestamp: current_time });

            self.reentrancy.end();
        }

        fn get_swap(self: @ContractState, swap_id: felt252) -> Swap {
            self.swaps.entry(swap_id).read()
        }

        fn pause(ref self: ContractState) {
            self.accesscontrol.assert_only_role(PAUSER_ROLE);
            self.pausable.pause();
        }

        fn unpause(ref self: ContractState) {
            self.accesscontrol.assert_only_role(PAUSER_ROLE);
            self.pausable.unpause();
        }

        fn set_time_locks(
            ref self: ContractState, min_time_lock: u64, max_time_lock: u64
        ) {
            self.accesscontrol.assert_only_role(DEFAULT_ADMIN_ROLE);
            assert(min_time_lock < max_time_lock, 'Invalid time locks');
            self.min_time_lock.write(min_time_lock);
            self.max_time_lock.write(max_time_lock);
        }

        fn set_fee(ref self: ContractState, new_fee: u256) {
            self.accesscontrol.assert_only_role(DEFAULT_ADMIN_ROLE);
            assert(new_fee <= 10000, 'Fee too high');
            self.fee_percentage.write(new_fee);
        }
    }

    #[abi(embed_v0)]
    impl UpgradeableImpl of IUpgradeable<ContractState> {
        fn upgrade(ref self: ContractState, new_class_hash: ClassHash) {
            self.accesscontrol.assert_only_role(UPGRADER_ROLE);
            self.upgradeable.upgrade(new_class_hash);
        }
    }

    #[starknet::interface]
    trait IPrivateBTCSwap<TContractState> {
        fn initiate_swap(
            ref self: TContractState,
            participant: ContractAddress,
            token: ContractAddress,
            amount: u256,
            secret_hash: felt252,
            time_lock: u64
        ) -> felt252;
        fn complete_swap(ref self: TContractState, swap_id: felt252, secret: felt252);
        fn refund_swap(ref self: TContractState, swap_id: felt252);
        fn get_swap(self: @TContractState, swap_id: felt252) -> Swap;
        fn pause(ref self: TContractState);
        fn unpause(ref self: TContractState);
        fn set_time_locks(ref self: TContractState, min_time_lock: u64, max_time_lock: u64);
        fn set_fee(ref self: TContractState, new_fee: u256);
    }
}
