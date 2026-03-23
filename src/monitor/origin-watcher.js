// Poll origin chain(s) for trigger events matching subscriptions

import { ethGetLogs, ethBlockNumber } from '../lib/rpc.js';
import { chainName } from '../lib/chains.js';

export class OriginWatcher {
  constructor(subscriptions, config) {
    this.config = config;
    this.handlers = [];
    this.running = false;
    this.interval = null;

    // Group subscriptions by chain
    this.chainWatchers = new Map();
    for (const sub of subscriptions) {
      if (sub.isCron) continue; // Cron handled separately
      const key = sub.chainId;
      if (!this.chainWatchers.has(key)) {
        this.chainWatchers.set(key, {
          chainId: sub.chainId,
          lastBlock: null,
          topics: [],
          contracts: new Set(),
        });
      }
      const w = this.chainWatchers.get(key);
      w.topics.push(sub.topic0);
      if (sub.contract && sub.contract !== '0x0000000000000000000000000000000000000000') {
        w.contracts.add(sub.contract);
      }
    }
  }

  onEvent(handler) {
    this.handlers.push(handler);
  }

  async start(pollMs) {
    this.running = true;

    // Initialize lastBlock for each chain — skip chains that fail
    for (const [chainId, w] of this.chainWatchers) {
      try {
        const block = await ethBlockNumber(chainId);
        if (!isNaN(block) && block > 0) {
          w.lastBlock = block;
        } else {
          w.disabled = true;
          w._retryCount = 0;
        }
      } catch {
        w.disabled = true;
        w._retryCount = 0;
      }
    }

    this.interval = setInterval(() => this._poll(), pollMs);
  }

  stop() {
    this.running = false;
    if (this.interval) clearInterval(this.interval);
  }

  async _poll() {
    if (!this.running) return;

    for (const [chainId, w] of this.chainWatchers) {
      // Retry disabled chains periodically (every 10 polls)
      if (w.disabled) {
        w._retryCount = (w._retryCount || 0) + 1;
        if (w._retryCount % 10 === 0) {
          try {
            const block = await ethBlockNumber(chainId);
            if (!isNaN(block) && block > 0) {
              w.lastBlock = block;
              w.disabled = false;
            }
          } catch {}
        }
        continue;
      }
      try {
        const currentBlock = await ethBlockNumber(chainId);
        if (isNaN(currentBlock) || currentBlock <= w.lastBlock) continue;

        const fromBlock = '0x' + (w.lastBlock + 1).toString(16);
        const toBlock = '0x' + currentBlock.toString(16);

        // Query logs for each subscribed topic
        // eth_getLogs topics filter: first element is an array of topic0 values (OR match)
        const uniqueTopics = [...new Set(w.topics)];
        const filter = {
          fromBlock,
          toBlock,
          topics: [uniqueTopics],
        };

        // If watching specific contracts, add address filter
        if (w.contracts.size === 1) {
          filter.address = [...w.contracts][0];
        } else if (w.contracts.size > 1) {
          filter.address = [...w.contracts];
        }

        const logs = await ethGetLogs(filter, chainId);
        if (logs?.length) {
          for (const log of logs) {
            for (const handler of this.handlers) {
              handler({
                type: 'origin',
                chainId,
                chainName: chainName(chainId),
                log,
                topic0: log.topics?.[0],
                blockNumber: parseInt(log.blockNumber, 16),
                txHash: log.transactionHash,
              });
            }
          }
        }

        w.lastBlock = currentBlock;
      } catch {
        // Non-fatal — will retry next poll
      }
    }
  }
}
