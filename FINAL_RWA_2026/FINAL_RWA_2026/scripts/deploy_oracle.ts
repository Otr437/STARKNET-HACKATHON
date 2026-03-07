import { Account, RpcProvider, CallData, json } from 'starknet';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

async function main() {
  console.log('=== Deploying InflationOracle ===\n');

  const provider = new RpcProvider({ nodeUrl: process.env.STARKNET_RPC_URL! });
  const account = new Account(
    provider,
    process.env.DEPLOYER_ADDRESS!,
    process.env.DEPLOYER_PRIVATE_KEY!
  );

  console.log('Deployer:', process.env.DEPLOYER_ADDRESS);
  console.log('Network:', process.env.STARKNET_RPC_URL, '\n');

  // Load compiled artifacts
  const sierraPath = path.join(__dirname, '../target/dev/starknet_rwa_InflationOracle.contract_class.json');
  const casmPath = path.join(__dirname, '../target/dev/starknet_rwa_InflationOracle.compiled_contract_class.json');

  const compiledSierra = json.parse(fs.readFileSync(sierraPath).toString('ascii'));
  const compiledCasm = json.parse(fs.readFileSync(casmPath).toString('ascii'));

  // Declare
  console.log('[1/2] Declaring contract...');
  const declareResponse = await account.declare({
    contract: compiledSierra,
    casm: compiledCasm,
  });
  
  await provider.waitForTransaction(declareResponse.transaction_hash);
  console.log('✅ Class hash:', declareResponse.class_hash, '\n');

  // Deploy
  console.log('[2/2] Deploying contract...');
  const constructorCalldata = CallData.compile({
    admin: account.address,
    initial_publisher: account.address,
    initial_cpi: 31412n,
    initial_tbill_3m_bps: 430n,
    initial_tbill_10y_bps: 455n,
    initial_fed_funds_bps: 450n,
    initial_cpi_yoy_bps: 270n,
  });

  const deployResponse = await account.deployContract({
    classHash: declareResponse.class_hash,
    constructorCalldata,
  });

  await provider.waitForTransaction(deployResponse.transaction_hash);
  
  console.log('\n✅ DEPLOYED!');
  console.log('Address:', deployResponse.contract_address);
  console.log('\nAdd to .env:');
  console.log(`ORACLE_CONTRACT_ADDRESS=${deployResponse.contract_address}`);

  // Append to .env
  if (fs.existsSync('.env')) {
    fs.appendFileSync('.env', `\nORACLE_CONTRACT_ADDRESS=${deployResponse.contract_address}\n`);
  }
}

main().catch(console.error);
