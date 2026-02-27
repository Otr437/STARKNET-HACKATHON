/**
 * SNIP-6 Standard Account Interface Service
 * Complete implementation of account operations following SNIP-6 specification
 * Handles __execute__, __validate__, is_valid_signature, and multicall
 * Includes HTTPS endpoint methods for API integration
 */

const { Call, CallData, hash, num, uint256 } = require('starknet');

class SNIP6AccountService {
    constructor(config) {
        this.SNIP6_INTERFACE_ID = '0x2ceccef7f994940b3962a6c67e0ba4fcd37df7d131417c604f91e03caecc1cd';
        
        this.contracts = {
            ETH: '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7',
            STRK: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d'
        };

        this.feeMultiplier = config.feeMultiplier || 1.5;
        this.walletService = config.walletService;
    }
    
    /**
     * Execute single call
     */
    async execute(call, account) {
        try {
            console.log('[SNIP6] Executing call:', call);
            
            const response = await account.execute(call);
            
            console.log('[SNIP6] Transaction sent:', response.transaction_hash);
            
            return {
                success: true,
                transactionHash: response.transaction_hash,
                response
            };
            
        } catch (error) {
            console.error('[SNIP6] Execute failed:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Execute multiple calls (multicall)
     */
    async executeMultiple(calls, account) {
        try {
            console.log('[SNIP6] Executing multicall with', calls.length, 'calls');
            
            const response = await account.execute(calls);
            
            console.log('[SNIP6] Multicall transaction sent:', response.transaction_hash);
            
            return {
                success: true,
                transactionHash: response.transaction_hash,
                callsCount: calls.length,
                response
            };
            
        } catch (error) {
            console.error('[SNIP6] Multicall failed:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Execute with fee estimation
     */
    async executeWithEstimate(call, account) {
        try {
            const feeResult = await this.estimateFee(call, account);
            
            if (!feeResult.success) {
                throw new Error(`Fee estimation failed: ${feeResult.error}`);
            }
            
            const result = await this.execute(call, account);
            
            if (result.success) {
                result.estimatedFee = feeResult.fee;
            }
            
            return result;
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Estimate transaction fee
     */
    async estimateFee(calls, account) {
        try {
            const callsArray = Array.isArray(calls) ? calls : [calls];
            
            console.log('[SNIP6] Estimating fee for', callsArray.length, 'calls');
            
            const feeEstimate = await account.estimateFee(callsArray);
            
            const suggestedMaxFee = BigInt(Math.floor(
                Number(feeEstimate.overall_fee) * this.feeMultiplier
            ));
            
            return {
                success: true,
                fee: {
                    overall_fee: feeEstimate.overall_fee.toString(),
                    suggestedMaxFee: suggestedMaxFee.toString(),
                    gas_consumed: feeEstimate.gas_consumed?.toString(),
                    gas_price: feeEstimate.gas_price?.toString(),
                    unit: feeEstimate.unit || 'WEI',
                    formatted: {
                        overall_fee_eth: this._weiToEth(feeEstimate.overall_fee),
                        suggested_max_fee_eth: this._weiToEth(suggestedMaxFee)
                    }
                }
            };
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Simulate transaction
     */
    async simulateTransaction(calls, account) {
        try {
            const callsArray = Array.isArray(calls) ? calls : [calls];
            
            const simulation = await account.simulateTransaction(callsArray);
            
            return {
                success: true,
                simulation,
                fee_estimate: simulation.fee_estimation
            };
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Validate signature using is_valid_signature
     */
    async isValidSignature(messageHash, signature, accountAddress, provider) {
        try {
            console.log('[SNIP6] Validating signature for account:', accountAddress);
            
            const result = await provider.callContract({
                contractAddress: accountAddress,
                entrypoint: 'is_valid_signature',
                calldata: CallData.compile({
                    hash: messageHash,
                    signature
                })
            });
            
            const VALID = BigInt('0x56414c4944');
            const isValid = BigInt(result[0]) === VALID;
            
            return {
                success: true,
                isValid,
                result: result[0]
            };
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Check if account supports SNIP-6
     */
    async supportsInterface(accountAddress, provider) {
        try {
            const result = await provider.callContract({
                contractAddress: accountAddress,
                entrypoint: 'supports_interface',
                calldata: CallData.compile({
                    interface_id: this.SNIP6_INTERFACE_ID
                })
            });
            
            const isSupported = BigInt(result[0]) === 1n;
            
            return {
                success: true,
                supportsInterface: isSupported,
                interfaceId: this.SNIP6_INTERFACE_ID
            };
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Get account nonce
     */
    async getNonce(account) {
        try {
            const nonce = await account.getNonce();
            
            return {
                success: true,
                nonce: nonce.toString()
            };
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Transfer ETH
     */
    async transferETH(recipient, amount, account) {
        try {
            const amountWei = this._ethToWei(amount);
            
            const call = {
                contractAddress: this.contracts.ETH,
                entrypoint: 'transfer',
                calldata: CallData.compile({
                    recipient,
                    amount: uint256.bnToUint256(amountWei)
                })
            };
            
            return await this.execute(call, account);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Transfer ERC20 token
     */
    async transferERC20(tokenAddress, recipient, amount, account) {
        try {
            const call = {
                contractAddress: tokenAddress,
                entrypoint: 'transfer',
                calldata: CallData.compile({
                    recipient,
                    amount: uint256.bnToUint256(BigInt(amount))
                })
            };
            
            return await this.execute(call, account);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Approve ERC20 spending
     */
    async approveERC20(tokenAddress, spender, amount, account) {
        try {
            const call = {
                contractAddress: tokenAddress,
                entrypoint: 'approve',
                calldata: CallData.compile({
                    spender,
                    amount: uint256.bnToUint256(BigInt(amount))
                })
            };
            
            return await this.execute(call, account);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Get ERC20 balance
     */
    async getERC20Balance(tokenAddress, accountAddress, provider) {
        try {
            const result = await provider.callContract({
                contractAddress: tokenAddress,
                entrypoint: 'balanceOf',
                calldata: CallData.compile({ account: accountAddress })
            });
            
            const balance = uint256.uint256ToBN({
                low: result[0],
                high: result[1]
            });
            
            return {
                success: true,
                balance: balance.toString(),
                balanceFormatted: this._formatTokenAmount(balance, 18)
            };
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Get ERC20 allowance
     */
    async getERC20Allowance(tokenAddress, owner, spender, provider) {
        try {
            const result = await provider.callContract({
                contractAddress: tokenAddress,
                entrypoint: 'allowance',
                calldata: CallData.compile({ owner, spender })
            });
            
            const allowance = uint256.uint256ToBN({
                low: result[0],
                high: result[1]
            });
            
            return {
                success: true,
                allowance: allowance.toString(),
                allowanceFormatted: this._formatTokenAmount(allowance, 18)
            };
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Approve and transfer in one transaction
     */
    async approveAndTransfer(tokenAddress, spender, recipient, amount, account) {
        try {
            const calls = [
                {
                    contractAddress: tokenAddress,
                    entrypoint: 'approve',
                    calldata: CallData.compile({
                        spender,
                        amount: uint256.bnToUint256(BigInt(amount))
                    })
                },
                {
                    contractAddress: tokenAddress,
                    entrypoint: 'transfer',
                    calldata: CallData.compile({
                        recipient,
                        amount: uint256.bnToUint256(BigInt(amount))
                    })
                }
            ];
            
            return await this.executeMultiple(calls, account);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Batch transfer to multiple recipients
     */
    async batchTransfer(tokenAddress, transfers, account) {
        try {
            const calls = transfers.map(({ recipient, amount }) => ({
                contractAddress: tokenAddress,
                entrypoint: 'transfer',
                calldata: CallData.compile({
                    recipient,
                    amount: uint256.bnToUint256(BigInt(amount))
                })
            }));
            
            return await this.executeMultiple(calls, account);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Deploy new account contract
     */
    async deployAccount(classHash, constructorCalldata, salt, account) {
        try {
            const deployPayload = {
                classHash,
                constructorCalldata,
                addressSalt: salt || num.toHex(num.toStorageKey(BigInt(Date.now())))
            };
            
            const response = await account.deployAccount(deployPayload);
            
            return {
                success: true,
                transactionHash: response.transaction_hash,
                contractAddress: response.contract_address,
                response
            };
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    setFeeMultiplier(multiplier) {
        if (multiplier < 1 || multiplier > 3) {
            throw new Error('Fee multiplier must be between 1 and 3');
        }
        this.feeMultiplier = multiplier;
    }
    
    _ethToWei(eth) {
        return BigInt(Math.floor(eth * 1e18));
    }
    
    _weiToEth(wei) {
        return Number(BigInt(wei)) / 1e18;
    }
    
    _formatTokenAmount(amount, decimals) {
        const divisor = BigInt(10 ** decimals);
        const wholePart = amount / divisor;
        const fractionalPart = amount % divisor;
        return `${wholePart}.${fractionalPart.toString().padStart(decimals, '0').slice(0, 6)}`;
    }
    
    // ============ HTTPS ENDPOINT METHODS ============
    
    /**
     * HTTPS Endpoint: Execute single call
     * POST to your API with: { call, account }
     */
    async httpsExecute(requestData) {
        try {
            const { call, account } = requestData;
            
            if (!call || !account) {
                return {
                    success: false,
                    error: 'Missing required fields: call, account'
                };
            }
            
            return await this.execute(call, account);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * HTTPS Endpoint: Execute multicall
     * POST to your API with: { calls, account }
     */
    async httpsExecuteMultiple(requestData) {
        try {
            const { calls, account } = requestData;
            
            if (!calls || !account) {
                return {
                    success: false,
                    error: 'Missing required fields: calls, account'
                };
            }
            
            return await this.executeMultiple(calls, account);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * HTTPS Endpoint: Transfer ETH
     * POST to your API with: { recipient, amount, account }
     */
    async httpsTransferETH(requestData) {
        try {
            const { recipient, amount, account } = requestData;
            
            if (!recipient || !amount || !account) {
                return {
                    success: false,
                    error: 'Missing required fields: recipient, amount, account'
                };
            }
            
            return await this.transferETH(recipient, amount, account);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * HTTPS Endpoint: Transfer ERC20
     * POST to your API with: { tokenAddress, recipient, amount, account }
     */
    async httpsTransferERC20(requestData) {
        try {
            const { tokenAddress, recipient, amount, account } = requestData;
            
            if (!tokenAddress || !recipient || !amount || !account) {
                return {
                    success: false,
                    error: 'Missing required fields: tokenAddress, recipient, amount, account'
                };
            }
            
            return await this.transferERC20(tokenAddress, recipient, amount, account);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * HTTPS Endpoint: Approve ERC20
     * POST to your API with: { tokenAddress, spender, amount, account }
     */
    async httpsApproveERC20(requestData) {
        try {
            const { tokenAddress, spender, amount, account } = requestData;
            
            if (!tokenAddress || !spender || !amount || !account) {
                return {
                    success: false,
                    error: 'Missing required fields: tokenAddress, spender, amount, account'
                };
            }
            
            return await this.approveERC20(tokenAddress, spender, amount, account);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * HTTPS Endpoint: Estimate fee
     * POST to your API with: { calls, account }
     */
    async httpsEstimateFee(requestData) {
        try {
            const { calls, account } = requestData;
            
            if (!calls || !account) {
                return {
                    success: false,
                    error: 'Missing required fields: calls, account'
                };
            }
            
            return await this.estimateFee(calls, account);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * HTTPS Endpoint: Get ERC20 balance
     * GET request with: { tokenAddress, accountAddress, provider }
     */
    async httpsGetERC20Balance(requestData) {
        try {
            const { tokenAddress, accountAddress, provider } = requestData;
            
            if (!tokenAddress || !accountAddress || !provider) {
                return {
                    success: false,
                    error: 'Missing required fields: tokenAddress, accountAddress, provider'
                };
            }
            
            return await this.getERC20Balance(tokenAddress, accountAddress, provider);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * HTTPS Endpoint: Check SNIP-6 support
     * GET request with: { accountAddress, provider }
     */
    async httpsSupportsInterface(requestData) {
        try {
            const { accountAddress, provider } = requestData;
            
            if (!accountAddress || !provider) {
                return {
                    success: false,
                    error: 'Missing required fields: accountAddress, provider'
                };
            }
            
            return await this.supportsInterface(accountAddress, provider);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * HTTPS Endpoint: Get account nonce
     * GET request with: { account }
     */
    async httpsGetNonce(requestData) {
        try {
            const { account } = requestData;
            
            if (!account) {
                return {
                    success: false,
                    error: 'Missing required field: account'
                };
            }
            
            return await this.getNonce(account);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
}

module.exports = SNIP6AccountService;

// Example usage
if (require.main === module) {
    const config = {
        feeMultiplier: 1.5,
        walletService: null
    };
    
    const snip6 = new SNIP6AccountService(config);
    
    console.log('SNIP-6 Account Service initialized');
}
