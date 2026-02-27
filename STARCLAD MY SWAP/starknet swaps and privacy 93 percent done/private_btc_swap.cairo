#[starknet::contract]
mod PrivateBTCSwap {
    use starknet::{ContractAddress, get_caller_address, get_block_timestamp};
    use starknet::storage::{
        StoragePointerReadAccess, StoragePointerWriteAccess, Map, StoragePathEntry
    };
    use core::poseidon::poseidon_hash_span;
    use core::num::traits::Zero;

    #[storage]
    struct Storage {
        // Swap ID counter
        swap_counter: u256,
        // Swap details: swap_id -> Swap
        swaps: Map<u256, Swap>,
        // Hash lock: hash -> swap_id
        hash_locks: Map<felt252, u256>,
        // User swaps: user -> swap_ids array (simplified as count)
        user_swap_count: Map<ContractAddress, u256>,
        // Swap status
        swap_status: Map<u256, SwapStatus>,
    }

    #[derive(Drop, Serde, starknet::Store)]
    struct Swap {
        initiator: ContractAddress,
        participant: ContractAddress,
        asset: ContractAddress,
        amount: u256,
        hash_lock: felt252,
        time_lock: u64,
        btc_address: felt252, // Bitcoin address as felt
        btc_amount: u256,
        secret: felt252, // Will be 0 until revealed
    }

    #[derive(Drop, Serde, starknet::Store, PartialEq)]
    enum SwapStatus {
        Active,
        Completed,
        Refunded,
        Expired,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        SwapInitiated: SwapInitiated,
        SwapCompleted: SwapCompleted,
        SwapRefunded: SwapRefunded,
        SecretRevealed: SecretRevealed,
    }

    #[derive(Drop, starknet::Event)]
    struct SwapInitiated {
        swap_id: u256,
        initiator: ContractAddress,
        participant: ContractAddress,
        amount: u256,
        hash_lock: felt252,
        time_lock: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct SwapCompleted {
        swap_id: u256,
        participant: ContractAddress,
        secret: felt252,
    }

    #[derive(Drop, starknet::Event)]
    struct SwapRefunded {
        swap_id: u256,
        initiator: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    struct SecretRevealed {
        swap_id: u256,
        secret: felt252,
    }

    #[constructor]
    fn constructor(ref self: ContractState) {
        self.swap_counter.write(0);
    }

    #[abi(embed_v0)]
    impl PrivateBTCSwapImpl of super::IPrivateBTCSwap<ContractState> {
        // Initiate atomic swap
        fn initiate_swap(
            ref self: ContractState,
            participant: ContractAddress,
            asset: ContractAddress,
            amount: u256,
            hash_lock: felt252,
            time_lock: u64,
            btc_address: felt252,
            btc_amount: u256,
        ) -> u256 {
            let caller = get_caller_address();
            let current_time = get_block_timestamp();
            
            assert(!participant.is_zero(), 'Invalid participant');
            assert(amount > 0, 'Amount must be positive');
            assert(time_lock > current_time, 'Time lock must be future');
            assert(time_lock - current_time >= 3600, 'Min 1 hour time lock'); // Min 1 hour

            let swap_id = self.swap_counter.read() + 1;
            self.swap_counter.write(swap_id);

            let swap = Swap {
                initiator: caller,
                participant,
                asset,
                amount,
                hash_lock,
                time_lock,
                btc_address,
                btc_amount,
                secret: 0,
            };

            self.swaps.entry(swap_id).write(swap);
            self.hash_locks.entry(hash_lock).write(swap_id);
            self.swap_status.entry(swap_id).write(SwapStatus::Active);

            let user_count = self.user_swap_count.entry(caller).read();
            self.user_swap_count.entry(caller).write(user_count + 1);

            self.emit(SwapInitiated {
                swap_id,
                initiator: caller,
                participant,
                amount,
                hash_lock,
                time_lock,
            });

            swap_id
        }

        // Complete swap with secret (participant calls this)
        fn complete_swap(ref self: ContractState, swap_id: u256, secret: felt252) {
            let caller = get_caller_address();
            let swap = self.swaps.entry(swap_id).read();
            let status = self.swap_status.entry(swap_id).read();

            assert(status == SwapStatus::Active, 'Swap not active');
            assert(caller == swap.participant, 'Only participant can complete');

            // Verify secret matches hash lock
            let secret_hash = self.hash_secret(secret);
            assert(secret_hash == swap.hash_lock, 'Invalid secret');

            let current_time = get_block_timestamp();
            assert(current_time < swap.time_lock, 'Swap expired');

            // Update swap with secret
            let mut updated_swap = swap;
            updated_swap.secret = secret;
            self.swaps.entry(swap_id).write(updated_swap);
            self.swap_status.entry(swap_id).write(SwapStatus::Completed);

            self.emit(SwapCompleted {
                swap_id,
                participant: caller,
                secret,
            });

            self.emit(SecretRevealed {
                swap_id,
                secret,
            });
        }

        // Refund swap after time lock expires
        fn refund_swap(ref self: ContractState, swap_id: u256) {
            let caller = get_caller_address();
            let swap = self.swaps.entry(swap_id).read();
            let status = self.swap_status.entry(swap_id).read();

            assert(status == SwapStatus::Active, 'Swap not active');
            assert(caller == swap.initiator, 'Only initiator can refund');

            let current_time = get_block_timestamp();
            assert(current_time >= swap.time_lock, 'Time lock not expired');

            self.swap_status.entry(swap_id).write(SwapStatus::Refunded);

            self.emit(SwapRefunded {
                swap_id,
                initiator: caller,
            });
        }

        // Verify secret against hash lock
        fn verify_secret(self: @ContractState, swap_id: u256, secret: felt252) -> bool {
            let swap = self.swaps.entry(swap_id).read();
            let secret_hash = self.hash_secret(secret);
            secret_hash == swap.hash_lock
        }

        // Get swap details
        fn get_swap(self: @ContractState, swap_id: u256) -> Swap {
            self.swaps.entry(swap_id).read()
        }

        // Get swap status
        fn get_swap_status(self: @ContractState, swap_id: u256) -> SwapStatus {
            self.swap_status.entry(swap_id).read()
        }

        // Get user's active swaps count
        fn get_user_swap_count(self: @ContractState, user: ContractAddress) -> u256 {
            self.user_swap_count.entry(user).read()
        }

        // Get swap by hash lock
        fn get_swap_by_hash(self: @ContractState, hash_lock: felt252) -> u256 {
            self.hash_locks.entry(hash_lock).read()
        }
    }

    #[generate_trait]
    impl InternalFunctions of InternalFunctionsTrait {
        // Hash secret using Poseidon
        fn hash_secret(self: @ContractState, secret: felt252) -> felt252 {
            let mut data = array![secret];
            poseidon_hash_span(data.span())
        }
    }
}

#[starknet::interface]
trait IPrivateBTCSwap<TContractState> {
    fn initiate_swap(
        ref self: TContractState,
        participant: ContractAddress,
        asset: ContractAddress,
        amount: u256,
        hash_lock: felt252,
        time_lock: u64,
        btc_address: felt252,
        btc_amount: u256,
    ) -> u256;
    fn complete_swap(ref self: TContractState, swap_id: u256, secret: felt252);
    fn refund_swap(ref self: TContractState, swap_id: u256);
    fn verify_secret(self: @TContractState, swap_id: u256, secret: felt252) -> bool;
    fn get_swap(self: @TContractState, swap_id: u256) -> Swap;
    fn get_swap_status(self: @TContractState, swap_id: u256) -> SwapStatus;
    fn get_user_swap_count(self: @TContractState, user: ContractAddress) -> u256;
    fn get_swap_by_hash(self: @TContractState, hash_lock: felt252) -> u256;
}

// Import for Swap struct visibility
use super::PrivateBTCSwap::Swap;
use super::PrivateBTCSwap::SwapStatus;
