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
SHA-256:  D1636A65DE07BF8ED2DBA21370E8DE560A428327B168A9A93EE35A2DD02C3000
SHA-512:  18A739B866D9F9CF07BB0EA230727FB8D4EFF7DF183513E5D62CCE2B7D361776522FD6934EC0E26621312EA809772C83845B20946B0ABA6C9B008E5CD93DE668
MD5:      2C9D6F1C5A8B7B435772CB270923DF6A
File Size: 1410 bytes

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
import { OracleScheduler } from './scheduler/oracle-scheduler.js';
import { logger, logError } from './utils/logger.js';
import { config } from './config.js';

async function main() {
  logger.info({
    env: config.nodeEnv,
    rpcUrl: config.rpcUrl,
    updateInterval: config.updateInterval
  }, 'Starting Starknet RWA Oracle');

  const scheduler = new OracleScheduler();

  try {
    // Initialize scheduler
    await scheduler.initialize();

    // Start scheduled updates
    scheduler.start();

    // Handle graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Received shutdown signal');
      
      scheduler.stop();
      
      logger.info('Oracle shutdown complete');
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Log status every hour
    setInterval(() => {
      const status = scheduler.getStatus();
      logger.info(status, 'Oracle status report');
    }, 3600000); // 1 hour

    logger.info('✅ Oracle is running - press Ctrl+C to stop');

  } catch (error: any) {
    logError('Fatal error', error);
    process.exit(1);
  }
}

// Run if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    logError('Unhandled error', error);
    process.exit(1);
  });
}

export { OracleScheduler };

