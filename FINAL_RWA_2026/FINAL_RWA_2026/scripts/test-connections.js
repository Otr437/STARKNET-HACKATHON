#!/usr/bin/env node
/**
 * Test all connections in the RWA system
 * Verifies that all components can communicate
 */

const https = require('https');
const http = require('http');

console.log('========================================');
console.log('RWA System Connection Test');
console.log('========================================\n');

const tests = [];

// Test 1: Backend API
tests.push({
  name: 'Backend API Health',
  test: () => new Promise((resolve, reject) => {
    http.get('http://localhost:3001/health', (res) => {
      if (res.statusCode === 200) {
        resolve('✅ Backend API is running');
      } else {
        reject(`❌ Backend returned ${res.statusCode}`);
      }
    }).on('error', reject);
  })
});

// Test 2: Backend prices endpoint
tests.push({
  name: 'Backend Prices API',
  test: () => new Promise((resolve, reject) => {
    http.get('http://localhost:3001/api/prices/current', (res) => {
      if (res.statusCode === 200) {
        resolve('✅ Prices API working');
      } else if (res.statusCode === 404) {
        resolve('⚠️  No price data yet (run: npm run once)');
      } else {
        reject(`❌ Prices API returned ${res.statusCode}`);
      }
    }).on('error', reject);
  })
});

// Test 3: WebSocket
tests.push({
  name: 'WebSocket Server',
  test: () => new Promise((resolve, reject) => {
    const WebSocket = require('ws');
    try {
      const ws = new WebSocket('ws://localhost:3002');
      ws.on('open', () => {
        ws.close();
        resolve('✅ WebSocket server is running');
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('Timeout')), 5000);
    } catch (error) {
      reject(error);
    }
  })
});

// Test 4: Starknet RPC
tests.push({
  name: 'Starknet RPC Connection',
  test: async () => {
    const { RpcProvider } = require('starknet');
    require('dotenv').config();
    
    const provider = new RpcProvider({
      nodeUrl: process.env.STARKNET_RPC_URL || 'https://starknet-sepolia.public.blastapi.io/rpc/v0_7'
    });
    
    try {
      await provider.getBlock('latest');
      return '✅ Starknet RPC connected';
    } catch (error) {
      throw new Error(`❌ RPC Error: ${error.message}`);
    }
  }
});

// Test 5: Contracts compiled
tests.push({
  name: 'Contract Compilation',
  test: () => new Promise((resolve, reject) => {
    const fs = require('fs');
    const path = require('path');
    
    const contractsDir = path.join(__dirname, '../contracts/target/dev');
    
    if (!fs.existsSync(contractsDir)) {
      reject('❌ Contracts not compiled (run: npm run build:contracts)');
      return;
    }
    
    const sierraFiles = fs.readdirSync(contractsDir).filter(f => f.endsWith('.sierra.json'));
    
    if (sierraFiles.length >= 4) {
      resolve(`✅ ${sierraFiles.length} contracts compiled`);
    } else {
      reject(`⚠️  Only ${sierraFiles.length}/4 contracts found`);
    }
  })
});

// Test 6: ABIs extracted
tests.push({
  name: 'Contract ABIs',
  test: () => new Promise((resolve, reject) => {
    const fs = require('fs');
    const path = require('path');
    
    const abisDir = path.join(__dirname, '../backend/abis');
    
    if (!fs.existsSync(abisDir)) {
      reject('❌ ABIs not extracted (run: npm run extract:abis)');
      return;
    }
    
    const abiFiles = fs.readdirSync(abisDir).filter(f => f.endsWith('.json'));
    
    if (abiFiles.length >= 4) {
      resolve(`✅ ${abiFiles.length} ABIs extracted`);
    } else {
      reject(`⚠️  Only ${abiFiles.length}/4 ABIs found`);
    }
  })
});

// Test 7: Environment variables
tests.push({
  name: 'Environment Configuration',
  test: () => new Promise((resolve, reject) => {
    require('dotenv').config();
    
    const required = [
      'STARKNET_RPC_URL',
      'DEPLOYER_ADDRESS',
      'PUBLISHER_ADDRESS',
    ];
    
    const optional = [
      'ORACLE_CONTRACT_ADDRESS',
      'FACTORY_CONTRACT_ADDRESS',
      'BLS_API_KEY',
      'FRED_API_KEY',
      'METALS_API_KEY',
      'ALPHA_VANTAGE_KEY',
    ];
    
    const missing = required.filter(key => !process.env[key]);
    const optionalPresent = optional.filter(key => process.env[key]);
    
    if (missing.length > 0) {
      reject(`❌ Missing: ${missing.join(', ')}`);
    } else {
      resolve(`✅ Required vars set, ${optionalPresent.length}/${optional.length} optional vars`);
    }
  })
});

// Run all tests
(async () => {
  for (const test of tests) {
    process.stdout.write(`[${test.name}] `);
    try {
      const result = await test.test();
      console.log(result);
    } catch (error) {
      console.log(error.message || error);
    }
  }
  
  console.log('\n========================================');
  console.log('Connection Test Complete');
  console.log('========================================\n');
  
  console.log('Next steps:');
  console.log('  1. Start backend:  cd backend && npm run dev');
  console.log('  2. Fetch prices:   npm run once');
  console.log('  3. Open frontend:  cd frontend && python3 -m http.server 8000');
})();
