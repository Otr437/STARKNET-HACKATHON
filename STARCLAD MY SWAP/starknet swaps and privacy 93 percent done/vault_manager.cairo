#[starknet::contract]
mod VaultManager {
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use starknet::storage::{
        StoragePointerReadAccess, StoragePointerWriteAccess, Map, StoragePathEntry
    };
    use core::num::traits::Zero;

    #[storage]
    struct Storage {
        // Vault owner
        owner: ContractAddress,
        // Curators with management permissions
        curators: Map<ContractAddress, bool>,
        // Assets in vault: asset_address -> amount
        vault_assets: Map<ContractAddress, u256>,
        // User deposits: user -> asset -> amount
        user_deposits: Map<(ContractAddress, ContractAddress), u256>,
        // Total value locked
        total_tvl: u256,
        // Management fee (basis points, e.g., 100 = 1%)
        management_fee: u256,
        // Performance fee (basis points)
        performance_fee: u256,
        // Fee recipient
        fee_recipient: ContractAddress,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        Deposit: Deposit,
        Withdraw: Withdraw,
        CuratorAdded: CuratorAdded,
        CuratorRemoved: CuratorRemoved,
        FeesUpdated: FeesUpdated,
        AssetRebalanced: AssetRebalanced,
    }

    #[derive(Drop, starknet::Event)]
    struct Deposit {
        user: ContractAddress,
        asset: ContractAddress,
        amount: u256,
    }

    #[derive(Drop, starknet::Event)]
    struct Withdraw {
        user: ContractAddress,
        asset: ContractAddress,
        amount: u256,
    }

    #[derive(Drop, starknet::Event)]
    struct CuratorAdded {
        curator: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    struct CuratorRemoved {
        curator: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    struct FeesUpdated {
        management_fee: u256,
        performance_fee: u256,
    }

    #[derive(Drop, starknet::Event)]
    struct AssetRebalanced {
        asset: ContractAddress,
        new_allocation: u256,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        owner: ContractAddress,
        initial_curator: ContractAddress,
        management_fee: u256,
        performance_fee: u256,
        fee_recipient: ContractAddress,
    ) {
        self.owner.write(owner);
        self.curators.entry(initial_curator).write(true);
        self.management_fee.write(management_fee);
        self.performance_fee.write(performance_fee);
        self.fee_recipient.write(fee_recipient);
        self.total_tvl.write(0);
    }

    #[abi(embed_v0)]
    impl VaultManagerImpl of super::IVaultManager<ContractState> {
        // Deposit assets into vault
        fn deposit(ref self: ContractState, asset: ContractAddress, amount: u256) {
            let caller = get_caller_address();
            assert(!caller.is_zero(), 'Invalid caller');
            assert(amount > 0, 'Amount must be positive');

            // Update user deposits
            let current_deposit = self.user_deposits.entry((caller, asset)).read();
            self.user_deposits.entry((caller, asset)).write(current_deposit + amount);

            // Update vault assets
            let current_vault_amount = self.vault_assets.entry(asset).read();
            self.vault_assets.entry(asset).write(current_vault_amount + amount);

            // Update TVL
            let current_tvl = self.total_tvl.read();
            self.total_tvl.write(current_tvl + amount);

            self.emit(Deposit { user: caller, asset, amount });
        }

        // Withdraw assets from vault
        fn withdraw(ref self: ContractState, asset: ContractAddress, amount: u256) {
            let caller = get_caller_address();
            assert(!caller.is_zero(), 'Invalid caller');

            let user_balance = self.user_deposits.entry((caller, asset)).read();
            assert(user_balance >= amount, 'Insufficient balance');

            // Deduct management fee
            let fee = (amount * self.management_fee.read()) / 10000;
            let withdraw_amount = amount - fee;

            // Update user deposits
            self.user_deposits.entry((caller, asset)).write(user_balance - amount);

            // Update vault assets
            let current_vault_amount = self.vault_assets.entry(asset).read();
            self.vault_assets.entry(asset).write(current_vault_amount - amount);

            // Update TVL
            let current_tvl = self.total_tvl.read();
            self.total_tvl.write(current_tvl - amount);

            self.emit(Withdraw { user: caller, asset, amount: withdraw_amount });
        }

        // Add curator (only owner)
        fn add_curator(ref self: ContractState, curator: ContractAddress) {
            self.only_owner();
            assert(!curator.is_zero(), 'Invalid curator address');
            self.curators.entry(curator).write(true);
            self.emit(CuratorAdded { curator });
        }

        // Remove curator (only owner)
        fn remove_curator(ref self: ContractState, curator: ContractAddress) {
            self.only_owner();
            self.curators.entry(curator).write(false);
            self.emit(CuratorRemoved { curator });
        }

        // Rebalance assets (only curators)
        fn rebalance_asset(
            ref self: ContractState, asset: ContractAddress, new_allocation: u256
        ) {
            self.only_curator();
            self.vault_assets.entry(asset).write(new_allocation);
            self.emit(AssetRebalanced { asset, new_allocation });
        }

        // Update fees (only owner)
        fn update_fees(ref self: ContractState, management_fee: u256, performance_fee: u256) {
            self.only_owner();
            assert(management_fee <= 1000, 'Management fee too high'); // Max 10%
            assert(performance_fee <= 3000, 'Performance fee too high'); // Max 30%
            
            self.management_fee.write(management_fee);
            self.performance_fee.write(performance_fee);
            self.emit(FeesUpdated { management_fee, performance_fee });
        }

        // View functions
        fn get_user_balance(
            self: @ContractState, user: ContractAddress, asset: ContractAddress
        ) -> u256 {
            self.user_deposits.entry((user, asset)).read()
        }

        fn get_vault_asset_amount(self: @ContractState, asset: ContractAddress) -> u256 {
            self.vault_assets.entry(asset).read()
        }

        fn get_total_tvl(self: @ContractState) -> u256 {
            self.total_tvl.read()
        }

        fn is_curator(self: @ContractState, address: ContractAddress) -> bool {
            self.curators.entry(address).read()
        }

        fn get_owner(self: @ContractState) -> ContractAddress {
            self.owner.read()
        }

        fn get_fees(self: @ContractState) -> (u256, u256) {
            (self.management_fee.read(), self.performance_fee.read())
        }
    }

    #[generate_trait]
    impl InternalFunctions of InternalFunctionsTrait {
        fn only_owner(self: @ContractState) {
            let caller = get_caller_address();
            assert(caller == self.owner.read(), 'Only owner can call');
        }

        fn only_curator(self: @ContractState) {
            let caller = get_caller_address();
            assert(
                self.curators.entry(caller).read() || caller == self.owner.read(),
                'Only curator can call'
            );
        }
    }
}

#[starknet::interface]
trait IVaultManager<TContractState> {
    fn deposit(ref self: TContractState, asset: ContractAddress, amount: u256);
    fn withdraw(ref self: TContractState, asset: ContractAddress, amount: u256);
    fn add_curator(ref self: TContractState, curator: ContractAddress);
    fn remove_curator(ref self: TContractState, curator: ContractAddress);
    fn rebalance_asset(ref self: TContractState, asset: ContractAddress, new_allocation: u256);
    fn update_fees(ref self: TContractState, management_fee: u256, performance_fee: u256);
    fn get_user_balance(self: @TContractState, user: ContractAddress, asset: ContractAddress) -> u256;
    fn get_vault_asset_amount(self: @TContractState, asset: ContractAddress) -> u256;
    fn get_total_tvl(self: @TContractState) -> u256;
    fn is_curator(self: @TContractState, address: ContractAddress) -> bool;
    fn get_owner(self: @TContractState) -> ContractAddress;
    fn get_fees(self: @TContractState) -> (u256, u256);
}
