// ABI-based log decoder using viem

import { decodeEventLog, parseAbi, toFunctionSelector, toEventSelector } from 'viem';

const abiRegistry = new Map();   // address → abi[]
const knownSelectors = new Map(); // 4-byte selector → sig string

// ─── Callback event (system) ────────────────────────────────────────────
export const CALLBACK_TOPIC = '0x8dd725fa9d6cd150017ab9e60318d40616439424e2fade9c1c58854950917dfc';
const CALLBACK_ABI = parseAbi(['event Callback(uint256 indexed chain_id, address indexed _contract, uint64 indexed gas_limit, bytes payload)']);

// ─── Registration ───────────────────────────────────────────────────────

export function registerAbis(address, abi) {
  const addr = address.toLowerCase();
  abiRegistry.set(addr, abi);
  // Index function selectors
  for (const item of abi) {
    if (item.type === 'function' && item.name) {
      try {
        const sig = `${item.name}(${(item.inputs || []).map(i => i.type).join(',')})`;
        const sel = toFunctionSelector(sig);
        knownSelectors.set(sel.toLowerCase(), sig);
      } catch {}
    }
  }
}

export function getAbi(address) {
  return abiRegistry.get(address?.toLowerCase()) || [];
}

export function getAllAbis() {
  const all = [];
  for (const abi of abiRegistry.values()) all.push(...abi);
  return all;
}

// ─── Log Decoding ───────────────────────────────────────────────────────

export function decodeLog(log) {
  const topics = (log.topics || []).map(t => t);
  const data = log.data || '0x';
  const addr = (log.address || '').toLowerCase();
  const topic0 = topics[0];

  // Try Callback event first
  if (topic0 === CALLBACK_TOPIC) {
    try {
      const decoded = decodeEventLog({ abi: CALLBACK_ABI, topics, data });
      const payload = decoded.args.payload;
      const selector = (payload && payload.length >= 10) ? payload.slice(0, 10) : null;
      const callbackInfo = {
        chainId: Number(decoded.args.chain_id),
        contract: decoded.args._contract,
        gasLimit: Number(decoded.args.gas_limit),
        selector,
        payload,
      };
      callbackInfo.fnName = lookupSelector(selector);
      return {
        name: 'Callback',
        args: decoded.args,
        isCallback: true,
        callbackInfo,
        raw: log,
      };
    } catch {}
  }

  // Try address-specific ABI
  const addressAbi = abiRegistry.get(addr);
  if (addressAbi?.length) {
    try {
      const decoded = decodeEventLog({ abi: addressAbi, topics, data });
      return { name: decoded.eventName, args: decoded.args, raw: log };
    } catch {}
  }

  // Try all registered ABIs
  for (const [, abi] of abiRegistry) {
    try {
      const decoded = decodeEventLog({ abi, topics, data });
      return { name: decoded.eventName, args: decoded.args, raw: log };
    } catch {}
  }

  // Fallback: unknown
  return { name: `Unknown(${topic0?.slice(0, 10)}...)`, args: {}, raw: log, unknown: true };
}

export function decodeLogs(logs) {
  return (logs || []).map(decodeLog);
}

// ─── Selector Lookup ────────────────────────────────────────────────────

export function registerSelector(hex, name) {
  knownSelectors.set(hex.toLowerCase(), name);
}

export function lookupSelector(hex) {
  if (!hex) return null;
  return knownSelectors.get(hex.toLowerCase().slice(0, 10)) || null;
}

// ─── Revert Reason Decoding ─────────────────────────────────────────────

export function decodeRevertReason(returnData) {
  if (!returnData || returnData === '0x') return null;
  // Error(string) = 0x08c379a0
  if (returnData.startsWith('0x08c379a0') && returnData.length >= 138) {
    try {
      const hex = returnData.slice(10);
      const len = parseInt(hex.slice(64, 128), 16);
      if (len > 0 && len < 10000 && hex.length >= 128 + len * 2) {
        const strHex = hex.slice(128, 128 + len * 2);
        let str = '';
        for (let i = 0; i < strHex.length; i += 2) str += String.fromCharCode(parseInt(strHex.slice(i, i + 2), 16));
        return str;
      }
    } catch {}
  }
  // Panic(uint256) = 0x4e487b71
  if (returnData.startsWith('0x4e487b71')) {
    const code = parseInt(returnData.slice(10), 16);
    const codes = { 0x01: 'Assertion failed', 0x11: 'Overflow', 0x12: 'Div by zero', 0x21: 'Invalid enum', 0x32: 'Array OOB', 0x41: 'Too much memory', 0x51: 'Zero-init fn pointer' };
    return `Panic(${codes[code] || `code ${code}`})`;
  }
  return `Unknown revert: ${returnData.slice(0, 20)}...`;
}

// ─── Arg Formatting ─────────────────────────────────────────────────────

export function formatArgs(args) {
  if (!args) return {};
  const result = {};
  for (const [key, val] of Object.entries(args)) {
    if (/^\d+$/.test(key)) continue;
    result[key] = formatValue(val);
  }
  return result;
}

function formatValue(val) {
  if (typeof val === 'bigint') return val.toString();
  if (Array.isArray(val)) return val.map(formatValue);
  if (typeof val === 'object' && val !== null) return formatArgs(val);
  return val;
}
