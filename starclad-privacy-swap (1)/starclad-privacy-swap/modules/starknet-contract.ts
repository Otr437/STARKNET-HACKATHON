/**
 * StarknetContractManager - Production contract interaction
 * Commit notes, initiate/lock/complete/refund swaps, SPV relay, event polling
 */
import { Account, RpcProvider, Contract, CallData, type Call } from 'starknet';
import { EventEmitter } from 'events';
import { SecureKeyManager } from './encryption';
import type { SpendProof } from './note-manager';
import type { StarknetSPVProof } from './bitcoin-bridge';

export class StarknetContractManager extends EventEmitter {
  private provider: RpcProvider;
  private account: Account;
  private swapContract: Contract;
  private bridgeContract: Contract;
  private pollTimer?: NodeJS.Timeout;
  private lastPolledBlock = 0n;

  constructor(private km: SecureKeyManager) {
    super();
    const rpc = km.getSecureEnv('STARKNET_RPC_URL');
    this.provider = new RpcProvider({ nodeUrl: rpc });

    const encKey = km.getSecureEnv('RELAYER_PRIVATE_KEY');
    const privKey = km.decryptPrivateKey(encKey);
    const address = km.getSecureEnv('RELAYER_ADDRESS');
    this.account = new Account(this.provider, address, privKey);

    const swapAddr = km.getSecureEnv('SWAP_CONTRACT_ADDRESS');
    const bridgeAddr = km.getSecureEnv('BRIDGE_CONTRACT_ADDRESS');

    // Minimal ABI - entries needed; full ABI can be fetched from provider in prod
    this.swapContract = new Contract([], swapAddr, this.provider);
    this.swapContract.connect(this.account);
    this.bridgeContract = new Contract([], bridgeAddr, this.provider);
    this.bridgeContract.connect(this.account);
  }

  async commitNote(noteHash: string): Promise<string> {
    const call: Call = {
      contractAddress: this.swapContract.address,
      entrypoint: 'commit_note',
      calldata: CallData.compile([noteHash]),
    };
    const { transaction_hash } = await this.account.execute(call);
    return transaction_hash;
  }

  async initiatePrivacySwap(
    initiatorNoteHash: string,
    initiatorNullifier: string,
    recipientNoteHash: string,
    htlcSecretHash: string,
    timelockDuration: number,
    proof: SpendProof,
  ): Promise<string> {
    const call: Call = {
      contractAddress: this.swapContract.address,
      entrypoint: 'initiate_privacy_swap',
      calldata: CallData.compile([
        initiatorNoteHash, initiatorNullifier, recipientNoteHash,
        htlcSecretHash, timelockDuration,
        proof.merkle_root, proof.proof_elements, proof.signature,
      ]),
    };
    const { transaction_hash } = await this.account.execute(call);
    return transaction_hash;
  }

  async lockSwapWithBTC(swapId: string, btcTxid: string, spvProof: StarknetSPVProof): Promise<string> {
    const call: Call = {
      contractAddress: this.swapContract.address,
      entrypoint: 'lock_swap_with_btc',
      calldata: CallData.compile([
        swapId, btcTxid, spvProof.block_height,
        spvProof.block_header, spvProof.merkle_proof, spvProof.tx_index,
      ]),
    };
    const { transaction_hash } = await this.account.execute(call);
    return transaction_hash;
  }

  async completeSwap(swapId: string, secret: string, proof: SpendProof): Promise<string> {
    const call: Call = {
      contractAddress: this.swapContract.address,
      entrypoint: 'complete_swap',
      calldata: CallData.compile([swapId, secret, proof.merkle_root, proof.proof_elements, proof.signature]),
    };
    const { transaction_hash } = await this.account.execute(call);
    return transaction_hash;
  }

  async refundSwap(swapId: string, proof: SpendProof): Promise<string> {
    const call: Call = {
      contractAddress: this.swapContract.address,
      entrypoint: 'refund_swap',
      calldata: CallData.compile([swapId, proof.merkle_root, proof.proof_elements, proof.signature]),
    };
    const { transaction_hash } = await this.account.execute(call);
    return transaction_hash;
  }

  async submitBTCBlockHeader(spvProof: StarknetSPVProof): Promise<string> {
    const call: Call = {
      contractAddress: this.bridgeContract.address,
      entrypoint: 'submit_block_header',
      calldata: CallData.compile([spvProof.block_height, ...spvProof.block_header]),
    };
    const { transaction_hash } = await this.account.execute(call);
    return transaction_hash;
  }

  async verifyBTCTransaction(spvProof: StarknetSPVProof, amount: bigint, scriptHash: string): Promise<string> {
    const call: Call = {
      contractAddress: this.bridgeContract.address,
      entrypoint: 'verify_btc_transaction',
      calldata: CallData.compile([
        spvProof.txid, spvProof.block_height,
        spvProof.merkle_proof, spvProof.tx_index, amount.toString(), scriptHash,
      ]),
    };
    const { transaction_hash } = await this.account.execute(call);
    return transaction_hash;
  }

  async getSwap(swapId: string): Promise<any> {
    return this.swapContract.call('get_swap', [swapId]);
  }

  async isNullifierSpent(nullifier: string): Promise<boolean> {
    const result = await this.swapContract.call('is_nullifier_spent', [nullifier]);
    return result[0] === 1n;
  }

  async getMerkleRoot(): Promise<string> {
    const result = await this.swapContract.call('get_merkle_root', []);
    return result[0].toString();
  }

  async getBlockNumber(): Promise<number> {
    const block = await this.provider.getBlock('latest');
    return block.block_number;
  }

  async getRelayerBalance(): Promise<bigint> {
    const balance = await this.provider.getBalance(this.account.address);
    return BigInt(balance);
  }

  async waitForTx(txHash: string): Promise<any> {
    return this.provider.waitForTransaction(txHash);
  }

  async estimateFee(calls: Call[]): Promise<any> {
    return this.account.estimateFee(calls);
  }

  /** Multicall: batch multiple calls in one transaction */
  async multicall(calls: Call[]): Promise<string> {
    const { transaction_hash } = await this.account.execute(calls);
    return transaction_hash;
  }

  /** Start polling for contract events */
  startEventPolling(intervalMs = 15_000): void {
    this.pollTimer = setInterval(() => this._pollEvents().catch(console.error), intervalMs);
  }

  private async _pollEvents(): Promise<void> {
    try {
      const block = await this.provider.getBlock('latest');
      const toBlock = BigInt(block.block_number);
      if (toBlock <= this.lastPolledBlock) return;
      const fromBlock = this.lastPolledBlock === 0n ? toBlock : this.lastPolledBlock + 1n;

      const swapEvents = await this.provider.getEvents({
        address: this.swapContract.address,
        from_block: { block_number: Number(fromBlock) },
        to_block:   { block_number: Number(toBlock) },
        chunk_size: 100,
      });
      for (const evt of swapEvents.events) {
        const key = evt.keys[0];
        if (key === '0x' + Buffer.from('NoteCommitted').toString('hex'))      this.emit('NoteCommitted', evt);
        else if (key === '0x' + Buffer.from('SwapInitiated').toString('hex')) this.emit('SwapInitiated', evt);
        else if (key === '0x' + Buffer.from('SwapLocked').toString('hex'))    this.emit('SwapLocked', evt);
        else if (key === '0x' + Buffer.from('SwapCompleted').toString('hex')) this.emit('SwapCompleted', evt);
        else if (key === '0x' + Buffer.from('SwapRefunded').toString('hex'))  this.emit('SwapRefunded', evt);
        else this.emit('event', evt);
      }

      const bridgeEvents = await this.provider.getEvents({
        address: this.bridgeContract.address,
        from_block: { block_number: Number(fromBlock) },
        to_block:   { block_number: Number(toBlock) },
        chunk_size: 100,
      });
      for (const evt of bridgeEvents.events) this.emit('bridge:event', evt);

      this.lastPolledBlock = toBlock;
    } catch { /* non-fatal — retries next interval */ }
  }

  shutdown(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.removeAllListeners();
  }
}
