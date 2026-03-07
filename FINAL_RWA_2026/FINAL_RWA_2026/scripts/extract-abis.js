#!/usr/bin/env node
/**
 * Extract contract ABIs from compiled Cairo contracts
 * Saves them in backend/abis/ for use by backend API
 */

const fs = require('fs');
const path = require('path');

const CONTRACTS_DIR = path.join(__dirname, '../contracts/target/dev');
const OUTPUT_DIR = path.join(__dirname, '../backend/abis');

const contracts = [
  'starknet_rwa_InflationOracle',
  'starknet_rwa_RWAFactory',
  'starknet_rwa_RWAToken',
  'starknet_rwa_RWAVault',
];

console.log('========================================');
console.log('Extracting Contract ABIs');
console.log('========================================\n');

// Create output directory
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  console.log(`✅ Created directory: ${OUTPUT_DIR}\n`);
}

contracts.forEach(contractName => {
  const sierraPath = path.join(CONTRACTS_DIR, `${contractName}.contract_class.json`);
  
  if (!fs.existsSync(sierraPath)) {
    console.error(`❌ Sierra file not found: ${contractName}`);
    console.error(`   Expected: ${sierraPath}`);
    console.error(`   Run: npm run build:contracts first\n`);
    return;
  }

  // Read sierra JSON
  const sierra = JSON.parse(fs.readFileSync(sierraPath, 'utf8'));
  
  // Extract ABI
  const abi = sierra.abi;
  
  if (!abi) {
    console.error(`❌ No ABI found in ${contractName}\n`);
    return;
  }

  // Save ABI
  const outputPath = path.join(OUTPUT_DIR, `${contractName}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(abi, null, 2));
  
  const size = (fs.statSync(outputPath).size / 1024).toFixed(2);
  console.log(`✅ ${contractName}`);
  console.log(`   → ${outputPath} (${size} KB)\n`);
});

console.log('========================================');
console.log('✅ ABI extraction complete!');
console.log('========================================\n');
console.log('Backend can now interact with contracts using these ABIs.');
