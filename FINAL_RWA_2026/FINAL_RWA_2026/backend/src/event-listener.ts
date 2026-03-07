import { RpcProvider, Contract, hash } from 'starknet';
import * as dotenv from 'dotenv';
import { broadcast } from './server';

dotenv.config();

const provider = new RpcProvider({ 
  nodeUrl: process.env.STARKNET_RPC_URL! 
});

interface EventFilter {
  contractAddress: string;
  eventName: string;
  fromBlock?: number;
}

// Event listener with polling
class EventListener {
  private filters: EventFilter[] = [];
  private lastCheckedBlock: number = 0;
  private pollInterval: number = 10000; // 10 seconds

  addFilter(filter: EventFilter) {
    this.filters.push(filter);
    console.log(`[Listener] Added filter: ${filter.eventName} on ${filter.contractAddress}`);
  }

  async start() {
    console.log('[Listener] Starting event listener...');
    
    // Get current block
    const block = await provider.getBlock('latest');
    this.lastCheckedBlock = block.block_number;
    
    setInterval(() => this.poll(), this.pollInterval);
  }

  private async poll() {
    try {
      const currentBlock = await provider.getBlock('latest');
      
      if (currentBlock.block_number <= this.lastCheckedBlock) {
        return; // No new blocks
      }

      console.log(`[Listener] Checking blocks ${this.lastCheckedBlock} to ${currentBlock.block_number}`);

      for (const filter of this.filters) {
        await this.checkEvents(filter, this.lastCheckedBlock, currentBlock.block_number);
      }

      this.lastCheckedBlock = currentBlock.block_number;
    } catch (error) {
      console.error('[Listener] Poll error:', error);
    }
  }

  private async checkEvents(filter: EventFilter, fromBlock: number, toBlock: number) {
    try {
      // Get events from contract
      const events = await provider.getEvents({
        from_block: { block_number: fromBlock },
        to_block: { block_number: toBlock },
        address: filter.contractAddress,
        keys: [[hash.getSelectorFromName(filter.eventName)]],
        chunk_size: 100,
      });

      for (const event of events.events) {
        this.handleEvent(filter.eventName, event);
      }
    } catch (error) {
      console.error(`[Listener] Error checking ${filter.eventName}:`, error);
    }
  }

  private handleEvent(eventName: string, event: any) {
    console.log(`[Event] ${eventName}:`, event);

    // Parse event data based on type
    let parsedEvent: any = { type: eventName };

    switch (eventName) {
      case 'RWACreated':
        parsedEvent = {
          type: 'RWACreated',
          rwa_id: event.data[0],
          token_address: event.data[1],
          vault_address: event.data[2],
          creator: event.data[3],
          timestamp: Date.now(),
        };
        break;

      case 'Deposited':
        parsedEvent = {
          type: 'Deposited',
          user: event.keys[1],
          usd_amount: event.data[0],
          tokens_minted: event.data[1],
          timestamp: Date.now(),
        };
        break;

      case 'Redeemed':
        parsedEvent = {
          type: 'Redeemed',
          user: event.keys[1],
          tokens_burned: event.data[0],
          usd_returned: event.data[1],
          timestamp: Date.now(),
        };
        break;

      case 'DataPublished':
        parsedEvent = {
          type: 'DataPublished',
          publisher: event.keys[1],
          round_id: event.keys[2],
          cpi_value: event.data[0],
          timestamp: Date.now(),
        };
        break;
    }

    // Broadcast to WebSocket clients
    broadcast({
      event: parsedEvent,
      block: event.block_number,
      tx_hash: event.transaction_hash,
    });

    // Store in database
    await this.storeEvent(parsedEvent, event);
  }

  private async storeEvent(parsedEvent: any, rawEvent: any) {
    const { db } = await import('../models/database');
    
    try {
      // Store transaction
      await db.saveTransaction({
        id: `${rawEvent.transaction_hash}-${Date.now()}`,
        tx_hash: rawEvent.transaction_hash,
        block_number: rawEvent.block_number,
        timestamp: Date.now(),
        type: parsedEvent.type.toLowerCase().replace('created', 'rwa_created'),
        user_address: parsedEvent.user || parsedEvent.creator,
        vault_address: parsedEvent.vault_address,
        amount: parsedEvent.usd_amount || parsedEvent.tokens_minted,
        data: parsedEvent,
      });
      
      // Store type-specific data
      if (parsedEvent.type === 'RWACreated') {
        // RWA asset will be stored by webhook handler
        console.log('[Store] RWA created, webhook will handle storage');
      }
      
      if (parsedEvent.type === 'Deposited') {
        // Update/create user position
        const existingPosition = await db.getUserPosition(
          parsedEvent.user,
          parsedEvent.vault_address || ''
        );
        
        if (existingPosition) {
          await db.updateUserPosition(parsedEvent.user, parsedEvent.vault_address || '', {
            token_balance: (BigInt(existingPosition.token_balance) + BigInt(parsedEvent.tokens_minted || '0')).toString(),
            deposit_usd_value: (BigInt(existingPosition.deposit_usd_value) + BigInt(parsedEvent.usd_amount || '0')).toString(),
            last_updated: Date.now(),
          });
        } else {
          await db.saveUserPosition({
            user_address: parsedEvent.user,
            vault_address: parsedEvent.vault_address || '',
            token_balance: parsedEvent.tokens_minted || '0',
            deposit_usd_value: parsedEvent.usd_amount || '0',
            entry_cpi: parsedEvent.cpi_at_entry || '0',
            yield_debt: '0',
            total_yield_claimed: '0',
            last_updated: Date.now(),
          });
        }
      }
      
      if (parsedEvent.type === 'Redeemed') {
        // Update user position
        const existingPosition = await db.getUserPosition(
          parsedEvent.user,
          parsedEvent.vault_address || ''
        );
        
        if (existingPosition) {
          const newBalance = BigInt(existingPosition.token_balance) - BigInt(parsedEvent.tokens_burned || '0');
          await db.updateUserPosition(parsedEvent.user, parsedEvent.vault_address || '', {
            token_balance: newBalance.toString(),
            last_updated: Date.now(),
          });
        }
      }
      
      if (parsedEvent.type === 'DataPublished') {
        // Store oracle update
        await db.saveOracleUpdate({
          round_id: parseInt(parsedEvent.round_id || '0'),
          publisher: parsedEvent.publisher,
          cpi_value: parsedEvent.cpi_value || '0',
          cpi_yoy_bps: parsedEvent.cpi_yoy_bps || '0',
          tbill_3m_bps: parsedEvent.tbill_3m_bps || '0',
          tbill_10y_bps: parsedEvent.tbill_10y_bps || '0',
          fed_funds_bps: parsedEvent.fed_funds_bps || '0',
          data_timestamp: parseInt(parsedEvent.data_timestamp || '0'),
          block_timestamp: Date.now(),
          tx_hash: rawEvent.transaction_hash,
        });
      }
      
      console.log('[Store] Event stored:', parsedEvent.type);
    } catch (error) {
      console.error('[Store] Database error:', error);
    }
  }
}

// Initialize listener
const listener = new EventListener();

// Add filters for main contracts
if (process.env.ORACLE_CONTRACT_ADDRESS) {
  listener.addFilter({
    contractAddress: process.env.ORACLE_CONTRACT_ADDRESS,
    eventName: 'DataPublished',
  });
}

if (process.env.FACTORY_CONTRACT_ADDRESS) {
  listener.addFilter({
    contractAddress: process.env.FACTORY_CONTRACT_ADDRESS,
    eventName: 'RWACreated',
  });
  listener.addFilter({
    contractAddress: process.env.FACTORY_CONTRACT_ADDRESS,
    eventName: 'RWADeactivated',
  });
}

// Start listening
listener.start().catch(console.error);

export { listener };
