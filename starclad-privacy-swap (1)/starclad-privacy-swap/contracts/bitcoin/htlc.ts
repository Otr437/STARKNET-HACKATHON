// Bitcoin Hash Time-Locked Contract (HTLC) Script
// This script enables atomic swaps with privacy features

// Standard HTLC with commitment hash
// 
// If the secret matching the commitment hash is revealed before timeout:
//   Recipient can claim funds
// Else after timeout:
//   Sender can reclaim funds

/*
Bitcoin Script (P2SH):

OP_IF
    // Path 1: Recipient claims with secret
    OP_SHA256
    <commitment_hash>
    OP_EQUALVERIFY
    <recipient_pubkey>
    OP_CHECKSIG
OP_ELSE
    // Path 2: Sender reclaims after timeout
    <locktime>
    OP_CHECKLOCKTIMEVERIFY
    OP_DROP
    <sender_pubkey>
    OP_CHECKSIG
OP_ENDIF
*/

import * as bitcoin from 'bitcoinjs-lib';
import { createHash } from 'crypto';

export interface HTLCParams {
  commitmentHash: Buffer;
  recipientPubKey: Buffer;
  senderPubKey: Buffer;
  locktime: number;
}

export class BitcoinHTLC {
  private network: bitcoin.Network;

  constructor(network: bitcoin.Network = bitcoin.networks.bitcoin) {
    this.network = network;
  }

  // Create HTLC redeem script
  createRedeemScript(params: HTLCParams): Buffer {
    const { commitmentHash, recipientPubKey, senderPubKey, locktime } = params;

    // Build the script
    const script = bitcoin.script.compile([
      bitcoin.opcodes.OP_IF,
        // Recipient path
        bitcoin.opcodes.OP_SHA256,
        commitmentHash,
        bitcoin.opcodes.OP_EQUALVERIFY,
        recipientPubKey,
        bitcoin.opcodes.OP_CHECKSIG,
      bitcoin.opcodes.OP_ELSE,
        // Sender refund path
        bitcoin.script.number.encode(locktime),
        bitcoin.opcodes.OP_CHECKLOCKTIMEVERIFY,
        bitcoin.opcodes.OP_DROP,
        senderPubKey,
        bitcoin.opcodes.OP_CHECKSIG,
      bitcoin.opcodes.OP_ENDIF,
    ]);

    return script;
  }

  // Create P2SH address from redeem script
  createP2SHAddress(redeemScript: Buffer): string {
    const p2sh = bitcoin.payments.p2sh({
      redeem: { output: redeemScript },
      network: this.network,
    });
    return p2sh.address!;
  }

  // Create funding transaction
  createFundingTx(
    utxos: bitcoin.TxInput[],
    htlcAddress: string,
    amount: number,
    changeAddress: string,
    fee: number
  ): bitcoin.Transaction {
    const psbt = new bitcoin.Psbt({ network: this.network });

    let totalInput = 0;
    for (const utxo of utxos) {
      psbt.addInput(utxo);
      totalInput += utxo.value || 0;
    }

    // Add HTLC output
    psbt.addOutput({
      address: htlcAddress,
      value: amount,
    });

    // Add change output if needed
    const change = totalInput - amount - fee;
    if (change > 546) { // Dust limit
      psbt.addOutput({
        address: changeAddress,
        value: change,
      });
    }

    return psbt.extractTransaction();
  }

  // Create claim transaction (recipient spends with secret)
  createClaimTx(
    htlcTxId: string,
    htlcVout: number,
    htlcAmount: number,
    redeemScript: Buffer,
    secret: Buffer,
    recipientAddress: string,
    recipientKeyPair: bitcoin.ECPairInterface,
    fee: number
  ): bitcoin.Transaction {
    const psbt = new bitcoin.Psbt({ network: this.network });

    // Add HTLC input
    psbt.addInput({
      hash: htlcTxId,
      index: htlcVout,
      sequence: 0xfffffffe,
      witnessUtxo: {
        script: bitcoin.payments.p2sh({
          redeem: { output: redeemScript },
          network: this.network,
        }).output!,
        value: htlcAmount,
      },
      redeemScript: redeemScript,
    });

    // Add output to recipient
    psbt.addOutput({
      address: recipientAddress,
      value: htlcAmount - fee,
    });

    // Sign with recipient key
    psbt.signInput(0, recipientKeyPair);

    // Finalize with secret reveal (OP_IF branch = 1)
    psbt.finalizeInput(0, (inputIndex, input) => {
      const redeemPayment = bitcoin.payments.p2sh({
        redeem: {
          input: bitcoin.script.compile([
            input.partialSig![0].signature,
            secret,
            bitcoin.opcodes.OP_TRUE, // Take IF branch
          ]),
          output: redeemScript,
        },
      });
      return {
        finalScriptSig: redeemPayment.input,
        finalScriptWitness: undefined,
      };
    });

    return psbt.extractTransaction();
  }

  // Create refund transaction (sender reclaims after timeout)
  createRefundTx(
    htlcTxId: string,
    htlcVout: number,
    htlcAmount: number,
    redeemScript: Buffer,
    locktime: number,
    senderAddress: string,
    senderKeyPair: bitcoin.ECPairInterface,
    fee: number
  ): bitcoin.Transaction {
    const psbt = new bitcoin.Psbt({ network: this.network });

    // Add HTLC input with locktime
    psbt.addInput({
      hash: htlcTxId,
      index: htlcVout,
      sequence: 0xfffffffe,
      witnessUtxo: {
        script: bitcoin.payments.p2sh({
          redeem: { output: redeemScript },
          network: this.network,
        }).output!,
        value: htlcAmount,
      },
      redeemScript: redeemScript,
    });

    // Add output to sender
    psbt.addOutput({
      address: senderAddress,
      value: htlcAmount - fee,
    });

    // Set locktime
    psbt.setLocktime(locktime);

    // Sign with sender key
    psbt.signInput(0, senderKeyPair);

    // Finalize with empty secret (OP_ELSE branch = 0)
    psbt.finalizeInput(0, (inputIndex, input) => {
      const redeemPayment = bitcoin.payments.p2sh({
        redeem: {
          input: bitcoin.script.compile([
            input.partialSig![0].signature,
            bitcoin.opcodes.OP_FALSE, // Take ELSE branch
          ]),
          output: redeemScript,
        },
      });
      return {
        finalScriptSig: redeemPayment.input,
        finalScriptWitness: undefined,
      };
    });

    return psbt.extractTransaction();
  }

  // Verify commitment hash matches secret
  verifySecret(secret: Buffer, commitmentHash: Buffer): boolean {
    const hash = createHash('sha256').update(secret).digest();
    return hash.equals(commitmentHash);
  }

  // Extract secret from claim transaction
  extractSecretFromTx(tx: bitcoin.Transaction, redeemScript: Buffer): Buffer | null {
    // Parse the scriptSig to extract the secret
    const input = tx.ins[0];
    const scriptSig = bitcoin.script.decompile(input.script);
    
    if (!scriptSig || scriptSig.length < 3) {
      return null;
    }

    // Secret is the second element (after signature, before OP_TRUE)
    const secret = scriptSig[1] as Buffer;
    return Buffer.isBuffer(secret) ? secret : null;
  }
}

// Example usage:
export function createPrivacySwap(
  commitment: string,
  recipientPubKey: Buffer,
  senderPubKey: Buffer,
  locktimeBlocks: number
): { redeemScript: Buffer; address: string } {
  const htlc = new BitcoinHTLC();
  
  // Hash the commitment for the script
  const commitmentHash = createHash('sha256')
    .update(Buffer.from(commitment.slice(2), 'hex'))
    .digest();

  const currentBlockHeight = 800000; // Get from blockchain
  const locktime = currentBlockHeight + locktimeBlocks;

  const redeemScript = htlc.createRedeemScript({
    commitmentHash,
    recipientPubKey,
    senderPubKey,
    locktime,
  });

  const address = htlc.createP2SHAddress(redeemScript);

  return { redeemScript, address };
}
