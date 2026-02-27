#[starknet::contract]
mod ShieldedRWAVault {
    use starknet::{ContractAddress, get_caller_address, get_block_timestamp};
    use core::poseidon::poseidon_hash_span;

    const TREE_DEPTH: u32 = 20;
    const TREE_SIZE: u32 = 1048576; // 2^20

    #[starknet::interface]
    trait IPriceOracle<TContractState> {
        fn get_price(self: @TContractState, symbol: felt252) -> (u256, u8, u64);
    }

    #[storage]
    struct Storage {
        owner: ContractAddress,
        oracle_address: ContractAddress,
        
        // Merkle tree of note commitments (NO WALLET INFO)
        merkle_tree: LegacyMap<u32, felt252>,
        next_index: u32,
        merkle_root: felt252,
        
        // Nullifiers (prevent double-spend)
        nullifiers_used: LegacyMap<felt252, bool>,
        
        // Assets
        asset_symbols: LegacyMap<u256, felt252>,
        asset_exists: LegacyMap<u256, bool>,
        next_asset_id: u256,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        Deposit: Deposit,
        Withdrawal: Withdrawal,
        AssetRegistered: AssetRegistered,
    }

    #[derive(Drop, starknet::Event)]
    struct Deposit {
        commitment: felt252,
        leaf_index: u32,
        timestamp: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct Withdrawal {
        nullifier: felt252,
        destination: ContractAddress,
        timestamp: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct AssetRegistered {
        asset_id: u256,
        symbol: felt252,
    }

    #[constructor]
    fn constructor(ref self: ContractState, owner: ContractAddress, oracle: ContractAddress) {
        self.owner.write(owner);
        self.oracle_address.write(oracle);
        self.next_index.write(0);
        self.next_asset_id.write(1);
        
        // Initialize empty tree
        self._init_tree();
    }

    #[abi(embed_v0)]
    impl ShieldedRWAVaultImpl of super::IShieldedRWAVault<ContractState> {
        
        // Register asset
        fn register_asset(ref self: ContractState, symbol: felt252) -> u256 {
            assert(get_caller_address() == self.owner.read(), 'Not owner');
            
            let asset_id = self.next_asset_id.read();
            self.asset_symbols.write(asset_id, symbol);
            self.asset_exists.write(asset_id, true);
            self.next_asset_id.write(asset_id + 1);
            
            self.emit(AssetRegistered { asset_id, symbol });
            asset_id
        }
        
        // Shielded deposit - NO WALLET INFO STORED
        fn deposit(ref self: ContractState, note_commitment: felt252) {
            assert(note_commitment != 0, 'Invalid commitment');
            
            // Add to Merkle tree
            let index = self.next_index.read();
            assert(index < TREE_SIZE, 'Tree full');
            
            self.merkle_tree.write(index, note_commitment);
            self.next_index.write(index + 1);
            
            // Update Merkle root
            self._update_merkle_root();
            
            self.emit(Deposit {
                commitment: note_commitment,
                leaf_index: index,
                timestamp: get_block_timestamp()
            });
        }
        
        // Shielded withdrawal with Noir proof
        fn withdraw(
            ref self: ContractState,
            noir_proof: Span<felt252>,
            nullifier: felt252,
            asset_id: u256,
            amount: u256,
            destination: ContractAddress
        ) {
            // Check nullifier not used
            assert(!self.nullifiers_used.read(nullifier), 'Already withdrawn');
            
            // Verify Noir proof proves:
            // 1. Note exists in Merkle tree
            // 2. User knows secret
            // 3. Nullifier matches
            let merkle_root = self.merkle_root.read();
            let verified = self._verify_withdrawal_proof(
                noir_proof,
                merkle_root,
                nullifier,
                destination.into()
            );
            assert(verified, 'Invalid proof');
            
            // Mark nullifier as used
            self.nullifiers_used.write(nullifier, true);
            
            // Get asset value from oracle
            let symbol = self.asset_symbols.read(asset_id);
            let oracle = IPriceOracleDispatcher {
                contract_address: self.oracle_address.read()
            };
            let (price, decimals, _) = oracle.get_price(symbol);
            
            // Calculate USD value
            let usd_value = (amount * price) / (10_u256.pow(decimals.into()));
            
            self.emit(Withdrawal {
                nullifier,
                destination,
                timestamp: get_block_timestamp()
            });
            
            // Bridge processes this event and sends funds to destination
        }
        
        // View functions
        fn get_merkle_root(self: @ContractState) -> felt252 {
            self.merkle_root.read()
        }
        
        fn is_nullifier_used(self: @ContractState, nullifier: felt252) -> bool {
            self.nullifiers_used.read(nullifier)
        }
        
        fn get_next_index(self: @ContractState) -> u32 {
            self.next_index.read()
        }
        
        fn get_asset_symbol(self: @ContractState, asset_id: u256) -> felt252 {
            self.asset_symbols.read(asset_id)
        }
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn _init_tree(ref self: ContractState) {
            // Initialize with zero hashes
            let zero_hash: felt252 = 0;
            self.merkle_root.write(zero_hash);
        }
        
        fn _update_merkle_root(ref self: ContractState) {
            let num_leaves = self.next_index.read();
            
            if num_leaves == 0 {
                self.merkle_root.write(0);
                return;
            }
            
            // Build proper Merkle tree level by level
            let mut current_level = ArrayTrait::new();
            
            // Level 0: leaves
            let mut i: u32 = 0;
            loop {
                if i >= num_leaves {
                    break;
                }
                current_level.append(self.merkle_tree.read(i));
                i += 1;
            };
            
            // Pad to power of 2
            let zero: felt252 = 0;
            while current_level.len() % 2 != 0 {
                current_level.append(zero);
            }
            
            // Build tree bottom-up
            let mut level = 0;
            loop {
                if current_level.len() == 1 || level >= 20 {
                    break;
                }
                
                let mut next_level = ArrayTrait::new();
                let mut j: u32 = 0;
                
                loop {
                    if j >= current_level.len() {
                        break;
                    }
                    
                    let left = *current_level.at(j);
                    let right = if j + 1 < current_level.len() {
                        *current_level.at(j + 1)
                    } else {
                        zero
                    };
                    
                    let parent = poseidon_hash_span(array![left, right].span());
                    next_level.append(parent);
                    
                    j += 2;
                };
                
                current_level = next_level;
                level += 1;
            };
            
            let root = *current_level.at(0);
            self.merkle_root.write(root);
        }
        
        fn _verify_withdrawal_proof(
            self: @ContractState,
            proof: Span<felt252>,
            merkle_root: felt252,
            nullifier: felt252,
            destination: felt252
        ) -> bool {
            // Verify Noir proof using Garaga
            // Public inputs: [merkle_root, nullifier, destination]
            
            assert(proof.len() > 0, 'Empty proof');
            
            // TODO: Call Garaga verifier
            // For hackathon: simplified check
            true
        }
    }
}

#[starknet::interface]
trait IShieldedRWAVault<TContractState> {
    fn register_asset(ref self: TContractState, symbol: felt252) -> u256;
    fn deposit(ref self: TContractState, note_commitment: felt252);
    fn withdraw(
        ref self: TContractState,
        noir_proof: Span<felt252>,
        nullifier: felt252,
        asset_id: u256,
        amount: u256,
        destination: ContractAddress
    );
    fn get_merkle_root(self: @TContractState) -> felt252;
    fn is_nullifier_used(self: @TContractState, nullifier: felt252) -> bool;
    fn get_next_index(self: @TContractState) -> u32;
    fn get_asset_symbol(self: @TContractState, asset_id: u256) -> felt252;
}
