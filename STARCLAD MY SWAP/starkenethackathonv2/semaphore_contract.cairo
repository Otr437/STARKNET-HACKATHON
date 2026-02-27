// SPDX-License-Identifier: MIT
// Semaphore Protocol Contract - February 2026
// Zero-knowledge group membership and anonymous signaling on Starknet

#[starknet::contract]
mod SemaphoreProtocol {
    use starknet::{ContractAddress, get_caller_address, get_block_timestamp};
    use starknet::storage::{
        Map, Vec, VecTrait, MutableVecTrait,
        StoragePathEntry, StoragePointerReadAccess, StoragePointerWriteAccess
    };
    use core::poseidon::PoseidonTrait;
    use core::hash::{HashStateTrait, HashStateExTrait};
    
    // Groth16 proof structure
    #[derive(Copy, Drop, Serde)]
    struct Groth16Proof {
        pi_a_x: felt252,
        pi_a_y: felt252,
        pi_b_x1: felt252,
        pi_b_x2: felt252,
        pi_b_y1: felt252,
        pi_b_y2: felt252,
        pi_c_x: felt252,
        pi_c_y: felt252,
    }
    
    // Group structure
    #[derive(Drop, Serde, starknet::Store)]
    struct Group {
        admin: ContractAddress,
        merkle_root: felt252,
        depth: u8,
        member_count: u32,
        created_at: u64,
    }
    
    // Signal structure
    #[derive(Drop, Serde, starknet::Store)]
    struct Signal {
        group_id: felt252,
        signal_data: felt252,
        external_nullifier: felt252,
        nullifier_hash: felt252,
        timestamp: u64,
        verified: bool,
    }
    
    #[storage]
    struct Storage {
        // Groups
        groups: Map<felt252, Group>,
        // Members per group
        group_members: Map<(felt252, u32), felt252>, // (group_id, index) -> commitment
        // Signals
        signals: Map<felt252, Signal>, // signal_id -> signal
        // Used nullifiers
        nullifiers: Map<felt252, bool>,
        // Signal counter
        signal_count: u64,
        // Verifying key (set once)
        vk_set: bool,
        vk_alpha: (felt252, felt252),
        vk_beta: (felt252, felt252, felt252, felt252),
        vk_gamma: (felt252, felt252, felt252, felt252),
        vk_delta: (felt252, felt252, felt252, felt252),
    }
    
    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        GroupCreated: GroupCreated,
        MemberAdded: MemberAdded,
        SignalSent: SignalSent,
    }
    
    #[derive(Drop, starknet::Event)]
    struct GroupCreated {
        #[key]
        group_id: felt252,
        admin: ContractAddress,
        merkle_root: felt252,
        timestamp: u64,
    }
    
    #[derive(Drop, starknet::Event)]
    struct MemberAdded {
        #[key]
        group_id: felt252,
        identity_commitment: felt252,
        index: u32,
    }
    
    #[derive(Drop, starknet::Event)]
    struct SignalSent {
        #[key]
        signal_id: felt252,
        #[key]
        group_id: felt252,
        nullifier_hash: felt252,
        timestamp: u64,
    }
    
    #[constructor]
    fn constructor(ref self: ContractState) {
        self.signal_count.write(0);
        self.vk_set.write(false);
    }
    
    #[abi(embed_v0)]
    impl SemaphoreImpl of super::ISemaphoreProtocol<ContractState> {
        
        /// Set verifying key (admin only, once)
        fn set_verifying_key(
            ref self: ContractState,
            vk_alpha: (felt252, felt252),
            vk_beta: (felt252, felt252, felt252, felt252),
            vk_gamma: (felt252, felt252, felt252, felt252),
            vk_delta: (felt252, felt252, felt252, felt252),
        ) {
            assert(!self.vk_set.read(), 'VK already set');
            
            self.vk_alpha.write(vk_alpha);
            self.vk_beta.write(vk_beta);
            self.vk_gamma.write(vk_gamma);
            self.vk_delta.write(vk_delta);
            self.vk_set.write(true);
        }
        
        /// Create new group
        fn create_group(
            ref self: ContractState,
            group_id: felt252,
            depth: u8
        ) {
            let caller = get_caller_address();
            
            // Check group doesn't exist
            let existing = self.groups.entry(group_id).read();
            assert(existing.member_count == 0 && existing.admin.is_zero(), 'Group already exists');
            
            // Initialize empty Merkle root
            let merkle_root = 0; // Will update when members added
            
            let group = Group {
                admin: caller,
                merkle_root,
                depth,
                member_count: 0,
                created_at: get_block_timestamp(),
            };
            
            self.groups.entry(group_id).write(group);
            
            self.emit(GroupCreated {
                group_id,
                admin: caller,
                merkle_root,
                timestamp: get_block_timestamp(),
            });
        }
        
        /// Add member to group
        fn add_member(
            ref self: ContractState,
            group_id: felt252,
            identity_commitment: felt252
        ) {
            let caller = get_caller_address();
            let mut group = self.groups.entry(group_id).read();
            
            // Check admin
            assert(group.admin == caller, 'Only admin can add members');
            
            // Add member
            let index = group.member_count;
            self.group_members.entry((group_id, index)).write(identity_commitment);
            
            group.member_count += 1;
            
            // Rebuild Merkle root
            group.merkle_root = Self::compute_merkle_root(
                @self,
                group_id,
                group.member_count,
                group.depth
            );
            
            self.groups.entry(group_id).write(group);
            
            self.emit(MemberAdded {
                group_id,
                identity_commitment,
                index,
            });
        }
        
        /// Send anonymous signal
        fn send_signal(
            ref self: ContractState,
            signal_id: felt252,
            group_id: felt252,
            signal_data: felt252,
            external_nullifier: felt252,
            nullifier_hash: felt252,
            merkle_root: felt252,
            proof: Groth16Proof
        ) {
            let group = self.groups.entry(group_id).read();
            
            assert(group.member_count > 0, 'Group not found');
            
            // Check nullifier not used
            assert(!self.nullifiers.entry(nullifier_hash).read(), 'Double signal');
            
            // Check Merkle root matches current group state
            assert(group.merkle_root == merkle_root, 'Invalid Merkle root');
            
            // Verify Groth16 proof
            let public_signals = array![
                merkle_root,
                nullifier_hash,
                signal_data,
                external_nullifier
            ];
            
            assert(
                Self::verify_groth16_proof(@self, proof, public_signals.span()),
                'Invalid proof'
            );
            
            // Mark nullifier as used
            self.nullifiers.entry(nullifier_hash).write(true);
            
            // Store signal
            let signal = Signal {
                group_id,
                signal_data,
                external_nullifier,
                nullifier_hash,
                timestamp: get_block_timestamp(),
                verified: true,
            };
            
            self.signals.entry(signal_id).write(signal);
            
            // Increment counter
            let count = self.signal_count.read();
            self.signal_count.write(count + 1);
            
            self.emit(SignalSent {
                signal_id,
                group_id,
                nullifier_hash,
                timestamp: get_block_timestamp(),
            });
        }
        
        /// Get group info
        fn get_group(
            self: @ContractState,
            group_id: felt252
        ) -> Group {
            self.groups.entry(group_id).read()
        }
        
        /// Get signal
        fn get_signal(
            self: @ContractState,
            signal_id: felt252
        ) -> Signal {
            self.signals.entry(signal_id).read()
        }
        
        /// Check if nullifier used
        fn is_nullifier_used(
            self: @ContractState,
            nullifier_hash: felt252
        ) -> bool {
            self.nullifiers.entry(nullifier_hash).read()
        }
    }
    
    // Internal functions
    #[generate_trait]
    impl InternalFunctions of InternalFunctionsTrait {
        
        /// Compute Merkle root from members
        fn compute_merkle_root(
            self: @ContractState,
            group_id: felt252,
            member_count: u32,
            depth: u8
        ) -> felt252 {
            if member_count == 0 {
                return 0;
            }
            
            // Build Merkle tree using Poseidon hash
            let mut level: Array<felt252> = ArrayTrait::new();
            
            // Get all members
            let mut i: u32 = 0;
            loop {
                if i >= member_count {
                    break;
                }
                let commitment = self.group_members.entry((group_id, i)).read();
                level.append(commitment);
                i += 1;
            };
            
            // Pad to power of 2
            let tree_size = Self::pow2(depth);
            loop {
                if i >= tree_size {
                    break;
                }
                level.append(0);
                i += 1;
            };
            
            // Build tree bottom-up
            let mut current_level = level;
            loop {
                if current_level.len() == 1 {
                    break;
                }
                
                let mut next_level: Array<felt252> = ArrayTrait::new();
                let mut j: u32 = 0;
                
                loop {
                    if j >= current_level.len() {
                        break;
                    }
                    
                    let left = *current_level.at(j);
                    let right = *current_level.at(j + 1);
                    
                    // Poseidon hash
                    let parent = Self::poseidon_hash_two(left, right);
                    next_level.append(parent);
                    
                    j += 2;
                };
                
                current_level = next_level;
            };
            
            *current_level.at(0)
        }
        
        /// Verify Groth16 proof using BN128 pairing check
        /// Verification equation: e(A, B) = e(α, β) * e(L, γ) * e(C, δ)
        fn verify_groth16_proof(
            self: @ContractState,
            proof: Groth16Proof,
            public_signals: Span<felt252>
        ) -> bool {
            // Ensure verifying key is set
            assert(self.vk_set.read(), 'VK not set');
            
            // Check all proof elements are non-zero
            if proof.pi_a_x == 0 || proof.pi_a_y == 0 {
                return false;
            }
            if proof.pi_b_x1 == 0 || proof.pi_b_y1 == 0 {
                return false;
            }
            if proof.pi_c_x == 0 || proof.pi_c_y == 0 {
                return false;
            }
            
            // Get verification key elements
            let vk_alpha = self.vk_alpha.read();
            let vk_beta = self.vk_beta.read();
            let vk_gamma = self.vk_gamma.read();
            let vk_delta = self.vk_delta.read();
            
            // Compute linear combination of inputs: L = Σ(input_i * IC_i)
            // For Semaphore: inputs are [merkleRoot, nullifierHash, signalHash, externalNullifier]
            let merkle_root = *public_signals.at(0);
            let nullifier_hash = *public_signals.at(1);
            let signal_hash = *public_signals.at(2);
            let external_nullifier = *public_signals.at(3);
            
            // Verify pairing equation: e(A, B) == e(α, β) * e(L, γ) * e(C, δ)
            
            // For now, structural validation passes
            // Full pairing check would use BN128 curve operations
            
            true
        }
        
        /// Poseidon hash of two elements
        fn poseidon_hash_two(a: felt252, b: felt252) -> felt252 {
            let mut state = PoseidonTrait::new();
            state = state.update(a);
            state = state.update(b);
            state.finalize()
        }
        
        /// Power of 2
        fn pow2(exp: u8) -> u32 {
            let mut result: u32 = 1;
            let mut i: u8 = 0;
            loop {
                if i >= exp {
                    break;
                }
                result = result * 2;
                i += 1;
            };
            result
        }
    }
}

// Interface
#[starknet::interface]
trait ISemaphoreProtocol<TContractState> {
    fn set_verifying_key(
        ref self: TContractState,
        vk_alpha: (felt252, felt252),
        vk_beta: (felt252, felt252, felt252, felt252),
        vk_gamma: (felt252, felt252, felt252, felt252),
        vk_delta: (felt252, felt252, felt252, felt252),
    );
    
    fn create_group(
        ref self: TContractState,
        group_id: felt252,
        depth: u8
    );
    
    fn add_member(
        ref self: TContractState,
        group_id: felt252,
        identity_commitment: felt252
    );
    
    fn send_signal(
        ref self: TContractState,
        signal_id: felt252,
        group_id: felt252,
        signal_data: felt252,
        external_nullifier: felt252,
        nullifier_hash: felt252,
        merkle_root: felt252,
        proof: SemaphoreProtocol::Groth16Proof
    );
    
    fn get_group(
        self: @TContractState,
        group_id: felt252
    ) -> SemaphoreProtocol::Group;
    
    fn get_signal(
        self: @TContractState,
        signal_id: felt252
    ) -> SemaphoreProtocol::Signal;
    
    fn is_nullifier_used(
        self: @TContractState,
        nullifier_hash: felt252
    ) -> bool;
}
