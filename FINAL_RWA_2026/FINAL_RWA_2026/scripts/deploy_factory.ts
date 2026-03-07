import { Account, RpcProvider, CallData, json } from 'starknet';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

async function main() {
  console.log('=== Deploying RWAFactory ===\n');

  const provider = new RpcProvider({ nodeUrl: process.env.STARKNET_RPC_URL! });
  const account = new Account(
    provider,
    process.env.DEPLOYER_ADDRESS!,
    process.env.DEPLOYER_PRIVATE_KEY!
  );

  if (!process.env.ORACLE_CONTRACT_ADDRESS) {
    throw new Error('Deploy oracle first');
  }

  console.log('[1/4] Declaring RWAToken...');
  const tokenSierra = json.parse(fs.readFileSync(
    path.join(__dirname, '../target/dev/starknet_rwa_RWAToken.contract_class.json')
  ).toString());
  const tokenCasm = json.parse(fs.readFileSync(
    path.join(__dirname, '../target/dev/starknet_rwa_RWAToken.compiled_contract_class.json')
  ).toString());

  const tokenDeclare = await account.declare({ contract: tokenSierra, casm: tokenCasm });
  await provider.waitForTransaction(tokenDeclare.transaction_hash);
  console.log('✅ Token class:', tokenDeclare.class_hash, '\n');

  console.log('[2/4] Declaring RWAVault...');
  const vaultSierra = json.parse(fs.readFileSync(
    path.join(__dirname, '../target/dev/starknet_rwa_RWAVault.contract_class.json')
  ).toString());
  const vaultCasm = json.parse(fs.readFileSync(
    path.join(__dirname, '../target/dev/starknet_rwa_RWAVault.compiled_contract_class.json')
  ).toString());

  const vaultDeclare = await account.declare({ contract: vaultSierra, casm: vaultCasm });
  await provider.waitForTransaction(vaultDeclare.transaction_hash);
  console.log('✅ Vault class:', vaultDeclare.class_hash, '\n');

  console.log('[3/4] Declaring RWAFactory...');
  const factorySierra = json.parse(fs.readFileSync(
    path.join(__dirname, '../target/dev/starknet_rwa_RWAFactory.contract_class.json')
  ).toString());
  const factoryCasm = json.parse(fs.readFileSync(
    path.join(__dirname, '../target/dev/starknet_rwa_RWAFactory.compiled_contract_class.json')
  ).toString());

  const factoryDeclare = await account.declare({ contract: factorySierra, casm: factoryCasm });
  await provider.waitForTransaction(factoryDeclare.transaction_hash);
  console.log('✅ Factory class:', factoryDeclare.class_hash, '\n');

  console.log('[4/4] Deploying Factory...');
  const feeToken = process.env.FEE_TOKEN_ADDRESS || 
    '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';

  const constructorCalldata = CallData.compile({
    admin: account.address,
    oracle_address: process.env.ORACLE_CONTRACT_ADDRESS,
    rwa_token_class_hash: tokenDeclare.class_hash,
    rwa_vault_class_hash: vaultDeclare.class_hash,
    fee_token: feeToken,
    creation_fee: 100_000_000n,
  });

  const deployResponse = await account.deployContract({
    classHash: factoryDeclare.class_hash,
    constructorCalldata,
  });

  await provider.waitForTransaction(deployResponse.transaction_hash);
  
  console.log('\n✅ DEPLOYED!');
  console.log('Factory:', deployResponse.contract_address);
  console.log('\nAdd to .env:');
  console.log(`FACTORY_CONTRACT_ADDRESS=${deployResponse.contract_address}`);

  if (fs.existsSync('.env')) {
    fs.appendFileSync('.env', `\nFACTORY_CONTRACT_ADDRESS=${deployResponse.contract_address}\n`);
  }
}

main().catch(console.error);
