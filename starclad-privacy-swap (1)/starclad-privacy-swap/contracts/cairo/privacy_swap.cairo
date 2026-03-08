use starknet::ContractAddress;

#[starknet::interface]
trait IVerifier<TContractState> {
    fn verify(self: @TContractState, proof: Array<felt252>, public_inputs: Array<felt252>) -> bool;
}

#[starknet::interface]
trait IPrivacySwap<TContractState> {
    fn add_commitment(ref self: TContractState, commitment: felt252);
    fn update_merkle_root(ref self: TContractState, new_root: felt252);
    fn initiate_swap(
        ref self: TContractState,
        swap_id: felt252,
        nullifier_hash: felt252,
        amount_commitment: felt252,
        recipient: ContractAddress,
        expiration_time: u64
    );
    fn complete_swap(
        ref self: TContractState,
        swap_id: felt252,
        proof: Array<felt252>,
        public_inputs: Array<felt252>
    );
    fn get_merkle_root(self: @TContractState) -> felt252;
    fn is_nullifier_used(self: @TContractState, nullifier_hash: felt252) -> bool;
    fn get_swap(self: @TContractState, swap_id: felt252) -> Swap;
}

#[derive(Copy, Drop, Serde, starknet::Store)]
enum SwapStatus {
    Pending,
    Locked,
    Completed,
    Cancelled,
    Expired
}

#[derive(Copy, Drop, Serde, starknet::Store)]
struct Swap {
    swap_id: felt252,
    nullifier_hash: felt252,
    amount_commitment: felt252,
    recipient: ContractAddress,
    amount: u256,
    expires_at: u64,
    status: SwapStatus,
    created_at: u64
}

#[starknet::contract]
mod PrivacySwap {
    use super::{IPrivacySwap, Swap, SwapStatus};
    use starknet::{ContractAddress, get_caller_address, get_block_timestamp};
    use starknet::storage::{Map, StoragePointerReadAccess, StoragePointerWriteAccess};

    #[storage]
    struct Storage {
        merkle_root: felt252,
        leaf_count: u256,
        nullifier_used: Map<felt252, bool>,
        commitments: Map<felt252, bool>,
        swaps: Map<felt252, Swap>,
        owner: ContractAddress,
        verifier_address: ContractAddress,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        CommitmentAdded: CommitmentAdded,
        SwapInitiated: SwapInitiated,
        SwapCompleted: SwapCompleted,
        MerkleRootUpdated: MerkleRootUpdated,
    }

    #[derive(Drop, starknet::Event)]
    struct CommitmentAdded {
        commitment: felt252,
        leaf_index: u256,
        merkle_root: felt252,
    }

    #[derive(Drop, starknet::Event)]
    struct SwapInitiated {
        swap_id: felt252,
        nullifier_hash: felt252,
        amount: u256,
        recipient: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    struct SwapCompleted {
        swap_id: felt252,
        recipient: ContractAddress,
        amount: u256,
    }

    #[derive(Drop, starknet::Event)]
    struct MerkleRootUpdated {
        old_root: felt252,
        new_root: felt252,
    }

    #[constructor]
    fn constructor(ref self: ContractState, owner: ContractAddress) {
        self.owner.write(owner);
        self.merkle_root.write(0);
        self.leaf_count.write(0);
    }

    #[abi(embed_v0)]
    impl PrivacySwapImpl of IPrivacySwap<ContractState> {
        fn add_commitment(ref self: ContractState, commitment: felt252) {
            assert(!self.commitments.read(commitment), 'Commitment already exists');
            
            self.commitments.write(commitment, true);
            let current_count = self.leaf_count.read();
            self.leaf_count.write(current_count + 1);
            
            self.emit(CommitmentAdded {
                commitment: commitment,
                leaf_index: current_count,
                merkle_root: self.merkle_root.read(),
            });
        }

        fn update_merkle_root(ref self: ContractState, new_root: felt252) {
            // Only owner can update merkle root
            assert(get_caller_address() == self.owner.read(), 'Only owner can update root');
            
            let old_root = self.merkle_root.read();
            self.merkle_root.write(new_root);
            
            self.emit(MerkleRootUpdated {
                old_root: old_root,
                new_root: new_root,
            });
        }

        fn initiate_swap(
            ref self: ContractState,
            swap_id: felt252,
            nullifier_hash: felt252,
            amount_commitment: felt252,
            recipient: ContractAddress,
            expiration_time: u64
        ) {
            assert(!self.nullifier_used.read(nullifier_hash), 'Nullifier already used');
            
            let current_time = get_block_timestamp();
            
            let swap = Swap {
                swap_id: swap_id,
                nullifier_hash: nullifier_hash,
                amount_commitment: amount_commitment,
                recipient: recipient,
                amount: 0, // Amount will be set when funds are received
                expires_at: current_time + expiration_time,
                status: SwapStatus::Locked,
                created_at: current_time,
            };
            
            self.swaps.write(swap_id, swap);
            self.nullifier_used.write(nullifier_hash, true);
            
            self.emit(SwapInitiated {
                swap_id: swap_id,
                nullifier_hash: nullifier_hash,
                amount: 0,
                recipient: recipient,
            });
        }

        fn complete_swap(
            ref self: ContractState,
            swap_id: felt252,
            proof: Array<felt252>,
            public_inputs: Array<felt252>
        ) {
            let swap = self.swaps.read(swap_id);
            assert(swap.swap_id != 0, 'Swap not found');
            
            let current_time = get_block_timestamp();
            assert(current_time <= swap.expires_at, 'Swap expired');
            
            assert(self.verify_proof(proof, public_inputs), 'Invalid proof');
            
            assert(*public_inputs.at(0) == self.merkle_root.read(), 'Invalid merkle root');
            assert(*public_inputs.at(1) == swap.nullifier_hash, 'Invalid nullifier');
            assert(*public_inputs.at(2) == swap.amount_commitment, 'Invalid amount commitment');
            
            // Update swap status
            let mut updated_swap = swap;
            updated_swap.status = SwapStatus::Completed;
            self.swaps.write(swap_id, updated_swap);
            
            self.emit(SwapCompleted {
                swap_id: swap_id,
                recipient: swap.recipient,
                amount: swap.amount,
            });
        }

        fn get_merkle_root(self: @ContractState) -> felt252 {
            self.merkle_root.read()
        }

        fn is_nullifier_used(self: @ContractState, nullifier_hash: felt252) -> bool {
            self.nullifier_used.read(nullifier_hash)
        }

        fn get_swap(self: @ContractState, swap_id: felt252) -> Swap {
            self.swaps.read(swap_id)
        }
    }

    #[generate_trait]
    impl InternalFunctions of InternalFunctionsTrait {
        fn verify_proof(
            self: @ContractState,
            proof: Array<felt252>,
            public_inputs: Array<felt252>
        ) -> bool {
            // Call external Groth16/STARK verifier contract
            let verifier_addr = self.verifier_address.read();
            assert(verifier_addr != starknet::contract_address_const::<0>(), 'Verifier not set');
            let verifier = IVerifier { contract_address: verifier_addr };
            verifier.verify(proof, public_inputs)
        }
    }
}
