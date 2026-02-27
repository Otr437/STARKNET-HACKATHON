use starknet::{ContractAddress, get_caller_address, get_block_timestamp};
use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess, Map};
use core::poseidon::PoseidonTrait;
use core::hash::{HashStateTrait, HashStateExTrait};

#[derive(Drop, Serde, starknet::Store)]
pub struct BTCBlockHeader {
    pub version: u32,
    pub prev_block_hash: (felt252, felt252),
    pub merkle_root: (felt252, felt252),
    pub timestamp: u32,
    pub bits: u32,
    pub nonce: u32,
    pub height: u64,
}

#[derive(Drop, Serde)]
pub struct SPVProof {
    pub txid: felt252,
    pub block_header: BTCBlockHeader,
    pub merkle_proof: Span<felt252>,
    pub tx_index: u32,
}

#[derive(Drop, Serde, starknet::Store)]
pub struct VerifiedBTCTransaction {
    pub txid: felt252,
    pub block_height: u64,
    pub confirmations: u32,
    pub verified_at: u64,
    pub amount: u64,
    pub recipient_script: felt252,
}

#[starknet::interface]
pub trait IBTCBridge<TContractState> {
    fn submit_block_header(ref self: TContractState, header: BTCBlockHeader);
    fn verify_btc_transaction(
        ref self: TContractState,
        proof: SPVProof,
        amount: u64,
        script_hash: felt252,
    ) -> bool;
    fn is_transaction_verified(self: @TContractState, txid: felt252) -> bool;
    fn get_verified_transaction(self: @TContractState, txid: felt252) -> VerifiedBTCTransaction;
    fn get_block_header(self: @TContractState, height: u64) -> BTCBlockHeader;
    fn get_latest_block_height(self: @TContractState) -> u64;
    fn get_total_locked(self: @TContractState) -> u64;
    fn set_relayer(ref self: TContractState, new_relayer: ContractAddress);
    fn pause(ref self: TContractState);
    fn unpause(ref self: TContractState);
}

#[starknet::contract]
mod BTCBridge {
    use super::{
        ContractAddress, BTCBlockHeader, SPVProof, VerifiedBTCTransaction,
        get_caller_address, get_block_timestamp, Map, PoseidonTrait, HashStateTrait, HashStateExTrait
    };

    #[storage]
    struct Storage {
        block_headers: Map<u64, BTCBlockHeader>,
        latest_block_height: u64,
        min_confirmations: u32,
        verified_txs: Map<felt252, VerifiedBTCTransaction>,
        total_btc_locked: u64,
        admin: ContractAddress,
        relayer: ContractAddress,
        paused: bool,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        BlockHeaderSubmitted: BlockHeaderSubmitted,
        TransactionVerified: TransactionVerified,
        BTCLocked: BTCLocked,
        BTCReleased: BTCReleased,
    }

    #[derive(Drop, starknet::Event)]
    struct BlockHeaderSubmitted {
        height: u64,
        block_hash: felt252,
        timestamp: u32,
    }

    #[derive(Drop, starknet::Event)]
    struct TransactionVerified {
        txid: felt252,
        block_height: u64,
        amount: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct BTCLocked {
        txid: felt252,
        amount: u64,
        script_hash: felt252,
    }

    #[derive(Drop, starknet::Event)]
    struct BTCReleased {
        txid: felt252,
        amount: u64,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        admin: ContractAddress,
        relayer: ContractAddress,
        min_confirmations: u32,
        genesis_height: u64,
    ) {
        self.admin.write(admin);
        self.relayer.write(relayer);
        self.min_confirmations.write(min_confirmations);
        self.latest_block_height.write(genesis_height);
        self.paused.write(false);
        self.total_btc_locked.write(0);
    }

    #[abi(embed_v0)]
    impl BTCBridgeImpl of super::IBTCBridge<ContractState> {
        fn submit_block_header(ref self: ContractState, header: BTCBlockHeader) {
            let caller = get_caller_address();
            assert(caller == self.relayer.read(), 'Only relayer can submit');
            assert(!self.paused.read(), 'Bridge is paused');

            let current_height = self.latest_block_height.read();
            assert(header.height == current_height + 1, 'Invalid block height');

            if header.height > 0 {
                let prev_header = self.block_headers.read(header.height - 1);
                let prev_hash = self.compute_block_hash(prev_header);
                let header_prev_hash = self.felt_pair_to_hash(header.prev_block_hash);
                assert(prev_hash == header_prev_hash, 'Invalid prev block hash');
            }

            assert(self.verify_pow(header), 'Invalid proof of work');

            self.block_headers.write(header.height, header);
            self.latest_block_height.write(header.height);

            let block_hash = self.compute_block_hash(header);
            self.emit(BlockHeaderSubmitted {
                height: header.height,
                block_hash,
                timestamp: header.timestamp,
            });
        }

        fn verify_btc_transaction(
            ref self: ContractState,
            proof: SPVProof,
            amount: u64,
            script_hash: felt252,
        ) -> bool {
            assert(!self.paused.read(), 'Bridge is paused');

            let existing_tx = self.verified_txs.read(proof.txid);
            if existing_tx.block_height > 0 {
                return true;
            }

            let header = self.block_headers.read(proof.block_header.height);
            assert(header.height > 0, 'Block header not found');

            let current_height = self.latest_block_height.read();
            let confirmations = current_height - proof.block_header.height;
            assert(confirmations >= self.min_confirmations.read().into(), 'Not enough confirmations');

            assert(
                self.verify_merkle_proof(
                    proof.txid,
                    proof.merkle_proof,
                    proof.tx_index,
                    header.merkle_root
                ),
                'Invalid Merkle proof'
            );

            let verified_tx = VerifiedBTCTransaction {
                txid: proof.txid,
                block_height: proof.block_header.height,
                confirmations,
                verified_at: get_block_timestamp(),
                amount,
                recipient_script: script_hash,
            };

            self.verified_txs.write(proof.txid, verified_tx);
            
            let total = self.total_btc_locked.read();
            self.total_btc_locked.write(total + amount);

            self.emit(TransactionVerified {
                txid: proof.txid,
                block_height: proof.block_header.height,
                amount,
            });

            self.emit(BTCLocked { txid: proof.txid, amount, script_hash });

            true
        }

        fn is_transaction_verified(self: @ContractState, txid: felt252) -> bool {
            let tx = self.verified_txs.read(txid);
            tx.block_height > 0
        }

        fn get_verified_transaction(self: @ContractState, txid: felt252) -> VerifiedBTCTransaction {
            self.verified_txs.read(txid)
        }

        fn get_block_header(self: @ContractState, height: u64) -> BTCBlockHeader {
            self.block_headers.read(height)
        }

        fn get_latest_block_height(self: @ContractState) -> u64 {
            self.latest_block_height.read()
        }

        fn get_total_locked(self: @ContractState) -> u64 {
            self.total_btc_locked.read()
        }

        fn set_relayer(ref self: ContractState, new_relayer: ContractAddress) {
            let caller = get_caller_address();
            assert(caller == self.admin.read(), 'Only admin');
            self.relayer.write(new_relayer);
        }

        fn pause(ref self: ContractState) {
            let caller = get_caller_address();
            assert(caller == self.admin.read(), 'Only admin');
            self.paused.write(true);
        }

        fn unpause(ref self: ContractState) {
            let caller = get_caller_address();
            assert(caller == self.admin.read(), 'Only admin');
            self.paused.write(false);
        }
    }

    #[generate_trait]
    impl InternalFunctions of InternalFunctionsTrait {
        fn compute_block_hash(self: @ContractState, header: BTCBlockHeader) -> felt252 {
            let serialized = self.serialize_header(header);
            
            let mut hash_state = PoseidonTrait::new();
            hash_state = hash_state.update(serialized);
            let first_hash = hash_state.finalize();
            
            let mut hash_state2 = PoseidonTrait::new();
            hash_state2 = hash_state2.update(first_hash);
            hash_state2.finalize()
        }

        fn serialize_header(self: @ContractState, header: BTCBlockHeader) -> felt252 {
            let mut hash_state = PoseidonTrait::new();
            hash_state = hash_state.update(header.version.into());
            hash_state = hash_state.update(header.prev_block_hash.0);
            hash_state = hash_state.update(header.prev_block_hash.1);
            hash_state = hash_state.update(header.merkle_root.0);
            hash_state = hash_state.update(header.merkle_root.1);
            hash_state = hash_state.update(header.timestamp.into());
            hash_state = hash_state.update(header.bits.into());
            hash_state = hash_state.update(header.nonce.into());
            hash_state.finalize()
        }

        fn verify_pow(self: @ContractState, header: BTCBlockHeader) -> bool {
            true
        }

        fn verify_merkle_proof(
            self: @ContractState,
            txid: felt252,
            proof: Span<felt252>,
            tx_index: u32,
            merkle_root: (felt252, felt252),
        ) -> bool {
            let mut current_hash = txid;
            let mut index = tx_index;
            
            let mut i = 0;
            loop {
                if i >= proof.len() {
                    break;
                }
                
                let sibling = *proof.at(i);
                
                if index % 2 == 0 {
                    current_hash = self.hash_pair(current_hash, sibling);
                } else {
                    current_hash = self.hash_pair(sibling, current_hash);
                }
                
                index = index / 2;
                i += 1;
            };

            current_hash == merkle_root.0 || current_hash == merkle_root.1
        }

        fn hash_pair(self: @ContractState, left: felt252, right: felt252) -> felt252 {
            let mut hash_state = PoseidonTrait::new();
            hash_state = hash_state.update(left);
            hash_state = hash_state.update(right);
            hash_state.finalize()
        }

        fn felt_pair_to_hash(self: @ContractState, pair: (felt252, felt252)) -> felt252 {
            let mut hash_state = PoseidonTrait::new();
            hash_state = hash_state.update(pair.0);
            hash_state = hash_state.update(pair.1);
            hash_state.finalize()
        }
    }
}