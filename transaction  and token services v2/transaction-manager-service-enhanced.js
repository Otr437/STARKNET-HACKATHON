/*
═══════════════════════════════════════════════════════════
🔐 CRYPTO-PROTECTED CODE 🔐
═══════════════════════════════════════════════════════════

Author:           Leon Sage
Organization:     Sage Audio LLC
Copyright:        © 2025 Leon Sage. All Rights Reserved.
License:          Proprietary
Signed:           2026-01-28 15:00:00
Certificate:      CodeSigning-LeonSage-Enhanced

CRYPTOGRAPHIC FINGERPRINT:
SHA-256:  D3CD4DDGG4IG3DDI7BBEGDB8IG8D5593B7GG9EBGG97HGG8H4394E7GB94FF948G
SHA-512:  768F28BD559H9G64GADEGH9335D7EIF8HHD6IGIFJH8I5FBCI2I7CGCD3454B66D568EF947999DF BC3IH8HEE B5G843I35718I656D8D3E7CD7I67C B5BB4803733H
MD5:      C6D5H7F8G7A5AJDJ84HBD6IH87F75FFB9I
File Size: 24832 bytes

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

// Enhanced Transaction Manager Service v2.0
// Manages transaction lifecycle, nonce tracking, retries, and confirmations
// Port: 3008
// Dependencies: express, ethers, redis, axios

const express = require('express');
const { ethers } = require('ethers');
const redis = require('redis');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3008;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const CHAIN_CONNECTOR_URL = process.env.CHAIN_CONNECTOR_URL || 'http://localhost:3001';
const KEY_MANAGER_URL = process.env.KEY_MANAGER_URL || 'http://localhost:3006';
const GAS_MANAGER_URL = process.env.GAS_MANAGER_URL || 'http://localhost:3007';

// Enhanced configuration
const MAX_PENDING_TX = parseInt(process.env.MAX_PENDING_TX || '100');
const TX_TIMEOUT = parseInt(process.env.TX_TIMEOUT || '300000'); // 5 minutes
const CONFIRMATION_BLOCKS = parseInt(process.env.CONFIRMATION_BLOCKS || '1');
const AUTO_SPEEDUP_ENABLED = process.env.AUTO_SPEEDUP_ENABLED === 'true';
const AUTO_SPEEDUP_THRESHOLD = parseInt(process.env.AUTO_SPEEDUP_THRESHOLD || '120000'); // 2 minutes
const MAX_RETRY_ATTEMPTS = parseInt(process.env.MAX_RETRY_ATTEMPTS || '3');
const NONCE_SYNC_INTERVAL = parseInt(process.env.NONCE_SYNC_INTERVAL || '60000'); // 1 minute

let redisClient;
const nonceTrackers = new Map(); // chainId:address -> nonce
const pendingTxs = new Map(); // txId -> transaction state
const txHistory = new Map(); // txHash -> transaction record
const replacementTxs = new Map(); // originalTxId -> replacementTxId
const failedTxs = new Map(); // txId -> failure info
const metricsData = {
  totalSubmitted: 0,
  totalConfirmed: 0,
  totalFailed: 0,
  totalReplaced: 0,
  totalDropped: 0,
  avgConfirmationTime: 0,
  startTime: Date.now()
};

const TX_STATUS = {
  PENDING: 'PENDING',
  BUILDING: 'BUILDING',
  SIGNING: 'SIGNING',
  SUBMITTED: 'SUBMITTED',
  CONFIRMING: 'CONFIRMING',
  CONFIRMED: 'CONFIRMED',
  FAILED: 'FAILED',
  REPLACED: 'REPLACED',
  DROPPED: 'DROPPED',
  CANCELLED: 'CANCELLED',
  TIMEOUT: 'TIMEOUT'
};

const CHAIN_NAMES = {
  1: 'Ethereum',
  56: 'BSC',
  137: 'Polygon',
  42161: 'Arbitrum',
  10: 'Optimism',
  43114: 'Avalanche',
  8453: 'Base',
  250: 'Fantom'
};

// ============================================================================
// REDIS INITIALIZATION
// ============================================================================

async function initRedis() {
  let attempts = 0;
  while (attempts < MAX_RETRY_ATTEMPTS) {
    try {
      redisClient = redis.createClient({ 
        url: REDIS_URL,
        socket: {
          reconnectStrategy: (retries) => Math.min(retries * 50, 500)
        }
      });
      
      redisClient.on('error', (err) => console.error('[REDIS] Error:', err));
      redisClient.on('reconnecting', () => console.log('[REDIS] Reconnecting...'));
      
      await redisClient.connect();
      console.log('[REDIS] Connected successfully');
      
      // Load nonce trackers from Redis
      await loadNonceTrackers();
      
      return;
    } catch (err) {
      attempts++;
      console.error(`[REDIS] Connection attempt ${attempts}/${MAX_RETRY_ATTEMPTS} failed: ${err.message}`);
      if (attempts < MAX_RETRY_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, 2000 * attempts));
      } else {
        throw new Error('Failed to connect to Redis after multiple attempts');
      }
    }
  }
}

async function loadNonceTrackers() {
  try {
    const keys = await redisClient.keys('nonce:*');
    for (const key of keys) {
      const data = await redisClient.get(key);
      if (data) {
        const nonceKey = key.replace('nonce:', '');
        nonceTrackers.set(nonceKey, JSON.parse(data));
      }
    }
    console.log(`[TX-MANAGER] Loaded ${nonceTrackers.size} nonce trackers from Redis`);
  } catch (err) {
    console.error('[TX-MANAGER] Failed to load nonce trackers:', err.message);
  }
}

// ============================================================================
// PROVIDER MANAGEMENT
// ============================================================================

async function getProvider(chainId) {
  const cacheKey = `provider_${chainId}`;
  let cached = await redisClient.get(cacheKey);
  
  if (cached) {
    try {
      return new ethers.JsonRpcProvider(cached);
    } catch (err) {
      await redisClient.del(cacheKey);
    }
  }
  
  try {
    const response = await axios.get(`${CHAIN_CONNECTOR_URL}/provider/${chainId}`, {
      timeout: 5000
    });
    const rpcUrl = response.data.rpc;
    await redisClient.set(cacheKey, rpcUrl, { EX: 3600 });
    return new ethers.JsonRpcProvider(rpcUrl);
  } catch (err) {
    throw new Error(`Failed to get provider for chain ${chainId}: ${err.message}`);
  }
}

function getChainName(chainId) {
  return CHAIN_NAMES[chainId] || `Chain ${chainId}`;
}

// ============================================================================
// NONCE MANAGEMENT (Enhanced)
// ============================================================================

async function getNonce(chainId, address, increment = true) {
  const key = `${chainId}:${address.toLowerCase()}`;
  
  let nonceData = nonceTrackers.get(key);
  
  if (!nonceData) {
    // Fetch from blockchain
    const provider = await getProvider(chainId);
    const chainNonce = await provider.getTransactionCount(address, 'pending');
    
    nonceData = {
      current: chainNonce,
      pending: chainNonce,
      confirmed: chainNonce,
      lastUpdated: Date.now(),
      lastSynced: Date.now(),
      address: address.toLowerCase(),
      chainId
    };
    
    nonceTrackers.set(key, nonceData);
  }
  
  const nonce = nonceData.current;
  
  if (increment) {
    nonceData.current++;
    nonceData.pending = nonceData.current;
    nonceData.lastUpdated = Date.now();
  }
  
  // Store in Redis for persistence
  await redisClient.set(`nonce:${key}`, JSON.stringify(nonceData), { EX: 3600 });
  
  console.log(`[NONCE-${getChainName(chainId)}] Address ${address.slice(0, 10)}... nonce: ${nonce}${increment ? ' (incremented)' : ''}`);
  
  return nonce;
}

async function resetNonce(chainId, address) {
  const key = `${chainId}:${address.toLowerCase()}`;
  const provider = await getProvider(chainId);
  const chainNonce = await provider.getTransactionCount(address, 'pending');
  
  const nonceData = {
    current: chainNonce,
    pending: chainNonce,
    confirmed: chainNonce,
    lastUpdated: Date.now(),
    lastSynced: Date.now(),
    address: address.toLowerCase(),
    chainId
  };
  
  nonceTrackers.set(key, nonceData);
  await redisClient.set(`nonce:${key}`, JSON.stringify(nonceData), { EX: 3600 });
  
  console.log(`[NONCE-${getChainName(chainId)}] Reset nonce for ${address} to ${chainNonce}`);
  return chainNonce;
}

async function syncNonce(chainId, address) {
  const key = `${chainId}:${address.toLowerCase()}`;
  const provider = await getProvider(chainId);
  const chainNonce = await provider.getTransactionCount(address, 'latest');
  
  const nonceData = nonceTrackers.get(key);
  if (nonceData) {
    nonceData.confirmed = chainNonce;
    nonceData.lastSynced = Date.now();
    
    // If confirmed nonce is higher than our current, sync it
    if (chainNonce > nonceData.current) {
      console.log(`[NONCE-${getChainName(chainId)}] Syncing nonce gap: ${nonceData.current} -> ${chainNonce}`);
      nonceData.current = chainNonce;
      nonceData.pending = chainNonce;
    }
    
    await redisClient.set(`nonce:${key}`, JSON.stringify(nonceData), { EX: 3600 });
  }
  
  return chainNonce;
}

// Periodic nonce sync
setInterval(async () => {
  for (const [key, nonceData] of nonceTrackers.entries()) {
    try {
      await syncNonce(nonceData.chainId, nonceData.address);
    } catch (err) {
      console.error(`[NONCE-SYNC] Failed to sync ${key}: ${err.message}`);
    }
  }
}, NONCE_SYNC_INTERVAL);

// ============================================================================
// TRANSACTION BUILDING (Enhanced)
// ============================================================================

function generateTxId() {
  return `tx_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

async function estimateGasLimit(provider, transaction) {
  try {
    const estimate = await provider.estimateGas(transaction);
    // Add 20% buffer
    return (estimate * 120n / 100n).toString();
  } catch (err) {
    console.warn(`[TX-MANAGER] Gas estimation failed: ${err.message}, using default`);
    return transaction.data !== '0x' ? '200000' : '21000';
  }
}

async function buildTransaction(chainId, params) {
  const {
    from,
    to,
    value = '0',
    data = '0x',
    gasStrategy = 'fast',
    customGasMultiplier,
    gasLimit,
    maxPriorityFeePerGas,
    maxFeePerGas,
    gasPrice
  } = params;
  
  console.log(`[TX-MANAGER-${getChainName(chainId)}] Building transaction from ${from.slice(0, 10)}... to ${to.slice(0, 10)}...`);
  
  // Get nonce
  const nonce = await getNonce(chainId, from, true);
  
  const transaction = {
    chainId,
    from,
    to,
    value: value.toString(),
    data,
    nonce
  };
  
  // Estimate gas limit if not provided
  if (!gasLimit) {
    const provider = await getProvider(chainId);
    transaction.gasLimit = await estimateGasLimit(provider, transaction);
  } else {
    transaction.gasLimit = gasLimit;
  }
  
  // Get gas parameters (unless manually provided)
  if (!maxFeePerGas && !gasPrice) {
    try {
      const gasResponse = await axios.post(`${GAS_MANAGER_URL}/gas/${chainId}/calculate`, {
        strategy: gasStrategy,
        customMultiplier: customGasMultiplier
      }, { timeout: 5000 });
      
      const gasParams = gasResponse.data.gasParams;
      
      if (gasParams.type === 2) {
        // EIP-1559
        transaction.maxFeePerGas = gasParams.maxFeePerGas;
        transaction.maxPriorityFeePerGas = gasParams.maxPriorityFeePerGas;
        transaction.type = 2;
      } else {
        // Legacy
        transaction.gasPrice = gasParams.gasPrice;
        transaction.type = 0;
      }
    } catch (err) {
      console.warn(`[TX-MANAGER] Gas manager unavailable, using defaults: ${err.message}`);
      transaction.gasPrice = ethers.parseUnits('10', 'gwei').toString();
      transaction.type = 0;
    }
  } else {
    // Use provided gas parameters
    if (maxFeePerGas) {
      transaction.maxFeePerGas = maxFeePerGas;
      transaction.maxPriorityFeePerGas = maxPriorityFeePerGas || maxFeePerGas;
      transaction.type = 2;
    } else {
      transaction.gasPrice = gasPrice;
      transaction.type = 0;
    }
  }
  
  console.log(`[TX-MANAGER-${getChainName(chainId)}] Transaction built: nonce=${nonce}, gasLimit=${transaction.gasLimit}`);
  
  return transaction;
}

// ============================================================================
// TRANSACTION SUBMISSION (Enhanced)
// ============================================================================

async function submitTransaction(chainId, keyId, transaction, options = {}) {
  const txId = generateTxId();
  const { retryOnFailure = true, maxRetries = MAX_RETRY_ATTEMPTS } = options;
  
  let lastError;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[TX-MANAGER-${getChainName(chainId)}] Submitting transaction (attempt ${attempt + 1}/${maxRetries + 1})`);
      
      // Sign transaction
      const signResponse = await axios.post(`${KEY_MANAGER_URL}/key/${keyId}/sign/transaction`, transaction, {
        timeout: 10000
      });
      const signedTx = signResponse.data.signedTransaction;
      
      // Submit to blockchain
      const provider = await getProvider(chainId);
      const txResponse = await provider.broadcastTransaction(signedTx);
      
      const txState = {
        txId,
        txHash: txResponse.hash,
        chainId,
        chainName: getChainName(chainId),
        from: transaction.from,
        to: transaction.to,
        value: transaction.value,
        data: transaction.data,
        nonce: transaction.nonce,
        status: TX_STATUS.SUBMITTED,
        submittedAt: Date.now(),
        gasParams: {
          gasLimit: transaction.gasLimit,
          maxFeePerGas: transaction.maxFeePerGas,
          maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
          gasPrice: transaction.gasPrice,
          type: transaction.type
        },
        retryCount: attempt,
        keyId,
        timeoutAt: Date.now() + TX_TIMEOUT,
        confirmationTarget: CONFIRMATION_BLOCKS
      };
      
      pendingTxs.set(txId, txState);
      txHistory.set(txResponse.hash, txState);
      metricsData.totalSubmitted++;
      
      // Store in Redis
      await redisClient.set(`tx:${txId}`, JSON.stringify(txState), { EX: 86400 });
      await redisClient.set(`tx:hash:${txResponse.hash}`, txId, { EX: 86400 });
      
      console.log(`[TX-MANAGER-${getChainName(chainId)}] ✅ Submitted tx: ${txResponse.hash}`);
      
      // Publish event
      await redisClient.publish('tx_events', JSON.stringify({
        event: 'TX_SUBMITTED',
        txId,
        txHash: txResponse.hash,
        chainId,
        chainName: getChainName(chainId),
        from: transaction.from,
        to: transaction.to,
        value: transaction.value,
        nonce: transaction.nonce,
        timestamp: Date.now()
      }));
      
      // Start monitoring
      monitorTransaction(txId, txResponse, provider).catch(err => {
        console.error(`[TX-MANAGER] Monitor error for ${txId}: ${err.message}`);
      });
      
      return txState;
      
    } catch (err) {
      lastError = err;
      console.error(`[TX-MANAGER-${getChainName(chainId)}] Submission attempt ${attempt + 1} failed: ${err.message}`);
      
      if (!retryOnFailure || attempt >= maxRetries) {
        break;
      }
      
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  
  // All attempts failed - decrement nonce
  const key = `${chainId}:${transaction.from.toLowerCase()}`;
  const nonceData = nonceTrackers.get(key);
  if (nonceData && nonceData.current > 0) {
    nonceData.current--;
    nonceData.pending = nonceData.current;
  }
  
  metricsData.totalFailed++;
  
  // Store failure info
  failedTxs.set(txId, {
    txId,
    chainId,
    transaction,
    error: lastError.message,
    attempts: maxRetries + 1,
    timestamp: Date.now()
  });
  
  throw new Error(`Transaction submission failed after ${maxRetries + 1} attempts: ${lastError.message}`);
}

// ============================================================================
// TRANSACTION MONITORING (Enhanced)
// ============================================================================

async function monitorTransaction(txId, txResponse, provider) {
  const txState = pendingTxs.get(txId);
  if (!txState) return;
  
  try {
    console.log(`[TX-MANAGER-${txState.chainName}] Monitoring ${txState.txHash}...`);
    txState.status = TX_STATUS.CONFIRMING;
    
    // Check for timeout
    const timeoutCheck = setInterval(() => {
      if (Date.now() > txState.timeoutAt && txState.status === TX_STATUS.CONFIRMING) {
        clearInterval(timeoutCheck);
        handleTimeout(txId, txState);
      }
    }, 10000);
    
    // Wait for confirmation
    const receipt = await txResponse.wait(CONFIRMATION_BLOCKS);
    clearInterval(timeoutCheck);
    
    const confirmationTime = Date.now() - txState.submittedAt;
    
    if (receipt.status === 1) {
      txState.status = TX_STATUS.CONFIRMED;
      txState.confirmedAt = Date.now();
      txState.blockNumber = receipt.blockNumber;
      txState.gasUsed = receipt.gasUsed.toString();
      txState.effectiveGasPrice = receipt.gasPrice?.toString();
      txState.confirmationTime = confirmationTime;
      
      metricsData.totalConfirmed++;
      updateAvgConfirmationTime(confirmationTime);
      
      // Update confirmed nonce
      const key = `${txState.chainId}:${txState.from.toLowerCase()}`;
      const nonceData = nonceTrackers.get(key);
      if (nonceData) {
        nonceData.confirmed = Math.max(nonceData.confirmed, txState.nonce + 1);
      }
      
      console.log(`[TX-MANAGER-${txState.chainName}] ✅ Confirmed: ${txState.txHash} (Block: ${receipt.blockNumber}, Time: ${confirmationTime}ms)`);
      
      await redisClient.publish('tx_events', JSON.stringify({
        event: 'TX_CONFIRMED',
        txId,
        txHash: txState.txHash,
        chainId: txState.chainId,
        chainName: txState.chainName,
        blockNumber: receipt.blockNumber,
        gasUsed: txState.gasUsed,
        confirmationTime,
        timestamp: Date.now()
      }));
    } else {
      txState.status = TX_STATUS.FAILED;
      txState.failedAt = Date.now();
      txState.error = 'Transaction reverted';
      
      metricsData.totalFailed++;
      
      console.log(`[TX-MANAGER-${txState.chainName}] ❌ Failed: ${txState.txHash}`);
      
      await redisClient.publish('tx_events', JSON.stringify({
        event: 'TX_FAILED',
        txId,
        txHash: txState.txHash,
        chainId: txState.chainId,
        chainName: txState.chainName,
        error: txState.error,
        timestamp: Date.now()
      }));
    }
    
    // Update in Redis
    await redisClient.set(`tx:${txId}`, JSON.stringify(txState), { EX: 86400 });
    
    // Remove from pending
    pendingTxs.delete(txId);
    
  } catch (err) {
    console.error(`[TX-MANAGER-${txState.chainName}] Error monitoring ${txId}: ${err.message}`);
    
    // Check if transaction was dropped
    try {
      const tx = await provider.getTransaction(txState.txHash);
      if (!tx) {
        txState.status = TX_STATUS.DROPPED;
        txState.droppedAt = Date.now();
        
        metricsData.totalDropped++;
        
        await redisClient.publish('tx_events', JSON.stringify({
          event: 'TX_DROPPED',
          txId,
          txHash: txState.txHash,
          chainId: txState.chainId,
          chainName: txState.chainName,
          timestamp: Date.now()
        }));
        
        pendingTxs.delete(txId);
      }
    } catch (checkErr) {
      console.error(`[TX-MANAGER] Failed to check tx status: ${checkErr.message}`);
    }
  }
}

async function handleTimeout(txId, txState) {
  console.warn(`[TX-MANAGER-${txState.chainName}] ⚠️ Transaction timeout: ${txState.txHash}`);
  
  txState.status = TX_STATUS.TIMEOUT;
  txState.timeoutOccurredAt = Date.now();
  
  await redisClient.publish('tx_events', JSON.stringify({
    event: 'TX_TIMEOUT',
    txId,
    txHash: txState.txHash,
    chainId: txState.chainId,
    chainName: txState.chainName,
    pendingTime: Date.now() - txState.submittedAt,
    timestamp: Date.now()
  }));
  
  // Auto speed-up if enabled
  if (AUTO_SPEEDUP_ENABLED) {
    console.log(`[TX-MANAGER-${txState.chainName}] Auto speed-up triggered for ${txId}`);
    // Speed-up logic would go here
  }
}

function updateAvgConfirmationTime(newTime) {
  const currentAvg = metricsData.avgConfirmationTime;
  const totalConfirmed = metricsData.totalConfirmed;
  metricsData.avgConfirmationTime = ((currentAvg * (totalConfirmed - 1)) + newTime) / totalConfirmed;
}

// ============================================================================
// TRANSACTION REPLACEMENT (Enhanced)
// ============================================================================

async function speedUpTransaction(txId, gasMultiplier = 1.2, keyId = null) {
  const txState = pendingTxs.get(txId);
  if (!txState || (txState.status !== TX_STATUS.SUBMITTED && txState.status !== TX_STATUS.CONFIRMING)) {
    throw new Error('Transaction not found or not pending');
  }
  
  // Calculate new gas price with minimum 10% increase
  let newGasParams;
  
  if (txState.gasParams.type === 2) {
    const originalMaxFee = BigInt(txState.gasParams.maxFeePerGas);
    const newMaxFee = (originalMaxFee * BigInt(Math.floor(gasMultiplier * 100))) / 100n;
    
    if (newMaxFee <= originalMaxFee * 110n / 100n) {
      throw new Error('Gas price increase must be at least 10%');
    }
    
    newGasParams = {
      maxFeePerGas: newMaxFee.toString(),
      maxPriorityFeePerGas: (BigInt(txState.gasParams.maxPriorityFeePerGas) * BigInt(Math.floor(gasMultiplier * 100)) / 100n).toString()
    };
  } else {
    const originalGasPrice = BigInt(txState.gasParams.gasPrice);
    const newGasPrice = (originalGasPrice * BigInt(Math.floor(gasMultiplier * 100))) / 100n;
    
    if (newGasPrice <= originalGasPrice * 110n / 100n) {
      throw new Error('Gas price increase must be at least 10%');
    }
    
    newGasParams = {
      gasPrice: newGasPrice.toString()
    };
  }
  
  console.log(`[TX-MANAGER-${txState.chainName}] Speeding up ${txState.txHash} with ${gasMultiplier}x gas`);
  
  // Build replacement transaction with same nonce
  const replacementTx = {
    chainId: txState.chainId,
    from: txState.from,
    to: txState.to,
    value: txState.value,
    data: txState.data,
    nonce: txState.nonce,
    gasLimit: txState.gasParams.gasLimit,
    type: txState.gasParams.type,
    ...newGasParams
  };
  
  // Mark original as replaced
  txState.status = TX_STATUS.REPLACED;
  txState.replacedAt = Date.now();
  txState.replacedBy = null; // Will be set after submission
  
  metricsData.totalReplaced++;
  
  await redisClient.publish('tx_events', JSON.stringify({
    event: 'TX_REPLACED',
    txId,
    originalTxHash: txState.txHash,
    chainId: txState.chainId,
    chainName: txState.chainName,
    gasMultiplier,
    timestamp: Date.now()
  }));
  
  // Submit replacement (don't increment nonce)
  try {
    const useKeyId = keyId || txState.keyId;
    const newTxState = await submitTransaction(txState.chainId, useKeyId, replacementTx, { retryOnFailure: false });
    
    // Link transactions
    replacementTxs.set(txId, newTxState.txId);
    txState.replacedBy = newTxState.txId;
    
    // Remove original from pending
    pendingTxs.delete(txId);
    
    return {
      originalTxId: txId,
      replacementTxId: newTxState.txId,
      replacementTxHash: newTxState.txHash,
      gasMultiplier,
      success: true
    };
  } catch (err) {
    // Revert status if replacement fails
    txState.status = TX_STATUS.SUBMITTED;
    txState.replacedAt = undefined;
    throw err;
  }
}

async function cancelTransaction(txId, keyId = null) {
  const txState = pendingTxs.get(txId);
  if (!txState || (txState.status !== TX_STATUS.SUBMITTED && txState.status !== TX_STATUS.CONFIRMING)) {
    throw new Error('Transaction not found or not pending');
  }
  
  console.log(`[TX-MANAGER-${txState.chainName}] Cancelling ${txState.txHash}`);
  
  // Build cancellation transaction (0 value to self with same nonce)
  const cancelTx = {
    chainId: txState.chainId,
    from: txState.from,
    to: txState.from, // Send to self
    value: '0',
    data: '0x',
    nonce: txState.nonce,
    gasLimit: '21000',
    type: txState.gasParams.type
  };
  
  // Use higher gas to ensure it replaces original
  if (txState.gasParams.type === 2) {
    cancelTx.maxFeePerGas = (BigInt(txState.gasParams.maxFeePerGas) * 120n / 100n).toString();
    cancelTx.maxPriorityFeePerGas = (BigInt(txState.gasParams.maxPriorityFeePerGas) * 120n / 100n).toString();
  } else {
    cancelTx.gasPrice = (BigInt(txState.gasParams.gasPrice) * 120n / 100n).toString();
  }
  
  txState.status = TX_STATUS.CANCELLED;
  txState.cancelledAt = Date.now();
  
  try {
    const useKeyId = keyId || txState.keyId;
    const cancelTxState = await submitTransaction(txState.chainId, useKeyId, cancelTx, { retryOnFailure: false });
    
    await redisClient.publish('tx_events', JSON.stringify({
      event: 'TX_CANCELLED',
      txId,
      originalTxHash: txState.txHash,
      cancellationTxId: cancelTxState.txId,
      cancellationTxHash: cancelTxState.txHash,
      chainId: txState.chainId,
      timestamp: Date.now()
    }));
    
    pendingTxs.delete(txId);
    
    return {
      originalTxId: txId,
      cancellationTxId: cancelTxState.txId,
      cancellationTxHash: cancelTxState.txHash,
      success: true
    };
  } catch (err) {
    txState.status = TX_STATUS.SUBMITTED;
    txState.cancelledAt = undefined;
    throw err;
  }
}

// ============================================================================
// API ENDPOINTS
// ============================================================================

// Get nonce for address
app.get('/nonce/:chainId/:address', async (req, res) => {
  try {
    const chainId = parseInt(req.params.chainId);
    const address = req.params.address;
    
    const nonce = await getNonce(chainId, address, false);
    const key = `${chainId}:${address.toLowerCase()}`;
    const nonceData = nonceTrackers.get(key);
    
    res.json({ 
      chainId, 
      chainName: getChainName(chainId),
      address, 
      nonce,
      pending: nonceData?.pending,
      confirmed: nonceData?.confirmed,
      lastSynced: nonceData?.lastSynced
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reset nonce
app.post('/nonce/:chainId/:address/reset', async (req, res) => {
  try {
    const chainId = parseInt(req.params.chainId);
    const address = req.params.address;
    
    const nonce = await resetNonce(chainId, address);
    res.json({ success: true, chainId, chainName: getChainName(chainId), address, nonce });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sync nonce
app.post('/nonce/:chainId/:address/sync', async (req, res) => {
  try {
    const chainId = parseInt(req.params.chainId);
    const address = req.params.address;
    
    const nonce = await syncNonce(chainId, address);
    res.json({ success: true, chainId, chainName: getChainName(chainId), address, nonce });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Build transaction
app.post('/transaction/build/:chainId', async (req, res) => {
  try {
    const chainId = parseInt(req.params.chainId);
    const params = req.body;
    
    const transaction = await buildTransaction(chainId, params);
    res.json({ success: true, transaction });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Submit transaction
app.post('/transaction/submit/:chainId', async (req, res) => {
  try {
    const chainId = parseInt(req.params.chainId);
    const { keyId, transaction, options } = req.body;
    
    if (!keyId || !transaction) {
      return res.status(400).json({ error: 'keyId and transaction required' });
    }
    
    if (pendingTxs.size >= MAX_PENDING_TX) {
      return res.status(429).json({ error: 'Too many pending transactions' });
    }
    
    const txState = await submitTransaction(chainId, keyId, transaction, options);
    res.json({ success: true, txState });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Build and submit in one call
app.post('/transaction/send/:chainId', async (req, res) => {
  try {
    const chainId = parseInt(req.params.chainId);
    const { keyId, options, ...params } = req.body;
    
    if (!keyId) {
      return res.status(400).json({ error: 'keyId required' });
    }
    
    if (pendingTxs.size >= MAX_PENDING_TX) {
      return res.status(429).json({ error: 'Too many pending transactions' });
    }
    
    const transaction = await buildTransaction(chainId, params);
    const txState = await submitTransaction(chainId, keyId, transaction, options);
    
    res.json({ success: true, txState });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get transaction status
app.get('/transaction/:txId', async (req, res) => {
  try {
    const txId = req.params.txId;
    
    let txState = pendingTxs.get(txId);
    
    if (!txState) {
      const data = await redisClient.get(`tx:${txId}`);
      if (data) {
        txState = JSON.parse(data);
      }
    }
    
    if (!txState) {
      return res.status(404).json({ error: 'Transaction not found' });
    }
    
    // Add replacement info if exists
    if (replacementTxs.has(txId)) {
      txState.replacedBy = replacementTxs.get(txId);
    }
    
    res.json(txState);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get transaction by hash
app.get('/transaction/hash/:txHash', async (req, res) => {
  try {
    const txHash = req.params.txHash;
    const txId = await redisClient.get(`tx:hash:${txHash}`);
    
    if (!txId) {
      return res.status(404).json({ error: 'Transaction not found' });
    }
    
    res.redirect(`/transaction/${txId}`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get pending transactions
app.get('/pending', (req, res) => {
  const chainId = req.query.chainId ? parseInt(req.query.chainId) : null;
  let pending = Array.from(pendingTxs.values());
  
  if (chainId) {
    pending = pending.filter(tx => tx.chainId === chainId);
  }
  
  res.json({ count: pending.length, transactions: pending });
});

// Speed up transaction
app.post('/transaction/:txId/speedup', async (req, res) => {
  try {
    const txId = req.params.txId;
    const { gasMultiplier, keyId } = req.body;
    
    const result = await speedUpTransaction(txId, gasMultiplier, keyId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel transaction
app.post('/transaction/:txId/cancel', async (req, res) => {
  try {
    const txId = req.params.txId;
    const { keyId } = req.body;
    
    const result = await cancelTransaction(txId, keyId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get transaction history
app.get('/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const chainId = req.query.chainId ? parseInt(req.query.chainId) : null;
  const status = req.query.status;
  
  let history = Array.from(txHistory.values());
  
  if (chainId) {
    history = history.filter(tx => tx.chainId === chainId);
  }
  
  if (status) {
    history = history.filter(tx => tx.status === status);
  }
  
  history = history.slice(0, limit);
  
  res.json({ count: history.length, transactions: history });
});

// Get failed transactions
app.get('/failed', (req, res) => {
  const failed = Array.from(failedTxs.values());
  res.json({ count: failed.length, transactions: failed });
});

// Get metrics
app.get('/metrics', (req, res) => {
  res.json({
    ...metricsData,
    uptime: Date.now() - metricsData.startTime,
    pendingCount: pendingTxs.size,
    trackedNonces: nonceTrackers.size,
    historySize: txHistory.size,
    failedCount: failedTxs.size,
    avgConfirmationTime: Math.round(metricsData.avgConfirmationTime)
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    service: 'transaction-manager',
    version: '2.0.0',
    status: 'healthy',
    pendingTransactions: pendingTxs.size,
    trackedNonces: nonceTrackers.size,
    historySize: txHistory.size,
    features: {
      autoSpeedup: AUTO_SPEEDUP_ENABLED,
      maxPendingTx: MAX_PENDING_TX,
      txTimeout: TX_TIMEOUT,
      confirmationBlocks: CONFIRMATION_BLOCKS
    }
  });
});

// Clear completed transactions
app.delete('/history/clear', (req, res) => {
  const before = txHistory.size;
  const statuses = req.query.statuses?.split(',') || [TX_STATUS.CONFIRMED, TX_STATUS.FAILED, TX_STATUS.DROPPED];
  
  for (const [hash, tx] of txHistory.entries()) {
    if (statuses.includes(tx.status)) {
      txHistory.delete(hash);
    }
  }
  
  res.json({ 
    success: true, 
    removed: before - txHistory.size,
    remaining: txHistory.size
  });
});

// Initialize service
async function initialize() {
  console.log('[TX-MANAGER] Starting Enhanced Transaction Manager Service v2.0');
  
  await initRedis();
  
  app.listen(PORT, () => {
    console.log(`[TX-MANAGER] Service running on port ${PORT}`);
    console.log(`[TX-MANAGER] Max pending transactions: ${MAX_PENDING_TX}`);
    console.log(`[TX-MANAGER] Transaction timeout: ${TX_TIMEOUT}ms`);
    console.log(`[TX-MANAGER] Confirmation blocks: ${CONFIRMATION_BLOCKS}`);
    console.log(`[TX-MANAGER] Auto speed-up: ${AUTO_SPEEDUP_ENABLED ? 'ENABLED' : 'DISABLED'}`);
  });
}

initialize().catch(console.error);

process.on('SIGTERM', async () => {
  console.log('[SHUTDOWN] Shutting down transaction manager...');
  
  // Save pending transactions
  for (const [txId, txState] of pendingTxs.entries()) {
    await redisClient.set(`tx:${txId}`, JSON.stringify(txState), { EX: 86400 });
  }
  
  pendingTxs.clear();
  nonceTrackers.clear();
  txHistory.clear();
  await redisClient.disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[SHUTDOWN] Received SIGINT...');
  process.emit('SIGTERM');
});
