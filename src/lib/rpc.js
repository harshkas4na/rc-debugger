// JSON-RPC wrapper for Reactive Network (rnk_*) and standard EVM (eth_*) calls

import { chainRpcs, rnChainId } from './chains.js';

const TIMEOUT = 10000;
const MAX_RETRIES = 2;

async function jsonRpc(url, method, params = []) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: controller.signal,
      });
      const json = await res.json();
      if (json.error) throw new Error(`RPC ${method}: ${json.error.message || JSON.stringify(json.error)}`);
      return json.result;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/**
 * Try RPCs in order — fallback to next on failure
 */
async function jsonRpcWithFallback(chainId, method, params = []) {
  const rpcs = chainRpcs(chainId);
  if (!rpcs.length) throw new Error(`No RPC for chain ${chainId}`);

  let lastErr;
  for (const url of rpcs) {
    try {
      return await jsonRpc(url, method, params);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function rnRpc(network) {
  const rpcs = chainRpcs(rnChainId(network));
  if (!rpcs.length) throw new Error(`No RPC for Reactive Network (${network})`);
  return rpcs[0];
}

// ─── Reactive Network (rnk_*) ───────────────────────────────────────────

export async function rnkGetRvmId(rcAddress, network) {
  const result = await jsonRpc(rnRpc(network), 'rnk_getRnkAddressMapping', [rcAddress]);
  return result?.rvmId ?? null;
}

export async function rnkGetHeadNumber(rvmId, network) {
  const hex = await jsonRpc(rnRpc(network), 'rnk_getHeadNumber', [rvmId]);
  const num = typeof hex === 'string' ? parseInt(hex, 16) : Number(hex);
  return isNaN(num) ? 0 : num;
}

export async function rnkGetTransactions(rvmId, start, limit, network) {
  const startHex = '0x' + start.toString(16);
  const limitHex = '0x' + limit.toString(16);
  return jsonRpc(rnRpc(network), 'rnk_getTransactions', [rvmId, startHex, limitHex]);
}

export async function rnkGetTransactionLogs(rvmId, txNumber, network) {
  const txHex = '0x' + txNumber.toString(16);
  return jsonRpc(rnRpc(network), 'rnk_getTransactionLogs', [rvmId, txHex]);
}

export async function rnkGetTransactionByHash(rvmId, txHash, network) {
  return jsonRpc(rnRpc(network), 'rnk_getTransactionByHash', [rvmId, txHash]);
}

export async function rnkGetSubscribers(rvmId, network) {
  return jsonRpc(rnRpc(network), 'rnk_getSubscribers', [rvmId]);
}

export async function rnkGetVm(rvmId, network) {
  return jsonRpc(rnRpc(network), 'rnk_getVm', [rvmId]);
}

// ─── Standard EVM (eth_*) — uses fallback RPCs ─────────────────────────

export async function ethGetTransactionReceipt(txHash, chainId) {
  return jsonRpcWithFallback(chainId, 'eth_getTransactionReceipt', [txHash]);
}

export async function ethGetTransaction(txHash, chainId) {
  return jsonRpcWithFallback(chainId, 'eth_getTransaction', [txHash]);
}

export async function ethGetLogs(filter, chainId) {
  return jsonRpcWithFallback(chainId, 'eth_getLogs', [filter]);
}

export async function ethBlockNumber(chainId) {
  const hex = await jsonRpcWithFallback(chainId, 'eth_blockNumber', []);
  const num = parseInt(hex, 16);
  return isNaN(num) ? 0 : num;
}

export async function ethGetBlockByNumber(chainId, blockRef = 'latest') {
  return jsonRpcWithFallback(chainId, 'eth_getBlockByNumber', [blockRef, false]);
}

export async function ethCall(chainId, tx, blockRef = 'latest') {
  return jsonRpcWithFallback(chainId, 'eth_call', [tx, blockRef]);
}
