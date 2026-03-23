// One-off trace command — trace a specific origin transaction through the full flow

import { loadConfig, validateConfig } from '../lib/config.js';
import { analyzeContracts } from '../analysis/abi-parser.js';
import { resolveRvmId } from '../analysis/subscription.js';
import { registerAbis, registerSelector, decodeLogs, decodeRevertReason, formatArgs, CALLBACK_TOPIC } from '../lib/decoder.js';
import { ethGetTransactionReceipt, rnkGetHeadNumber, rnkGetTransactions, rnkGetTransactionLogs, ethGetLogs, ethBlockNumber } from '../lib/rpc.js';
import { chainName, rnChainId, SYSTEM_CONTRACTS } from '../lib/chains.js';
import { findCallbackExecution, getRevertReason } from '../monitor/dest-watcher.js';

export default async function trace(args) {
  // Parse --tx flag
  const txIdx = args.indexOf('--tx');
  const txHash = txIdx !== -1 ? args[txIdx + 1] : args[0];

  if (!txHash || !txHash.startsWith('0x')) {
    console.error('  Usage: rc-debug trace --tx <txHash>');
    process.exit(1);
  }

  const config = loadConfig();
  if (!config) {
    console.error('  No .rc-debug.json found. Run \x1b[1mrc-debug init\x1b[0m first.');
    process.exit(1);
  }

  console.log('\n  \x1b[36m\x1b[1mRC Debugger \u2014 Trace\x1b[0m\n');
  console.log(`  TX: ${txHash}`);
  console.log(`  Network: ${config.network}\n`);

  // Setup ABIs
  const contracts = await analyzeContracts(config);
  for (const role of ['rc', 'origin', 'callback']) {
    const c = contracts[role];
    if (c?.abi && c.address) {
      registerAbis(c.address, c.abi);
      if (c.selectorMap) {
        for (const [sel, fn] of c.selectorMap) registerSelector(sel, fn.signature);
      }
    }
  }

  // Resolve RVM ID
  const rcAddr = config.contracts.rc.address;
  let rvmId;
  try {
    rvmId = await resolveRvmId(rcAddr, config.network);
    console.log(`  RVM ID: ${rvmId}\n`);
  } catch (err) {
    console.error(`  \x1b[31m${err.message}\x1b[0m`);
    process.exit(1);
  }

  // STEP 1: Get origin tx receipt
  console.log('  \x1b[1m\u2500\u2500 STEP 1: Origin Event \u2500\u2500\x1b[0m');
  const originChainId = config.contracts.origin.chainId;
  let receipt;
  try {
    receipt = await ethGetTransactionReceipt(txHash, originChainId);
    if (!receipt) throw new Error('Receipt not found');
  } catch (err) {
    console.error(`  \x1b[31mFailed to fetch receipt: ${err.message}\x1b[0m`);
    process.exit(1);
  }

  const originStatus = receipt.status === '0x1' ? '\x1b[32mSUCCESS\x1b[0m' : '\x1b[31mFAILED\x1b[0m';
  console.log(`  Status:  ${originStatus}`);
  console.log(`  Block:   ${parseInt(receipt.blockNumber, 16)}`);
  console.log(`  Chain:   ${chainName(originChainId)} (${originChainId})`);

  const originLogs = decodeLogs(receipt.logs || []);
  console.log(`  Events:  ${originLogs.length}`);
  for (const log of originLogs) {
    console.log(`    \x1b[36m\u2022\x1b[0m ${log.name}`);
    if (log.args && !log.unknown) {
      const args = formatArgs(log.args);
      for (const [k, v] of Object.entries(args)) {
        const val = typeof v === 'string' && v.length > 60 ? v.slice(0, 60) + '...' : v;
        console.log(`      ${k}: \x1b[33m${val}\x1b[0m`);
      }
    }
  }

  // STEP 2: Find RC transaction
  console.log('\n  \x1b[1m\u2500\u2500 STEP 2: RC Observation \u2500\u2500\x1b[0m');
  console.log('  Scanning RC transactions...');

  const head = await rnkGetHeadNumber(rvmId, config.network);
  let rcTxFound = null;
  const scanLimit = 100;
  const batchSize = 20;

  for (let pos = head; pos > Math.max(0, head - scanLimit); pos -= batchSize) {
    const start = Math.max(1, pos - batchSize + 1);
    const count = pos - start + 1;
    const txs = await rnkGetTransactions(rvmId, start, count, config.network);
    if (!txs?.length) continue;

    for (const tx of txs) {
      const refTx = (tx.ref_tx || tx.refTx || tx.reference_tx || '').toLowerCase();
      if (refTx === txHash.toLowerCase()) {
        rcTxFound = tx;
        break;
      }
    }
    if (rcTxFound) break;
  }

  if (!rcTxFound) {
    console.log('  \x1b[31mRC transaction not found. The RC may not have observed this event.\x1b[0m');
    process.exit(1);
  }

  const rcTxNum = typeof rcTxFound.number === 'string' ? parseInt(rcTxFound.number, 16) : rcTxFound.number;
  const rcStatus = rcTxFound.status === '0x1' || rcTxFound.status === 1 ? '\x1b[32mSUCCESS\x1b[0m' : '\x1b[31mFAILED\x1b[0m';
  console.log(`  Found!   RC TX #${rcTxNum}`);
  console.log(`  Status:  ${rcStatus}`);
  if (rcTxFound.hash) console.log(`  Hash:    ${rcTxFound.hash}`);

  // STEP 3: RC Logs
  console.log('\n  \x1b[1m\u2500\u2500 STEP 3: RC Logs & Callbacks \u2500\u2500\x1b[0m');

  let rcLogs = [];
  try {
    rcLogs = await rnkGetTransactionLogs(rvmId, rcTxNum, config.network);
  } catch {}

  const decodedRcLogs = decodeLogs(rcLogs || []);
  console.log(`  Events:  ${decodedRcLogs.length}`);

  const callbacks = decodedRcLogs.filter(l => l.isCallback);
  console.log(`  Callbacks: ${callbacks.length}`);

  for (const log of decodedRcLogs) {
    const prefix = log.isCallback ? '\x1b[35m\u25B6\x1b[0m' : '\x1b[36m\u2022\x1b[0m';
    console.log(`    ${prefix} ${log.name}`);
    if (log.isCallback && log.callbackInfo) {
      const ci = log.callbackInfo;
      console.log(`      Chain:    ${chainName(ci.chainId)} (${ci.chainId})`);
      console.log(`      Contract: ${ci.contract}`);
      console.log(`      Function: \x1b[33m${ci.fnName || ci.selector}\x1b[0m`);
      console.log(`      Gas:      ${ci.gasLimit}`);
    }
  }

  // STEP 4: Callback Execution
  if (callbacks.length === 0) {
    console.log('\n  \x1b[33mNo callbacks to trace.\x1b[0m\n');
    return;
  }

  console.log('\n  \x1b[1m\u2500\u2500 STEP 4: Callback Execution \u2500\u2500\x1b[0m');

  for (const cb of callbacks) {
    const ci = cb.callbackInfo;
    const rnCid = rnChainId(config.network);

    if (ci.chainId === rnCid) {
      console.log(`  \x1b[33m[Self-Callback]\x1b[0m ${ci.fnName || ci.selector} \u2192 RC on RN`);
      continue;
    }

    console.log(`  Searching ${chainName(ci.chainId)} for callback execution...`);

    const destBlock = await ethBlockNumber(ci.chainId);
    const result = await findCallbackExecution(ci.chainId, ci.contract, Math.max(0, destBlock - 100));

    if (result.found) {
      const status = result.success ? '\x1b[32mSUCCESS\x1b[0m' : '\x1b[31mFAILED\x1b[0m';
      console.log(`  Status:  ${status}`);
      console.log(`  TX:      ${result.txHash}`);
      console.log(`  Block:   ${result.blockNumber}`);
      console.log(`  Gas:     ${result.gasUsed?.toLocaleString()}`);

      if (!result.success) {
        const reason = await getRevertReason(ci.chainId, result.txHash);
        if (reason) console.log(`  Revert:  \x1b[31m${reason}\x1b[0m`);
      }

      if (result.logs?.length) {
        console.log(`  Events:`);
        for (const log of result.logs) {
          console.log(`    \x1b[36m\u2022\x1b[0m ${log.name}`);
        }
      }
    } else {
      console.log('  \x1b[31mCallback execution not found.\x1b[0m');
      console.log('  It may not have been delivered yet, or the search window was too small.');
    }
  }

  console.log('');
}
