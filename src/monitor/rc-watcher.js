// Poll Reactive Network for new RC transactions and trace them

import { rnkGetHeadNumber, rnkGetTransactions, rnkGetTransactionLogs } from '../lib/rpc.js';
import { decodeLogs, CALLBACK_TOPIC } from '../lib/decoder.js';
import { rnChainId } from '../lib/chains.js';

export class RcWatcher {
  constructor(rvmId, network) {
    this.rvmId = rvmId;
    this.network = network;
    this.lastHead = 0;
    this.running = false;
    this.interval = null;
    this.handlers = [];
    this.errors = 0;
    this.lastError = null;
  }

  onTransaction(handler) {
    this.handlers.push(handler);
  }

  async init() {
    this.lastHead = await rnkGetHeadNumber(this.rvmId, this.network);
    if (isNaN(this.lastHead) || this.lastHead < 0) this.lastHead = 0;
  }

  async start(pollMs) {
    this.running = true;
    this.interval = setInterval(() => this._poll(), pollMs);
  }

  stop() {
    this.running = false;
    if (this.interval) clearInterval(this.interval);
  }

  get healthy() {
    return this.errors < 5;
  }

  async _poll() {
    if (!this.running) return;

    try {
      const currentHead = await rnkGetHeadNumber(this.rvmId, this.network);
      if (isNaN(currentHead) || currentHead <= this.lastHead) return;

      const start = this.lastHead + 1;
      const count = currentHead - this.lastHead;
      const txs = await rnkGetTransactions(this.rvmId, start, count, this.network);

      if (!txs?.length) {
        this.lastHead = currentHead;
        return;
      }

      for (const tx of txs) {
        // Normalize field names (RPC response varies)
        const txNum = parseHexOrNum(tx.number) || parseHexOrNum(tx.txNumber) || 0;
        const status = tx.status === '0x1' || tx.status === 1 || tx.status === true;
        const refTx = tx.ref_tx || tx.refTx || tx.reference_tx || tx.refTransaction || '';
        const originChainId = parseHexOrNum(tx.origin_chain_id || tx.originChainId || tx.refChainId || tx.ref_chain_id) || 0;

        // Fetch RC logs
        let decodedLogs = [];
        let callbacks = [];

        try {
          const logs = await rnkGetTransactionLogs(this.rvmId, txNum, this.network);
          if (logs?.length) {
            decodedLogs = decodeLogs(logs);
            callbacks = decodedLogs
              .filter(l => l.isCallback)
              .map(l => l.callbackInfo);
          }
        } catch (err) {
          // Log fetch failed but don't crash the poll loop
          this.lastError = `Log fetch failed for tx #${txNum}: ${err.message}`;
        }

        const rcTx = {
          type: 'rc',
          txNumber: txNum,
          hash: tx.hash || tx.txHash,
          status,
          originChainId,
          refTx,
          logs: decodedLogs,
          callbacks,
          raw: tx,
        };

        for (const handler of this.handlers) {
          try { handler(rcTx); } catch {}
        }
      }

      this.lastHead = currentHead;
      this.errors = 0; // Reset on success
    } catch (err) {
      this.errors++;
      this.lastError = err.message;
    }
  }
}

function parseHexOrNum(val) {
  if (val === undefined || val === null) return null;
  if (typeof val === 'number') return val;
  if (typeof val === 'string' && val.startsWith('0x')) return parseInt(val, 16);
  if (typeof val === 'string') return parseInt(val, 10);
  return Number(val);
}
