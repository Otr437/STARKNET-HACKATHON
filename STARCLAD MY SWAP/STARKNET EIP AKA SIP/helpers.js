/**
 * Utility Functions for Starknet SNIP Modules
 * Helper functions for formatting, validation, and conversion
 */

const { num, hash, uint256 } = require('starknet');

class Utils {
    static formatAddress(address, length = 6) {
        if (!address) return '';
        return `${address.slice(0, length + 2)}...${address.slice(-length)}`;
    }
    
    static formatTxHash(txHash, length = 8) {
        if (!txHash) return '';
        return `${txHash.slice(0, length + 2)}...${txHash.slice(-length)}`;
    }
    
    static formatNumber(num, decimals = 2) {
        return Number(num).toLocaleString('en-US', {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals
        });
    }
    
    static formatETH(wei, decimals = 6) {
        const eth = Number(BigInt(wei)) / 1e18;
        return `${this.formatNumber(eth, decimals)} ETH`;
    }
    
    static formatSTRK(amount, decimals = 6) {
        const strk = Number(BigInt(amount)) / 1e18;
        return `${this.formatNumber(strk, decimals)} STRK`;
    }
    
    static formatTokenAmount(amount, decimals = 18, precision = 6) {
        const divisor = 10 ** decimals;
        const formatted = Number(BigInt(amount)) / divisor;
        return this.formatNumber(formatted, precision);
    }
    
    static formatTimestamp(timestamp) {
        const date = new Date(timestamp * 1000);
        return date.toLocaleString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }
    
    static formatRelativeTime(timestamp) {
        const now = Date.now();
        const diff = now - (timestamp * 1000);
        
        const seconds = Math.floor(diff / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
        if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
        if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
        return `${seconds} second${seconds !== 1 ? 's' : ''} ago`;
    }
    
    static formatDuration(seconds) {
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;

        const parts = [];
        if (days > 0) parts.push(`${days}d`);
        if (hours > 0) parts.push(`${hours}h`);
        if (minutes > 0) parts.push(`${minutes}m`);
        if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

        return parts.join(' ');
    }
    
    static isValidAddress(address) {
        if (!address || typeof address !== 'string') return false;
        const cleanAddress = address.startsWith('0x') ? address.slice(2) : address;
        return /^[0-9a-fA-F]{1,64}$/.test(cleanAddress);
    }
    
    static isValidTxHash(txHash) {
        return this.isValidAddress(txHash);
    }
    
    static normalizeAddress(address) {
        if (!address) return null;
        let clean = address.toLowerCase();
        if (!clean.startsWith('0x')) {
            clean = '0x' + clean;
        }
        return clean;
    }
    
    static ethToWei(eth) {
        return BigInt(Math.floor(Number(eth) * 1e18));
    }
    
    static weiToEth(wei) {
        return Number(BigInt(wei)) / 1e18;
    }
    
    static toU256(value) {
        const bigValue = BigInt(value);
        return uint256.bnToUint256(bigValue);
    }
    
    static fromU256(u256) {
        return uint256.uint256ToBN(u256);
    }
    
    static getSelectorFromName(functionName) {
        return hash.getSelectorFromName(functionName);
    }
    
    static generateNonce() {
        return num.toHex(BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)));
    }
    
    static generateSalt() {
        return num.toHex(num.toStorageKey(BigInt(Math.floor(Math.random() * 1e16))));
    }
    
    static sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    static async retry(fn, options = {}) {
        const {
            retries = 3,
            delay = 1000,
            backoff = 2,
            onRetry = null
        } = options;

        let lastError;
        
        for (let i = 0; i <= retries; i++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error;
                
                if (i < retries) {
                    const waitTime = delay * Math.pow(backoff, i);
                    
                    if (onRetry) {
                        onRetry(i + 1, retries, waitTime, error);
                    }
                    
                    await this.sleep(waitTime);
                }
            }
        }
        
        throw lastError;
    }
    
    static truncate(str, maxLength = 50) {
        if (!str || str.length <= maxLength) return str;
        return str.slice(0, maxLength - 3) + '...';
    }
    
    static getExplorerTxUrl(txHash, chainId) {
        const explorers = {
            'SN_MAIN': 'https://starkscan.co/tx',
            'SN_SEPOLIA': 'https://sepolia.starkscan.co/tx'
        };
        
        const baseUrl = explorers[chainId] || explorers['SN_SEPOLIA'];
        return `${baseUrl}/${txHash}`;
    }
    
    static getExplorerAddressUrl(address, chainId) {
        const explorers = {
            'SN_MAIN': 'https://starkscan.co/contract',
            'SN_SEPOLIA': 'https://sepolia.starkscan.co/contract'
        };
        
        const baseUrl = explorers[chainId] || explorers['SN_SEPOLIA'];
        return `${baseUrl}/${address}`;
    }
    
    static parseError(error) {
        if (typeof error === 'string') return error;
        
        if (error.message) {
            const match = error.message.match(/Error in the called contract.*?:\n(.*?)(\n|$)/);
            if (match) return match[1];
            
            return error.message;
        }
        
        return 'Unknown error occurred';
    }
    
    static debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }
    
    static throttle(func, limit) {
        let inThrottle;
        return function executedFunction(...args) {
            if (!inThrottle) {
                func(...args);
                inThrottle = true;
                setTimeout(() => inThrottle = false, limit);
            }
        };
    }
    
    static isBigInt(value) {
        return typeof value === 'bigint';
    }
    
    static toBigInt(value) {
        try {
            return BigInt(value);
        } catch {
            return 0n;
        }
    }
    
    static percentage(value, total) {
        if (total === 0) return 0;
        return (Number(value) / Number(total)) * 100;
    }
    
    static round(value, decimals = 2) {
        const multiplier = Math.pow(10, decimals);
        return Math.round(value * multiplier) / multiplier;
    }
    
    static checkBrowserSupport() {
        const features = {
            clipboard: typeof navigator !== 'undefined' && typeof navigator.clipboard !== 'undefined',
            localStorage: typeof localStorage !== 'undefined',
            bigInt: typeof BigInt !== 'undefined',
            webCrypto: typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined'
        };

        const allSupported = Object.values(features).every(supported => supported);

        return {
            supported: allSupported,
            features
        };
    }
    
    static getChainName(chainId) {
        const chains = {
            'SN_MAIN': 'Starknet Mainnet',
            'SN_SEPOLIA': 'Starknet Sepolia Testnet'
        };
        
        return chains[chainId] || 'Unknown Network';
    }
    
    static formatCalldata(calldata) {
        if (!Array.isArray(calldata)) return '[]';
        if (calldata.length === 0) return '[]';
        if (calldata.length <= 3) return JSON.stringify(calldata, null, 2);
        
        return `[${calldata.slice(0, 3).join(', ')}, ... (${calldata.length} items)]`;
    }
    
    static formatBytes(bytes, decimals = 2) {
        if (bytes === 0) return '0 Bytes';

        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];

        const i = Math.floor(Math.log(bytes) / Math.log(k));

        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }
}

module.exports = Utils;
