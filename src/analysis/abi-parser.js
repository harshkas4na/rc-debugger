// Parse Foundry/Hardhat artifacts and raw ABI files to extract events, functions, selectors

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { toEventSelector, toFunctionSelector } from 'viem';
import { fetchAbi, loadAbiFromFile } from '../lib/abi-resolver.js';

/**
 * Load ABI from an artifact file (Foundry or Hardhat format) or raw ABI JSON
 */
export function loadArtifact(filePath) {
  const absPath = resolve(filePath);
  if (!existsSync(absPath)) throw new Error(`Artifact not found: ${absPath}`);
  const raw = JSON.parse(readFileSync(absPath, 'utf-8'));

  // Foundry: { abi: [...] }
  // Hardhat: { abi: [...] }
  // Raw ABI: [...]
  const abi = Array.isArray(raw) ? raw : raw.abi;
  if (!Array.isArray(abi)) throw new Error(`No ABI found in ${filePath}`);
  return abi;
}

/**
 * Extract all events from an ABI with their topic0 hashes
 */
export function extractEvents(abi) {
  const events = [];
  for (const item of abi) {
    if (item.type !== 'event') continue;
    const sig = `${item.name}(${item.inputs.map(i => i.type).join(',')})`;
    const topic0 = toEventSelector(sig);
    events.push({
      name: item.name,
      signature: sig,
      topic0,
      inputs: item.inputs,
      indexed: item.inputs.filter(i => i.indexed).map(i => i.name),
    });
  }
  return events;
}

/**
 * Extract all external/public functions from an ABI with their selectors
 */
export function extractFunctions(abi) {
  const fns = [];
  for (const item of abi) {
    if (item.type !== 'function') continue;
    const sig = `${item.name}(${item.inputs.map(i => i.type).join(',')})`;
    const selector = toFunctionSelector(sig);
    fns.push({
      name: item.name,
      signature: sig,
      selector,
      inputs: item.inputs,
      stateMutability: item.stateMutability,
    });
  }
  return fns;
}

/**
 * Build a selector → function info map from ABI
 */
export function buildSelectorMap(abi) {
  const map = new Map();
  for (const fn of extractFunctions(abi)) {
    map.set(fn.selector.toLowerCase(), fn);
  }
  return map;
}

/**
 * Build a topic0 → event info map from ABI
 */
export function buildTopicMap(abi) {
  const map = new Map();
  for (const ev of extractEvents(abi)) {
    map.set(ev.topic0.toLowerCase(), ev);
  }
  return map;
}

/**
 * Parse all contracts from config and return structured analysis.
 * ABIs can come from: config.contracts[role].abi (inline), .artifact path, or auto-fetch.
 */
export async function analyzeContracts(config, onStatus) {
  const status = onStatus || (() => {});
  const result = { rc: null, origin: null, callback: null };

  for (const role of ['rc', 'origin', 'callback']) {
    const c = config.contracts[role];
    if (!c?.address) continue;

    let abi = null;

    // 1. Inline ABI in config (set by init after fetch/load)
    if (Array.isArray(c.abi) && c.abi.length > 0) {
      abi = c.abi;
    }

    // 2. Artifact path
    if (!abi && c.artifact) {
      try { abi = loadArtifact(c.artifact); } catch {}
    }

    // 3. Auto-fetch from block explorer
    if (!abi && c.chainId) {
      status(`Fetching ABI for ${role} from block explorer...`);
      abi = await fetchAbi(c.chainId, c.address);
      if (abi) status(`  ✓ ${role} ABI fetched`);
    }

    if (!abi) {
      status(`  ✗ No ABI for ${role} (${c.address.slice(0, 10)}...) — decoding will be limited`);
      result[role] = { address: c.address, chainId: c.chainId, error: 'No ABI available' };
      continue;
    }

    try {
      result[role] = {
        address: c.address,
        chainId: c.chainId,
        abi,
        events: extractEvents(abi),
        functions: extractFunctions(abi),
        selectorMap: buildSelectorMap(abi),
        topicMap: buildTopicMap(abi),
      };
    } catch (err) {
      result[role] = { address: c.address, chainId: c.chainId, error: err.message };
    }
  }

  // Singleton: origin and callback are the same contract
  if (config.singleton && result.origin && !result.callback) {
    result.callback = result.origin;
  }

  return result;
}
