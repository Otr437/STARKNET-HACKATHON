import { Account, RpcProvider, CallData } from 'starknet';
import * as dotenv from 'dotenv';

dotenv.config();

enum AssetType {
  TreasuryBill = 0,
  RealEstate = 1,
  Commodity = 2,
  CorporateBond = 3,
  InflationBond = 4,
}

async function main() {
  console.log('=== Creating Test RWA Asset ===\n');

  const provider = new RpcProvider({ nodeUrl: process.env.STARKNET_RPC_URL! });
  const account = new Account(
    provider,
    process.env.DEPLOYER_ADDRESS!,
    process.env.DEPLOYER_PRIVATE_KEY!
  );

  if (!process.env.FACTORY_CONTRACT_ADDRESS) {
    throw new Error('Deploy factory first');
  }

  console.log('Creating 6-Month Treasury Bill...');
  
  const now = Math.floor(Date.now() / 1000);
  const sixMonths = now + (180 * 24 * 60 * 60);
  
  const calldata = CallData.compile({
    asset_type: AssetType.TreasuryBill,
    name: 'US_TBILL_6M',
    symbol: 'USTB6M',
    isin: 'US912796XY12',
    issuer: 'US_TREASURY',
    maturity_timestamp: sixMonths,
    par_value: 10000n,
    yield_basis_points: 450,
    inflation_indexed: false,
    total_supply_cap: { low: 1000000n * 10n**18n, high: 0n },
  });

  const { transaction_hash } = await account.execute({
    contractAddress: process.env.FACTORY_CONTRACT_ADDRESS,
    entrypoint: 'create_rwa',
    calldata,
  });

  console.log('TX:', transaction_hash);
  await provider.waitForTransaction(transaction_hash);
  
  console.log('\n✅ Asset Created!');
  console.log('Symbol: USTB6M');
  console.log('Par: $100.00');
  console.log('Yield: 4.50%');
  console.log('Maturity:', new Date(sixMonths * 1000).toISOString());
}

main().catch(console.error);
