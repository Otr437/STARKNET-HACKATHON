/**
 * Price Data Converter
 * Converts real-world price data to blockchain-compatible format
 */

export interface RealWorldPrice {
  symbol: string;
  price_usd: number;
  timestamp: number;
}

export interface BlockchainPrice {
  symbol: string;
  price_cents: bigint;        // Price in cents (2 decimals)
  price_1e8: bigint;          // Price with 8 decimals for precision
  price_wei: bigint;          // Price in 18 decimals (like ETH wei)
  timestamp: bigint;
}

/**
 * Convert USD price to blockchain formats
 * 
 * Examples:
 * - Gold $2,650.50/oz → 265050 cents, 265050000000 (1e8), 2650500000000000000000 wei
 * - AAPL $220.75 → 22075 cents, 22075000000 (1e8), 220750000000000000000 wei
 */
export function convertToBlockchainFormat(price: RealWorldPrice): BlockchainPrice {
  // Ensure price is valid number
  if (!price.price_usd || isNaN(price.price_usd) || price.price_usd < 0) {
    throw new Error(`Invalid price for ${price.symbol}: ${price.price_usd}`);
  }

  // Convert to cents (2 decimals) - standard for financial contracts
  const cents = Math.round(price.price_usd * 100);
  
  // Convert to 8 decimals (common in fixed-point math)
  const price_1e8 = Math.round(price.price_usd * 1e8);
  
  // Convert to 18 decimals (ERC20 standard, even though this is Starknet)
  const price_wei = BigInt(Math.round(price.price_usd * 1e18));

  return {
    symbol: price.symbol,
    price_cents: BigInt(cents),
    price_1e8: BigInt(price_1e8),
    price_wei: price_wei,
    timestamp: BigInt(price.timestamp),
  };
}

/**
 * Convert multiple prices to blockchain format
 */
export function convertPriceBatch(prices: RealWorldPrice[]): BlockchainPrice[] {
  return prices.map(convertToBlockchainFormat);
}

/**
 * Format price for Starknet felt252 (max ~2^251)
 * Starknet felts can hold very large numbers but we use u256 for prices
 */
export function toStarknetU256(value: bigint): { low: bigint; high: bigint } {
  const low = value & ((1n << 128n) - 1n);
  const high = value >> 128n;
  return { low, high };
}

/**
 * Convert price to Cairo U256 struct format
 */
export function toCairoU256Price(price: BlockchainPrice): {
  symbol: string;
  low: string;
  high: string;
  timestamp: string;
} {
  const { low, high } = toStarknetU256(price.price_wei);
  
  return {
    symbol: price.symbol,
    low: '0x' + low.toString(16),
    high: '0x' + high.toString(16),
    timestamp: price.timestamp.toString(),
  };
}

/**
 * Batch convert for on-chain submission
 */
export function preparePricesForChain(prices: RealWorldPrice[]) {
  const blockchain = convertPriceBatch(prices);
  return blockchain.map(toCairoU256Price);
}

/**
 * Example usage:
 * 
 * const realPrice = { symbol: 'GOLD', price_usd: 2650.50, timestamp: Date.now() };
 * const blockchainPrice = convertToBlockchainFormat(realPrice);
 * const cairoFormat = toCairoU256Price(blockchainPrice);
 * 
 * // Send to contract:
 * contract.updatePrice(cairoFormat.symbol, cairoFormat.low, cairoFormat.high);
 */
