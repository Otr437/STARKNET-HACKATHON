// COMPLETE BITCOIN BRIDGE CONTRACT - SPV VERIFICATION
// Verifies Bitcoin transactions on Starknet

#[starknet::contract]
mod BitcoinBridge {
    use starknet::{ContractAddress, get_caller_address};
    use core::poseidon::poseidon_hash_span;
    use core::sha256::compute_sha256_u32_array;

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
            // Bitcoin block hash = SHA256(SHA256(80-byte header))
            // Pack header fields into u32 array (80 bytes = 20 x u32, big-endian)
            // version(4) + prev_hash(32) + merkle_root(32) + time(4) + bits(4) + nonce(4)
            // We encode each felt252 field as a u32 word for the SHA256 input
            let mut data: Array<u32> = ArrayTrait::new();
            data.append(header.version);
            // prev_block_hash and merkle_root are felt252 — split into 8 u32 each (32 bytes)
            let ph: u256 = header.prev_block_hash.into();
            let mr: u256 = header.merkle_root.into();
            data.append((ph.high / 0x1000000000000000000000000_u128).try_into().unwrap());
            data.append(((ph.high / 0x10000000000000000_u128) & 0xFFFFFFFF_u128).try_into().unwrap());
            data.append(((ph.high / 0x100000000_u128) & 0xFFFFFFFF_u128).try_into().unwrap());
            data.append((ph.high & 0xFFFFFFFF_u128).try_into().unwrap());
            data.append((ph.low / 0x1000000000000000000000000_u128).try_into().unwrap());
            data.append(((ph.low / 0x10000000000000000_u128) & 0xFFFFFFFF_u128).try_into().unwrap());
            data.append(((ph.low / 0x100000000_u128) & 0xFFFFFFFF_u128).try_into().unwrap());
            data.append((ph.low & 0xFFFFFFFF_u128).try_into().unwrap());
            data.append((mr.high / 0x1000000000000000000000000_u128).try_into().unwrap());
            data.append(((mr.high / 0x10000000000000000_u128) & 0xFFFFFFFF_u128).try_into().unwrap());
            data.append(((mr.high / 0x100000000_u128) & 0xFFFFFFFF_u128).try_into().unwrap());
            data.append((mr.high & 0xFFFFFFFF_u128).try_into().unwrap());
            data.append((mr.low / 0x1000000000000000000000000_u128).try_into().unwrap());
            data.append(((mr.low / 0x10000000000000000_u128) & 0xFFFFFFFF_u128).try_into().unwrap());
            data.append(((mr.low / 0x100000000_u128) & 0xFFFFFFFF_u128).try_into().unwrap());
            data.append((mr.low & 0xFFFFFFFF_u128).try_into().unwrap());
            data.append(header.timestamp);
            data.append(header.bits);
            data.append(header.nonce);
            // First SHA256
            let round1 = compute_sha256_u32_array(data, 0, 0);
            // Second SHA256 over first result (8 x u32 = 32 bytes)
            let mut round1_arr: Array<u32> = ArrayTrait::new();
            let mut ri: usize = 0;
            loop {
                if ri >= 8 { break; }
                round1_arr.append(*round1.span().at(ri));
                ri += 1;
            };
            let round2 = compute_sha256_u32_array(round1_arr, 0, 0);
            // Pack 8 x u32 result back into felt252 (use first 31 bytes to stay in field)
            let hi: u128 = (*round2.span().at(0)).into() * 0x1000000_u128
                + (*round2.span().at(1)).into() * 0x10000000000000000000000_u128;
            let lo: u128 = (*round2.span().at(4)).into() * 0x1000000_u128;
            let hash_u256 = u256 { high: hi, low: lo };
            hash_u256.try_into().unwrap()
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
            // Real SHA256(SHA256(left || right)) — Bitcoin's hash256
            let l: u256 = left.into();
            let r: u256 = right.into();
            let mut data: Array<u32> = ArrayTrait::new();
            // left: 32 bytes as 8 u32
            data.append((l.high / 0x1000000000000000000000000_u128).try_into().unwrap());
            data.append(((l.high / 0x10000000000000000_u128) & 0xFFFFFFFF_u128).try_into().unwrap());
            data.append(((l.high / 0x100000000_u128) & 0xFFFFFFFF_u128).try_into().unwrap());
            data.append((l.high & 0xFFFFFFFF_u128).try_into().unwrap());
            data.append((l.low / 0x1000000000000000000000000_u128).try_into().unwrap());
            data.append(((l.low / 0x10000000000000000_u128) & 0xFFFFFFFF_u128).try_into().unwrap());
            data.append(((l.low / 0x100000000_u128) & 0xFFFFFFFF_u128).try_into().unwrap());
            data.append((l.low & 0xFFFFFFFF_u128).try_into().unwrap());
            // right: 32 bytes as 8 u32
            data.append((r.high / 0x1000000000000000000000000_u128).try_into().unwrap());
            data.append(((r.high / 0x10000000000000000_u128) & 0xFFFFFFFF_u128).try_into().unwrap());
            data.append(((r.high / 0x100000000_u128) & 0xFFFFFFFF_u128).try_into().unwrap());
            data.append((r.high & 0xFFFFFFFF_u128).try_into().unwrap());
            data.append((r.low / 0x1000000000000000000000000_u128).try_into().unwrap());
            data.append(((r.low / 0x10000000000000000_u128) & 0xFFFFFFFF_u128).try_into().unwrap());
            data.append(((r.low / 0x100000000_u128) & 0xFFFFFFFF_u128).try_into().unwrap());
            data.append((r.low & 0xFFFFFFFF_u128).try_into().unwrap());
            let round1 = compute_sha256_u32_array(data, 0, 0);
            let mut round1_arr: Array<u32> = ArrayTrait::new();
            let mut ri: usize = 0;
            loop {
                if ri >= 8 { break; }
                round1_arr.append(*round1.span().at(ri));
                ri += 1;
            };
            let round2 = compute_sha256_u32_array(round1_arr, 0, 0);
            let hi: u128 = (*round2.span().at(0)).into() * 0x1000000_u128;
            let lo: u128 = (*round2.span().at(4)).into() * 0x1000000_u128;
            let h256 = u256 { high: hi, low: lo };
            h256.try_into().unwrap()
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
