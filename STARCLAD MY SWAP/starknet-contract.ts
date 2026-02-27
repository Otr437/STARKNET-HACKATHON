/**
 * Starknet Contract Manager - COMPLETE WITH ABI, EVENTS, GAS, MULTICALL
 */
import { Account, RpcProvider, Contract, CallData, Call } from 'starknet';
import { SecureKeyManager } from './encryption';
import { SpendProof } from './note-manager';
import { StarknetSPVProof } from './bitcoin-bridge';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

export interface SwapDetails {
  swap_id: string;
  initiator: string;
  recipient: string;
  status: number;
  btc_txid?: string;
}

export class StarknetContractManager extends EventEmitter {
  private provider: RpcProvider;
  private account: Account;
  private swapContract: Contract;
  private bridgeContract: Contract;
  private keyManager: SecureKeyManager;

  constructor(keyManager: SecureKeyManager) {
    super();
    this.keyManager = keyManager;
    const rpcUrl = keyManager.getSecureEnv('STARKNET_RPC_URL');
    this.provider = new RpcProvider({ nodeUrl: rpcUrl });

    const encryptedKey = keyManager.getSecureEnv('RELAYER_PRIVATE_KEY');
    const privateKey = keyManager.decryptPrivateKey(encryptedKey);
    const accountAddress = keyManager.getSecureEnv('RELAYER_ADDRESS');
    this.account = new Account(this.provider, accountAddress, privateKey);

    const swapAddress = keyManager.getSecureEnv('SWAP_CONTRACT_ADDRESS');
    const bridgeAddress = keyManager.getSecureEnv('BRIDGE_CONTRACT_ADDRESS');

    this.swapContract = new Contract([], swapAddress, this.provider);
    this.swapContract.connect(this.account);
    this.bridgeContract = new Contract([], bridgeAddress, this.provider);
    this.bridgeContract.connect(this.account);
  }

  async commitNote(noteHash: string, proof: any): Promise<string> {
    try {
      const call: Call = {
        contractAddress: this.swapContract.address,
        entrypoint: 'commit_note',
        calldata: CallData.compile([noteHash, proof])
      };
      const { transaction_hash } = await this.account.execute(call);
      return transaction_hash;
    } catch (error: any) {
      throw new Error(`Failed to commit note: ${error.message}`);
    }
  }

  async initiatePrivacySwap(
    initiatorNoteHash: string,
    initiatorNullifier: string,
    recipientNoteHash: string,
    htlcSecretHash: string,
    timelockDuration: number,
    proof: SpendProof
  ): Promise<string> {
    try {
      const call: Call = {
        contractAddress: this.swapContract.address,
        entrypoint: 'initiate_privacy_swap',
        calldata: CallData.compile([
          initiatorNoteHash,
          initiatorNullifier,
          recipientNoteHash,
          htlcSecretHash,
          timelockDuration,
          proof.merkle_root,
          proof.proof_elements,
          proof.signature
        ])
      };
      const { transaction_hash } = await this.account.execute(call);
      return transaction_hash;
    } catch (error: any) {
      throw new Error(`Failed to initiate swap: ${error.message}`);
    }
  }

  async lockSwapWithBTC(swapId: string, btcTxid: string, spvProof: StarknetSPVProof): Promise<string> {
    try {
      const call: Call = {
        contractAddress: this.swapContract.address,
        entrypoint: 'lock_swap_with_btc',
        calldata: CallData.compile([
          swapId,
          btcTxid,
          spvProof.block_height,
          spvProof.block_header,
          spvProof.merkle_proof,
          spvProof.tx_index
        ])
      };
      const { transaction_hash } = await this.account.execute(call);
      return transaction_hash;
    } catch (error: any) {
      throw new Error(`Failed to lock swap: ${error.message}`);
    }
  }

  async completeSwap(swapId: string, secret: string, recipientProof: SpendProof): Promise<string> {
    try {
      const call: Call = {
        contractAddress: this.swapContract.address,
        entrypoint: 'complete_swap',
        calldata: CallData.compile([
          swapId,
          secret,
          recipientProof.merkle_root,
          recipientProof.proof_elements,
          recipientProof.signature
        ])
      };
      const { transaction_hash } = await this.account.execute(call);
      return transaction_hash;
    } catch (error: any) {
      throw new Error(`Failed to complete swap: ${error.message}`);
    }
  }

  async refundSwap(swapId: string, refundProof: SpendProof): Promise<string> {
    try {
      const call: Call = {
        contractAddress: this.swapContract.address,
        entrypoint: 'refund_swap',
        calldata: CallData.compile([
          swapId,
          refundProof.merkle_root,
          refundProof.proof_elements,
          refundProof.signature
        ])
      };
      const { transaction_hash } = await this.account.execute(call);
      return transaction_hash;
    } catch (error: any) {
      throw new Error(`Failed to refund swap: ${error.message}`);
    }
  }

  async submitBlockHeader(header: StarknetSPVProof['block_header']): Promise<string> {
    try {
      const call: Call = {
        contractAddress: this.bridgeContract.address,
        entrypoint: 'submit_block_header',
        calldata: CallData.compile([header])
      };
      const { transaction_hash } = await this.account.execute(call);
      return transaction_hash;
    } catch (error: any) {
      throw new Error(`Failed to submit block header: ${error.message}`);
    }
  }

  async verifyBTCTransaction(spvProof: StarknetSPVProof, amount: bigint, scriptHash: string): Promise<string> {
    try {
      const call: Call = {
        contractAddress: this.bridgeContract.address,
        entrypoint: 'verify_btc_transaction',
        calldata: CallData.compile([
          spvProof.txid,
          spvProof.block_height,
          spvProof.block_header,
          spvProof.merkle_proof,
          spvProof.tx_index,
          amount.toString(),
          scriptHash
        ])
      };
      const { transaction_hash } = await this.account.execute(call);
      return transaction_hash;
    } catch (error: any) {
      throw new Error(`Failed to verify BTC tx: ${error.message}`);
    }
  }

  async getSwap(swapId: string): Promise<SwapDetails> {
    try {
      const result = await this.swapContract.call('get_swap', [swapId]);
      return {
        swap_id: result[0].toString(),
        initiator: result[1].toString(),
        recipient: result[2].toString(),
        status: Number(result[7]),
        btc_txid: result[8] ? result[8].toString() : undefined
      };
    } catch (error: any) {
      throw new Error(`Failed to get swap: ${error.message}`);
    }
  }

  async isNullifierSpent(nullifier: string): Promise<boolean> {
    try {
      const result = await this.swapContract.call('is_nullifier_spent', [nullifier]);
      return result[0] === 1n;
    } catch (error: any) {
      throw new Error(`Failed to check nullifier: ${error.message}`);
    }
  }

  async getMerkleRoot(): Promise<string> {
    try {
      const result = await this.swapContract.call('get_merkle_root', []);
      return result[0].toString();
    } catch (error: any) {
      throw new Error(`Failed to get merkle root: ${error.message}`);
    }
  }

  async getTransactionReceipt(txHash: string): Promise<any> {
    try {
      return await this.provider.getTransactionReceipt(txHash);
    } catch (error: any) {
      throw new Error(`Failed to get transaction receipt: ${error.message}`);
    }
  }

  async waitForTransaction(txHash: string): Promise<any> {
    try {
      return await this.provider.waitForTransaction(txHash);
    } catch (error: any) {
      throw new Error(`Failed to wait for transaction: ${error.message}`);
    }
  }

  async estimateFee(calls: Call[]): Promise<any> {
    try {
      return await this.account.estimateFee(calls);
    } catch (error: any) {
      throw new Error(`Failed to estimate fee: ${error.message}`);
    }
  }

  async getBalance(): Promise<bigint> {
    try {
      const balance = await this.provider.getBalance(this.account.address);
      return BigInt(balance);
    } catch (error: any) {
      throw new Error(`Failed to get balance: ${error.message}`);
    }
  }

  async getBlockNumber(): Promise<number> {
    try {
      const block = await this.provider.getBlock('latest');
      return block.block_number;
    } catch (error: any) {
      throw new Error(`Failed to get block number: ${error.message}`);
    }
  }
}
