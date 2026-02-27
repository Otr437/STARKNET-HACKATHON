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
SHA-256:  F82CD5F5A8C6780ED70338586C78B29831F4B094DEE58A5EFB94072E9042DA35
SHA-512:  A36CF1DB1F5766E26C9104C648E3C9FFA2BFB1BA0A34781D4B7752DF1022FFAAFF42AFFA33FAEE788E9CC62202048B5D5809D4D156119C21E0C1867C7A0B364B
MD5:      6D31F71B195934098A1B08685F6D6A0A
File Size: 7542 bytes

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
import {
  Account,
  Contract,
  RpcProvider,
  cairo,
  CallData,
  num
} from 'starknet';
import { AggregatedPrice, StarknetPriceUpdate, TransactionResult } from '../types.js';
import { logger, logUpdate, logError } from '../utils/logger.js';
import { retryWithBackoff } from '../utils/retry.js';
import { config } from '../config.js';

export class StarknetPoster {
  private provider: RpcProvider;
  private account: Account;
  private contract?: Contract;
  private contractAddress?: string;

  constructor() {
    this.provider = new RpcProvider({ nodeUrl: config.rpcUrl });
    this.account = new Account(
      this.provider,
      config.accountAddress,
      config.privateKey
    );

    if (config.contractAddress) {
      this.contractAddress = config.contractAddress;
      logger.info({ address: config.contractAddress }, 'Oracle contract configured');
    } else {
      logger.warn('Oracle contract address not set - please deploy contract first');
    }
  }

  async initialize(): Promise<void> {
    try {
      // Verify account
      const balance = await this.provider.getBalance(config.accountAddress);
      logger.info({
        address: config.accountAddress,
        balance: num.toHex(balance)
      }, 'Account verified');

      if (this.contractAddress) {
        // Load contract ABI
        const { abi } = await import('../contracts/oracle-abi.js');
        this.contract = new Contract(abi, this.contractAddress, this.provider);
        this.contract.connect(this.account);
        logger.info({ address: this.contractAddress }, 'Contract connected');
      }
    } catch (error: any) {
      logError('StarknetPoster.initialize', error);
      throw new Error(`Failed to initialize Starknet poster: ${error.message}`);
    }
  }

  async postPrice(aggregatedPrice: AggregatedPrice): Promise<TransactionResult> {
    if (!this.contract || !this.contractAddress) {
      throw new Error('Contract not initialized - deploy contract first');
    }

    const priceUpdate = this.convertToStarknetPrice(aggregatedPrice);

    return await retryWithBackoff(
      () => this.executePriceUpdate(priceUpdate),
      {
        maxRetries: config.maxRetries,
        baseDelay: config.retryDelay,
        exponentialBackoff: true,
        onRetry: (attempt, error) => {
          logger.warn({
            symbol: aggregatedPrice.symbol,
            attempt,
            error: error.message
          }, 'Retrying price update');
        }
      },
      `postPrice-${aggregatedPrice.symbol}`
    );
  }

  async postMultiplePrices(
    aggregatedPrices: Map<string, AggregatedPrice>
  ): Promise<Map<string, TransactionResult>> {
    const results = new Map<string, TransactionResult>();

    // Post prices sequentially to avoid nonce issues
    for (const [symbol, price] of aggregatedPrices.entries()) {
      try {
        const result = await this.postPrice(price);
        results.set(symbol, result);

        if (result.success) {
          logUpdate(symbol, price.price, result.transactionHash!);
        }
      } catch (error: any) {
        logError('postMultiplePrices', error, { symbol });
        results.set(symbol, {
          success: false,
          error: error.message
        });
      }
    }

    logger.info({
      total: aggregatedPrices.size,
      successful: Array.from(results.values()).filter(r => r.success).length,
      failed: Array.from(results.values()).filter(r => !r.success).length
    }, 'Batch price update completed');

    return results;
  }

  private async executePriceUpdate(
    priceUpdate: StarknetPriceUpdate
  ): Promise<TransactionResult> {
    if (!this.contract) {
      throw new Error('Contract not initialized');
    }

    try {
      // Convert symbol to felt252
      const symbolFelt = cairo.felt(priceUpdate.symbol);

      // Convert price to uint256 (multiply by 10^decimals to preserve precision)
      const scaledPrice = BigInt(Math.round(priceUpdate.price * Math.pow(10, priceUpdate.decimals)));
      const priceU256 = cairo.uint256(scaledPrice);

      const calldata = CallData.compile({
        symbol: symbolFelt,
        price: priceU256,
        decimals: priceUpdate.decimals,
        timestamp: priceUpdate.timestamp
      });

      logger.debug({
        symbol: priceUpdate.symbol,
        price: priceUpdate.price,
        scaledPrice: scaledPrice.toString(),
        decimals: priceUpdate.decimals
      }, 'Executing price update');

      // Execute transaction
      const response = await this.contract.update_price(calldata);

      // Wait for transaction confirmation
      await this.provider.waitForTransaction(response.transaction_hash);

      logger.info({
        symbol: priceUpdate.symbol,
        txHash: response.transaction_hash
      }, 'Price updated on-chain');

      return {
        success: true,
        transactionHash: response.transaction_hash
      };
    } catch (error: any) {
      logError('executePriceUpdate', error, {
        symbol: priceUpdate.symbol,
        price: priceUpdate.price
      });

      return {
        success: false,
        error: error.message
      };
    }
  }

  private convertToStarknetPrice(aggregated: AggregatedPrice): StarknetPriceUpdate {
    // Scale price to preserve precision (price * 10^decimals)
    const scaledPrice = BigInt(Math.round(aggregated.price * Math.pow(10, aggregated.decimals)));

    return {
      symbol: aggregated.symbol,
      price: scaledPrice,
      decimals: aggregated.decimals,
      timestamp: Math.floor(aggregated.timestamp / 1000) // Convert to seconds
    };
  }

  async getPrice(symbol: string): Promise<{ price: bigint; timestamp: number } | null> {
    if (!this.contract) {
      throw new Error('Contract not initialized');
    }

    try {
      const symbolFelt = cairo.felt(symbol);
      const result = await this.contract.get_price(symbolFelt);

      return {
        price: result.price,
        timestamp: Number(result.timestamp)
      };
    } catch (error) {
      logError('getPrice', error, { symbol });
      return null;
    }
  }

  async getLastUpdateTime(symbol: string): Promise<number | null> {
    if (!this.contract) {
      throw new Error('Contract not initialized');
    }

    try {
      const symbolFelt = cairo.felt(symbol);
      const result = await this.contract.get_last_update_time(symbolFelt);
      return Number(result);
    } catch (error) {
      logError('getLastUpdateTime', error, { symbol });
      return null;
    }
  }

  async checkHealth(): Promise<boolean> {
    try {
      // Check if we can query the contract
      if (this.contract) {
        // Try to read from contract (this should not fail)
        await this.contract.get_owner();
      }

      // Check account balance
      const balance = await this.provider.getBalance(config.accountAddress);
      if (balance === 0n) {
        logger.warn('Account balance is zero - cannot send transactions');
        return false;
      }

      return true;
    } catch (error) {
      logError('checkHealth', error);
      return false;
    }
  }

  setContractAddress(address: string): void {
    this.contractAddress = address;
    if (address) {
      // Reload contract with new address
      this.initialize().catch(error => {
        logError('setContractAddress.initialize', error);
      });
    }
  }

  getProvider(): RpcProvider {
    return this.provider;
  }

  getAccount(): Account {
    return this.account;
  }

  getContractAddress(): string | undefined {
    return this.contractAddress;
  }
}

