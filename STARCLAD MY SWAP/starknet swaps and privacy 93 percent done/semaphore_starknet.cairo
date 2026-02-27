#[starknet::contract]
mod SemaphoreStarknet {
    use starknet::{ContractAddress, get_caller_address};
    use starknet::storage::{
        StoragePointerReadAccess, StoragePointerWriteAccess, Map, StoragePathEntry
    };
    use core::poseidon::poseidon_hash_span;
    use core::num::traits::Zero;

    // Merkle tree depth for group membership
    const TREE_DEPTH: u32 = 20;
    const MAX_GROUP_SIZE: u256 = 1048576; // 2^20

    #[storage]
    struct Storage {
        // Group management
        group_counter: u256,
        group_admins: Map<u256, ContractAddress>,
        group_merkle_roots: Map<u256, felt252>,
        group_sizes: Map<u256, u256>,
        
        // Merkle tree nodes: group_id -> level -> index -> node
        merkle_nodes: Map<(u256, u32, u256), felt252>,
        
        // Identity commitments in groups: group_id -> index -> commitment
        identity_commitments: Map<(u256, u256), felt252>,
        
        // Nullifier tracking to prevent double-signaling
        nullifiers: Map<felt252, bool>,
        
        // External nullifiers for different applications
        external_nullifiers: Map<(u256, felt252), bool>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        GroupCreated: GroupCreated,
        MemberAdded: MemberAdded,
        MemberRemoved: MemberRemoved,
        ProofVerified: ProofVerified,
        SignalSent: SignalSent,
    }

    #[derive(Drop, starknet::Event)]
    struct GroupCreated {
        group_id: u256,
        admin: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    struct MemberAdded {
        group_id: u256,
        identity_commitment: felt252,
        index: u256,
    }

    #[derive(Drop, starknet::Event)]
    struct MemberRemoved {
        group_id: u256,
        identity_commitment: felt252,
        index: u256,
    }

    #[derive(Drop, starknet::Event)]
    struct ProofVerified {
        group_id: u256,
        nullifier: felt252,
        external_nullifier: felt252,
    }

    #[derive(Drop, starknet::Event)]
    struct SignalSent {
        group_id: u256,
        signal: felt252,
        nullifier: felt252,
    }

    #[constructor]
    fn constructor(ref self: ContractState) {
        self.group_counter.write(0);
    }

    #[abi(embed_v0)]
    impl SemaphoreStarknetImpl of super::ISemaphoreStarknet<ContractState> {
        // Create a new group
        fn create_group(ref self: ContractState, admin: ContractAddress) -> u256 {
            assert(!admin.is_zero(), 'Invalid admin address');
            
            let group_id = self.group_counter.read() + 1;
            self.group_counter.write(group_id);
            
            self.group_admins.entry(group_id).write(admin);
            self.group_sizes.entry(group_id).write(0);
            
            // Initialize root with zero value
            let zero_value = self.hash_left_right(0, 0);
            self.group_merkle_roots.entry(group_id).write(zero_value);
            
            self.emit(GroupCreated { group_id, admin });
            group_id
        }

        // Add member to group (admin only)
        fn add_member(ref self: ContractState, group_id: u256, identity_commitment: felt252) {
            self.only_group_admin(group_id);
            
            let current_size = self.group_sizes.entry(group_id).read();
            assert(current_size < MAX_GROUP_SIZE, 'Group is full');
            
            let index = current_size;
            
            // Store identity commitment
            self.identity_commitments.entry((group_id, index)).write(identity_commitment);
            
            // Update Merkle tree
            self.update_merkle_tree(group_id, index, identity_commitment);
            
            // Increment group size
            self.group_sizes.entry(group_id).write(current_size + 1);
            
            self.emit(MemberAdded {
                group_id,
                identity_commitment,
                index,
            });
        }

        // Remove member from group (admin only)
        fn remove_member(ref self: ContractState, group_id: u256, index: u256) {
            self.only_group_admin(group_id);
            
            let current_size = self.group_sizes.entry(group_id).read();
            assert(index < current_size, 'Invalid index');
            
            let identity_commitment = self.identity_commitments.entry((group_id, index)).read();
            
            // Set to zero (removed)
            self.identity_commitments.entry((group_id, index)).write(0);
            self.update_merkle_tree(group_id, index, 0);
            
            self.emit(MemberRemoved {
                group_id,
                identity_commitment,
                index,
            });
        }

        // Verify proof and send signal
        fn verify_proof(
            ref self: ContractState,
            group_id: u256,
            signal: felt252,
            nullifier_hash: felt252,
            external_nullifier: felt252,
            proof: Span<felt252>,
        ) {
            // Check nullifier hasn't been used
            assert(!self.nullifiers.entry(nullifier_hash).read(), 'Nullifier already used');
            
            // Verify the proof
            let merkle_root = self.group_merkle_roots.entry(group_id).read();
            let is_valid = self.verify_membership_proof(
                merkle_root,
                nullifier_hash,
                external_nullifier,
                signal,
                proof
            );
            
            assert(is_valid, 'Invalid proof');
            
            // Mark nullifier as used
            self.nullifiers.entry(nullifier_hash).write(true);
            self.external_nullifiers.entry((group_id, external_nullifier)).write(true);
            
            self.emit(ProofVerified {
                group_id,
                nullifier: nullifier_hash,
                external_nullifier,
            });
            
            self.emit(SignalSent {
                group_id,
                signal,
                nullifier: nullifier_hash,
            });
        }

        // View functions
        fn get_group_admin(self: @ContractState, group_id: u256) -> ContractAddress {
            self.group_admins.entry(group_id).read()
        }

        fn get_group_size(self: @ContractState, group_id: u256) -> u256 {
            self.group_sizes.entry(group_id).read()
        }

        fn get_merkle_root(self: @ContractState, group_id: u256) -> felt252 {
            self.group_merkle_roots.entry(group_id).read()
        }

        fn is_nullifier_used(self: @ContractState, nullifier: felt252) -> bool {
            self.nullifiers.entry(nullifier).read()
        }

        fn get_identity_commitment(
            self: @ContractState, group_id: u256, index: u256
        ) -> felt252 {
            self.identity_commitments.entry((group_id, index)).read()
        }

        fn get_group_count(self: @ContractState) -> u256 {
            self.group_counter.read()
        }
    }

    #[generate_trait]
    impl InternalFunctions of InternalFunctionsTrait {
        fn only_group_admin(self: @ContractState, group_id: u256) {
            let caller = get_caller_address();
            let admin = self.group_admins.entry(group_id).read();
            assert(caller == admin, 'Only group admin');
        }

        // Hash two nodes together using Poseidon
        fn hash_left_right(self: @ContractState, left: felt252, right: felt252) -> felt252 {
            let mut data = array![left, right];
            poseidon_hash_span(data.span())
        }

        // Update Merkle tree after adding/removing member
        fn update_merkle_tree(
            ref self: ContractState,
            group_id: u256,
            leaf_index: u256,
            leaf_value: felt252
        ) {
            // Set leaf node
            self.merkle_nodes.entry((group_id, 0, leaf_index)).write(leaf_value);
            
            let mut current_index = leaf_index;
            let mut current_hash = leaf_value;
            
            // Update path to root
            let mut level: u32 = 0;
            loop {
                if level >= TREE_DEPTH {
                    break;
                }
                
                let is_left = (current_index % 2) == 0;
                let sibling_index = if is_left { current_index + 1 } else { current_index - 1 };
                
                let sibling_hash = self.merkle_nodes.entry((group_id, level, sibling_index)).read();
                
                // Compute parent hash
                current_hash = if is_left {
                    self.hash_left_right(current_hash, sibling_hash)
                } else {
                    self.hash_left_right(sibling_hash, current_hash)
                };
                
                current_index = current_index / 2;
                level += 1;
                
                // Store parent node
                self.merkle_nodes.entry((group_id, level, current_index)).write(current_hash);
            };
            
            // Update root
            self.group_merkle_roots.entry(group_id).write(current_hash);
        }

        // Verify membership proof
        fn verify_membership_proof(
            self: @ContractState,
            merkle_root: felt252,
            nullifier_hash: felt252,
            external_nullifier: felt252,
            signal: felt252,
            proof: Span<felt252>
        ) -> bool {
            // Verify proof structure
            if proof.len() < 3 {
                return false;
            }
            
            // Proof elements:
            // proof[0] = merkle root from proof
            // proof[1] = path element 1
            // proof[2] = path element 2
            // Additional elements could include more path elements
            
            let proof_root = *proof.at(0);
            
            // Verify merkle root matches
            if proof_root != merkle_root {
                return false;
            }
            
            // Verify merkle root is not zero (group exists)
            if merkle_root == 0 {
                return false;
            }
            
            // In a full implementation with STARK proofs:
            // 1. Verify the STARK proof that proves knowledge of:
            //    - identity commitment (trapdoor, nullifier)
            //    - Merkle path from commitment to root
            //    - Correct nullifier computation: hash(nullifier, external_nullifier)
            //    - Signal is correctly formed
            // 2. This would use Cairo's built-in verify_stark_proof function
            // 3. The proof would be generated off-chain using Cairo programs
            
            // For now, we verify basic structure
            // Production would add: verify_stark_proof(proof, public_inputs)
            
            true
        }
    }
}

#[starknet::interface]
trait ISemaphoreStarknet<TContractState> {
    fn create_group(ref self: TContractState, admin: ContractAddress) -> u256;
    fn add_member(ref self: TContractState, group_id: u256, identity_commitment: felt252);
    fn remove_member(ref self: TContractState, group_id: u256, index: u256);
    fn verify_proof(
        ref self: TContractState,
        group_id: u256,
        signal: felt252,
        nullifier_hash: felt252,
        external_nullifier: felt252,
        proof: Span<felt252>,
    );
    fn get_group_admin(self: @TContractState, group_id: u256) -> ContractAddress;
    fn get_group_size(self: @TContractState, group_id: u256) -> u256;
    fn get_merkle_root(self: @TContractState, group_id: u256) -> felt252;
    fn is_nullifier_used(self: @TContractState, nullifier: felt252) -> bool;
    fn get_identity_commitment(self: @TContractState, group_id: u256, index: u256) -> felt252;
    fn get_group_count(self: @TContractState) -> u256;
}
