/**
 * SNIP-12 Typed Data Signing Service
 * Complete implementation of off-chain message signing for Starknet
 * Equivalent to EIP-712 for Ethereum
 * Includes HTTPS endpoint methods for API integration
 */

const { typedData, hash, num, ec } = require('starknet');

class SNIP12SigningService {
    constructor(config) {
        this.revision = '1'; // Using revision 1 (Poseidon hash)
        this.signatureCache = new Map();
        this.walletService = config.walletService; // Reference to wallet service
    }
    
    /**
     * Create SNIP-12 compliant typed data structure
     */
    createTypedData(params) {
        const {
            domainName,
            domainVersion = '1',
            domainChainId,
            primaryType,
            message,
            types
        } = params;
        
        if (!domainName || !primaryType || !message || !types) {
            throw new Error('Missing required parameters for typed data');
        }
        
        const domain = {
            name: domainName,
            version: domainVersion,
            chainId: domainChainId,
            revision: this.revision
        };
        
        const fullTypes = {
            StarknetDomain: [
                { name: 'name', type: 'shortstring' },
                { name: 'version', type: 'shortstring' },
                { name: 'chainId', type: 'shortstring' },
                { name: 'revision', type: 'shortstring' }
            ],
            ...types
        };
        
        return {
            types: fullTypes,
            primaryType,
            domain,
            message
        };
    }
    
    /**
     * Sign typed data using connected wallet
     */
    async signTypedData(typedDataStructure, account) {
        try {
            console.log('[SNIP12] Signing typed data:', typedDataStructure);
            
            const signature = await account.signMessage(typedDataStructure);
            
            const messageHash = typedData.getMessageHash(
                typedDataStructure,
                account.address
            );
            
            const cacheKey = messageHash;
            this.signatureCache.set(cacheKey, {
                signature,
                typedData: typedDataStructure,
                signer: account.address,
                timestamp: Date.now()
            });
            
            return {
                success: true,
                signature,
                messageHash,
                typedData: typedDataStructure,
                signer: account.address
            };
            
        } catch (error) {
            console.error('[SNIP12] Signing failed:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Verify SNIP-12 signature
     */
    async verifySignature(params, provider) {
        try {
            const { typedData, signature, signerAddress } = params;
            
            if (!typedData || !signature || !signerAddress) {
                throw new Error('Missing required parameters for verification');
            }
            
            const messageHash = typedData.getMessageHash(typedData, signerAddress);
            
            const result = await provider.callContract({
                contractAddress: signerAddress,
                entrypoint: 'is_valid_signature',
                calldata: [
                    messageHash,
                    signature.length,
                    ...signature
                ]
            });
            
            const VALID_SIGNATURE = BigInt('0x56414c4944');
            const isValid = BigInt(result[0]) === VALID_SIGNATURE;
            
            return {
                success: true,
                isValid,
                messageHash,
                signer: signerAddress
            };
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Sign simple text message
     */
    async signMessage(message, account, chainId) {
        try {
            const typedDataStructure = this.createTypedData({
                domainName: 'Starknet Message',
                domainVersion: '1',
                domainChainId: chainId,
                primaryType: 'Message',
                message: {
                    content: message
                },
                types: {
                    Message: [
                        { name: 'content', type: 'string' }
                    ]
                }
            });
            
            return await this.signTypedData(typedDataStructure, account);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Sign authentication request (Sign In With Starknet - SIWS)
     */
    async signAuthentication(params, account, chainId) {
        try {
            const {
                domain,
                statement,
                uri,
                nonce,
                issuedAt,
                expirationTime,
                notBefore,
                requestId,
                resources = []
            } = params;
            
            const address = account.address;
            
            const message = {
                domain,
                address,
                statement: statement || 'Sign in to authenticate',
                uri: uri || (typeof window !== 'undefined' ? window.location.origin : 'https://example.com'),
                version: '1',
                chainId,
                nonce: nonce || this._generateNonce(),
                issuedAt: issuedAt || new Date().toISOString(),
                expirationTime: expirationTime || null,
                notBefore: notBefore || null,
                requestId: requestId || null,
                resources: resources
            };
            
            const messageTypes = [
                { name: 'domain', type: 'string' },
                { name: 'address', type: 'ContractAddress' },
                { name: 'statement', type: 'string' },
                { name: 'uri', type: 'string' },
                { name: 'version', type: 'string' },
                { name: 'chainId', type: 'string' },
                { name: 'nonce', type: 'string' },
                { name: 'issuedAt', type: 'string' }
            ];
            
            if (expirationTime) {
                messageTypes.push({ name: 'expirationTime', type: 'string' });
            }
            if (notBefore) {
                messageTypes.push({ name: 'notBefore', type: 'string' });
            }
            if (requestId) {
                messageTypes.push({ name: 'requestId', type: 'string' });
            }
            if (resources.length > 0) {
                messageTypes.push({ name: 'resources', type: 'string*' });
            }
            
            const typedDataStructure = this.createTypedData({
                domainName: 'Sign In With Starknet',
                domainVersion: '1',
                domainChainId: chainId,
                primaryType: 'Authentication',
                message,
                types: {
                    Authentication: messageTypes
                }
            });
            
            const result = await this.signTypedData(typedDataStructure, account);
            
            if (result.success) {
                result.siwsMessage = this._buildSIWSMessage(message);
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
     * Sign marketplace order (NFT, DeFi, etc.)
     */
    async signOrder(orderParams, account, chainId) {
        try {
            const {
                orderType = 'LISTING',
                maker,
                taker = '0x0',
                makerAsset,
                takerAsset,
                makerAmount,
                takerAmount,
                salt,
                expiry,
                nonce,
                marketplace = 'Generic Marketplace'
            } = orderParams;
            
            const order = {
                orderType,
                maker: maker || account.address,
                taker,
                makerAsset,
                takerAsset,
                makerAmount: this._toU256(makerAmount),
                takerAmount: this._toU256(takerAmount),
                salt: salt || this._generateSalt(),
                expiry: expiry || Math.floor(Date.now() / 1000) + 86400,
                nonce: nonce || this._generateNonce()
            };
            
            const typedDataStructure = this.createTypedData({
                domainName: marketplace,
                domainVersion: '1',
                domainChainId: chainId,
                primaryType: 'Order',
                message: order,
                types: {
                    Order: [
                        { name: 'orderType', type: 'string' },
                        { name: 'maker', type: 'ContractAddress' },
                        { name: 'taker', type: 'ContractAddress' },
                        { name: 'makerAsset', type: 'ContractAddress' },
                        { name: 'takerAsset', type: 'ContractAddress' },
                        { name: 'makerAmount', type: 'u256' },
                        { name: 'takerAmount', type: 'u256' },
                        { name: 'salt', type: 'felt' },
                        { name: 'expiry', type: 'u64' },
                        { name: 'nonce', type: 'felt' }
                    ]
                }
            });
            
            const result = await this.signTypedData(typedDataStructure, account);
            
            if (result.success) {
                result.order = order;
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
     * Sign permit (ERC20 approval via signature)
     */
    async signPermit(permitParams, account, chainId) {
        try {
            const {
                tokenAddress,
                spender,
                value,
                deadline,
                nonce
            } = permitParams;
            
            if (!tokenAddress || !spender || value === undefined) {
                throw new Error('Missing required permit parameters');
            }
            
            const permit = {
                owner: account.address,
                spender,
                value: this._toU256(value),
                nonce: nonce || '0',
                deadline: deadline || Math.floor(Date.now() / 1000) + 3600
            };
            
            const typedDataStructure = this.createTypedData({
                domainName: 'ERC20 Permit',
                domainVersion: '1',
                domainChainId: chainId,
                primaryType: 'Permit',
                message: permit,
                types: {
                    Permit: [
                        { name: 'owner', type: 'ContractAddress' },
                        { name: 'spender', type: 'ContractAddress' },
                        { name: 'value', type: 'u256' },
                        { name: 'nonce', type: 'felt' },
                        { name: 'deadline', type: 'u64' }
                    ]
                }
            });
            
            const result = await this.signTypedData(typedDataStructure, account);
            
            if (result.success) {
                result.permit = permit;
                result.tokenAddress = tokenAddress;
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
     * Sign vote (DAO governance)
     */
    async signVote(voteParams, account, chainId) {
        try {
            const {
                proposalId,
                support,
                voter,
                reason = '',
                params = []
            } = voteParams;
            
            const vote = {
                proposalId,
                support,
                voter: voter || account.address,
                reason,
                params
            };
            
            const typedDataStructure = this.createTypedData({
                domainName: 'DAO Governance',
                domainVersion: '1',
                domainChainId: chainId,
                primaryType: 'Vote',
                message: vote,
                types: {
                    Vote: [
                        { name: 'proposalId', type: 'felt' },
                        { name: 'support', type: 'bool' },
                        { name: 'voter', type: 'ContractAddress' },
                        { name: 'reason', type: 'string' },
                        { name: 'params', type: 'felt*' }
                    ]
                }
            });
            
            return await this.signTypedData(typedDataStructure, account);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Get signature from cache
     */
    getCachedSignature(messageHash) {
        return this.signatureCache.get(messageHash) || null;
    }
    
    /**
     * Clear signature cache
     */
    clearCache() {
        this.signatureCache.clear();
    }
    
    _generateNonce() {
        return num.toHex(num.toStorageKey(BigInt(Math.floor(Math.random() * 1e16))));
    }
    
    _generateSalt() {
        return num.toHex(num.toStorageKey(BigInt(Math.floor(Math.random() * 1e16))));
    }
    
    _toU256(value) {
        const bigValue = BigInt(value);
        return {
            low: num.toHex(bigValue & ((1n << 128n) - 1n)),
            high: num.toHex(bigValue >> 128n)
        };
    }
    
    _buildSIWSMessage(message) {
        let siws = `${message.domain} wants you to sign in with your Starknet account:\n`;
        siws += `${message.address}\n\n`;
        if (message.statement) {
            siws += `${message.statement}\n\n`;
        }
        siws += `URI: ${message.uri}\n`;
        siws += `Version: ${message.version}\n`;
        siws += `Chain ID: ${message.chainId}\n`;
        siws += `Nonce: ${message.nonce}\n`;
        siws += `Issued At: ${message.issuedAt}`;
        
        if (message.expirationTime) {
            siws += `\nExpiration Time: ${message.expirationTime}`;
        }
        if (message.notBefore) {
            siws += `\nNot Before: ${message.notBefore}`;
        }
        if (message.requestId) {
            siws += `\nRequest ID: ${message.requestId}`;
        }
        if (message.resources && message.resources.length > 0) {
            siws += `\nResources:`;
            message.resources.forEach(resource => {
                siws += `\n- ${resource}`;
            });
        }
        
        return siws;
    }
    
    // ============ HTTPS ENDPOINT METHODS ============
    
    /**
     * HTTPS Endpoint: Sign simple message
     * POST to your API with: { message, accountPrivateKey }
     */
    async httpsSignMessage(requestData) {
        try {
            const { message, account, chainId } = requestData;
            
            if (!message || !account || !chainId) {
                return {
                    success: false,
                    error: 'Missing required fields: message, account, chainId'
                };
            }
            
            return await this.signMessage(message, account, chainId);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * HTTPS Endpoint: Sign authentication
     * POST to your API with: { domain, statement, uri, account, chainId }
     */
    async httpsSignAuthentication(requestData) {
        try {
            const { account, chainId, ...params } = requestData;
            
            if (!account || !chainId) {
                return {
                    success: false,
                    error: 'Missing required fields: account, chainId'
                };
            }
            
            return await this.signAuthentication(params, account, chainId);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * HTTPS Endpoint: Sign order
     * POST to your API with: { orderParams, account, chainId }
     */
    async httpsSignOrder(requestData) {
        try {
            const { orderParams, account, chainId } = requestData;
            
            if (!orderParams || !account || !chainId) {
                return {
                    success: false,
                    error: 'Missing required fields: orderParams, account, chainId'
                };
            }
            
            return await this.signOrder(orderParams, account, chainId);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * HTTPS Endpoint: Sign permit
     * POST to your API with: { permitParams, account, chainId }
     */
    async httpsSignPermit(requestData) {
        try {
            const { permitParams, account, chainId } = requestData;
            
            if (!permitParams || !account || !chainId) {
                return {
                    success: false,
                    error: 'Missing required fields: permitParams, account, chainId'
                };
            }
            
            return await this.signPermit(permitParams, account, chainId);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * HTTPS Endpoint: Sign vote
     * POST to your API with: { voteParams, account, chainId }
     */
    async httpsSignVote(requestData) {
        try {
            const { voteParams, account, chainId } = requestData;
            
            if (!voteParams || !account || !chainId) {
                return {
                    success: false,
                    error: 'Missing required fields: voteParams, account, chainId'
                };
            }
            
            return await this.signVote(voteParams, account, chainId);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * HTTPS Endpoint: Verify signature
     * POST to your API with: { typedData, signature, signerAddress, provider }
     */
    async httpsVerifySignature(requestData) {
        try {
            const { provider, ...params } = requestData;
            
            if (!params.typedData || !params.signature || !params.signerAddress || !provider) {
                return {
                    success: false,
                    error: 'Missing required fields: typedData, signature, signerAddress, provider'
                };
            }
            
            return await this.verifySignature(params, provider);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * HTTPS Endpoint: Get cached signature
     * GET request with: { messageHash }
     */
    async httpsGetCachedSignature(requestData) {
        try {
            const { messageHash } = requestData;
            
            if (!messageHash) {
                return {
                    success: false,
                    error: 'Missing required field: messageHash'
                };
            }
            
            const cached = this.getCachedSignature(messageHash);
            
            if (cached) {
                return {
                    success: true,
                    cached
                };
            } else {
                return {
                    success: false,
                    error: 'Signature not found in cache'
                };
            }
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
}

module.exports = SNIP12SigningService;

// Example usage
if (require.main === module) {
    const config = {
        walletService: null
    };
    
    const snip12 = new SNIP12SigningService(config);
    
    console.log('SNIP-12 Signing Service initialized');
}
