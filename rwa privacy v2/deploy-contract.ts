/*
═══════════════════════════════════════════════════════════
🔐 CRYPTO-PROTECTED CODE 🔐
═══════════════════════════════════════════════════════════

Author:           Leon Sage
Organization:     Sage Audio LLC
Copyright:        © 2025 Leon Sage. All Rights Reserved.
License:          Proprietary
Signed:           2026-02-26 11:42:20
Certificate:      CodeSigning-LeonSage

CRYPTOGRAPHIC FINGERPRINT:
SHA-256:  32CA1AA9B87B52B7D81A7366BD85DBB89B1C4355F535001A4E746497E68851B3
SHA-512:  D613FAABB87EF4E6DDF90D4A16C20E5F09B031170DA6303578C501253960FF3CACCE90B893D0CE6CE1583A62B351ACBCF5F664ED1F574C4B916F6EF8D89EB0CD
MD5:      29BBE6CDAD4FC865B6BFD5E1662D0772
File Size: 5003 bytes

LICENSE:
PROPRIETARY LICENSE

Copyright (c) 2026 Leon Sage. All Rights Reserved.
Sage Audio LLC

This software is proprietary and confidential property of Leon Sage.
UNAUTHORIZED COPYING, MODIFICATION, DISTRIBUTION, OR USE IS STRICTLY PROHIBITED.

⚠️  ANTI-THEFT NOTICE:
This code is cryptographically signed and protected. Any
unauthorized modification, distribution, or removal of this
protection constitutes copyright infringement.
═══════════════════════════════════════════════════════════
*/
import { Account, Contract, RpcProvider, cairo, json, hash } from 'starknet';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { config } from '../src/config.js';
import { logger } from '../src/utils/logger.js';

async function deployContract() {
  logger.info('Starting contract deployment...');

  try {
    // Initialize provider and account
    const provider = new RpcProvider({ nodeUrl: config.rpcUrl });
    const account = new Account(provider, config.accountAddress, config.privateKey);

    logger.info({
      account: config.accountAddress,
      network: config.rpcUrl
    }, 'Account initialized');

    // Load compiled contract
    const contractPath = join(process.cwd(), 'src/contracts/oracle.sierra.json');
    const casmPath = join(process.cwd(), 'src/contracts/oracle.casm.json');

    let compiledContract, compiledCasm;
    
    try {
      compiledContract = json.parse(readFileSync(contractPath, 'utf8'));
      compiledCasm = json.parse(readFileSync(casmPath, 'utf8'));
      logger.info('Contract files loaded');
    } catch (error) {
      logger.error('Contract files not found. Please compile the Cairo contract first.');
      logger.info('Run: scarb build');
      throw error;
    }

    // Calculate class hash
    const classHash = hash.computeContractClassHash(compiledContract);
    logger.info({ classHash }, 'Contract class hash calculated');

    // Declare contract (if not already declared)
    logger.info('Declaring contract...');
    
    let declareResponse;
    try {
      declareResponse = await account.declareIfNot({
        contract: compiledContract,
        casm: compiledCasm
      });

      if (declareResponse.transaction_hash) {
        logger.info({
          txHash: declareResponse.transaction_hash
        }, 'Contract declared, waiting for confirmation...');

        await provider.waitForTransaction(declareResponse.transaction_hash);
        logger.info('Declaration confirmed');
      } else {
        logger.info('Contract already declared');
      }
    } catch (error: any) {
      if (error.message.includes('already declared')) {
        logger.info('Contract already declared, proceeding to deploy');
      } else {
        throw error;
      }
    }

    // Deploy contract
    logger.info('Deploying contract...');

    const constructor = {
      owner: account.address,
      oracle: account.address // Initially set oracle to deployer
    };

    const deployResponse = await account.deployContract({
      classHash: declareResponse?.class_hash || classHash,
      constructorCalldata: cairo.compile CallData.compile(constructor)
    });

    logger.info({
      txHash: deployResponse.transaction_hash,
      contractAddress: deployResponse.contract_address
    }, 'Contract deployed, waiting for confirmation...');

    await provider.waitForTransaction(deployResponse.transaction_hash);

    const contractAddress = deployResponse.contract_address[0];

    logger.info({
      contractAddress,
      txHash: deployResponse.transaction_hash
    }, '✅ Contract deployed successfully!');

    // Update .env file
    const envPath = join(process.cwd(), '.env');
    try {
      let envContent = readFileSync(envPath, 'utf8');
      
      if (envContent.includes('ORACLE_CONTRACT_ADDRESS=')) {
        envContent = envContent.replace(
          /ORACLE_CONTRACT_ADDRESS=.*/,
          `ORACLE_CONTRACT_ADDRESS=${contractAddress}`
        );
      } else {
        envContent += `\nORACLE_CONTRACT_ADDRESS=${contractAddress}\n`;
      }
      
      writeFileSync(envPath, envContent);
      logger.info('.env file updated with contract address');
    } catch (error) {
      logger.warn('Could not update .env file automatically');
    }

    // Verify contract can be read
    logger.info('Verifying contract...');
    
    const { abi } = await import('../src/contracts/oracle-abi.js');
    const contract = new Contract(abi, contractAddress, provider);
    
    const owner = await contract.get_owner();
    logger.info({ owner: owner.toString() }, 'Contract owner verified');

    logger.info(`
========================================
🎉 DEPLOYMENT SUCCESSFUL!
========================================

Contract Address: ${contractAddress}
Transaction Hash: ${deployResponse.transaction_hash}
Network: ${config.rpcUrl}
Owner: ${account.address}

Next steps:
1. Update your .env file if not done automatically:
   ORACLE_CONTRACT_ADDRESS=${contractAddress}

2. Start the oracle backend:
   npm run dev

3. View on Voyager:
   https://sepolia.voyager.online/contract/${contractAddress}
========================================
    `);

    return contractAddress;

  } catch (error: any) {
    logger.error({ error: error.message }, 'Deployment failed');
    throw error;
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  deployContract()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

export { deployContract };

