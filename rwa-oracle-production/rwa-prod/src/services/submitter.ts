// src/services/submitter.ts
// ─────────────────────────────────────────────────────────────
//  StarkNet Oracle Submitter (PRODUCTION)
//  Uses starknet.js v6 to call update_price() on the deployed
//  RWA Oracle contract. Returns SubmitResult[] with tx hashes
//  and block numbers for DB persistence.
// ─────────────────────────────────────────────────────────────

import {
  Account,
  RpcProvider,
  Contract,
  cairo,
  shortString,
} from "starknet";
import { AggregatedPrice, ASSETS, SubmitResult } from "../types";
import { logger } from "../utils/logger";

// ── Minimal ABI ───────────────────────────────────────────────
const ORACLE_ABI = [
  {
    type: "function",
    name: "update_price",
    inputs: [
      { name: "asset_id", type: "core::felt252" },
      { name: "price",    type: "core::integer::u256" },
      { name: "timestamp",type: "core::integer::u64" },
    ],
    outputs: [],
    state_mutability: "external",
  },
  {
    type: "function",
    name: "batch_update_price",
    inputs: [
      { name: "asset_ids",  type: "core::array::Array::<core::felt252>" },
      { name: "prices",     type: "core::array::Array::<core::integer::u256>" },
      { name: "timestamps", type: "core::array::Array::<core::integer::u64>" },
    ],
    outputs: [],
    state_mutability: "external",
  },
  {
    type: "function",
    name: "register_asset",
    inputs: [
      { name: "asset_id",   type: "core::felt252" },
      { name: "symbol",     type: "core::felt252" },
      { name: "decimals",   type: "core::integer::u8" },
      { name: "asset_type", type: "core::felt252" },
    ],
    outputs: [],
    state_mutability: "external",
  },
  {
    type: "function",
    name: "get_asset_info",
    inputs: [{ name: "asset_id", type: "core::felt252" }],
    outputs: [
      {
        type: "tuple",
        members: [
          { name: "symbol",     type: "core::felt252" },
          { name: "decimals",   type: "core::integer::u8" },
          { name: "asset_type", type: "core::felt252" },
          { name: "active",     type: "core::bool" },
        ],
      },
    ],
    state_mutability: "view",
  },
] as const;

/**
 * Convert a human-readable float price to an on-chain u256.
 * Uses integer arithmetic to avoid floating-point precision loss.
 */
function toOnChainPrice(price: number, decimals: number): bigint {
  const multiplier = 10n ** BigInt(decimals);
  const priceStr = price.toFixed(decimals);
  const [whole, frac = ""] = priceStr.split(".");
  const fracPadded = frac.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(whole) * multiplier + BigInt(fracPadded);
}

function toFelt252(str: string): string {
  return shortString.encodeShortString(str);
}

export class OracleSubmitter {
  private provider: RpcProvider;
  private account: Account;
  private contract: Contract;
  private readonly contractAddress: string;

  constructor() {
    const rpcUrl          = process.env.STARKNET_RPC_URL!;
    const accountAddress  = process.env.STARKNET_ACCOUNT_ADDRESS!;
    const privateKey      = process.env.STARKNET_PRIVATE_KEY!;
    const contractAddress = process.env.ORACLE_CONTRACT_ADDRESS!;

    if (!rpcUrl || !accountAddress || !privateKey || !contractAddress) {
      throw new Error("StarkNet configuration incomplete — check env vars");
    }

    this.contractAddress = contractAddress;
    this.provider = new RpcProvider({ nodeUrl: rpcUrl });
    this.account = new Account(this.provider, accountAddress, privateKey);
    this.contract = new Contract(ORACLE_ABI as any, contractAddress, this.account);

    logger.info("OracleSubmitter initialized", {
      rpc: rpcUrl,
      account: accountAddress,
      oracle: contractAddress,
    });
  }

  /**
   * Verify the RPC connection is live.
   */
  async checkConnection(): Promise<boolean> {
    try {
      await this.provider.getChainId();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Register all assets from the ASSETS config that aren't yet active on-chain.
   */
  async registerMissingAssets(): Promise<void> {
    logger.info("Checking which assets need registration...");

    for (const asset of ASSETS) {
      try {
        const info = await this.contract.get_asset_info(toFelt252(asset.assetId));
        if (info.active) {
          logger.debug(`${asset.assetId} already registered — skipping`);
          continue;
        }
      } catch {
        // Not registered — proceed
      }

      try {
        logger.info(`Registering asset on-chain: ${asset.assetId}`);
        const tx = await this.contract.register_asset(
          toFelt252(asset.assetId),
          toFelt252(asset.symbol),
          asset.decimals,
          toFelt252(asset.assetType)
        );
        await this.provider.waitForTransaction(tx.transaction_hash);
        logger.info(`Registered ${asset.assetId} — tx: ${tx.transaction_hash}`);
      } catch (err: any) {
        logger.error(`Failed to register ${asset.assetId}: ${err.message}`);
      }
    }
  }

  /**
   * Submit a batch of aggregated prices using the contract's native
   * batch_update_price function (one tx for all assets — most gas efficient).
   * Falls back to individual submissions if the batch call fails.
   * Returns SubmitResult[] for DB persistence.
   */
  async submitPrices(prices: AggregatedPrice[]): Promise<SubmitResult[]> {
    if (prices.length === 0) {
      logger.warn("No prices to submit");
      return [];
    }

    // Prepare arrays for batch_update_price
    const assetIds:  string[]  = [];
    const onChainPrices: bigint[] = [];
    const timestamps: number[] = [];
    const decimalsMap: number[] = [];

    for (const p of prices) {
      const assetConfig = ASSETS.find((a) => a.assetId === p.assetId);
      const decimals = assetConfig?.decimals ?? 8;
      assetIds.push(toFelt252(p.assetId));
      onChainPrices.push(toOnChainPrice(p.medianPrice, decimals));
      timestamps.push(p.timestamp);
      decimalsMap.push(decimals);
    }

    logger.info(`Submitting ${prices.length} prices via batch_update_price...`);
    logger.debug("Assets:", prices.map((p) => `${p.assetId}=$${p.medianPrice.toFixed(4)}`));

    try {
      const tx = await this.contract.batch_update_price(
        assetIds,
        onChainPrices.map((p) => cairo.uint256(p)),
        timestamps,
      );

      logger.info(`Batch tx submitted: ${tx.transaction_hash}`);
      const receipt = await this.provider.waitForTransaction(tx.transaction_hash);
      logger.info(`Confirmed in block ${receipt.block_number}`, { tx: tx.transaction_hash });

      return prices.map((p, i) => ({
        assetId:      p.assetId,
        medianPrice:  p.medianPrice,
        sourceCount:  p.sources.length,
        sources:      p.sources.map((s) => s.source),
        onChainPrice: onChainPrices[i].toString(),
        timestamp:    p.timestamp,
        txHash:       tx.transaction_hash,
        blockNumber:  receipt.block_number,
        status:       "CONFIRMED" as const,
      }));
    } catch (err: any) {
      logger.error(`Batch submit failed: ${err.message}`);
      logger.info("Falling back to individual submissions...");

      const results: SubmitResult[] = [];
      for (const p of prices) {
        const result = await this.submitSingle(p);
        results.push(result);
      }
      return results;
    }
  }

  private async submitSingle(p: AggregatedPrice): Promise<SubmitResult> {
    const assetConfig = ASSETS.find((a) => a.assetId === p.assetId);
    const decimals = assetConfig?.decimals ?? 8;
    const priceOnChain = toOnChainPrice(p.medianPrice, decimals);

    try {
      const tx = await this.contract.update_price(
        toFelt252(p.assetId),
        cairo.uint256(priceOnChain),
        p.timestamp
      );
      await this.provider.waitForTransaction(tx.transaction_hash);
      logger.info(`${p.assetId}: updated $${p.medianPrice.toFixed(4)} — tx: ${tx.transaction_hash}`);

      return {
        assetId:      p.assetId,
        medianPrice:  p.medianPrice,
        sourceCount:  p.sources.length,
        sources:      p.sources.map((s) => s.source),
        onChainPrice: priceOnChain.toString(),
        timestamp:    p.timestamp,
        txHash:       tx.transaction_hash,
        blockNumber:  undefined,
        status:       "CONFIRMED" as const,
      };
    } catch (err: any) {
      logger.error(`${p.assetId} individual update failed: ${err.message}`);
      return {
        assetId:      p.assetId,
        medianPrice:  p.medianPrice,
        sourceCount:  p.sources.length,
        sources:      p.sources.map((s) => s.source),
        onChainPrice: priceOnChain.toString(),
        timestamp:    p.timestamp,
        txHash:       undefined,
        blockNumber:  undefined,
        status:       "FAILED" as const,
        errorMessage: err.message,
      };
    }
  }
}
