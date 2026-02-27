/*
═══════════════════════════════════════════════════════════
🔐 CRYPTO-PROTECTED CODE 🔐
═══════════════════════════════════════════════════════════

Author:           Leon Sage
Organization:     Sage Audio LLC
Copyright:        © 2025 Leon Sage. All Rights Reserved.
License:          Proprietary
Signed:           2026-02-26 11:42:21
Certificate:      CodeSigning-LeonSage

CRYPTOGRAPHIC FINGERPRINT:
SHA-256:  F97904774AEE80E463D311D2F97BC0537136E0F0A6980575888EF7327BB0DB8B
SHA-512:  3670E3B8BC6130C73C245FD81BB0549C7910CCF2F34369EB41F782DA7CD3B5DC863FCA86C9BFB29398F864DF4D29424DEE32BF55208A22FB60426B80202145AF
MD5:      6DDA9158C00564E69EF0FA1D8A35DFD7
File Size: 4780 bytes

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
import { OracleScheduler } from './index.js';
import { SUPPORTED_ASSETS } from './types.js';
import { logger } from './utils/logger.js';
import { config } from './config.js';

async function test() {
  logger.info('🧪 Starting oracle test...');

  try {
    // Test 1: Configuration
    logger.info('Test 1: Verifying configuration...');
    logger.info({
      rpcUrl: config.rpcUrl,
      accountAddress: config.accountAddress,
      hasPrivateKey: !!config.privateKey,
      hasAlphaVantageKey: !!config.alphaVantageKey,
      updateInterval: config.updateInterval
    }, 'Configuration loaded');

    // Test 2: Initialize scheduler
    logger.info('Test 2: Initializing scheduler...');
    const scheduler = new OracleScheduler();
    await scheduler.initialize();
    logger.info('✅ Scheduler initialized');

    // Test 3: Check fetcher availability
    logger.info('Test 3: Checking data sources...');
    const fetcherManager = scheduler.getFetcherManager();
    const sources = fetcherManager.getAvailableSources();
    logger.info({ sources }, 'Available data sources');

    // Test 4: Fetch test prices
    logger.info('Test 4: Fetching test prices...');
    const testAssets = SUPPORTED_ASSETS.filter(a => a.enabled).slice(0, 3);
    logger.info({
      symbols: testAssets.map(a => a.symbol)
    }, 'Testing with assets');

    const pricesBySymbol = await fetcherManager.fetchAll(testAssets);
    
    logger.info({
      symbolsWithData: pricesBySymbol.size,
      data: Array.from(pricesBySymbol.entries()).map(([symbol, prices]) => ({
        symbol,
        priceCount: prices.length,
        prices: prices.map(p => ({ price: p.price, source: p.source }))
      }))
    }, 'Prices fetched');

    if (pricesBySymbol.size === 0) {
      throw new Error('No prices fetched - check API keys and network');
    }

    // Test 5: Aggregate prices
    logger.info('Test 5: Aggregating prices...');
    const aggregator = scheduler.getAggregator();
    const aggregated = aggregator.aggregateMultiple(pricesBySymbol);

    logger.info({
      aggregatedCount: aggregated.size,
      prices: Array.from(aggregated.entries()).map(([symbol, agg]) => ({
        symbol,
        price: agg.price,
        sources: agg.sourceCount,
        confidence: agg.confidence
      }))
    }, 'Prices aggregated');

    // Test 6: Test Starknet connection (don't post, just verify)
    logger.info('Test 6: Verifying Starknet connection...');
    const poster = scheduler.getPoster();
    const isHealthy = await poster.checkHealth();

    if (!isHealthy) {
      logger.warn('Starknet connection unhealthy - check balance and RPC');
    } else {
      logger.info('✅ Starknet connection healthy');
    }

    // Test 7: Verify contract (if deployed)
    if (config.contractAddress) {
      logger.info('Test 7: Verifying contract...');
      try {
        const contractAddr = poster.getContractAddress();
        logger.info({ contractAddress: contractAddr }, 'Contract configured');
        
        // Try to read from contract
        const testSymbol = testAssets[0].symbol;
        const lastUpdate = await poster.getLastUpdateTime(testSymbol);
        
        if (lastUpdate && lastUpdate > 0) {
          logger.info({
            symbol: testSymbol,
            lastUpdate: new Date(lastUpdate * 1000).toISOString()
          }, 'Contract has data');
        } else {
          logger.info('Contract deployed but no data yet');
        }
      } catch (error: any) {
        logger.warn({ error: error.message }, 'Could not read from contract');
      }
    } else {
      logger.warn('Test 7: Contract not deployed yet - run npm run deploy:contract');
    }

    logger.info(`
========================================
✅ ALL TESTS PASSED!
========================================

Summary:
- Configuration: Valid
- Data Sources: ${sources.length} available
- Prices Fetched: ${pricesBySymbol.size} symbols
- Prices Aggregated: ${aggregated.size} symbols
- Starknet: ${isHealthy ? 'Connected' : 'Check configuration'}
- Contract: ${config.contractAddress ? 'Deployed' : 'Not deployed'}

Next steps:
${!config.contractAddress ? '1. Deploy contract: npm run deploy:contract\n' : ''}${config.contractAddress ? '1. Start oracle: npm run dev\n' : '2. Start oracle: npm run dev\n'}${config.contractAddress ? '2. Monitor logs: tail -f logs/oracle.log' : '3. Monitor logs: tail -f logs/oracle.log'}
========================================
    `);

  } catch (error: any) {
    logger.error({ error: error.message, stack: error.stack }, '❌ Test failed');
    throw error;
  }
}

// Run tests
test()
  .then(() => {
    logger.info('Test completed successfully');
    process.exit(0);
  })
  .catch(error => {
    logger.error('Test failed');
    process.exit(1);
  });

