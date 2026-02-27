/**
 * Wallet Connection Service for Starknet
 * Supports wallet connection, account management, and transaction handling
 * Includes HTTPS endpoint methods for API integration
 */

const { connect, disconnect } = require('@starknet-io/get-starknet');
const { RpcProvider, Account, constants } = require('starknet');

class WalletConnectionService {
    constructor(config) {
        this.wallet = null;
        this.account = null;
        this.provider = new RpcProvider({ nodeUrl: config.rpcUrl });
        this.address = null;
        this.chainId = null;
        this.isConnected = false;
        
        this.networkConfig = {
            [constants.StarknetChainId.SN_MAIN]: {
                name: 'Mainnet',
                rpcUrl: config.mainnetRpcUrl || 'https://starknet-mainnet.public.blastapi.io/rpc/v0_8',
                explorerUrl: 'https://starkscan.co'
            },
            [constants.StarknetChainId.SN_SEPOLIA]: {
                name: 'Sepolia Testnet',
                rpcUrl: config.sepoliaRpcUrl || 'https://starknet-sepolia.public.blastapi.io/rpc/v0_8',
                explorerUrl: 'https://sepolia.starkscan.co'
            }
        };
        
        this.eventHandlers = new Map();
        this.ETH_CONTRACT = '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7';
        this.STRK_CONTRACT = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
    }
    
    /**
     * Connect to Starknet wallet
     */
    async connect(options = {}) {
        try {
            console.log('[WalletConnection] Initiating connection...');
            
            const selectedWallet = await connect({
                modalMode: options.modalMode || 'alwaysAsk',
                modalTheme: options.theme || 'dark',
                dappName: options.dappName || 'Starknet SNIP Demo',
                includeRecommended: true
            });
            
            if (!selectedWallet) {
                throw new Error('User rejected wallet connection');
            }
            
            this.wallet = selectedWallet;
            
            if (!selectedWallet.isConnected) {
                await selectedWallet.enable({ starknetVersion: 'v5' });
            }
            
            this.account = selectedWallet.account;
            this.address = this.account.address;
            
            const chainId = await selectedWallet.provider.getChainId();
            this.chainId = chainId;
            
            const networkConfig = this.networkConfig[chainId] || this.networkConfig[constants.StarknetChainId.SN_SEPOLIA];
            this.provider = new RpcProvider({ nodeUrl: networkConfig.rpcUrl });
            
            this.isConnected = true;
            this._setupEventListeners();
            
            this._emitEvent('connected', {
                address: this.address,
                chainId: this.chainId,
                walletName: selectedWallet.name,
                walletIcon: selectedWallet.icon
            });
            
            return {
                success: true,
                address: this.address,
                chainId: this.chainId,
                walletName: selectedWallet.name,
                walletIcon: selectedWallet.icon,
                network: networkConfig.name
            };
            
        } catch (error) {
            console.error('[WalletConnection] Connection failed:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Disconnect wallet
     */
    async disconnect() {
        try {
            this._removeEventListeners();
            await disconnect({ clearLastWallet: true });
            
            const previousAddress = this.address;
            this.wallet = null;
            this.account = null;
            this.address = null;
            this.chainId = null;
            this.isConnected = false;
            
            this._emitEvent('disconnected', { previousAddress });
            
            return { success: true };
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Get account balance (ETH)
     */
    async getBalance(accountAddress = null) {
        try {
            const address = accountAddress || this.address;
            
            if (!this.provider || !address) {
                throw new Error('Provider not initialized or address not available');
            }
            
            const balance = await this.provider.callContract({
                contractAddress: this.ETH_CONTRACT,
                entrypoint: 'balanceOf',
                calldata: [address]
            });
            
            const balanceWei = BigInt(balance[0]) + (BigInt(balance[1]) << 128n);
            const balanceEth = Number(balanceWei) / 1e18;
            
            return {
                success: true,
                balance: balanceEth,
                balanceWei: balanceWei.toString(),
                formatted: `${balanceEth.toFixed(6)} ETH`
            };
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Get transaction receipt
     */
    async getTransactionReceipt(txHash) {
        try {
            if (!this.provider) {
                throw new Error('Provider not initialized');
            }
            
            const receipt = await this.provider.getTransactionReceipt(txHash);
            
            return {
                success: true,
                receipt,
                status: receipt.execution_status,
                blockNumber: receipt.block_number,
                blockHash: receipt.block_hash
            };
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Wait for transaction confirmation
     */
    async waitForTransaction(txHash, options = {}) {
        try {
            if (!this.provider) {
                throw new Error('Provider not initialized');
            }
            
            console.log(`[WalletConnection] Waiting for transaction: ${txHash}`);
            
            const receipt = await this.provider.waitForTransaction(txHash, {
                retryInterval: options.retryInterval || 5000,
                successStates: options.successStates || ['ACCEPTED_ON_L2', 'ACCEPTED_ON_L1']
            });
            
            this._emitEvent('transactionConfirmed', { txHash, receipt });
            
            return {
                success: true,
                receipt,
                status: receipt.execution_status
            };
            
        } catch (error) {
            this._emitEvent('transactionFailed', { txHash, error: error.message });
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Switch network
     */
    async switchNetwork(chainId) {
        try {
            if (!this.wallet) {
                throw new Error('Wallet not connected');
            }
            
            await this.wallet.request({
                type: 'wallet_switchStarknetChain',
                params: { chainId }
            });
            
            this.chainId = chainId;
            
            const networkConfig = this.networkConfig[chainId];
            if (networkConfig) {
                this.provider = new RpcProvider({ nodeUrl: networkConfig.rpcUrl });
            }
            
            this._emitEvent('networkChanged', { chainId });
            
            return {
                success: true,
                chainId,
                network: networkConfig?.name || 'Unknown'
            };
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Get network info
     */
    getNetworkInfo() {
        if (!this.chainId) {
            return null;
        }
        
        const config = this.networkConfig[this.chainId];
        return {
            chainId: this.chainId,
            name: config?.name || 'Unknown Network',
            rpcUrl: config?.rpcUrl,
            explorerUrl: config?.explorerUrl
        };
    }
    
    /**
     * Get account instance
     */
    getAccount() {
        if (!this.account) {
            throw new Error('Wallet not connected');
        }
        return this.account;
    }
    
    /**
     * Get provider instance
     */
    getProvider() {
        if (!this.provider) {
            throw new Error('Provider not initialized');
        }
        return this.provider;
    }
    
    /**
     * Get current address
     */
    getAddress() {
        return this.address;
    }
    
    /**
     * Get chain ID
     */
    getChainId() {
        return this.chainId;
    }
    
    /**
     * Check connection status
     */
    isWalletConnected() {
        return this.isConnected && this.account !== null;
    }
    
    /**
     * Add custom network
     */
    addCustomNetwork(chainId, config) {
        this.networkConfig[chainId] = config;
        console.log('[WalletConnection] Custom network added:', chainId);
    }
    
    /**
     * Register event handler
     */
    on(event, handler) {
        if (!this.eventHandlers.has(event)) {
            this.eventHandlers.set(event, []);
        }
        this.eventHandlers.get(event).push(handler);
    }
    
    /**
     * Unregister event handler
     */
    off(event, handler) {
        if (!this.eventHandlers.has(event)) return;
        
        const handlers = this.eventHandlers.get(event);
        const index = handlers.indexOf(handler);
        if (index > -1) {
            handlers.splice(index, 1);
        }
    }
    
    /**
     * Setup wallet event listeners
     */
    _setupEventListeners() {
        if (!this.wallet) return;
        
        this.wallet.on('accountsChanged', (accounts) => {
            if (accounts && accounts.length > 0) {
                this.address = accounts[0];
                this.account = this.wallet.account;
                this._emitEvent('accountChanged', { address: this.address });
            } else {
                this.disconnect();
            }
        });
        
        this.wallet.on('networkChanged', (chainId) => {
            this.chainId = chainId;
            
            const networkConfig = this.networkConfig[chainId];
            if (networkConfig) {
                this.provider = new RpcProvider({ nodeUrl: networkConfig.rpcUrl });
            }
            
            this._emitEvent('networkChanged', { chainId });
        });
    }
    
    /**
     * Remove wallet event listeners
     */
    _removeEventListeners() {
        if (!this.wallet) return;
        
        try {
            this.wallet.off('accountsChanged');
            this.wallet.off('networkChanged');
        } catch (error) {
            console.warn('[WalletConnection] Error removing listeners:', error);
        }
    }
    
    /**
     * Emit custom event
     */
    _emitEvent(event, data) {
        if (!this.eventHandlers.has(event)) return;
        
        const handlers = this.eventHandlers.get(event);
        handlers.forEach(handler => {
            try {
                handler(data);
            } catch (error) {
                console.error(`[WalletConnection] Event handler error (${event}):`, error);
            }
        });
        
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent(`starknet:${event}`, { detail: data }));
        }
    }
    
    // ============ HTTPS ENDPOINT METHODS ============
    // These methods wrap the core functionality for HTTPS API access
    
    /**
     * HTTPS Endpoint: Connect wallet
     * POST to your API with: { options }
     */
    async httpsConnect(requestData) {
        try {
            const { options } = requestData;
            return await this.connect(options || {});
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * HTTPS Endpoint: Disconnect wallet
     * POST to your API
     */
    async httpsDisconnect() {
        return await this.disconnect();
    }
    
    /**
     * HTTPS Endpoint: Get wallet status
     * GET request, no authentication needed for read-only
     */
    async httpsGetStatus() {
        return {
            success: true,
            isConnected: this.isConnected,
            address: this.address,
            chainId: this.chainId,
            network: this.getNetworkInfo()
        };
    }
    
    /**
     * HTTPS Endpoint: Get balance
     * GET request with optional address parameter
     */
    async httpsGetBalance(requestData) {
        try {
            const { address } = requestData || {};
            return await this.getBalance(address);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * HTTPS Endpoint: Get transaction receipt
     * GET request with: { txHash }
     */
    async httpsGetTransaction(requestData) {
        try {
            const { txHash } = requestData;
            
            if (!txHash) {
                return {
                    success: false,
                    error: 'Missing required field: txHash'
                };
            }
            
            return await this.getTransactionReceipt(txHash);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * HTTPS Endpoint: Wait for transaction
     * POST to your API with: { txHash, options }
     */
    async httpsWaitForTransaction(requestData) {
        try {
            const { txHash, options } = requestData;
            
            if (!txHash) {
                return {
                    success: false,
                    error: 'Missing required field: txHash'
                };
            }
            
            return await this.waitForTransaction(txHash, options || {});
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * HTTPS Endpoint: Switch network
     * POST to your API with: { chainId }
     */
    async httpsSwitchNetwork(requestData) {
        try {
            const { chainId } = requestData;
            
            if (!chainId) {
                return {
                    success: false,
                    error: 'Missing required field: chainId'
                };
            }
            
            return await this.switchNetwork(chainId);
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
}

module.exports = WalletConnectionService;

// Example usage
if (require.main === module) {
    const config = {
        rpcUrl: 'https://starknet-sepolia.public.blastapi.io/rpc/v0_8',
        mainnetRpcUrl: 'https://starknet-mainnet.public.blastapi.io/rpc/v0_8',
        sepoliaRpcUrl: 'https://starknet-sepolia.public.blastapi.io/rpc/v0_8'
    };
    
    const walletService = new WalletConnectionService(config);
    
    // Example: Connect wallet
    walletService.connect().then(result => {
        console.log('Wallet connection:', result);
    });
}
