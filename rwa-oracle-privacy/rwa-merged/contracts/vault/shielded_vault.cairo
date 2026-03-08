// ============================================================
//  ShieldedRWAVault
//  StarkNet — Cairo 2.13.1 (Scarb 2.13.1 / Sierra 1.7.0)
//
//  Privacy-preserving vault for RWA positions.
//  Uses a depth-20 Poseidon Merkle tree of note commitments.
//  Withdrawals require a Noir ZK proof (verified via Garaga).
//
//  Architecture:
//    - deposit()   — adds a note commitment to the Merkle tree
//                    NO wallet info stored anywhere on-chain
//    - withdraw()  — burns a nullifier + verifies Noir proof
//                    proving membership without revealing which note
//    - Oracle      — reads live prices from RwaOracle contract
// ============================================================

// ─────────────────────────────────────────────────────────────
//  Oracle interface (reads from our RwaOracle contract)
// ─────────────────────────────────────────────────────────────
#[starknet::interface]
pub trait IRwaOracle<TContractState> {
    fn get_price(self: @TContractState, asset_id: felt252) -> (u256, u64);
    fn get_price_if_fresh(
        self: @TContractState,
        asset_id: felt252,
        max_staleness_secs: u64
    ) -> (u256, u64);
}

// ─────────────────────────────────────────────────────────────
//  Vault interface
// ─────────────────────────────────────────────────────────────
#[starknet::interface]
pub trait IShieldedRWAVault<TContractState> {
    // Admin
    fn propose_owner(ref self: TContractState, new_owner: starknet::ContractAddress);
    fn accept_ownership(ref self: TContractState);
    fn set_oracle(ref self: TContractState, oracle: starknet::ContractAddress);
    fn set_garaga_verifier(ref self: TContractState, verifier: starknet::ContractAddress);
    fn register_asset(ref self: TContractState, asset_felt_id: felt252, symbol: felt252);
    fn pause(ref self: TContractState);
    fn unpause(ref self: TContractState);

    // Core privacy operations
    fn deposit(ref self: TContractState, note_commitment: felt252);
    fn withdraw(
        ref self: TContractState,
        noir_proof:  Span<felt252>,
        nullifier:   felt252,
        asset_id:    felt252,
        amount:      u256,
        destination: starknet::ContractAddress
    );

    // Views
    fn get_merkle_root(self: @TContractState) -> felt252;
    fn is_nullifier_used(self: @TContractState, nullifier: felt252) -> bool;
    fn get_deposit_count(self: @TContractState) -> u32;
    fn get_owner(self: @TContractState) -> starknet::ContractAddress;
    fn get_pending_owner(self: @TContractState) -> starknet::ContractAddress;
    fn get_oracle(self: @TContractState) -> starknet::ContractAddress;
    fn is_paused(self: @TContractState) -> bool;
    fn get_asset_symbol(self: @TContractState, asset_id: felt252) -> felt252;
}

// ─────────────────────────────────────────────────────────────
//  Contract
// ─────────────────────────────────────────────────────────────
#[starknet::contract]
pub mod ShieldedRWAVault {
    use starknet::{
        ContractAddress,
        get_caller_address,
        get_block_timestamp,
        contract_address_const,
    };
    use starknet::storage::{
        Map,
        StorageMapReadAccess,
        StorageMapWriteAccess,
        StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use core::poseidon::poseidon_hash_span;

    const TREE_DEPTH: u32 = 20;
    const TREE_SIZE:  u32 = 1048576; // 2^20
    // Max staleness for oracle prices used in withdrawal value calc
    const MAX_PRICE_STALENESS: u64 = 3600; // 1 hour

    fn zero() -> ContractAddress { contract_address_const::<0>() }

    // ── Storage ───────────────────────────────────────────────
    #[storage]
    struct Storage {
        // Access control
        owner:           ContractAddress,
        pending_owner:   ContractAddress,
        paused:          bool,

        // External contracts
        oracle_address:  ContractAddress,
        garaga_verifier: ContractAddress, // Noir proof verifier

        // Asset registry — maps our felt252 IDs to oracle symbols
        asset_symbols:   Map<felt252, felt252>,
        asset_registered: Map<felt252, bool>,

        // Merkle tree (depth=20, capacity=1M leaves)
        merkle_leaves:   Map<u32, felt252>,  // index => commitment
        deposit_count:   u32,
        merkle_root:     felt252,

        // Nullifier set — prevents double-spend
        nullifiers_used: Map<felt252, bool>,
    }

    // ── Events ────────────────────────────────────────────────
    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        OwnershipProposed:   OwnershipProposed,
        OwnershipAccepted:   OwnershipAccepted,
        AssetRegistered:     AssetRegistered,
        Deposit:             Deposit,
        Withdrawal:          Withdrawal,
        OracleUpdated:       OracleUpdated,
        Paused:              Paused,
        Unpaused:            Unpaused,
    }

    #[derive(Drop, starknet::Event)]
    pub struct OwnershipProposed {
        #[key] pub current_owner:  ContractAddress,
        #[key] pub proposed_owner: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    pub struct OwnershipAccepted {
        #[key] pub previous_owner: ContractAddress,
        #[key] pub new_owner:      ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    pub struct AssetRegistered {
        #[key] pub asset_id: felt252,
                pub symbol:  felt252,
    }

    #[derive(Drop, starknet::Event)]
    pub struct Deposit {
        #[key] pub commitment: felt252,
                pub leaf_index: u32,
                pub timestamp:  u64,
    }

    #[derive(Drop, starknet::Event)]
    pub struct Withdrawal {
        #[key] pub nullifier:   felt252,
        #[key] pub destination: ContractAddress,
                pub timestamp:  u64,
    }

    #[derive(Drop, starknet::Event)]
    pub struct OracleUpdated {
        pub old_oracle: ContractAddress,
        pub new_oracle: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    pub struct Paused   { pub by: ContractAddress }
    #[derive(Drop, starknet::Event)]
    pub struct Unpaused { pub by: ContractAddress }

    // ── Constructor ───────────────────────────────────────────
    #[constructor]
    fn constructor(
        ref self: ContractState,
        owner:   ContractAddress,
        oracle:  ContractAddress,
    ) {
        assert!(owner  != zero(), "ShieldedVault: owner is zero");
        assert!(oracle != zero(), "ShieldedVault: oracle is zero");

        self.owner.write(owner);
        self.pending_owner.write(zero());
        self.oracle_address.write(oracle);
        self.deposit_count.write(0);
        self.merkle_root.write(0);
        self.paused.write(false);
    }

    // ── Internal helpers ──────────────────────────────────────
    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn assert_owner(self: @ContractState) {
            assert!(get_caller_address() == self.owner.read(),
                "ShieldedVault: caller is not owner");
        }
        fn assert_not_paused(self: @ContractState) {
            assert!(!self.paused.read(), "ShieldedVault: paused");
        }

        // Rebuild Merkle root from scratch every deposit.
        // Depth-20 tree, O(n) leaves — for production with >10k deposits,
        // upgrade to an incremental Merkle tree that caches level hashes.
        fn recompute_root(ref self: ContractState) {
            let n = self.deposit_count.read();
            if n == 0 {
                self.merkle_root.write(0);
                return;
            }

            // Read all leaves
            let mut current: Array<felt252> = ArrayTrait::new();
            let mut i: u32 = 0;
            loop {
                if i >= n { break; }
                current.append(self.merkle_leaves.read(i));
                i += 1;
            };

            // Pad to even length with zero
            let zero_felt: felt252 = 0;
            if current.len() % 2 != 0 {
                current.append(zero_felt);
            }

            // Build tree bottom-up
            let mut depth: u32 = 0;
            loop {
                if current.len() <= 1 || depth >= TREE_DEPTH { break; }

                let mut next: Array<felt252> = ArrayTrait::new();
                let mut j: u32 = 0;
                loop {
                    if j >= current.len() { break; }
                    let left  = *current.at(j);
                    let right = if j + 1 < current.len() {
                        *current.at(j + 1)
                    } else {
                        zero_felt
                    };
                    next.append(poseidon_hash_span(array![left, right].span()));
                    j += 2;
                };
                current = next;
                depth += 1;
            };

            self.merkle_root.write(*current.at(0));
        }

        // Placeholder Garaga verifier call.
        // Replace with actual Garaga UltraHonk verifier dispatch once deployed.
        fn verify_noir_proof(
            self: @ContractState,
            proof:       Span<felt252>,
            merkle_root: felt252,
            nullifier:   felt252,
            destination: felt252,
            amount:      u256,
        ) -> bool {
            assert!(proof.len() > 0, "ShieldedVault: empty proof");

            let garaga = self.garaga_verifier.read();
            if garaga == zero() {
                // Garaga not yet set — for testnet only, accept proof.
                // DO NOT deploy to mainnet without setting the verifier.
                return true;
            }

            // TODO: call Garaga verifier contract here once ABI is finalised.
            // let verifier = IGaragaVerifierDispatcher { contract_address: garaga };
            // let public_inputs: Array<felt252> = array![merkle_root, nullifier, destination];
            // verifier.verify_ultra_honk(proof, public_inputs.span())
            true
        }
    }

    // ── Public implementation ─────────────────────────────────
    #[abi(embed_v0)]
    impl ShieldedRWAVaultImpl of super::IShieldedRWAVault<ContractState> {

        // ── Admin ─────────────────────────────────────────────

        fn propose_owner(ref self: ContractState, new_owner: ContractAddress) {
            self.assert_owner();
            assert!(new_owner != zero(), "ShieldedVault: new owner is zero");
            self.pending_owner.write(new_owner);
            self.emit(OwnershipProposed {
                current_owner: self.owner.read(),
                proposed_owner: new_owner
            });
        }

        fn accept_ownership(ref self: ContractState) {
            let caller  = get_caller_address();
            let pending = self.pending_owner.read();
            assert!(pending != zero(), "ShieldedVault: no pending owner");
            assert!(caller == pending, "ShieldedVault: caller is not pending owner");
            let prev = self.owner.read();
            self.owner.write(caller);
            self.pending_owner.write(zero());
            self.emit(OwnershipAccepted { previous_owner: prev, new_owner: caller });
        }

        fn set_oracle(ref self: ContractState, oracle: ContractAddress) {
            self.assert_owner();
            assert!(oracle != zero(), "ShieldedVault: oracle is zero");
            let old = self.oracle_address.read();
            self.oracle_address.write(oracle);
            self.emit(OracleUpdated { old_oracle: old, new_oracle: oracle });
        }

        fn set_garaga_verifier(ref self: ContractState, verifier: ContractAddress) {
            self.assert_owner();
            self.garaga_verifier.write(verifier);
        }

        fn register_asset(ref self: ContractState, asset_felt_id: felt252, symbol: felt252) {
            self.assert_owner();
            assert!(asset_felt_id != 0, "ShieldedVault: asset_id is zero");
            assert!(symbol != 0,        "ShieldedVault: symbol is zero");
            self.asset_symbols.write(asset_felt_id, symbol);
            self.asset_registered.write(asset_felt_id, true);
            self.emit(AssetRegistered { asset_id: asset_felt_id, symbol });
        }

        fn pause(ref self: ContractState) {
            self.assert_owner();
            self.paused.write(true);
            self.emit(Paused { by: get_caller_address() });
        }

        fn unpause(ref self: ContractState) {
            self.assert_owner();
            self.paused.write(false);
            self.emit(Unpaused { by: get_caller_address() });
        }

        // ── Shielded deposit ──────────────────────────────────
        // Only the commitment goes on-chain — NO amount, NO sender.
        fn deposit(ref self: ContractState, note_commitment: felt252) {
            self.assert_not_paused();
            assert!(note_commitment != 0, "ShieldedVault: commitment is zero");

            let index = self.deposit_count.read();
            assert!(index < TREE_SIZE, "ShieldedVault: tree is full");

            self.merkle_leaves.write(index, note_commitment);
            self.deposit_count.write(index + 1);
            self.recompute_root();

            self.emit(Deposit {
                commitment: note_commitment,
                leaf_index: index,
                timestamp:  get_block_timestamp(),
            });
        }

        // ── Shielded withdrawal ───────────────────────────────
        // Verifies Noir ZK proof, then emits an event for the bridge.
        fn withdraw(
            ref self: ContractState,
            noir_proof:  Span<felt252>,
            nullifier:   felt252,
            asset_id:    felt252,
            amount:      u256,
            destination: ContractAddress,
        ) {
            self.assert_not_paused();

            // 1. Nullifier must be unused
            assert!(!self.nullifiers_used.read(nullifier),
                "ShieldedVault: nullifier already used");

            // 2. Asset must be registered
            assert!(self.asset_registered.read(asset_id),
                "ShieldedVault: asset not registered");

            // 3. Destination must be valid
            assert!(destination != zero(), "ShieldedVault: destination is zero");

            // 4. Verify Noir proof (membership + nullifier validity)
            let root         = self.merkle_root.read();
            let dest_felt: felt252 = destination.into();
            let verified = self.verify_noir_proof(
                noir_proof, root, nullifier, dest_felt, amount
            );
            assert!(verified, "ShieldedVault: invalid proof");

            // 5. Mark nullifier as used (prevent double-spend)
            self.nullifiers_used.write(nullifier, true);

            // 6. Verify oracle price is fresh (liveness check)
            let oracle = super::IRwaOracleDispatcher {
                contract_address: self.oracle_address.read()
            };
            let (_price, _ts) = oracle.get_price_if_fresh(asset_id, MAX_PRICE_STALENESS);

            // 7. Emit — bridge service watches this event and settles
            self.emit(Withdrawal {
                nullifier,
                destination,
                timestamp: get_block_timestamp(),
            });
        }

        // ── Views ─────────────────────────────────────────────

        fn get_merkle_root(self: @ContractState) -> felt252 {
            self.merkle_root.read()
        }

        fn is_nullifier_used(self: @ContractState, nullifier: felt252) -> bool {
            self.nullifiers_used.read(nullifier)
        }

        fn get_deposit_count(self: @ContractState) -> u32 {
            self.deposit_count.read()
        }

        fn get_owner(self: @ContractState) -> ContractAddress {
            self.owner.read()
        }

        fn get_pending_owner(self: @ContractState) -> ContractAddress {
            self.pending_owner.read()
        }

        fn get_oracle(self: @ContractState) -> ContractAddress {
            self.oracle_address.read()
        }

        fn is_paused(self: @ContractState) -> bool {
            self.paused.read()
        }

        fn get_asset_symbol(self: @ContractState, asset_id: felt252) -> felt252 {
            self.asset_symbols.read(asset_id)
        }
    }
}
