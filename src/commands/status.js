// Status command — show config, detected flows, and subscriptions without TUI

import { loadConfig, validateConfig } from '../lib/config.js';
import { detectFlows } from '../analysis/flow-detector.js';
import { renderFlowSummary } from '../ui/flow-graph.js';
import { chainName } from '../lib/chains.js';

export default async function status() {
  const config = loadConfig();
  if (!config) {
    console.error('  No .rc-debug.json found. Run \x1b[1mrc-debug init\x1b[0m first.');
    process.exit(1);
  }

  const errors = validateConfig(config);

  console.log('\n  \x1b[36m\x1b[1mRC Debugger \u2014 Status\x1b[0m\n');

  // Config summary
  console.log('  \x1b[1mConfig\x1b[0m');
  console.log(`    Network:     ${config.network}`);
  console.log(`    Singleton:   ${config.singleton ? 'yes' : 'no'}`);
  console.log(`    Poll:        ${config.pollInterval}ms`);
  console.log('');

  console.log('  \x1b[1mContracts\x1b[0m');
  for (const [role, c] of Object.entries(config.contracts)) {
    if (!c?.address) continue;
    const chain = c.chainId ? `${chainName(c.chainId)} (${c.chainId})` : 'N/A';
    console.log(`    ${role.padEnd(10)} ${c.address}  on ${chain}`);
    if (c.artifact) console.log(`${''.padEnd(15)}ABI: ${c.artifact}`);
  }

  if (errors.length) {
    console.log('');
    console.log('  \x1b[31mConfig Issues:\x1b[0m');
    for (const e of errors) console.log(`    \x1b[31m\u2717\x1b[0m ${e}`);
    process.exit(1);
  }

  // Detect flows
  console.log('\n  \x1b[90mAnalyzing...\x1b[0m\n');

  try {
    const detection = await detectFlows(config, (msg) => {
      process.stdout.write(`  \x1b[90m  ${msg}\x1b[0m\n`);
    });

    console.log('');
    console.log(`  \x1b[1mRVM ID\x1b[0m: ${detection.rvmId}`);

    // Subscriptions
    console.log(`\n  \x1b[1mSubscriptions\x1b[0m (${detection.subscriptions.length})`);
    for (const sub of detection.subscriptions) {
      const chain = chainName(sub.chainId);
      const type = sub.isCron ? `\x1b[35m[CRON ${sub.cronName}]\x1b[0m` : `\x1b[36m[EVENT]\x1b[0m`;
      const contract = sub.contract ? `${sub.contract.slice(0, 10)}...` : '???';
      const topic = sub.topic0 ? `${sub.topic0.slice(0, 18)}...` : '???';
      console.log(`    ${type} ${chain} | ${contract} | ${topic}`);
    }

    // Callback patterns
    if (detection.callbackPatterns.length) {
      console.log(`\n  \x1b[1mCallback Patterns\x1b[0m (${detection.callbackPatterns.length})`);
      for (const cb of detection.callbackPatterns) {
        const type = cb.isSelfCallback ? '\x1b[33m[SELF]\x1b[0m' : '\x1b[32m[DEST]\x1b[0m';
        const chain = chainName(cb.destChainId);
        console.log(`    ${type} \u2192 ${chain} (${cb.destChainId}) | ${cb.destContract.slice(0, 10)}... | sel: ${cb.selector} | seen: ${cb.count}x`);
      }
    }

    // Detected flows
    console.log(`\n  \x1b[1mDetected Flows\x1b[0m (${detection.flows.length})`);
    if (detection.flows.length) {
      const lines = renderFlowSummary(detection.flows);
      for (const line of lines) console.log(line);
    } else {
      console.log('    \x1b[90mNone detected. Use rc-debug add-flow to add manually.\x1b[0m');
    }

    // Custom flows
    if (config.customFlows?.length) {
      console.log(`\n  \x1b[1mCustom Flows\x1b[0m (${config.customFlows.length})`);
      for (const cf of config.customFlows) {
        console.log(`    \x1b[33m\u2022\x1b[0m ${cf.name}`);
      }
    }

  } catch (err) {
    console.error(`\n  \x1b[31mError: ${err.message}\x1b[0m`);
    process.exit(1);
  }

  console.log('');
}
