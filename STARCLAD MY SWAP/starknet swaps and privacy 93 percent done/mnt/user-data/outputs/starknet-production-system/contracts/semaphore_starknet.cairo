// SPDX-License-Identifier: MIT
// Semaphore Protocol Implementation for Starknet
// Zero-knowledge proof based anonymous signaling

#[starknet::contract]
mod SemaphoreStarknet {
    use openzeppelin::access::accesscontrol::AccessControlComponent;
    use openzeppelin::security::pausable::PausableComponent;
    use openzeppelin::upgrades::UpgradeableComponent;
    use openzeppelin::upgrades::interface::IUpgradeable;
    use openzeppelin::introspection::src5::SRC5Component;
    use starknet::{ContractAddress, get_caller_address, ClassHash};
    use starknet::storage::{
        StoragePointerReadAccess, StoragePointerWriteAccess, StoragePathEntry, Map
    };
    use core::poseidon::poseidon_hash_span;

    // Role definitions
    const DEFAULT_ADMIN_ROLE: felt252 = 0;
    const GROUP_ADMIN_ROLE: felt252 = selector!("GROUP_ADMIN_ROLE");
    const VERIFIER_ROLE: felt252 = selector!("VERIFIER_ROLE");
    const PAUSER_ROLE: felt252 = selector!("PAUSER_ROLE");
    const UPGRADER_ROLE: felt252 = selector!("UPGRADER_ROLE");

    // Merkle tree depth (20 allows for 2^20 = 1,048,576 members)
    const TREE_DEPTH: u32 = 20;
    const MAX_DEPTH: u32 = 32;

    // Group struct
    #[derive(Drop, Serde, Copy, starknet::Store)]
    struct Group {
        admin: ContractAddress,
        merkle_tree_root: felt252,
        depth: u32,
        member_count: u256,
        created_at: u64,
    }

    // Components
    component!(path: AccessControlComponent, storage: accesscontrol, event: AccessControlEvent);
    component!(path: PausableComponent, storage: pausable, event: PausableEvent);
    component!(path: UpgradeableComponent, storage: upgradeable, event: UpgradeableEvent);
    component!(path: SRC5Component, storage: src5, event: SRC5Event);

    #[abi(embed_v0)]
    impl AccessControlImpl =
        AccessControlComponent::AccessControlImpl<ContractState>;
    impl AccessControlInternalImpl = AccessControlComponent::InternalImpl<ContractState>;

    #[abi(embed_v0)]
    impl PausableImpl = PausableComponent::PausableImpl<ContractState>;
    impl PausableInternalImpl = PausableComponent::InternalImpl<ContractState>;

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
        upgradeable: UpgradeableComponent::Storage,
        #[substorage(v0)]
        src5: SRC5Component::Storage,
        // Semaphore state
        groups: Map<u256, Group>, // group_id => Group
        group_counter: u256,
        identity_commitments: Map<(u256, felt252), bool>, // (group_id, commitment) => exists
        nullifiers: Map<felt252, bool>, // nullifier => used
        // Merkle tree storage: (group_id, level, index) => hash
        merkle_tree_nodes: Map<(u256, u32, u256), felt252>,
        // Zero hashes for empty tree nodes
        zero_hashes: Map<u32, felt252>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        AccessControlEvent: AccessControlComponent::Event,
        #[flat]
        PausableEvent: PausableComponent::Event,
        #[flat]
        UpgradeableEvent: UpgradeableComponent::Event,
        #[flat]
        SRC5Event: SRC5Component::Event,
        GroupCreated: GroupCreated,
        MemberAdded: MemberAdded,
        MemberRemoved: MemberRemoved,
        ProofVerified: ProofVerified,
        SignalBroadcast: SignalBroadcast,
    }

    #[derive(Drop, starknet::Event)]
    struct GroupCreated {
        #[key]
        group_id: u256,
        admin: ContractAddress,
        depth: u32,
        timestamp: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct MemberAdded {
        #[key]
        group_id: u256,
        identity_commitment: felt252,
        index: u256,
        timestamp: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct MemberRemoved {
        #[key]
        group_id: u256,
        identity_commitment: felt252,
        timestamp: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct ProofVerified {
        #[key]
        group_id: u256,
        nullifier_hash: felt252,
        timestamp: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct SignalBroadcast {
        #[key]
        group_id: u256,
        #[key]
        nullifier_hash: felt252,
        signal: felt252,
        timestamp: u64,
    }

    #[constructor]
    fn constructor(ref self: ContractState, admin: ContractAddress) {
        // Initialize components
        self.accesscontrol.initializer();
        self.pausable.initializer();

        // Grant roles
        self.accesscontrol._grant_role(DEFAULT_ADMIN_ROLE, admin);
        self.accesscontrol._grant_role(GROUP_ADMIN_ROLE, admin);
        self.accesscontrol._grant_role(VERIFIER_ROLE, admin);
        self.accesscontrol._grant_role(PAUSER_ROLE, admin);
        self.accesscontrol._grant_role(UPGRADER_ROLE, admin);

        // Initialize zero hashes for Merkle tree
        self._initialize_zero_hashes();
        self.group_counter.write(0);
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn _initialize_zero_hashes(ref self: ContractState) {
            // Initialize zero hashes for empty Merkle tree nodes
            // zero_hash[0] = poseidon_hash(0)
            let mut zero = poseidon_hash_span(array![0].span());
            self.zero_hashes.entry(0).write(zero);

            // zero_hash[i+1] = poseidon_hash(zero_hash[i], zero_hash[i])
            let mut i: u32 = 1;
            loop {
                if i > MAX_DEPTH {
                    break;
                }
                zero = poseidon_hash_span(array![zero, zero].span());
                self.zero_hashes.entry(i).write(zero);
                i += 1;
            }
        }

        fn _compute_merkle_root(
            ref self: ContractState,
            group_id: u256,
            leaf: felt252,
            index: u256,
            depth: u32
        ) -> felt252 {
            let mut current_hash = leaf;
            let mut current_index = index;
            let mut level: u32 = 0;

            loop {
                if level >= depth {
                    break;
                }

                let is_right = (current_index % 2) == 1;
                current_index = current_index / 2;

                let sibling_index = if is_right {
                    current_index * 2
                } else {
                    current_index * 2 + 1
                };

                // Get sibling hash
                let sibling = self
                    .merkle_tree_nodes
                    .entry((group_id, level, sibling_index))
                    .read();
                let sibling_or_zero = if sibling == 0 {
                    self.zero_hashes.entry(level).read()
                } else {
                    sibling
                };

                // Compute parent hash
                current_hash =
                    if is_right {
                        poseidon_hash_span(array![sibling_or_zero, current_hash].span())
                    } else {
                        poseidon_hash_span(array![current_hash, sibling_or_zero].span())
                    };

                // Store parent hash
                self
                    .merkle_tree_nodes
                    .entry((group_id, level + 1, current_index))
                    .write(current_hash);

                level += 1;
            };

            current_hash
        }

        fn _verify_proof(
            self: @ContractState,
            root: felt252,
            leaf: felt252,
            path_indices: Span<u256>,
            path_elements: Span<felt252>,
            depth: u32
        ) -> bool {
            let mut current_hash = leaf;

            let mut i: u32 = 0;
            loop {
                if i >= depth {
                    break;
                }

                let path_element = *path_elements.at(i);
                let is_right = (*path_indices.at(i) % 2) == 1;

                current_hash =
                    if is_right {
                        poseidon_hash_span(array![path_element, current_hash].span())
                    } else {
                        poseidon_hash_span(array![current_hash, path_element].span())
                    };

                i += 1;
            };

            current_hash == root
        }
    }

    #[abi(embed_v0)]
    impl SemaphoreStarknetImpl of ISemaphoreStarknet<ContractState> {
        fn create_group(ref self: ContractState, depth: u32, admin: ContractAddress) -> u256 {
            self.accesscontrol.assert_only_role(GROUP_ADMIN_ROLE);
            assert(depth > 0 && depth <= MAX_DEPTH, 'Invalid depth');

            let group_id = self.group_counter.read();
            let current_time = starknet::get_block_timestamp();

            let group = Group {
                admin,
                merkle_tree_root: self.zero_hashes.entry(depth).read(),
                depth,
                member_count: 0,
                created_at: current_time,
            };

            self.groups.entry(group_id).write(group);
            self.group_counter.write(group_id + 1);

            self.emit(GroupCreated { group_id, admin, depth, timestamp: current_time });

            group_id
        }

        fn add_member(
            ref self: ContractState, group_id: u256, identity_commitment: felt252
        ) {
            self.pausable.assert_not_paused();

            let mut group = self.groups.entry(group_id).read();
            let caller = get_caller_address();

            assert(caller == group.admin, 'Not group admin');
            assert(
                !self.identity_commitments.entry((group_id, identity_commitment)).read(),
                'Member already exists'
            );

            // Add to identity commitments
            self.identity_commitments.entry((group_id, identity_commitment)).write(true);

            // Update Merkle tree
            let index = group.member_count;
            self
                .merkle_tree_nodes
                .entry((group_id, 0, index))
                .write(identity_commitment);

            let new_root = self._compute_merkle_root(group_id, identity_commitment, index, group.depth);

            group.merkle_tree_root = new_root;
            group.member_count += 1;
            self.groups.entry(group_id).write(group);

            self
                .emit(
                    MemberAdded {
                        group_id,
                        identity_commitment,
                        index,
                        timestamp: starknet::get_block_timestamp()
                    }
                );
        }

        fn verify_proof(
            ref self: ContractState,
            group_id: u256,
            signal: felt252,
            nullifier_hash: felt252,
            external_nullifier: felt252,
            path_indices: Span<u256>,
            path_elements: Span<felt252>
        ) -> bool {
            self.pausable.assert_not_paused();

            let group = self.groups.entry(group_id).read();

            // Check nullifier not used
            assert(!self.nullifiers.entry(nullifier_hash).read(), 'Nullifier already used');

            // Verify proof path length
            assert(path_indices.len() == group.depth, 'Invalid path length');
            assert(path_elements.len() == group.depth, 'Invalid path length');

            // In production, this would verify a STARK proof
            // For now, we verify the Merkle proof
            let signal_hash = poseidon_hash_span(array![signal].span());
            let is_valid = self
                ._verify_proof(
                    group.merkle_tree_root,
                    signal_hash,
                    path_indices,
                    path_elements,
                    group.depth
                );

            if is_valid {
                // Mark nullifier as used
                self.nullifiers.entry(nullifier_hash).write(true);

                self
                    .emit(
                        ProofVerified {
                            group_id, nullifier_hash, timestamp: starknet::get_block_timestamp()
                        }
                    );

                self
                    .emit(
                        SignalBroadcast {
                            group_id,
                            nullifier_hash,
                            signal,
                            timestamp: starknet::get_block_timestamp()
                        }
                    );
            }

            is_valid
        }

        fn get_group(self: @ContractState, group_id: u256) -> Group {
            self.groups.entry(group_id).read()
        }

        fn is_member(
            self: @ContractState, group_id: u256, identity_commitment: felt252
        ) -> bool {
            self.identity_commitments.entry((group_id, identity_commitment)).read()
        }

        fn is_nullifier_used(self: @ContractState, nullifier_hash: felt252) -> bool {
            self.nullifiers.entry(nullifier_hash).read()
        }

        fn pause(ref self: ContractState) {
            self.accesscontrol.assert_only_role(PAUSER_ROLE);
            self.pausable.pause();
        }

        fn unpause(ref self: ContractState) {
            self.accesscontrol.assert_only_role(PAUSER_ROLE);
            self.pausable.unpause();
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
    trait ISemaphoreStarknet<TContractState> {
        fn create_group(ref self: TContractState, depth: u32, admin: ContractAddress) -> u256;
        fn add_member(ref self: TContractState, group_id: u256, identity_commitment: felt252);
        fn verify_proof(
            ref self: TContractState,
            group_id: u256,
            signal: felt252,
            nullifier_hash: felt252,
            external_nullifier: felt252,
            path_indices: Span<u256>,
            path_elements: Span<felt252>
        ) -> bool;
        fn get_group(self: @TContractState, group_id: u256) -> Group;
        fn is_member(self: @TContractState, group_id: u256, identity_commitment: felt252) -> bool;
        fn is_nullifier_used(self: @TContractState, nullifier_hash: felt252) -> bool;
        fn pause(ref self: TContractState);
        fn unpause(ref self: TContractState);
    }
}
