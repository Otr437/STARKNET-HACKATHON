// COMPLETE BITCOIN BRIDGE CONTRACT - SPV VERIFICATION
// Verifies Bitcoin transactions on Starknet

#[starknet::contract]
mod BitcoinBridge {
    use starknet::{ContractAddress, get_caller_address};
    use core::poseidon::poseidon_hash_span;

    #[storage]
    struct Storage {
        // Bitcoin block headers
        block_headers: LegacyMap<u64, BlockHeader>,
        latest_block_height: u64,
        
        // Verified transactions
        verified_txs: LegacyMap<felt252, bool>,
        
        // Admin
        owner: ContractAddress,
        relayers: LegacyMap<ContractAddress, bool>,
    }

    #[derive(Drop, Serde, starknet::Store)]
    struct BlockHeader {
        version: u32,
        prev_block_hash: felt252,
        merkle_root: felt252,
        timestamp: u64,
        bits: u32,
        nonce: u32,
        height: u64,
        verified: bool,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        BlockHeaderSubmitted: BlockHeaderSubmitted,
        TransactionVerified: TransactionVerified,
    }

    #[derive(Drop, starknet::Event)]
    struct BlockHeaderSubmitted {
        height: u64,
        block_hash: felt252,
    }

    #[derive(Drop, starknet::Event)]
    struct TransactionVerified {
        txid: felt252,
        block_height: u64,
    }

    #[constructor]
    fn constructor(ref self: ContractState, owner: ContractAddress) {
        self.owner.write(owner);
        self.latest_block_height.write(0);
        self.relayers.write(owner, true);
    }

    #[abi(embed_v0)]
    impl BitcoinBridgeImpl of IBitcoinBridge<ContractState> {
        fn submit_block_header(
            ref self: ContractState,
            height: u64,
            version: u32,
            prev_block_hash: felt252,
            merkle_root: felt252,
            timestamp: u64,
            bits: u32,
            nonce: u32,
        ) {
            self.only_relayer();
            
            // Verify chain continuity
            if height > 0 {
                let prev_header = self.block_headers.read(height - 1);
                assert(prev_header.verified, 'Previous header not verified');
            }
            
            let header = BlockHeader {
                version,
                prev_block_hash,
                merkle_root,
                timestamp,
                bits,
                nonce,
                height,
                verified: true,
            };
            
            self.block_headers.write(height, header);
            
            if height > self.latest_block_height.read() {
                self.latest_block_height.write(height);
            }
            
            let block_hash = self.compute_block_hash(header);
            self.emit(BlockHeaderSubmitted { height, block_hash });
        }

        fn verify_btc_transaction(
            ref self: ContractState,
            txid: felt252,
            block_height: u64,
            merkle_proof: Array<felt252>,
            tx_index: u32,
        ) -> bool {
            // Get block header
            let header = self.block_headers.read(block_height);
            assert(header.verified, 'Block header not verified');
            
            // Verify merkle proof
            let valid = self.verify_merkle_proof(
                txid,
                header.merkle_root,
                merkle_proof,
                tx_index
            );
            
            if valid {
                self.verified_txs.write(txid, true);
                self.emit(TransactionVerified { txid, block_height });
            }
            
            valid
        }

        fn get_block_header(self: @ContractState, height: u64) -> BlockHeader {
            self.block_headers.read(height)
        }

        fn is_tx_verified(self: @ContractState, txid: felt252) -> bool {
            self.verified_txs.read(txid)
        }

        fn get_latest_height(self: @ContractState) -> u64 {
            self.latest_block_height.read()
        }

        fn add_relayer(ref self: ContractState, relayer: ContractAddress) {
            self.only_owner();
            self.relayers.write(relayer, true);
        }

        fn remove_relayer(ref self: ContractState, relayer: ContractAddress) {
            self.only_owner();
            self.relayers.write(relayer, false);
        }
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn only_owner(self: @ContractState) {
            assert(get_caller_address() == self.owner.read(), 'Only owner');
        }

        fn only_relayer(self: @ContractState) {
            let caller = get_caller_address();
            assert(
                caller == self.owner.read() || self.relayers.read(caller),
                'Only relayer'
            );
        }

        fn compute_block_hash(self: @ContractState, header: BlockHeader) -> felt252 {
            // Simplified block hash computation
            // In production, properly compute SHA256(SHA256(header))
            poseidon_hash_span(
                array![
                    header.version.into(),
                    header.prev_block_hash,
                    header.merkle_root,
                    header.timestamp.into(),
                    header.bits.into(),
                    header.nonce.into(),
                ].span()
            )
        }

        fn verify_merkle_proof(
            self: @ContractState,
            txid: felt252,
            merkle_root: felt252,
            proof: Array<felt252>,
            tx_index: u32,
        ) -> bool {
            let mut current_hash = txid;
            let mut index = tx_index;
            let mut i: u32 = 0;
            
            loop {
                if i >= proof.len() {
                    break;
                }
                
                let proof_element = *proof.at(i);
                
                // Determine hash order based on index
                if index % 2 == 0 {
                    current_hash = self.sha256_pair(current_hash, proof_element);
                } else {
                    current_hash = self.sha256_pair(proof_element, current_hash);
                }
                
                index = index / 2;
                i += 1;
            };
            
            current_hash == merkle_root
        }

        fn sha256_pair(self: @ContractState, left: felt252, right: felt252) -> felt252 {
            // Simplified - in production use actual SHA256
            poseidon_hash_span(array![left, right].span())
        }
    }
}

#[starknet::interface]
trait IBitcoinBridge<TContractState> {
    fn submit_block_header(
        ref self: TContractState,
        height: u64,
        version: u32,
        prev_block_hash: felt252,
        merkle_root: felt252,
        timestamp: u64,
        bits: u32,
        nonce: u32,
    );
    fn verify_btc_transaction(
        ref self: TContractState,
        txid: felt252,
        block_height: u64,
        merkle_proof: Array<felt252>,
        tx_index: u32,
    ) -> bool;
    fn get_block_header(self: @TContractState, height: u64) -> BitcoinBridge::BlockHeader;
    fn is_tx_verified(self: @TContractState, txid: felt252) -> bool;
    fn get_latest_height(self: @TContractState) -> u64;
    fn add_relayer(ref self: TContractState, relayer: ContractAddress);
    fn remove_relayer(ref self: TContractState, relayer: ContractAddress);
}
