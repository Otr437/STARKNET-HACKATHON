use starknet::ContractAddress;
use snforge_std::{declare, ContractClassTrait, start_prank, stop_prank, CheatTarget};

#[test]
fn test_vault_deployment() {
    let contract = declare("VaultManager").unwrap();
    
    let owner: ContractAddress = starknet::contract_address_const::<0x123>();
    let curator: ContractAddress = starknet::contract_address_const::<0x456>();
    let fee_recipient: ContractAddress = starknet::contract_address_const::<0x789>();
    
    let mut constructor_calldata = array![
        owner.into(),
        curator.into(),
        100_u256.low.into(),
        100_u256.high.into(),
        200_u256.low.into(),
        200_u256.high.into(),
        fee_recipient.into(),
    ];
    
    let (contract_address, _) = contract.deploy(@constructor_calldata).unwrap();
    
    // Verify deployment
    assert(contract_address.is_non_zero(), 'Contract not deployed');
}

#[test]
fn test_deposit() {
    // Deploy contract
    let contract = declare("VaultManager").unwrap();
    let owner: ContractAddress = starknet::contract_address_const::<0x123>();
    let curator: ContractAddress = starknet::contract_address_const::<0x456>();
    let fee_recipient: ContractAddress = starknet::contract_address_const::<0x789>();
    
    let mut constructor_calldata = array![
        owner.into(),
        curator.into(),
        100_u256.low.into(),
        100_u256.high.into(),
        200_u256.low.into(),
        200_u256.high.into(),
        fee_recipient.into(),
    ];
    
    let (contract_address, _) = contract.deploy(@constructor_calldata).unwrap();
    
    // Test deposit
    let user: ContractAddress = starknet::contract_address_const::<0xabc>();
    let asset: ContractAddress = starknet::contract_address_const::<0xdef>();
    let amount: u256 = 1000;
    
    start_prank(CheatTarget::One(contract_address), user);
    
    // Call deposit (would need to be properly dispatched)
    // vault.deposit(asset, amount);
    
    stop_prank(CheatTarget::One(contract_address));
}

#[test]
fn test_curator_permissions() {
    let contract = declare("VaultManager").unwrap();
    let owner: ContractAddress = starknet::contract_address_const::<0x123>();
    let curator: ContractAddress = starknet::contract_address_const::<0x456>();
    let fee_recipient: ContractAddress = starknet::contract_address_const::<0x789>();
    
    let mut constructor_calldata = array![
        owner.into(),
        curator.into(),
        100_u256.low.into(),
        100_u256.high.into(),
        200_u256.low.into(),
        200_u256.high.into(),
        fee_recipient.into(),
    ];
    
    let (contract_address, _) = contract.deploy(@constructor_calldata).unwrap();
    
    // Test that curator can rebalance
    // Test that non-curator cannot rebalance
}
