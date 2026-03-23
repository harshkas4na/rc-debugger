// Tier 4 #18: Persistent flow history store
// Uses a JSON file with periodic flush — no native dependencies needed.
// Stores last N flows (default 500) with full trace data.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DEFAULT_DIR = join(homedir(), '.rc-debug', 'history');
const MAX_ENTRIES = 500;

export class FlowStore {
  constructor(dir) {
    this.dir = dir || DEFAULT_DIR;
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    this.filePath = join(this.dir, 'flows.json');
    this.entries = this._load();
    this._dirty = false;

    // Auto-flush every 10 seconds
    this._flushInterval = setInterval(() => this.flush(), 10000);
  }

  _load() {
    if (!existsSync(this.filePath)) return [];
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch {
      return [];
    }
  }

  flush() {
    if (!this._dirty) return;
    try {
      writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2));
      this._dirty = false;
    } catch {}
  }

  add(instance) {
    const entry = serializeInstance(instance);
    this.entries.unshift(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(0, MAX_ENTRIES);
    }
    this._dirty = true;
  }

  query({ status, flowName, limit = 20, since } = {}) {
    let results = this.entries;

    if (status === 'ok') results = results.filter(e => !e.failed);
    if (status === 'fail') results = results.filter(e => e.failed);
    if (flowName) results = results.filter(e => e.flow.includes(flowName));
    if (since) {
      const cutoff = new Date(since).getTime();
      results = results.filter(e => new Date(e.timestamp).getTime() >= cutoff);
    }

    return results.slice(0, limit);
  }

  getById(id) {
    return this.entries.find(e => e.id === id) || null;
  }

  get count() { return this.entries.length; }

  get stats() {
    const total = this.entries.length;
    const ok = this.entries.filter(e => !e.failed).length;
    const fail = total - ok;
    return { total, ok, fail, successRate: total > 0 ? Math.round((ok / total) * 100) : 100 };
  }

  stop() {
    clearInterval(this._flushInterval);
    this.flush();
  }
}

function serializeInstance(inst) {
  return {
    id: inst.id,
    timestamp: new Date(inst.startTime).toISOString(),
    flow: inst.flow.name,
    flowId: inst.flow.id,
    triggerId: inst.triggerId,
    completed: inst.completed,
    failed: inst.failed,
    failReason: inst.failReason,
    duration: parseFloat(inst.duration),
    nodes: Object.fromEntries(
      Object.entries(inst.nodes).map(([key, node]) => [
        key,
        {
          state: node.state,
          timestamp: node._timestamp || null,
          data: node.data ? summarize(key, node.data) : null,
        },
      ])
    ),
    hops: (inst.hops || []).map(h => ({
      type: h.type, fnName: h.fnName, selector: h.selector,
    })),
  };
}

function summarize(key, data) {
  const s = {};
  for (const k of ['txHash', 'hash', 'chainId', 'chainName', 'blockNumber', 'txNumber',
    'success', 'gasUsed', 'gasLimit', 'revertReason', 'error', 'type']) {
    if (data[k] !== undefined) s[k] = data[k];
  }
  if (data.callbacks?.length) {
    s.callbacks = data.callbacks.map(cb => ({
      chainId: cb.chainId, contract: cb.contract, selector: cb.selector, fnName: cb.fnName,
    }));
  }
  return s;
}
