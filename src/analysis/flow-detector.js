// Auto-detect reactive flows by combining ABI analysis + RN subscriptions + callback patterns

import { analyzeContracts } from './abi-parser.js';
import { resolveRvmId, fetchSubscriptions, discoverCallbackPatterns, CRON_TOPICS } from './subscription.js';
import { rnChainId, chainName, SYSTEM_CONTRACTS } from '../lib/chains.js';
import { registerAbis, registerSelector } from '../lib/decoder.js';

/**
 * Detect all reactive flows for a given config
 * Returns { rvmId, flows[], subscriptions[], callbackPatterns[], contracts }
 */
export async function detectFlows(config, onStatus) {
  const status = onStatus || (() => {});
  const result = {
    rvmId: null,
    flows: [],
    subscriptions: [],
    callbackPatterns: [],
    contracts: null,
  };

  // 1. Analyze contract ABIs
  status('Parsing contract ABIs...');
  const contracts = await analyzeContracts(config, status);
  result.contracts = contracts;

  // Register ABIs with decoder
  for (const role of ['rc', 'origin', 'callback']) {
    const c = contracts[role];
    if (c?.abi && c.address) {
      registerAbis(c.address, c.abi);
      // Register function selectors
      if (c.selectorMap) {
        for (const [sel, fn] of c.selectorMap) {
          registerSelector(sel, fn.signature);
        }
      }
    }
  }

  // 2. Resolve RVM ID
  status('Resolving RVM ID...');
  const rcAddr = config.contracts.rc.address;
  result.rvmId = await resolveRvmId(rcAddr, config.network);
  status(`RVM ID: ${result.rvmId}`);

  // 3. Fetch subscriptions
  status('Fetching subscriptions...');
  result.subscriptions = await fetchSubscriptions(result.rvmId, config.network, rcAddr);
  status(`Found ${result.subscriptions.length} subscription(s)`);

  // 4. Discover callback patterns from recent txs
  status('Scanning recent RC transactions for callback patterns...');
  result.callbackPatterns = await discoverCallbackPatterns(result.rvmId, config.network, 30);
  status(`Found ${result.callbackPatterns.length} callback pattern(s)`);

  // 5. Build flows by matching subscriptions → callback patterns
  status('Building flow graph...');
  result.flows = buildFlows(config, contracts, result.subscriptions, result.callbackPatterns);

  // 6. Add custom flows from config
  if (config.customFlows?.length) {
    for (const cf of config.customFlows) {
      result.flows.push({
        name: cf.name,
        trigger: cf.trigger,
        callback: cf.callback,
        isCustom: true,
      });
    }
  }

  status(`Detected ${result.flows.length} flow(s)`);
  return result;
}

function buildFlows(config, contracts, subscriptions, callbackPatterns) {
  const flows = [];
  const originTopicMap = contracts.origin?.topicMap;
  const callbackSelectorMap = contracts.callback?.selectorMap;
  const rcSelectorMap = contracts.rc?.selectorMap;
  const rnCid = rnChainId(config.network);

  // Collect user-specified contract addresses for filtering
  const userContracts = new Set();
  for (const c of Object.values(config.contracts)) {
    if (c?.address) userContracts.add(c.address.toLowerCase());
  }

  // Filter subscriptions: only keep those matching user's contracts, cron, or system
  const relevantSubs = subscriptions.filter(sub => {
    if (sub.isCron || sub.isSystem) return true;
    if (userContracts.has(sub.contract)) return true;
    // Also keep if the rvmContract (the RC contract that created this sub) matches user's RC
    if (sub.rvmContract && userContracts.has(sub.rvmContract.toLowerCase())) return true;
    return false;
  });

  // Filter callbacks: only keep those targeting user's contracts
  const relevantCallbacks = callbackPatterns.filter(cb => {
    if (cb.isSelfCallback) return true;
    if (userContracts.has(cb.destContract?.toLowerCase())) return true;
    return false;
  });

  // Separate dest and self callbacks
  const destCallbacks = relevantCallbacks.filter(cb => !cb.isSelfCallback);
  const selfCallbacks = relevantCallbacks.filter(cb => cb.isSelfCallback);

  for (const sub of relevantSubs) {
    let triggerName, triggerType;

    if (sub.isCron) {
      triggerName = sub.cronName;
      triggerType = 'cron';
    } else if (originTopicMap && originTopicMap.has(sub.topic0.toLowerCase())) {
      const ev = originTopicMap.get(sub.topic0.toLowerCase());
      triggerName = ev.name;
      triggerType = 'event';
    } else if (contracts.callback?.topicMap?.has(sub.topic0.toLowerCase())) {
      const ev = contracts.callback.topicMap.get(sub.topic0.toLowerCase());
      triggerName = ev.name;
      triggerType = 'feedback';
    } else {
      triggerName = `Unknown(${sub.topic0.slice(0, 10)}...)`;
      triggerType = 'event';
    }

    if (destCallbacks.length === 0 && selfCallbacks.length === 0) {
      // No callback patterns — partial flow
      flows.push({
        id: `flow-${flows.length}`,
        name: `${triggerName} -> ?`,
        trigger: { type: triggerType, chainId: sub.chainId, contract: sub.contract, topic0: sub.topic0, eventName: triggerName },
        callback: null,
        selfCallbacks: [],
      });
      continue;
    }

    // Create flows for dest callbacks
    for (const cb of destCallbacks) {
      let fnName = callbackSelectorMap?.get(cb.selector.toLowerCase())?.name
                || cb.fnName
                || `fn(${cb.selector})`;

      const flow = {
        id: `flow-${flows.length}`,
        name: `${triggerName} -> ${fnName}`,
        trigger: { type: triggerType, chainId: sub.chainId, contract: sub.contract, topic0: sub.topic0, eventName: triggerName },
        callback: { type: 'dest', chainId: cb.destChainId, contract: cb.destContract, selector: cb.selector, fnName },
        selfCallbacks: selfCallbacks.map(sc => {
          const scFnName = rcSelectorMap?.get(sc.selector.toLowerCase())?.name || sc.fnName || `fn(${sc.selector})`;
          return { ...sc, fnName: scFnName };
        }),
      };
      flows.push(flow);
    }

    // If only self-callbacks (no dest), create self-callback flows
    if (destCallbacks.length === 0 && selfCallbacks.length > 0) {
      for (const sc of selfCallbacks) {
        const fnName = rcSelectorMap?.get(sc.selector.toLowerCase())?.name || sc.fnName || `fn(${sc.selector})`;
        flows.push({
          id: `flow-${flows.length}`,
          name: `${triggerName} -> ${fnName} (self)`,
          trigger: { type: triggerType, chainId: sub.chainId, contract: sub.contract, topic0: sub.topic0, eventName: triggerName },
          callback: { type: 'self', chainId: sc.destChainId, contract: sc.destContract, selector: sc.selector, fnName },
          selfCallbacks: [],
        });
      }
    }
  }

  // Deduplicate by trigger+callback combination (not just name)
  const seen = new Set();
  return flows.filter(f => {
    const key = `${f.trigger.topic0}:${f.trigger.chainId}:${f.callback?.selector || 'none'}:${f.callback?.chainId || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
