/**
 * SNIP-9 Outside Execution Service
 * Complete implementation of meta-transactions and gasless execution
 * Allows executing transactions on behalf of accounts
 * Includes HTTPS endpoint methods for API integration
 */

const { CallData, typedData, hash, num } = require('starknet');

class SNIP9OutsideExecutionService {
    constructor(config) {
        this.SNIP9_V1_INTERFACE_ID = '0x68cfd18b92d1907b8ba3cc324900277f5a3622099431ea85dd8089255e4181';
        this.SNIP9_V2_INTERFACE_ID = '0x1d1144bb2138366ff28d8e9ab57456b1d332ac42196230c3a602003c89872';
        
        this.DEFAULT_WINDOW = 3600; // 1 hour
        this.MAX_WINDOW = 86400; // 24 hours
        
        this.walletService = config.walletService;
    }
    
    /**
     * Check if account supports SNIP-9
     */
    async supportsOutsideExecution(accountAddress, provider) {
        try {
            console.log('[SNIP9] Checking SNIP-9 support for:', accountAddress);
            
            let supportsV1 = false;
            try {
                const resultV1 = await provider.callContract({
                    contractAddress: accountAddress,
                    entrypoint: 'supports_interface',
                    calldata: CallData.compile({
                        interface_id: this.SNIP9_V1_INTERFACE_ID
                    })
                });
                supportsV1 = BigInt(resultV1[0]) === 1n;
            } catch (e) {
                console.log('[SNIP9] V1 check failed');
            }
            
            let supportsV2 = false;
            try {
                const resultV2 = await provider.callContract({
                    contractAddress: accountAddress,
                    entrypoint: 'supports_interface',
                    calldata: CallData.compile({
                        interface_id: this.SNIP9_V2_INTERFACE_ID
                    })
                });
                supportsV2 = BigInt(resultV2[0]) === 1n;
            } catch (e) {
                console.log('[SNIP9] V2 check failed');
            }
            
            const version = supportsV2 ? 2 : supportsV1 ? 1 : 0;
            
            return {
                success: true,
                supportsV1,
                supportsV2,
                version,
                supported: version > 0
            };
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Create OutsideExecution structure
     */
    createOutsideExecution(params) {
        const {
            caller = '0x0',
            nonce,
            execute_after,
            execute_before,
            calls
        } = params;
        
        if (!calls || calls.length === 0) {
            throw new Error('At least one call is required');
        }
        
        const now = Math.floor(Date.now() / 1000);
        const executeAfter = execute_after || now;
        const executeBefore = execute_before || (now + this.DEFAULT_WINDOW);
        
        if (executeBefore <= executeAfter) {
            throw new Error('execute_before must be after execute_after');
        }
        
        if (executeBefore - executeAfter > this.MAX_WINDOW) {
            console.warn('[SNIP9] Execution window exceeds 24 hours');
        }
        
        const nonceValue = nonce || num.toHex(BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)));
        
        return {
            caller,
            nonce: nonceValue,
            execute_after: executeAfter,
            execute_before: executeBefore,
            calls: calls.map(call => this._normalizeCall(call))
        };
    }
    
    /**
     * Sign outside execution request
     */
    async signOutsideExecution(outsideExecution, account, chainId) {
        try {
            console.log('[SNIP9] Signing outside execution:', outsideExecution);
            
            const typedDataStructure = {
                types: {
                    StarknetDomain: [
                        { name: 'name', type: 'shortstring' },
                        { name: 'version', type: 'shortstring' },
                        { name: 'chainId', type: 'shortstring' },
                        { name: 'revision', type: 'shortstring' }
                    ],
                    OutsideExecution: [
                        { name: 'Caller', type: 'ContractAddress' },
                        { name: 'Nonce', type: 'felt' },
                        { name: 'Execute After', type: 'u128' },
                        { name: 'Execute Before', type: 'u128' },
                        { name: 'Calls', type: 'Call*' }
                    ],
                    Call: [
                        { name: 'To', type: 'ContractAddress' },
                        { name: 'Selector', type: 'selector' },
                        { name: 'Calldata', type: 'felt*' }
                    ]
                },
                primaryType: 'OutsideExecution',
                domain: {
                    name: 'Account.execute_from_outside',
                    version: '2',
                    chainId,
                    revision: '1'
                },
                message: {
                    'Caller': outsideExecution.caller,
                    'Nonce': outsideExecution.nonce,
                    'Execute After': outsideExecution.execute_after,
                    'Execute Before': outsideExecution.execute_before,
                    'Calls': outsideExecution.calls.map(call => ({
                        'To': call.to,
                        'Selector': call.selector,
                        'Calldata': call.calldata
                    }))
                }
            };
            
            const signature = await account.signMessage(typedDataStructure);
            
            return {
                success: true,
                signature,
                outsideExecution,
                typedData: typedDataStructure,
                signer: account.address
            };
            
        } catch (error) {
            console.error('[SNIP9] Signing failed:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Execute from outside (meta-transaction)
     */
    async executeFromOutside(params, account) {
        try {
            const { accountAddress, outsideExecution, signature } = params;
            
            console.log('[SNIP9] Executing from outside for account:', accountAddress);
            
            const calldata = CallData.compile({
                outside_execution: outsideExecution,
                signature
            });
            
            const result = await account.execute({
                contractAddress: accountAddress,
                entrypoint: 'execute_from_outside',
                calldata
            });
            
            return {
                success: true,
                transactionHash: result.transaction_hash,
                result
            };
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Get outside execution nonce
     */
    async getOutsideNonce(accountAddress, provider) {
        try {
            const result = await provider.callContract({
                contractAddress: accountAddress,
                entrypoint: 'get_outside_execution_nonce',
                calldata: []
            });
            
            const nonce = BigInt(result[0]);
            
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
     * Create gasless token transfer
     */
    async createGaslessTransfer(tokenAddress, recipient, amount, account, chainId) {
        try {
            console.log('[SNIP9] Creating gasless transfer');
            
            const call = {
                contractAddress: tokenAddress,
                entrypoint: 'transfer',
                calldata: CallData.compile({
                    recipient,
                    amount: { low: amount, high: 0 }
                })
            };
            
            const outsideExecution = this.createOutsideExecution({
                caller: '0x0',
                calls: [call]
            });
            
            return await this.signOutsideExecution(outsideExecution, account, chainId);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Create gasless approval
     */
    async createGaslessApproval(tokenAddress, spender, amount, account, chainId) {
        try {
            console.log('[SNIP9] Creating gasless approval');
            
            const call = {
                contractAddress: tokenAddress,
                entrypoint: 'approve',
                calldata: CallData.compile({
                    spender,
                    amount: { low: amount, high: 0 }
                })
            };
            
            const outsideExecution = this.createOutsideExecution({
                caller: spender,
                calls: [call]
            });
            
            return await this.signOutsideExecution(outsideExecution, account, chainId);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Create scheduled transaction
     */
    async createScheduledTransaction(calls, executeAfter, executeBefore, account, chainId) {
        try {
            console.log('[SNIP9] Creating scheduled transaction');
            
            const now = Math.floor(Date.now() / 1000);
            
            if (executeAfter < now) {
                throw new Error('Execute after time must be in the future');
            }
            
            if (executeBefore <= executeAfter) {
                throw new Error('Execute before must be after execute after');
            }
            
            const outsideExecution = this.createOutsideExecution({
                caller: '0x0',
                execute_after: executeAfter,
                execute_before: executeBefore,
                calls
            });
            
            return await this.signOutsideExecution(outsideExecution, account, chainId);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Create permit for ERC20 approval via signature
     */
    async createPermit(tokenAddress, spender, amount, deadline, account, chainId) {
        try {
            console.log('[SNIP9] Creating permit');
            
            const now = Math.floor(Date.now() / 1000);
            const executeDeadline = deadline || (now + 3600);
            
            const call = {
                contractAddress: tokenAddress,
                entrypoint: 'approve',
                calldata: CallData.compile({
                    spender,
                    amount: { low: amount, high: 0 }
                })
            };
            
            const outsideExecution = this.createOutsideExecution({
                caller: spender,
                execute_after: now,
                execute_before: executeDeadline,
                calls: [call]
            });
            
            return await this.signOutsideExecution(outsideExecution, account, chainId);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Create batch gasless transactions
     */
    async createBatchGasless(calls, options, account, chainId) {
        try {
            console.log('[SNIP9] Creating batch gasless transactions');
            
            const outsideExecution = this.createOutsideExecution({
                caller: options.caller || '0x0',
                execute_after: options.execute_after,
                execute_before: options.execute_before,
                calls
            });
            
            return await this.signOutsideExecution(outsideExecution, account, chainId);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Verify outside execution signature
     */
    async verifyOutsideExecution(params, provider) {
        try {
            const { accountAddress, outsideExecution, signature } = params;
            
            const chainId = await provider.getChainId();
            
            const typedDataStructure = {
                types: {
                    StarknetDomain: [
                        { name: 'name', type: 'shortstring' },
                        { name: 'version', type: 'shortstring' },
                        { name: 'chainId', type: 'shortstring' },
                        { name: 'revision', type: 'shortstring' }
                    ],
                    OutsideExecution: [
                        { name: 'Caller', type: 'ContractAddress' },
                        { name: 'Nonce', type: 'felt' },
                        { name: 'Execute After', type: 'u128' },
                        { name: 'Execute Before', type: 'u128' },
                        { name: 'Calls', type: 'Call*' }
                    ],
                    Call: [
                        { name: 'To', type: 'ContractAddress' },
                        { name: 'Selector', type: 'selector' },
                        { name: 'Calldata', type: 'felt*' }
                    ]
                },
                primaryType: 'OutsideExecution',
                domain: {
                    name: 'Account.execute_from_outside',
                    version: '2',
                    chainId,
                    revision: '1'
                },
                message: {
                    'Caller': outsideExecution.caller,
                    'Nonce': outsideExecution.nonce,
                    'Execute After': outsideExecution.execute_after,
                    'Execute Before': outsideExecution.execute_before,
                    'Calls': outsideExecution.calls.map(call => ({
                        'To': call.to,
                        'Selector': call.selector,
                        'Calldata': call.calldata
                    }))
                }
            };
            
            const messageHash = typedData.getMessageHash(typedDataStructure, accountAddress);
            
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
                messageHash
            };
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Check if outside execution is still valid (time-wise)
     */
    isExecutionWindowValid(outsideExecution) {
        const now = Math.floor(Date.now() / 1000);
        const isAfterStart = now >= outsideExecution.execute_after;
        const isBeforeEnd = now <= outsideExecution.execute_before;
        
        return {
            isValid: isAfterStart && isBeforeEnd,
            canExecuteNow: isAfterStart && isBeforeEnd,
            hasStarted: isAfterStart,
            hasExpired: now > outsideExecution.execute_before,
            secondsUntilStart: Math.max(0, outsideExecution.execute_after - now),
            secondsUntilExpiry: Math.max(0, outsideExecution.execute_before - now)
        };
    }
    
    _normalizeCall(call) {
        return {
            to: call.contractAddress || call.to,
            selector: call.selector || hash.getSelectorFromName(call.entrypoint),
            calldata: call.calldata || []
        };
    }
    
    // ============ HTTPS ENDPOINT METHODS ============
    
    /**
     * HTTPS Endpoint: Check SNIP-9 support
     * GET request with: { accountAddress, provider }
     */
    async httpsSupportsOutsideExecution(requestData) {
        try {
            const { accountAddress, provider } = requestData;
            
            if (!accountAddress || !provider) {
                return {
                    success: false,
                    error: 'Missing required fields: accountAddress, provider'
                };
            }
            
            return await this.supportsOutsideExecution(accountAddress, provider);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * HTTPS Endpoint: Create gasless transfer
     * POST to your API with: { tokenAddress, recipient, amount, account, chainId }
     */
    async httpsCreateGaslessTransfer(requestData) {
        try {
            const { tokenAddress, recipient, amount, account, chainId } = requestData;
            
            if (!tokenAddress || !recipient || !amount || !account || !chainId) {
                return {
                    success: false,
                    error: 'Missing required fields: tokenAddress, recipient, amount, account, chainId'
                };
            }
            
            return await this.createGaslessTransfer(tokenAddress, recipient, amount, account, chainId);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * HTTPS Endpoint: Create gasless approval
     * POST to your API with: { tokenAddress, spender, amount, account, chainId }
     */
    async httpsCreateGaslessApproval(requestData) {
        try {
            const { tokenAddress, spender, amount, account, chainId } = requestData;
            
            if (!tokenAddress || !spender || !amount || !account || !chainId) {
                return {
                    success: false,
                    error: 'Missing required fields: tokenAddress, spender, amount, account, chainId'
                };
            }
            
            return await this.createGaslessApproval(tokenAddress, spender, amount, account, chainId);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * HTTPS Endpoint: Create scheduled transaction
     * POST to your API with: { calls, executeAfter, executeBefore, account, chainId }
     */
    async httpsCreateScheduledTransaction(requestData) {
        try {
            const { calls, executeAfter, executeBefore, account, chainId } = requestData;
            
            if (!calls || !executeAfter || !executeBefore || !account || !chainId) {
                return {
                    success: false,
                    error: 'Missing required fields: calls, executeAfter, executeBefore, account, chainId'
                };
            }
            
            return await this.createScheduledTransaction(calls, executeAfter, executeBefore, account, chainId);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * HTTPS Endpoint: Create permit
     * POST to your API with: { tokenAddress, spender, amount, deadline, account, chainId }
     */
    async httpsCreatePermit(requestData) {
        try {
            const { tokenAddress, spender, amount, deadline, account, chainId } = requestData;
            
            if (!tokenAddress || !spender || !amount || !account || !chainId) {
                return {
                    success: false,
                    error: 'Missing required fields: tokenAddress, spender, amount, account, chainId'
                };
            }
            
            return await this.createPermit(tokenAddress, spender, amount, deadline, account, chainId);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * HTTPS Endpoint: Execute from outside
     * POST to your API with: { accountAddress, outsideExecution, signature, account }
     */
    async httpsExecuteFromOutside(requestData) {
        try {
            const { accountAddress, outsideExecution, signature, account } = requestData;
            
            if (!accountAddress || !outsideExecution || !signature || !account) {
                return {
                    success: false,
                    error: 'Missing required fields: accountAddress, outsideExecution, signature, account'
                };
            }
            
            return await this.executeFromOutside({ accountAddress, outsideExecution, signature }, account);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * HTTPS Endpoint: Get outside nonce
     * GET request with: { accountAddress, provider }
     */
    async httpsGetOutsideNonce(requestData) {
        try {
            const { accountAddress, provider } = requestData;
            
            if (!accountAddress || !provider) {
                return {
                    success: false,
                    error: 'Missing required fields: accountAddress, provider'
                };
            }
            
            return await this.getOutsideNonce(accountAddress, provider);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * HTTPS Endpoint: Verify outside execution
     * POST to your API with: { accountAddress, outsideExecution, signature, provider }
     */
    async httpsVerifyOutsideExecution(requestData) {
        try {
            const { accountAddress, outsideExecution, signature, provider } = requestData;
            
            if (!accountAddress || !outsideExecution || !signature || !provider) {
                return {
                    success: false,
                    error: 'Missing required fields: accountAddress, outsideExecution, signature, provider'
                };
            }
            
            return await this.verifyOutsideExecution({ accountAddress, outsideExecution, signature }, provider);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * HTTPS Endpoint: Check execution window validity
     * GET request with: { outsideExecution }
     */
    async httpsIsExecutionWindowValid(requestData) {
        try {
            const { outsideExecution } = requestData;
            
            if (!outsideExecution) {
                return {
                    success: false,
                    error: 'Missing required field: outsideExecution'
                };
            }
            
            return {
                success: true,
                ...this.isExecutionWindowValid(outsideExecution)
            };
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
}

module.exports = SNIP9OutsideExecutionService;

// Example usage
if (require.main === module) {
    const config = {
        walletService: null
    };
    
    const snip9 = new SNIP9OutsideExecutionService(config);
    
    console.log('SNIP-9 Outside Execution Service initialized');
}
