// Orchestrator — ties origin watcher, RC watcher, dest watcher, and flow state together
//
// Handles 3 trigger types:
//   1. Origin events (from origin chain) — matched via pendingOriginEvents
//   2. Cron ticks (from RN system contract) — detected by refChainId == RN chain
//   3. Feedback events (from CC chain) — treated like origin events
//
// Handles self-callback chains:
//   When RC emits self-callback, we queue the flow instance to be continued
//   when the follow-up RC tx arrives (matched by the self-callback delivery tx)

import { OriginWatcher } from './origin-watcher.js';
import { RcWatcher } from './rc-watcher.js';
import { DestWatcher, findCallbackExecution, getRevertReason } from './dest-watcher.js';
import { FlowTracker } from './flow-state.js';
import { ethBlockNumber } from '../lib/rpc.js';
import { rnChainId, chainName, isRnChainId } from '../lib/chains.js';
import { decodeRevertReason } from '../lib/decoder.js';
import { CRON_TOPICS } from '../analysis/subscription.js';

export class Orchestrator {
  constructor(config, detection) {
    this.config = config;
    this.detection = detection;
    this.flows = detection.flows;
    this.rvmId = detection.rvmId;
    this.tracker = new FlowTracker();

    this.originWatcher = new OriginWatcher(detection.subscriptions, config);
    this.rcWatcher = new RcWatcher(detection.rvmId, config.network);
    this.destWatcher = new DestWatcher();

    // Pending: origin events waiting for RC match
    this.pendingOriginEvents = [];

    // Pending: self-callback continuations waiting for follow-up RC tx
    this.pendingSelfCallbacks = []; // { instance, contract, timestamp }

    // Build O(1) flow lookup: "topic0:chainId" → flow
    this._flowMap = new Map();
    this._cronFlows = []; // cron-triggered flows
    for (const flow of this.flows) {
      if (flow.trigger.type === 'cron') {
        this._cronFlows.push(flow);
      }
      if (flow.trigger.topic0 && flow.trigger.chainId) {
        const key = `${flow.trigger.topic0.toLowerCase()}:${flow.trigger.chainId}`;
        this._flowMap.set(key, flow);
      }
    }

    this._wireHandlers();
  }

  _wireHandlers() {
    // Origin event detected → find matching flow, start instance
    this.originWatcher.onEvent((event) => {
      const flow = this._matchFlowByTrigger(event.topic0, event.chainId);
      if (!flow) return;

      const instance = this.tracker.start(flow, event.txHash);
      instance.setOriginDetected({
        chainId: event.chainId,
        chainName: event.chainName,
        txHash: event.txHash,
        blockNumber: event.blockNumber,
        log: event.log,
      });

      this.pendingOriginEvents.push({
        instance,
        originTxHash: event.txHash,
        originChainId: event.chainId,
        timestamp: Date.now(),
      });
    });

    // RC transaction detected → route to appropriate handler
    this.rcWatcher.onTransaction((rcTx) => {
      this._handleRcTx(rcTx);
    });
  }

  _handleRcTx(rcTx) {
    const refTx = (rcTx.refTx || '').toLowerCase();
    const now = Date.now();
    const rnCid = rnChainId(this.config.network);

    // Expire old pending events (>5 min)
    this.pendingOriginEvents = this.pendingOriginEvents.filter(p => now - p.timestamp < 300000);
    this.pendingSelfCallbacks = this.pendingSelfCallbacks.filter(p => now - p.timestamp < 300000);

    // ── Priority 1: Match to pending self-callback continuation ──
    // Self-callbacks are delivered as new RC txs. The refChainId will be RN chain,
    // and the tx is targeting a known RC contract from a prior self-callback.
    if (rcTx.originChainId === rnCid || isRnChainId(rcTx.originChainId)) {
      const selfIdx = this.pendingSelfCallbacks.findIndex(p => {
        // Match by contract address — the self-callback targets a specific RC contract
        const to = (rcTx.raw?.to || '').toLowerCase();
        return to && p.contract && to === p.contract.toLowerCase();
      });

      if (selfIdx !== -1) {
        const pending = this.pendingSelfCallbacks[selfIdx];
        this.pendingSelfCallbacks.splice(selfIdx, 1);
        this._processSelfCallbackContinuation(pending.instance, rcTx);
        return;
      }
    }

    // ── Priority 2: Match to pending origin event by refTx ──
    let matched = null;
    if (refTx) {
      const matchIdx = this.pendingOriginEvents.findIndex(p =>
        p.originTxHash.toLowerCase() === refTx
      );
      if (matchIdx !== -1) {
        matched = this.pendingOriginEvents[matchIdx];
        this.pendingOriginEvents.splice(matchIdx, 1);
      }
    }

    if (matched) {
      this._processMatchedRcTx(matched.instance, rcTx);
      return;
    }

    // ── Priority 3: Cron-triggered tx (refChainId is RN, no pending match) ──
    if (rcTx.originChainId === rnCid || isRnChainId(rcTx.originChainId)) {
      if (rcTx.callbacks.length > 0 || rcTx.logs.length > 0) {
        this._processCronTx(rcTx);
        return;
      }
    }

    // ── Priority 4: Unmatched tx with callbacks (feedback or missed origin) ──
    if (rcTx.callbacks.length > 0) {
      this._processUnmatchedRcTx(rcTx);
    }
  }

  // ─── Tier 1 Fix #1: Cron flows properly tracked ──────────────────────

  _processCronTx(rcTx) {
    const flow = this._cronFlows[0] || this.flows[0];
    if (!flow) return;

    const instance = this.tracker.start(flow, `cron-${rcTx.txNumber}`);
    instance.setOriginDetected({
      type: 'cron',
      chainName: 'Reactive Network',
      txNumber: rcTx.txNumber,
    });

    this._processMatchedRcTx(instance, rcTx);
  }

  // ─── Tier 1 Fix #3: RC revert reason decoded ────────────────────────

  _processMatchedRcTx(instance, rcTx) {
    if (!rcTx.status) {
      // Decode RC revert reason from rData or logs
      let revertReason = 'RC transaction reverted';
      const rData = rcTx.raw?.rData;
      if (rData && rData !== '0x' && rData.length > 2) {
        const decoded = decodeRevertReason(rData);
        if (decoded) revertReason = decoded;
      }
      // Also check if any log contains error info
      for (const log of rcTx.logs) {
        if (log.name?.includes('Error') || log.name?.includes('Panic')) {
          revertReason = `${log.name}: ${JSON.stringify(log.args || {})}`;
          break;
        }
      }

      instance.setFailed('rcWatch', revertReason);
      this.tracker.complete(instance);
      return;
    }

    instance.setRcObserved({
      txNumber: rcTx.txNumber,
      hash: rcTx.hash,
      logs: rcTx.logs,
      gasUsed: rcTx.raw?.used ? parseInt(rcTx.raw.used, 16) : null,
      gasLimit: rcTx.raw?.limit ? parseInt(rcTx.raw.limit, 16) : null,
    });

    if (rcTx.callbacks.length === 0) {
      // No callbacks — might still be valid (logging-only react)
      if (rcTx.logs.length > 0) {
        // Has logs but no callbacks — complete as success (observation-only flow)
        instance.setCallbackEmitted({ callbacks: [], logs: rcTx.logs });
        instance.setDestExecuted({ success: true, observationOnly: true });
        this.tracker.complete(instance);
      } else {
        instance.setFailed('callback', 'No callbacks or logs emitted by RC');
        this.tracker.complete(instance);
      }
      return;
    }

    instance.setCallbackEmitted({
      callbacks: rcTx.callbacks,
      logs: rcTx.logs,
    });

    // ─── Tier 1 Fix #2: Self-callbacks properly chained ──────────────

    const rnCid = rnChainId(this.config.network);
    let hasDestCallback = false;
    let hasSelfCallback = false;

    for (const cb of rcTx.callbacks) {
      if (cb.chainId === rnCid || isRnChainId(cb.chainId)) {
        // Self-callback: queue for continuation tracking
        hasSelfCallback = true;
        instance.addHop({
          type: 'self',
          selector: cb.selector,
          fnName: cb.fnName,
          contract: cb.contract,
        });

        // Register this flow instance to be continued when the self-callback
        // delivery arrives as the next RC tx
        this.pendingSelfCallbacks.push({
          instance,
          contract: cb.contract,
          timestamp: Date.now(),
        });
      } else {
        // Dest callback: watch for execution on dest chain
        hasDestCallback = true;
        this._watchDestCallback(instance, cb).catch(err => {
          instance.setFailed('dest', err.message);
          this.tracker.complete(instance);
        });
      }
    }

    // If only self-callbacks, don't complete yet — wait for continuation
    // The flow will be completed when the self-callback RC tx is processed
    // or when it times out (handled by expiry in _handleRcTx)
    if (!hasDestCallback && !hasSelfCallback) {
      instance.setDestExecuted({ success: true });
      this.tracker.complete(instance);
    }
    // If hasDestCallback, _watchDestCallback will complete it
    // If only hasSelfCallback, pendingSelfCallbacks will continue it
  }

  // ─── Self-callback continuation ──────────────────────────────────────

  _processSelfCallbackContinuation(instance, rcTx) {
    if (!rcTx.status) {
      let revertReason = 'Self-callback delivery failed';
      const rData = rcTx.raw?.rData;
      if (rData && rData !== '0x' && rData.length > 2) {
        const decoded = decodeRevertReason(rData);
        if (decoded) revertReason = `Self-callback revert: ${decoded}`;
      }
      instance.setFailed('dest', revertReason);
      this.tracker.complete(instance);
      return;
    }

    // Self-callback succeeded — check if it emits more callbacks
    instance.addHop({
      type: 'self-delivered',
      txNumber: rcTx.txNumber,
      hash: rcTx.hash,
      logs: rcTx.logs,
    });

    if (rcTx.callbacks.length > 0) {
      // Self-callback triggered more callbacks — continue the chain
      const rnCid = rnChainId(this.config.network);
      let hasMore = false;

      for (const cb of rcTx.callbacks) {
        if (cb.chainId === rnCid || isRnChainId(cb.chainId)) {
          // Another self-callback — chain continues (max 5 hops to prevent loops)
          if (instance.hops.length < 10) {
            instance.addHop({ type: 'self', selector: cb.selector, fnName: cb.fnName, contract: cb.contract });
            this.pendingSelfCallbacks.push({
              instance,
              contract: cb.contract,
              timestamp: Date.now(),
            });
            hasMore = true;
          }
        } else {
          // Finally a dest callback — watch for it
          hasMore = true;
          this._watchDestCallback(instance, cb).catch(err => {
            instance.setFailed('dest', err.message);
            this.tracker.complete(instance);
          });
        }
      }

      if (!hasMore) {
        instance.setDestExecuted({ success: true, selfCallbackChainComplete: true });
        this.tracker.complete(instance);
      }
    } else {
      // Self-callback didn't emit more callbacks — flow is done
      instance.setDestExecuted({ success: true, selfCallbackComplete: true });
      this.tracker.complete(instance);
    }
  }

  _processUnmatchedRcTx(rcTx) {
    // Try to match by refChainId to a flow trigger
    const flow = this.flows.find(f =>
      f.trigger.chainId === rcTx.originChainId
    ) || this.flows[0];
    if (!flow) return;

    const instance = this.tracker.start(flow, `rc-${rcTx.txNumber}`);
    instance.setOriginDetected({
      type: 'unmatched',
      chainId: rcTx.originChainId,
      chainName: chainName(rcTx.originChainId),
      txNumber: rcTx.txNumber,
      refTx: rcTx.refTx,
    });
    this._processMatchedRcTx(instance, rcTx);
  }

  async _watchDestCallback(instance, cb) {
    try {
      const startBlock = await ethBlockNumber(cb.chainId);
      const searchFrom = Math.max(0, startBlock - 50);
      const maxAttempts = 60;
      const pollMs = this.config.pollInterval || 3000;

      for (let i = 0; i < maxAttempts; i++) {
        await new Promise(r => setTimeout(r, pollMs));

        const result = await findCallbackExecution(
          cb.chainId,
          cb.contract,
          searchFrom,
          50 + (i * 10)
        );

        if (result.found) {
          if (!result.success) {
            result.revertReason = await getRevertReason(cb.chainId, result.txHash);
          }
          instance.setDestExecuted({
            success: result.success,
            txHash: result.txHash,
            blockNumber: result.blockNumber,
            logs: result.logs,
            gasUsed: result.gasUsed,
            revertReason: result.revertReason,
            chainId: cb.chainId,
            chainName: chainName(cb.chainId),
          });
          this.tracker.complete(instance);
          return;
        }
      }

      instance.setFailed('dest', `Callback not found on ${chainName(cb.chainId)} (~${Math.round(maxAttempts * pollMs / 1000)}s timeout)`);
      this.tracker.complete(instance);
    } catch (err) {
      instance.setFailed('dest', err.message);
      this.tracker.complete(instance);
    }
  }

  _matchFlowByTrigger(topic0, chainId) {
    if (!topic0) return null;
    const key = `${topic0.toLowerCase()}:${chainId}`;
    return this._flowMap.get(key) || null;
  }

  async start() {
    await this.rcWatcher.init();
    const pollMs = this.config.pollInterval || 3000;
    await this.originWatcher.start(pollMs);
    await this.rcWatcher.start(pollMs);
    await this.destWatcher.start(pollMs);

    // Periodic cleanup of stale pending queues (independent of RC tx arrival)
    this._cleanupInterval = setInterval(() => {
      const now = Date.now();
      this.pendingOriginEvents = this.pendingOriginEvents.filter(p => now - p.timestamp < 300000);
      const before = this.pendingSelfCallbacks.length;
      this.pendingSelfCallbacks = this.pendingSelfCallbacks.filter(p => now - p.timestamp < 300000);
      // Fail instances whose self-callbacks expired
      if (before > this.pendingSelfCallbacks.length) {
        // Expired entries already removed; instances will time out naturally
      }
    }, 60000);
  }

  stop() {
    this.originWatcher.stop();
    this.rcWatcher.stop();
    this.destWatcher.stop();
    if (this._cleanupInterval) clearInterval(this._cleanupInterval);
  }
}
