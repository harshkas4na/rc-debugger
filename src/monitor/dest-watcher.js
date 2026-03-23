// Watch destination chain for callback execution
// Two-phase approach:
//   Phase 1: Search for any new logs from the dest contract (callback emits events → found)
//   Phase 2: Block-scan for callback proxy tx (callback may not emit events)

import { ethGetLogs, ethBlockNumber, ethGetTransactionReceipt, ethCall } from '../lib/rpc.js';
import { decodeLogs, decodeRevertReason } from '../lib/decoder.js';
import { SYSTEM_CONTRACTS } from '../lib/chains.js';

const CALLBACK_PROXY = SYSTEM_CONTRACTS.callbackProxy.toLowerCase();
const CALLBACK_PROXY_ALT = '0x' + 'ff'.repeat(20);

function isCallbackProxy(address) {
  if (!address) return false;
  const lower = address.toLowerCase();
  return lower === CALLBACK_PROXY || lower === CALLBACK_PROXY_ALT;
}

/**
 * Search destination chain for callback execution.
 * Phase 1: Look for ANY new logs from dest contract (most callbacks emit events).
 * Phase 2: If no logs, scan blocks for tx from callback proxy to dest contract.
 */
export async function findCallbackExecution(chainId, destContract, startBlock, maxBlocks = 200) {
  try {
    const currentBlock = await ethBlockNumber(chainId);
    if (isNaN(currentBlock) || currentBlock <= 0) return { found: false };

    const fromBlock = startBlock || Math.max(0, currentBlock - maxBlocks);
    const toBlock = currentBlock;

    // ─── Phase 1: Search for logs from dest contract ─────────
    const filter = {
      fromBlock: '0x' + fromBlock.toString(16),
      toBlock: '0x' + toBlock.toString(16),
      address: destContract,
    };

    const logs = await ethGetLogs(filter, chainId);
    if (logs?.length) {
      // Group logs by transaction
      const txGroups = new Map();
      for (const log of logs) {
        const txHash = log.transactionHash;
        if (!txHash) continue;
        if (!txGroups.has(txHash)) txGroups.set(txHash, []);
        txGroups.get(txHash).push(log);
      }

      // Check each tx — prefer callback proxy sender, but accept any
      // First pass: look for callback proxy tx
      for (const [txHash, txLogs] of txGroups) {
        const receipt = await ethGetTransactionReceipt(txHash, chainId);
        if (!receipt) continue;

        if (isCallbackProxy(receipt.from)) {
          return buildResult(txHash, receipt, txLogs);
        }
      }

      // Second pass: accept any tx that emitted logs from dest contract
      // (the callback might be relayed by a different sender on some chains)
      for (const [txHash, txLogs] of txGroups) {
        const receipt = await ethGetTransactionReceipt(txHash, chainId);
        if (!receipt) continue;

        // Check if it's a tx TO the dest contract (could be callback relay)
        if (receipt.to?.toLowerCase() === destContract.toLowerCase()) {
          return buildResult(txHash, receipt, txLogs);
        }
      }

      // Third pass: just return the most recent tx with logs from this contract
      const lastTxHash = [...txGroups.keys()].pop();
      if (lastTxHash) {
        const receipt = await ethGetTransactionReceipt(lastTxHash, chainId);
        if (receipt) {
          return buildResult(lastTxHash, receipt, txGroups.get(lastTxHash));
        }
      }
    }

    // ─── Phase 2: Block scan for callback proxy tx ───────────
    // (callback may not emit events, e.g. if it reverted)
    // This is slower — scan block by block for tx from proxy to dest
    const scanRange = Math.min(20, toBlock - fromBlock);
    for (let b = toBlock; b >= Math.max(fromBlock, toBlock - scanRange); b--) {
      try {
        const block = await import('../lib/rpc.js').then(m =>
          m.ethGetBlockByNumber(chainId, '0x' + b.toString(16))
        );
        if (!block?.transactions?.length) continue;

        for (const txHash of block.transactions) {
          const receipt = await ethGetTransactionReceipt(txHash, chainId);
          if (!receipt) continue;
          if (isCallbackProxy(receipt.from) && receipt.to?.toLowerCase() === destContract.toLowerCase()) {
            return buildResult(txHash, receipt, receipt.logs || []);
          }
        }
      } catch {}
    }

    return { found: false };
  } catch {
    return { found: false };
  }
}

function buildResult(txHash, receipt, logs) {
  return {
    found: true,
    txHash,
    success: receipt.status === '0x1',
    blockNumber: parseInt(receipt.blockNumber, 16) || 0,
    logs: decodeLogs(logs),
    gasUsed: parseInt(receipt.gasUsed, 16) || 0,
    from: receipt.from,
  };
}

/**
 * Try to get revert reason for a failed callback tx
 */
export async function getRevertReason(chainId, txHash) {
  try {
    const receipt = await ethGetTransactionReceipt(txHash, chainId);
    if (!receipt || receipt.status === '0x1') return null;

    const callResult = await ethCall(chainId, {
      from: receipt.from,
      to: receipt.to,
      data: receipt.input || receipt.data,
    }, receipt.blockNumber);

    return decodeRevertReason(callResult);
  } catch (err) {
    const msg = err?.message || '';
    if (msg.includes('execution reverted')) {
      const match = msg.match(/0x[0-9a-fA-F]+/);
      if (match) return decodeRevertReason(match[0]);
    }
    return null;
  }
}

/**
 * DestWatcher — polls for callback executions on destination chains
 */
export class DestWatcher {
  constructor() {
    this.pending = [];
    this.running = false;
    this.interval = null;
  }

  watch(chainId, contract, startBlock) {
    return new Promise(resolve => {
      this.pending.push({ chainId, contract, startBlock, resolve, attempts: 0, maxAttempts: 60 });
    });
  }

  async start(pollMs) {
    this.running = true;
    this.interval = setInterval(() => this._poll(), pollMs);
  }

  stop() {
    this.running = false;
    if (this.interval) clearInterval(this.interval);
  }

  async _poll() {
    if (!this.running) return;

    const stillPending = [];
    for (const item of this.pending) {
      item.attempts++;
      const result = await findCallbackExecution(item.chainId, item.contract, item.startBlock);

      if (result.found) {
        if (!result.success) {
          result.revertReason = await getRevertReason(item.chainId, result.txHash);
        }
        item.resolve(result);
      } else if (item.attempts >= item.maxAttempts) {
        item.resolve({ found: false, timeout: true });
      } else {
        stillPending.push(item);
      }
    }
    this.pending = stillPending;
  }
}
