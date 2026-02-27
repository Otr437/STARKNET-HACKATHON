#[starknet::contract]
mod PriceOracle {
    use core::starknet::{ContractAddress, get_caller_address, get_block_timestamp};
    use core::starknet::storage::{Map, StoragePathEntry};
    use core::num::traits::Zero;

    // Storage structure for price data
    #[derive(Drop, Serde, starknet::Store)]
    struct PriceData {
        price: u256,
        decimals: u8,
        timestamp: u64,
        source_count: u8,
        confidence: u8
    }

    #[storage]
    struct Storage {
        owner: ContractAddress,
        oracle_address: ContractAddress,
        prices: Map<felt252, PriceData>, // symbol => PriceData
        is_authorized: Map<ContractAddress, bool>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        PriceUpdated: PriceUpdated,
        OracleChanged: OracleChanged,
        AuthorizationChanged: AuthorizationChanged,
        OwnershipTransferred: OwnershipTransferred
    }

    #[derive(Drop, starknet::Event)]
    struct PriceUpdated {
        symbol: felt252,
        price: u256,
        decimals: u8,
        timestamp: u64,
        confidence: u8
    }

    #[derive(Drop, starknet::Event)]
    struct OracleChanged {
        old_oracle: ContractAddress,
        new_oracle: ContractAddress
    }

    #[derive(Drop, starknet::Event)]
    struct AuthorizationChanged {
        account: ContractAddress,
        authorized: bool
    }

    #[derive(Drop, starknet::Event)]
    struct OwnershipTransferred {
        previous_owner: ContractAddress,
        new_owner: ContractAddress
    }

    #[constructor]
    fn constructor(ref self: ContractState, owner: ContractAddress, oracle: ContractAddress) {
        self.owner.write(owner);
        self.oracle_address.write(oracle);
        self.is_authorized.entry(oracle).write(true);
    }

    #[abi(embed_v0)]
    impl PriceOracleImpl of super::IPriceOracle<ContractState> {
        // Update price for a symbol
        fn update_price(
            ref self: ContractState,
            symbol: felt252,
            price: u256,
            decimals: u8,
            timestamp: u64
        ) {
            self._assert_authorized();
            
            // Validate inputs
            assert(price > 0, 'Price must be positive');
            assert(decimals <= 18, 'Decimals too large');
            assert(timestamp > 0, 'Invalid timestamp');

            // Store price data
            let price_data = PriceData {
                price,
                decimals,
                timestamp,
                source_count: 1,
                confidence: 95
            };

            self.prices.entry(symbol).write(price_data);

            // Emit event
            self.emit(PriceUpdated { symbol, price, decimals, timestamp, confidence: 95 });
        }

        // Batch update multiple prices
        fn update_prices(
            ref self: ContractState,
            symbols: Span<felt252>,
            prices: Span<u256>,
            decimals_list: Span<u8>,
            timestamps: Span<u64>
        ) {
            self._assert_authorized();

            let len = symbols.len();
            assert(len == prices.len(), 'Length mismatch: prices');
            assert(len == decimals_list.len(), 'Length mismatch: decimals');
            assert(len == timestamps.len(), 'Length mismatch: timestamps');

            let mut i: u32 = 0;
            loop {
                if i >= len {
                    break;
                }

                let symbol = *symbols.at(i);
                let price = *prices.at(i);
                let decimals = *decimals_list.at(i);
                let timestamp = *timestamps.at(i);

                self.update_price(symbol, price, decimals, timestamp);

                i += 1;
            }
        }

        // Get price for a symbol
        fn get_price(self: @ContractState, symbol: felt252) -> (u256, u8, u64) {
            let price_data = self.prices.entry(symbol).read();
            assert(price_data.timestamp > 0, 'Price not found');
            
            (price_data.price, price_data.decimals, price_data.timestamp)
        }

        // Get detailed price data
        fn get_price_data(self: @ContractState, symbol: felt252) -> PriceData {
            let price_data = self.prices.entry(symbol).read();
            assert(price_data.timestamp > 0, 'Price not found');
            
            price_data
        }

        // Check if price is stale (older than max_age seconds)
        fn is_price_stale(self: @ContractState, symbol: felt252, max_age: u64) -> bool {
            let price_data = self.prices.entry(symbol).read();
            
            if price_data.timestamp == 0 {
                return true;
            }

            let current_time = get_block_timestamp();
            let age = current_time - price_data.timestamp;
            
            age > max_age
        }

        // Get last update timestamp
        fn get_last_update_time(self: @ContractState, symbol: felt252) -> u64 {
            let price_data = self.prices.entry(symbol).read();
            price_data.timestamp
        }

        // Check if symbol has price data
        fn has_price(self: @ContractState, symbol: felt252) -> bool {
            let price_data = self.prices.entry(symbol).read();
            price_data.timestamp > 0
        }

        // Admin functions
        fn set_oracle(ref self: ContractState, new_oracle: ContractAddress) {
            self._assert_owner();
            
            let old_oracle = self.oracle_address.read();
            
            // Revoke old oracle authorization
            self.is_authorized.entry(old_oracle).write(false);
            
            // Set and authorize new oracle
            self.oracle_address.write(new_oracle);
            self.is_authorized.entry(new_oracle).write(true);
            
            self.emit(OracleChanged { old_oracle, new_oracle });
        }

        fn set_authorized(ref self: ContractState, account: ContractAddress, authorized: bool) {
            self._assert_owner();
            
            self.is_authorized.entry(account).write(authorized);
            
            self.emit(AuthorizationChanged { account, authorized });
        }

        fn transfer_ownership(ref self: ContractState, new_owner: ContractAddress) {
            self._assert_owner();
            assert(!new_owner.is_zero(), 'Invalid new owner');
            
            let previous_owner = self.owner.read();
            self.owner.write(new_owner);
            
            self.emit(OwnershipTransferred { previous_owner, new_owner });
        }

        // View functions
        fn get_owner(self: @ContractState) -> ContractAddress {
            self.owner.read()
        }

        fn get_oracle(self: @ContractState) -> ContractAddress {
            self.oracle_address.read()
        }

        fn is_address_authorized(self: @ContractState, account: ContractAddress) -> bool {
            self.is_authorized.entry(account).read()
        }
    }

    #[generate_trait]
    impl InternalFunctions of InternalFunctionsTrait {
        fn _assert_owner(self: @ContractState) {
            let caller = get_caller_address();
            let owner = self.owner.read();
            assert(caller == owner, 'Caller is not owner');
        }

        fn _assert_authorized(self: @ContractState) {
            let caller = get_caller_address();
            let is_authorized = self.is_authorized.entry(caller).read();
            assert(is_authorized, 'Caller not authorized');
        }
    }
}

#[starknet::interface]
trait IPriceOracle<TContractState> {
    // Price update functions
    fn update_price(
        ref self: TContractState,
        symbol: felt252,
        price: u256,
        decimals: u8,
        timestamp: u64
    );
    
    fn update_prices(
        ref self: TContractState,
        symbols: Span<felt252>,
        prices: Span<u256>,
        decimals_list: Span<u8>,
        timestamps: Span<u64>
    );

    // Price query functions
    fn get_price(self: @TContractState, symbol: felt252) -> (u256, u8, u64);
    fn get_price_data(self: @TContractState, symbol: felt252) -> PriceOracle::PriceData;
    fn is_price_stale(self: @TContractState, symbol: felt252, max_age: u64) -> bool;
    fn get_last_update_time(self: @TContractState, symbol: felt252) -> u64;
    fn has_price(self: @TContractState, symbol: felt252) -> bool;

    // Admin functions
    fn set_oracle(ref self: TContractState, new_oracle: ContractAddress);
    fn set_authorized(ref self: TContractState, account: ContractAddress, authorized: bool);
    fn transfer_ownership(ref self: TContractState, new_owner: ContractAddress);

    // View functions
    fn get_owner(self: @TContractState) -> ContractAddress;
    fn get_oracle(self: @TContractState) -> ContractAddress;
    fn is_address_authorized(self: @TContractState, account: ContractAddress) -> bool;
}
