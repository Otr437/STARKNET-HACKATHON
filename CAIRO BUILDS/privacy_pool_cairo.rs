use starknet::ContractAddress;
use starknet::{get_caller_address, get_block_timestamp, get_contract_address};
use openzeppelin::token::erc20::interface::{IERC20Dispatcher, IERC20DispatcherTrait};
use super::merkle_tree::{hash_pair, TREE_HEIGHT};
use super::proof_verifier::{verify_swap_proof, verify_withdrawal_proof, SwapProof, WithdrawalProof};

#[starknet::interface]
pub trait IPrivacyPool<TContractState> {
    fn deposit(ref self: TContractState, token: ContractAddress, amount: u256, commitment: felt252);
    fn swap(ref self: TContractState, proof: SwapProof);
    fn withdraw(ref self: TContractState, proof: WithdrawalProof);
    fn get_merkle_root(self: @TContractState) -> felt252;
    fn is_nullifier_used(self: @TContractState, nullifier: felt252) -> bool;
    fn get_tree_size(self: @TContractState) -> u32;
    fn is_known_commitment(self: @TContractState, commitment: felt252) -> bool;
    fn get_commitment_at_index(self: @TContractState, index: u32) -> felt252;
}

#[starknet::contract]
mod PrivacyPool {
    use super::{ContractAddress, IERC20Dispatcher, IERC20DispatcherTrait};
    use super::{get_caller_address, get_block_timestamp, get_contract_address};
    use super::{hash_pair, TREE_HEIGHT};
    use super::{verify_swap_proof, verify_withdrawal_proof, SwapProof, WithdrawalProof};

    #[storage]
    struct Storage {
        commitments: LegacyMap<u32, felt252>,
        tree_size: u32,
        nullifiers: LegacyMap<felt252, bool>,
        token_balances: LegacyMap<ContractAddress, u256>,
        commitment_exists: LegacyMap<felt252, bool>,
        merkle_roots: LegacyMap<u32, felt252>,
        current_root_index: u32,
        relayers: LegacyMap<ContractAddress, bool>,
        owner: ContractAddress,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        Deposit: Deposit,
        Swap: Swap,
        Withdrawal: Withdrawal,
        RelayerRegistered: RelayerRegistered,
    }

    #[derive(Drop, starknet::Event)]
    struct Deposit {
        #[key]
        commitment: felt252,
        token: ContractAddress,
        leaf_index: u32,
        timestamp: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct Swap {
        #[key]
        nullifier: felt252,
        new_commitment: felt252,
        timestamp: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct Withdrawal {
        #[key]
        nullifier: felt252,
        recipient: ContractAddress,
        token: ContractAddress,
        amount: u256,
        timestamp: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct RelayerRegistered {
        relayer: ContractAddress,
    }

    #[constructor]
    fn constructor(ref self: ContractState, owner: ContractAddress) {
        self.owner.write(owner);
        self.tree_size.write(0);
        self.current_root_index.write(0);
    }

    #[abi(embed_v0)]
    impl PrivacyPoolImpl of super::IPrivacyPool<ContractState> {
        fn deposit(
            ref self: ContractState,
            token: ContractAddress,
            amount: u256,
            commitment: felt252
        ) {
            assert(commitment != 0, 'Invalid commitment');
            assert(!self.commitment_exists.read(commitment), 'Commitment exists');
            
            let caller = get_caller_address();
            let this = get_contract_address();
            
            let token_dispatcher = IERC20Dispatcher { contract_address: token };
            token_dispatcher.transfer_from(caller, this, amount);
            
            let leaf_index = self.tree_size.read();
            self.commitments.write(leaf_index, commitment);
            self.commitment_exists.write(commitment, true);
            self.tree_size.write(leaf_index + 1);
            
            let current_balance = self.token_balances.read(token);
            self.token_balances.write(token, current_balance + amount);
            
            self.update_merkle_root();
            
            self.emit(Deposit {
                commitment,
                token,
                leaf_index,
                timestamp: get_block_timestamp(),
            });
        }

        fn swap(ref self: ContractState, proof: SwapProof) {
            assert(!self.nullifiers.read(proof.nullifier), 'Nullifier used');
            assert(!self.commitment_exists.read(proof.new_commitment), 'Commitment exists');
            
            let root = self.get_merkle_root();
            assert(verify_swap_proof(proof, root), 'Invalid proof');
            
            self.nullifiers.write(proof.nullifier, true);
            
            let leaf_index = self.tree_size.read();
            self.commitments.write(leaf_index, proof.new_commitment);
            self.commitment_exists.write(proof.new_commitment, true);
            self.tree_size.write(leaf_index + 1);
            
            let balance_in = self.token_balances.read(proof.token_in);
            self.token_balances.write(proof.token_in, balance_in - proof.amount_in);
            
            let balance_out = self.token_balances.read(proof.token_out);
            self.token_balances.write(proof.token_out, balance_out + proof.amount_out);
            
            self.update_merkle_root();
            
            self.emit(Swap {
                nullifier: proof.nullifier,
                new_commitment: proof.new_commitment,
                timestamp: get_block_timestamp(),
            });
        }

        fn withdraw(ref self: ContractState, proof: WithdrawalProof) {
            assert(!self.nullifiers.read(proof.nullifier), 'Nullifier used');
            
            let root = self.get_merkle_root();
            assert(verify_withdrawal_proof(proof, root), 'Invalid proof');
            
            self.nullifiers.write(proof.nullifier, true);
            
            let token_dispatcher = IERC20Dispatcher { contract_address: proof.token };
            token_dispatcher.transfer(proof.recipient, proof.amount);
            
            let current_balance = self.token_balances.read(proof.token);
            self.token_balances.write(proof.token, current_balance - proof.amount);
            
            self.emit(Withdrawal {
                nullifier: proof.nullifier,
                recipient: proof.recipient,
                token: proof.token,
                amount: proof.amount,
                timestamp: get_block_timestamp(),
            });
        }

        fn get_merkle_root(self: @ContractState) -> felt252 {
            let index = self.current_root_index.read();
            self.merkle_roots.read(index)
        }

        fn is_nullifier_used(self: @ContractState, nullifier: felt252) -> bool {
            self.nullifiers.read(nullifier)
        }

        fn get_tree_size(self: @ContractState) -> u32 {
            self.tree_size.read()
        }

        fn is_known_commitment(self: @ContractState, commitment: felt252) -> bool {
            self.commitment_exists.read(commitment)
        }

        fn get_commitment_at_index(self: @ContractState, index: u32) -> felt252 {
            self.commitments.read(index)
        }
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn update_merkle_root(ref self: ContractState) {
            let size = self.tree_size.read();
            if size == 0 {
                return;
            }
            
            let mut current_level = ArrayTrait::new();
            let mut i: u32 = 0;
            
            loop {
                if i >= size {
                    break;
                }
                current_level.append(self.commitments.read(i));
                i += 1;
            };
            
            let mut level: u32 = 0;
            loop {
                if current_level.len() <= 1 || level >= TREE_HEIGHT {
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
                        0
                    };
                    
                    next_level.append(hash_pair(left, right));
                    j += 2;
                };
                
                current_level = next_level;
                level += 1;
            };
            
            if current_level.len() > 0 {
                let root = *current_level.at(0);
                let index = self.current_root_index.read();
                self.merkle_roots.write(index + 1, root);
                self.current_root_index.write(index + 1);
            }
        }

        fn only