use starknet::ContractAddress;
use starknet::get_caller_address;
use starknet::get_block_timestamp;

#[starknet::interface]
trait IERC20<TContractState> {
    fn transfer_from(ref self: TContractState, sender: ContractAddress, recipient: ContractAddress, amount: u256) -> bool;
    fn transfer(ref self: TContractState, recipient: ContractAddress, amount: u256) -> bool;
}

#[starknet::interface]
trait IStarkNetIntentBridge<TContractState> {
    fn create_intent(ref self: TContractState, target_chain: u8, token_in: ContractAddress, token_out: felt252, amount_in: u256, min_amount_out: u256, deadline: u64) -> felt252;
    fn fill_intent(ref self: TContractState, intent_hash: felt252, proof: Array<felt252>, fill_tx_hash: felt252);
    fn propose_bundle(ref self: TContractState, bundle_root: felt252, fill_count: u64, total_value: u256, fills: Array<felt252>);
    fn challenge_bundle(ref self: TContractState, bundle_root: felt252, invalid_fill: felt252, proof: Array<felt252>);
    fn execute_bundle(ref self: TContractState, bundle_root: felt252, solver_repayments: Array<(ContractAddress, u256)>);
    fn update_chain_state(ref self: TContractState, chain_id: u8, new_root: felt252, block_height: u64);
}

#[starknet::contract]
mod StarkNetIntentBridge {
    use super::{ContractAddress, get_caller_address, get_block_timestamp};
    use starknet::storage::{Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess, StoragePointerWriteAccess};
    use core::poseidon::poseidon_hash_span;
    use core::array::ArrayTrait;

    const MINA_CHAIN: u8 = 0;
    const ZCASH_CHAIN: u8 = 1;
    const STARKNET_CHAIN: u8 = 2;
    const EVM_CHAIN: u8 = 3;
    const CHALLENGE_PERIOD: u64 = 3600;

    #[storage]
    struct Storage {
        owner: ContractAddress,
        dataworker: ContractAddress,
        mina_state_root: felt252,
        zcash_state_root: felt252,
        evm_state_root: felt252,
        intent_nonce: u64,
        total_volume: u64,
        pending_bundle_root: felt252,
        bundle_challenge_deadline: u64,
        processed_intents: Map<felt252, bool>,
        processed_fills: Map<felt252, bool>,
        approved_solvers: Map<ContractAddress, bool>,
        solver_balances: Map<ContractAddress, u256>,
        supported_tokens: Map<ContractAddress, bool>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        IntentCreated: IntentCreated,
        IntentFilled: IntentFilled,
        BundleProposed: BundleProposed,
        BundleExecuted: BundleExecuted,
        BundleDisputed: BundleDisputed,
        SolverRepaid: SolverRepaid,
        ChainStateUpdated: ChainStateUpdated,
    }

    #[derive(Drop, starknet::Event)]
    struct IntentCreated {
        intent_hash: felt252,
        user: ContractAddress,
        target_chain: u8,
        token_in: ContractAddress,
        amount_in: u256,
        min_amount_out: u256,
        deadline: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct IntentFilled {
        intent_hash: felt252,
        solver: ContractAddress,
        amount_out: u256,
        fill_tx_hash: felt252,
    }

    #[derive(Drop, starknet::Event)]
    struct BundleProposed {
        bundle_root: felt252,
        fill_count: u64,
        total_value: u256,
        challenge_deadline: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct BundleExecuted {
        bundle_root: felt252,
    }

    #[derive(Drop, starknet::Event)]
    struct BundleDisputed {
        bundle_root: felt252,
        challenger: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    struct SolverRepaid {
        solver: ContractAddress,
        amount: u256,
    }

    #[derive(Drop, starknet::Event)]
    struct ChainStateUpdated {
        chain_id: u8,
        new_root: felt252,
        block_height: u64,
    }

    #[constructor]
    fn constructor(ref self: ContractState, owner: ContractAddress, dataworker: ContractAddress) {
        self.owner.write(owner);
        self.dataworker.write(dataworker);
        self.intent_nonce.write(0);
        self.total_volume.write(0);
        self.pending_bundle_root.write(0);
        self.bundle_challenge_deadline.write(0);
        self.mina_state_root.write(0);
        self.zcash_state_root.write(0);
        self.evm_state_root.write(0);
    }

    #[abi(embed_v0)]
    impl StarkNetIntentBridgeImpl of super::IStarkNetIntentBridge<ContractState> {
        fn create_intent(
            ref self: ContractState,
            target_chain: u8,
            token_in: ContractAddress,
            token_out: felt252,
            amount_in: u256,
            min_amount_out: u256,
            deadline: u64
        ) -> felt252 {
            assert(self.supported_tokens.read(token_in), 'Token not supported');
            assert(deadline > get_block_timestamp(), 'Deadline passed');
            assert(
                target_chain == MINA_CHAIN || target_chain == ZCASH_CHAIN || target_chain == EVM_CHAIN,
                'Invalid chain'
            );

            let caller = get_caller_address();
            let this = starknet::get_contract_address();
            
            let token_dispatcher = super::IERC20Dispatcher { contract_address: token_in };
            token_dispatcher.transfer_from(caller, this, amount_in);

            let nonce = self.intent_nonce.read();
            self.intent_nonce.write(nonce + 1);

            let mut intent_data = ArrayTrait::new();
            intent_data.append(caller.into());
            intent_data.append(STARKNET_CHAIN.into());
            intent_data.append(target_chain.into());
            intent_data.append(token_in.into());
            intent_data.append(token_out);
            intent_data.append(amount_in.low.into());
            intent_data.append(amount_in.high.into());
            intent_data.append(min_amount_out.low.into());
            intent_data.append(min_amount_out.high.into());
            intent_data.append(deadline.into());
            intent_data.append(nonce.into());

            let intent_hash = poseidon_hash_span(intent_data.span());
            self.processed_intents.write(intent_hash, true);

            self.emit(IntentCreated {
                intent_hash,
                user: caller,
                target_chain,
                token_in,
                amount_in,
                min_amount_out,
                deadline,
            });

            intent_hash
        }

        fn fill_intent(
            ref self: ContractState,
            intent_hash: felt252,
            proof: Array<felt252>,
            fill_tx_hash: felt252
        ) {
            assert(!self.processed_fills.read(intent_hash), 'Intent already filled');
            
            let solver = get_caller_address();
            let current_time = get_block_timestamp();

            self.processed_fills.write(intent_hash, true);

            self.emit(IntentFilled {
                intent_hash,
                solver,
                amount_out: 0,
                fill_tx_hash,
            });
        }

        fn propose_bundle(
            ref self: ContractState,
            bundle_root: felt252,
            fill_count: u64,
            total_value: u256,
            fills: Array<felt252>
        ) {
            assert(get_caller_address() == self.dataworker.read(), 'Not dataworker');
            assert(self.pending_bundle_root.read() == 0, 'Bundle already pending');
            assert(fill_count == fills.len().into(), 'Fill count mismatch');

            let challenge_deadline = get_block_timestamp() + CHALLENGE_PERIOD;
            
            self.pending_bundle_root.write(bundle_root);
            self.bundle_challenge_deadline.write(challenge_deadline);

            self.emit(BundleProposed {
                bundle_root,
                fill_count,
                total_value,
                challenge_deadline,
            });
        }

        fn challenge_bundle(
            ref self: ContractState,
            bundle_root: felt252,
            invalid_fill: felt252,
            proof: Array<felt252>
        ) {
            assert(self.pending_bundle_root.read() == bundle_root, 'Bundle not pending');
            assert(get_block_timestamp() < self.bundle_challenge_deadline.read(), 'Challenge period ended');

            assert(self.verify_merkle_proof(invalid_fill, proof, bundle_root), 'Invalid proof');
            
            self.pending_bundle_root.write(0);
            self.bundle_challenge_deadline.write(0);

            self.emit(BundleDisputed {
                bundle_root,
                challenger: get_caller_address(),
            });
        }

        fn execute_bundle(
            ref self: ContractState,
            bundle_root: felt252,
            solver_repayments: Array<(ContractAddress, u256)>
        ) {
            assert(get_caller_address() == self.dataworker.read(), 'Not dataworker');
            assert(self.pending_bundle_root.read() == bundle_root, 'Bundle not pending');
            assert(get_block_timestamp() >= self.bundle_challenge_deadline.read(), 'Challenge period active');

            let mut i = 0;
            loop {
                if i >= solver_repayments.len() {
                    break;
                }

                let (solver, amount) = *solver_repayments.at(i);
                if amount > 0 {
                    let balance = self.solver_balances.read(solver);
                    if balance > 0 {
                        self.solver_balances.write(solver, 0);
                        self.emit(SolverRepaid { solver, amount: balance });
                    }
                }

                i += 1;
            };

            self.pending_bundle_root.write(0);
            self.bundle_challenge_deadline.write(0);
            
            let volume = self.total_volume.read();
            self.total_volume.write(volume + solver_repayments.len().into());

            self.emit(BundleExecuted { bundle_root });
        }

        fn update_chain_state(
            ref self: ContractState,
            chain_id: u8,
            new_root: felt252,
            block_height: u64
        ) {
            assert(get_caller_address() == self.dataworker.read(), 'Not dataworker');

            if chain_id == MINA_CHAIN {
                self.mina_state_root.write(new_root);
            } else if chain_id == ZCASH_CHAIN {
                self.zcash_state_root.write(new_root);
            } else if chain_id == EVM_CHAIN {
                self.evm_state_root.write(new_root);
            } else {
                panic!("Invalid chain ID");
            }

            self.emit(ChainStateUpdated {
                chain_id,
                new_root,
                block_height,
            });
        }
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn verify_merkle_proof(
            self: @ContractState,
            leaf: felt252,
            proof: Array<felt252>,
            root: felt252
        ) -> bool {
            let mut computed_hash = leaf;
            let mut i = 0;
            
            loop {
                if i >= proof.len() {
                    break;
                }
                
                let proof_element = *proof.at(i);
                
                let mut arr = ArrayTrait::new();
                if computed_hash < proof_element {
                    arr.append(computed_hash);
                    arr.append(proof_element);
                } else {
                    arr.append(proof_element);
                    arr.append(computed_hash);
                }
                computed_hash = poseidon_hash_span(arr.span());
                
                i += 1;
            };

            computed_hash == root
        }

        fn get_chain_root(self: @ContractState, chain_id: u8) -> felt252 {
            if chain_id == MINA_CHAIN {
                self.mina_state_root.read()
            } else if chain_id == ZCASH_CHAIN {
                self.zcash_state_root.read()
            } else if chain_id == EVM_CHAIN {
                self.evm_state_root.read()
            } else {
                0
            }
        }
    }
}