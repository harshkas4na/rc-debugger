// Tier 2 #9: JSON flow logger — persists traces to a JSONL file

import { appendFileSync, writeFileSync } from 'fs';

export class FlowLogger {
  constructor(filePath) {
    this.filePath = filePath;
    this.count = 0;
    // Write header
    writeFileSync(this.filePath, '');
  }

  log(instance) {
    const entry = {
      timestamp: new Date().toISOString(),
      flow: instance.flow.name,
      flowId: instance.flow.id,
      triggerId: instance.triggerId,
      completed: instance.completed,
      failed: instance.failed,
      failReason: instance.failReason,
      duration: instance.duration,
      nodes: {},
      hops: instance.hops.map(h => ({
        type: h.type,
        fnName: h.fnName,
        selector: h.selector,
      })),
    };

    // Serialize node data (strip raw logs for compactness)
    for (const [key, node] of Object.entries(instance.nodes)) {
      entry.nodes[key] = {
        state: node.state,
        data: node.data ? summarizeNodeData(key, node.data) : null,
      };
    }

    try {
      appendFileSync(this.filePath, JSON.stringify(entry) + '\n');
      this.count++;
    } catch {}
  }
}

function summarizeNodeData(nodeKey, data) {
  const summary = {};

  if (data.txHash) summary.txHash = data.txHash;
  if (data.hash) summary.txHash = data.hash;
  if (data.chainId) summary.chainId = data.chainId;
  if (data.chainName) summary.chainName = data.chainName;
  if (data.blockNumber) summary.blockNumber = data.blockNumber;
  if (data.txNumber) summary.txNumber = data.txNumber;
  if (data.success !== undefined) summary.success = data.success;
  if (data.gasUsed) summary.gasUsed = data.gasUsed;
  if (data.revertReason) summary.revertReason = data.revertReason;
  if (data.error) summary.error = data.error;
  if (data.type) summary.type = data.type;

  // Summarize callbacks
  if (data.callbacks?.length) {
    summary.callbacks = data.callbacks.map(cb => ({
      chainId: cb.chainId,
      contract: cb.contract,
      selector: cb.selector,
      fnName: cb.fnName,
    }));
  }

  return summary;
}
