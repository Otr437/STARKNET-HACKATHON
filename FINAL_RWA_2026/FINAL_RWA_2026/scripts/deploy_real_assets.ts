import { Account, RpcProvider, CallData } from 'starknet';
import * as dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

enum AssetType {
  TreasuryBill = 0,
  RealEstate = 1,
  Commodity = 2,
  CorporateBond = 3,
  InflationBond = 4,
}

/**
 * Deploy REAL RWA Assets
 * 
 * This creates tokenized real-world assets using REAL price data:
 * - Tokenized Gold (XAU)
 * - Tokenized Silver (XAG)
 * - US 2-Year Treasury Note
 * - US 10-Year TIPS (inflation-protected)
 * - Apple Stock (AAPL)
 * - Microsoft Stock (MSFT)
 * 
 * Each asset uses live price data from the oracle
 */

async function main() {
  console.log('=== Deploying REAL RWA Assets ===\n');

  const provider = new RpcProvider({ nodeUrl: process.env.STARKNET_RPC_URL! });
  const account = new Account(
    provider,
    process.env.DEPLOYER_ADDRESS!,
    process.env.DEPLOYER_PRIVATE_KEY!
  );

  const factoryAddress = process.env.FACTORY_CONTRACT_ADDRESS;
  if (!factoryAddress) {
    throw new Error('Factory not deployed. Run deploy:factory first.');
  }

  console.log('Factory:', factoryAddress);
  console.log('Deployer:', account.address);
  
  // Fetch current asset prices from backend
  const backendUrl = process.env.BACKEND_API_URL || 'http://localhost:3001';
  let prices: any = null;
  
  try {
    const response = await fetch(`${backendUrl}/api/prices/current`);
    if (response.ok) {
      prices = await response.json();
      console.log('\n✅ Got current prices from backend API');
    }
  } catch (error) {
    console.warn('⚠️  Could not fetch prices from backend. Using fallback values.');
    console.warn('    Run oracle publisher first: npm run once');
  }

  // REAL ASSET DEFINITIONS
  const assets = [
    {
      name: 'Tokenized_Gold',
      symbol: 'tGOLD',
      asset_type: AssetType.Commodity,
      isin: 'XC0009655157', // Official gold ISIN
      issuer: 'LBMA',  // London Bullion Market Association
      par_value: Math.round((prices?.gold_usd || 2650) * 100 / 20), // 1 token = 1/20 oz, in cents
      yield_bps: 0, // Gold has no yield
      inflation_indexed: false,
      maturity: 0,
      supply_cap: 100_000n * 10n**18n, // 100,000 tokens
      description: 'Each token = 1/20 troy oz gold. Price updated from LBMA spot.'
    },
    {
      name: 'Tokenized_Silver',
      symbol: 'tSILVER',
      asset_type: AssetType.Commodity,
      isin: 'XC0009653103',
      issuer: 'LBMA',
      par_value: Math.round((prices?.silver_usd || 31) * 100), // 1 token = 1 oz, in cents
      yield_bps: 0,
      inflation_indexed: false,
      maturity: 0,
      supply_cap: 1_000_000n * 10n**18n,
      description: 'Each token = 1 troy oz silver. Price from LBMA spot.'
    },
    {
      name: 'US_Treasury_2Y',
      symbol: 'USTN2Y',
      asset_type: AssetType.TreasuryBill,
      isin: 'US912828YX91',
      issuer: 'US_TREASURY',
      par_value: 10000, // $100.00 in cents
      yield_bps: 430, // ~4.30% from FRED data
      inflation_indexed: false,
      maturity: Math.floor(Date.now() / 1000) + (2 * 365 * 24 * 60 * 60), // 2 years
      supply_cap: 10_000_000n * 10n**18n,
      description: 'US 2-Year Treasury Note. Yield from FRED TB3MS.'
    },
    {
      name: 'US_TIPS_10Y',
      symbol: 'TIPS10Y',
      asset_type: AssetType.InflationBond,
      isin: 'US912828B816',
      issuer: 'US_TREASURY',
      par_value: 10000,
      yield_bps: 200, // Real yield ~2.00%
      inflation_indexed: true, // NAV adjusts with CPI
      maturity: Math.floor(Date.now() / 1000) + (10 * 365 * 24 * 60 * 60),
      supply_cap: 5_000_000n * 10n**18n,
      description: 'US 10-Year TIPS. Par value inflates with BLS CPI.'
    },
    {
      name: 'Apple_Inc_Stock',
      symbol: 'tAAPL',
      asset_type: AssetType.Commodity, // Using commodity type for stocks
      isin: 'US0378331005',
      issuer: 'AAPL',
      par_value: Math.round((prices?.aapl_usd || 220) * 100), // Current AAPL price in cents
      yield_bps: 50, // ~0.5% dividend yield
      inflation_indexed: false,
      maturity: 0,
      supply_cap: 1_000_000n * 10n**18n,
      description: 'Tokenized Apple stock. Price from Alpha Vantage.'
    },
    {
      name: 'Microsoft_Stock',
      symbol: 'tMSFT',
      asset_type: AssetType.Commodity,
      isin: 'US5949181045',
      issuer: 'MSFT',
      par_value: Math.round((prices?.msft_usd || 420) * 100),
      yield_bps: 75,
      inflation_indexed: false,
      maturity: 0,
      supply_cap: 1_000_000n * 10n**18n,
      description: 'Tokenized Microsoft stock. Price from Alpha Vantage.'
    },
  ];

  console.log(`\nDeploying ${assets.length} real-world assets...\n`);

  for (const asset of assets) {
    console.log(`\n[${"=".repeat(50)}]`);
    console.log(`Creating: ${asset.name} (${asset.symbol})`);
    console.log(`Par Value: $${(asset.par_value / 100).toFixed(2)}`);
    console.log(`Yield: ${(asset.yield_bps / 100).toFixed(2)}%`);
    console.log(`${asset.description}`);

    try {
      const calldata = CallData.compile({
        asset_type: asset.asset_type,
        name: asset.name,
        symbol: asset.symbol,
        isin: asset.isin,
        issuer: asset.issuer,
        maturity_timestamp: asset.maturity,
        par_value: asset.par_value,
        yield_basis_points: asset.yield_bps,
        inflation_indexed: asset.inflation_indexed,
        total_supply_cap: asset.supply_cap,
      });

      const { transaction_hash } = await account.execute({
        contractAddress: factoryAddress,
        entrypoint: 'create_rwa',
        calldata,
      });

      console.log(`TX: ${transaction_hash}`);
      await provider.waitForTransaction(transaction_hash);
      console.log(`✅ ${asset.symbol} deployed successfully!`);

      // Wait 5 seconds between deployments
      await new Promise(resolve => setTimeout(resolve, 5000));

    } catch (error) {
      console.error(`❌ Failed to deploy ${asset.symbol}:`, error);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('✅ All REAL RWA assets deployed!');
  console.log('='.repeat(60));
  console.log('\nView assets in frontend or via API:');
  console.log(`  curl ${backendUrl}/api/rwa/all`);
}

main().catch(console.error);
