// SPDX-License-Identifier: MIT
// Vault Manager Contract - Production Ready with Access Control
// Manages vault deposits, withdrawals, and curator operations

#[starknet::contract]
mod VaultManager {
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
    use core::num::traits::Zero;

    // Role definitions
    const DEFAULT_ADMIN_ROLE: felt252 = 0;
    const CURATOR_ROLE: felt252 = selector!("CURATOR_ROLE");
    const MANAGER_ROLE: felt252 = selector!("MANAGER_ROLE");
    const PAUSER_ROLE: felt252 = selector!("PAUSER_ROLE");
    const UPGRADER_ROLE: felt252 = selector!("UPGRADER_ROLE");

    // Components
    component!(path: AccessControlComponent, storage: accesscontrol, event: AccessControlEvent);
    component!(path: PausableComponent, storage: pausable, event: PausableEvent);
    component!(
        path: ReentrancyGuardComponent, storage: reentrancy, event: ReentrancyGuardEvent
    );
    component!(path: UpgradeableComponent, storage: upgradeable, event: UpgradeableEvent);
    component!(path: SRC5Component, storage: src5, event: SRC5Event);

    // AccessControl
    #[abi(embed_v0)]
    impl AccessControlImpl =
        AccessControlComponent::AccessControlImpl<ContractState>;
    impl AccessControlInternalImpl = AccessControlComponent::InternalImpl<ContractState>;

    // Pausable
    #[abi(embed_v0)]
    impl PausableImpl = PausableComponent::PausableImpl<ContractState>;
    impl PausableInternalImpl = PausableComponent::InternalImpl<ContractState>;

    // ReentrancyGuard
    impl ReentrancyGuardInternalImpl =
        ReentrancyGuardComponent::InternalImpl<ContractState>;

    // Upgradeable
    impl UpgradeableInternalImpl = UpgradeableComponent::InternalImpl<ContractState>;

    // SRC5
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
        // Vault state
        vault_balance: Map<ContractAddress, u256>, // token => balance
        user_deposits: Map<(ContractAddress, ContractAddress), u256>, // (user, token) => amount
        curator_allocations: Map<(ContractAddress, ContractAddress), u256>, // (curator, token) => allocated amount
        total_deposits: Map<ContractAddress, u256>, // token => total deposits
        vault_fee_percentage: u256, // basis points (10000 = 100%)
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
        Deposit: Deposit,
        Withdrawal: Withdrawal,
        CuratorAllocation: CuratorAllocation,
        FeeCollected: FeeCollected,
        TreasuryUpdated: TreasuryUpdated,
    }

    #[derive(Drop, starknet::Event)]
    struct Deposit {
        #[key]
        user: ContractAddress,
        #[key]
        token: ContractAddress,
        amount: u256,
        timestamp: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct Withdrawal {
        #[key]
        user: ContractAddress,
        #[key]
        token: ContractAddress,
        amount: u256,
        fee: u256,
        timestamp: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct CuratorAllocation {
        #[key]
        curator: ContractAddress,
        #[key]
        token: ContractAddress,
        amount: u256,
        timestamp: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct FeeCollected {
        #[key]
        token: ContractAddress,
        amount: u256,
        timestamp: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct TreasuryUpdated {
        old_treasury: ContractAddress,
        new_treasury: ContractAddress,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        admin: ContractAddress,
        treasury: ContractAddress,
        initial_fee: u256
    ) {
        // Initialize components
        self.accesscontrol.initializer();
        self.pausable.initializer();
        self.reentrancy.initializer();

        // Grant roles
        self.accesscontrol._grant_role(DEFAULT_ADMIN_ROLE, admin);
        self.accesscontrol._grant_role(CURATOR_ROLE, admin);
        self.accesscontrol._grant_role(MANAGER_ROLE, admin);
        self.accesscontrol._grant_role(PAUSER_ROLE, admin);
        self.accesscontrol._grant_role(UPGRADER_ROLE, admin);

        // Set initial state
        self.treasury.write(treasury);
        self.vault_fee_percentage.write(initial_fee);
    }

    #[abi(embed_v0)]
    impl VaultManagerImpl of IVaultManager<ContractState> {
        fn deposit(ref self: ContractState, token: ContractAddress, amount: u256) {
            self.pausable.assert_not_paused();
            self.reentrancy.start();

            let caller = get_caller_address();
            let this = get_contract_address();

            // Transfer tokens from user to vault
            let token_dispatcher = IERC20Dispatcher { contract_address: token };
            token_dispatcher.transfer_from(caller, this, amount);

            // Update balances
            let current_deposit = self.user_deposits.entry((caller, token)).read();
            self.user_deposits.entry((caller, token)).write(current_deposit + amount);

            let current_total = self.total_deposits.entry(token).read();
            self.total_deposits.entry(token).write(current_total + amount);

            let current_vault = self.vault_balance.entry(token).read();
            self.vault_balance.entry(token).write(current_vault + amount);

            self
                .emit(
                    Deposit {
                        user: caller,
                        token,
                        amount,
                        timestamp: starknet::get_block_timestamp()
                    }
                );

            self.reentrancy.end();
        }

        fn withdraw(ref self: ContractState, token: ContractAddress, amount: u256) {
            self.pausable.assert_not_paused();
            self.reentrancy.start();

            let caller = get_caller_address();
            let user_balance = self.user_deposits.entry((caller, token)).read();

            assert(amount <= user_balance, 'Insufficient balance');

            // Calculate fee
            let fee = (amount * self.vault_fee_percentage.read()) / 10000;
            let amount_after_fee = amount - fee;

            // Update balances
            self.user_deposits.entry((caller, token)).write(user_balance - amount);

            let current_total = self.total_deposits.entry(token).read();
            self.total_deposits.entry(token).write(current_total - amount);

            let current_vault = self.vault_balance.entry(token).read();
            self.vault_balance.entry(token).write(current_vault - amount);

            // Transfer tokens
            let token_dispatcher = IERC20Dispatcher { contract_address: token };
            token_dispatcher.transfer(caller, amount_after_fee);

            // Send fee to treasury
            if fee > 0 {
                token_dispatcher.transfer(self.treasury.read(), fee);
                self.emit(FeeCollected { token, amount: fee, timestamp: starknet::get_block_timestamp() });
            }

            self
                .emit(
                    Withdrawal {
                        user: caller,
                        token,
                        amount,
                        fee,
                        timestamp: starknet::get_block_timestamp()
                    }
                );

            self.reentrancy.end();
        }

        fn allocate_to_curator(
            ref self: ContractState,
            curator: ContractAddress,
            token: ContractAddress,
            amount: u256
        ) {
            self.accesscontrol.assert_only_role(MANAGER_ROLE);
            self.pausable.assert_not_paused();

            let available = self.vault_balance.entry(token).read();
            assert(amount <= available, 'Insufficient vault balance');

            // Update allocations
            let current_allocation = self.curator_allocations.entry((curator, token)).read();
            self
                .curator_allocations
                .entry((curator, token))
                .write(current_allocation + amount);

            self
                .emit(
                    CuratorAllocation {
                        curator,
                        token,
                        amount,
                        timestamp: starknet::get_block_timestamp()
                    }
                );
        }

        fn pause(ref self: ContractState) {
            self.accesscontrol.assert_only_role(PAUSER_ROLE);
            self.pausable.pause();
        }

        fn unpause(ref self: ContractState) {
            self.accesscontrol.assert_only_role(PAUSER_ROLE);
            self.pausable.unpause();
        }

        fn set_treasury(ref self: ContractState, new_treasury: ContractAddress) {
            self.accesscontrol.assert_only_role(DEFAULT_ADMIN_ROLE);
            let old_treasury = self.treasury.read();
            self.treasury.write(new_treasury);
            self.emit(TreasuryUpdated { old_treasury, new_treasury });
        }

        fn set_fee(ref self: ContractState, new_fee: u256) {
            self.accesscontrol.assert_only_role(DEFAULT_ADMIN_ROLE);
            assert(new_fee <= 10000, 'Fee too high');
            self.vault_fee_percentage.write(new_fee);
        }

        fn get_user_balance(
            self: @ContractState, user: ContractAddress, token: ContractAddress
        ) -> u256 {
            self.user_deposits.entry((user, token)).read()
        }

        fn get_curator_allocation(
            self: @ContractState, curator: ContractAddress, token: ContractAddress
        ) -> u256 {
            self.curator_allocations.entry((curator, token)).read()
        }

        fn get_vault_balance(self: @ContractState, token: ContractAddress) -> u256 {
            self.vault_balance.entry(token).read()
        }

        fn get_total_deposits(self: @ContractState, token: ContractAddress) -> u256 {
            self.total_deposits.entry(token).read()
        }

        fn get_fee_percentage(self: @ContractState) -> u256 {
            self.vault_fee_percentage.read()
        }

        fn get_treasury(self: @ContractState) -> ContractAddress {
            self.treasury.read()
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
    trait IVaultManager<TContractState> {
        fn deposit(ref self: TContractState, token: ContractAddress, amount: u256);
        fn withdraw(ref self: TContractState, token: ContractAddress, amount: u256);
        fn allocate_to_curator(
            ref self: TContractState,
            curator: ContractAddress,
            token: ContractAddress,
            amount: u256
        );
        fn pause(ref self: TContractState);
        fn unpause(ref self: TContractState);
        fn set_treasury(ref self: TContractState, new_treasury: ContractAddress);
        fn set_fee(ref self: TContractState, new_fee: u256);
        fn get_user_balance(
            self: @TContractState, user: ContractAddress, token: ContractAddress
        ) -> u256;
        fn get_curator_allocation(
            self: @TContractState, curator: ContractAddress, token: ContractAddress
        ) -> u256;
        fn get_vault_balance(self: @TContractState, token: ContractAddress) -> u256;
        fn get_total_deposits(self: @TContractState, token: ContractAddress) -> u256;
        fn get_fee_percentage(self: @TContractState) -> u256;
        fn get_treasury(self: @TContractState) -> ContractAddress;
    }
}
