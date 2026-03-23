// Query Reactive Network for actual subscriptions and match to contract events

import { rnkGetRvmId, rnkGetSubscribers, rnkGetVm, rnkGetTransactions, rnkGetTransactionLogs, rnkGetHeadNumber } from '../lib/rpc.js';
import { decodeLogs, CALLBACK_TOPIC } from '../lib/decoder.js';
import { rnChainId, SYSTEM_CONTRACTS } from '../lib/chains.js';

const CRON_TOPICS = {
  '0xf02d6ea5c22a71cffe930a4523fcb4f129be6c804db50e4202fb4e0b07ccb514': 'Cron1',
  '0x04463f7c1651e6b9774d7f85c85bb94654e3c46ca79b0c16fb16d4183307b687': 'Cron10',
  '0xb49937fb8970e19fd46d48f7e3fb00d659deac0347f79cd7cb542f0fc1503c70': 'Cron100',
  '0xe20b31294d84c3661ddc8f423abb9c70310d0cf172aa2714ead78029b325e3f4': 'Cron1000',
  '0xd214e1d84db704ed42d37f538ea9bf71e44ba28bc1cc088b2f5deca654677a56': 'Cron10000',
};

/**
 * Resolve RC address → RVM ID
 */
export async function resolveRvmId(rcAddress, network) {
  let rvmId;
  try {
    rvmId = await rnkGetRvmId(rcAddress, network);
  } catch (err) {
    const msg = err?.message || '';
    if (msg.includes('not found') || msg.includes('RVM not found')) {
      throw new Error(`RC address ${rcAddress} not found on ${network}. Check the address and network.`);
    }
    throw new Error(`Failed to resolve RVM ID: ${msg}`);
  }
  if (!rvmId || rvmId === '0x' || rvmId === '0x0000000000000000000000000000000000000000') {
    throw new Error(`RC ${rcAddress} has no RVM on ${network}. It may not be deployed or not yet active.`);
  }
  return rvmId;
}

/**
 * Fetch all subscriptions for an RVM and classify them
 */
export async function fetchSubscriptions(rvmId, network) {
  const raw = await rnkGetSubscribers(rvmId, network);
  if (!raw?.length) return [];

  const subs = [];
  const seen = new Set();

  for (const s of raw) {
    const chainId = Number(s.chain_id || s.chainId);
    const contract = (s.contract || s._contract || '').toLowerCase();
    // topics can be: array [topic0, topic1, ...] or separate fields
    const topic0 = (Array.isArray(s.topics) ? s.topics[0] : (s.topic_0 || s.topic0 || '')).toLowerCase();
    const uid = s.uid || `${chainId}:${contract}:${topic0}`;
    if (seen.has(uid)) continue;
    seen.add(uid);

    const cronName = CRON_TOPICS[topic0];
    const isSystem = contract === SYSTEM_CONTRACTS.cronService.toLowerCase();

    subs.push({
      chainId,
      contract,
      topic0,
      isCron: !!cronName,
      cronName: cronName || null,
      isSystem,
      rvmContract: s.rvmContract,
    });
  }

  return subs;
}

/**
 * Scan recent RC transactions to discover callback patterns
 * Returns array of { destChainId, destContract, selector, fnName }
 */
export async function discoverCallbackPatterns(rvmId, network, sampleSize = 20) {
  const head = await rnkGetHeadNumber(rvmId, network);
  if (!head || head <= 0) return [];

  const start = Math.max(1, head - sampleSize + 1);
  const limit = Math.min(sampleSize, head);
  const txs = await rnkGetTransactions(rvmId, start, limit, network);
  if (!txs?.length) return [];

  const patterns = new Map(); // key: chainId:contract:selector → pattern

  for (const tx of txs) {
    const txNum = typeof tx.number === 'string' ? parseInt(tx.number, 16) : tx.number;
    try {
      const logs = await rnkGetTransactionLogs(rvmId, txNum, network);
      if (!logs?.length) continue;

      // Use the decoder to properly parse Callback events
      const decoded = decodeLogs(logs);
      for (const dl of decoded) {
        if (!dl.isCallback || !dl.callbackInfo) continue;
        const ci = dl.callbackInfo;
        const selector = ci.selector || '0x00000000';
        const key = `${ci.chainId}:${ci.contract}:${selector}`;
        if (!patterns.has(key)) {
          const rnCid = rnChainId(network);
          patterns.set(key, {
            destChainId: ci.chainId,
            destContract: (ci.contract || '').toLowerCase(),
            selector,
            fnName: ci.fnName,
            isSelfCallback: ci.chainId === rnCid,
            count: 0,
          });
        }
        patterns.get(key).count++;
      }
    } catch {
      // Skip failed log fetches
    }
  }

  return [...patterns.values()];
}

export { CRON_TOPICS };
