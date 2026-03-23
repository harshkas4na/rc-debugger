// Tier 4 #21: CI integration — watch for a flow and exit with status code
//
// Usage:
//   rc-debug assert --flow "Greet" --timeout 30
//   rc-debug assert --timeout 60 --expect-success
//   rc-debug assert --timeout 30 --expect-fail
//
// Exit codes:
//   0 = flow matched expected outcome
//   1 = flow did not match or timed out

import { loadConfig, validateConfig } from '../lib/config.js';
import { detectFlows } from '../analysis/flow-detector.js';
import { Orchestrator } from '../monitor/orchestrator.js';

export default async function assert(args) {
  // Parse flags
  const flowName = getFlag(args, '--flow');
  const timeout = parseInt(getFlag(args, '--timeout') || '60') * 1000;
  const expectFail = args.includes('--expect-fail');
  const expectSuccess = args.includes('--expect-success') || !expectFail;
  const verbose = args.includes('--verbose') || args.includes('-v');
  const json = args.includes('--json');

  const config = loadConfig();
  if (!config) {
    output({ error: 'No .rc-debug.json found' }, json);
    process.exit(1);
  }

  const errors = validateConfig(config);
  if (errors.length) {
    output({ error: errors.join(', ') }, json);
    process.exit(1);
  }

  if (verbose) console.error('  Detecting flows...');

  let detection;
  try {
    detection = await detectFlows(config, verbose ? (m) => console.error(`  ${m}`) : () => {});
  } catch (err) {
    output({ error: `Flow detection failed: ${err.message}` }, json);
    process.exit(1);
  }

  if (verbose) console.error(`  ${detection.flows.length} flow(s) detected. Waiting for match...`);

  const orchestrator = new Orchestrator(config, detection);
  await orchestrator.start();

  // Wait for a matching flow
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ matched: false, reason: 'timeout' });
    }, timeout);

    orchestrator.tracker.onChange(() => {
      const history = orchestrator.tracker.getHistory();
      for (const inst of history) {
        if (inst._assertChecked) continue;
        inst._assertChecked = true;

        // Check if flow name matches (if specified)
        if (flowName && !inst.flow.name.toLowerCase().includes(flowName.toLowerCase())) {
          continue;
        }

        clearTimeout(timer);
        resolve({
          matched: true,
          flow: inst.flow.name,
          success: !inst.failed,
          failed: inst.failed,
          failReason: inst.failReason,
          duration: inst.duration,
          hops: inst.hops.length,
        });
        return;
      }
    });
  });

  orchestrator.stop();

  if (!result.matched) {
    output({
      status: 'timeout',
      message: `No ${flowName ? `"${flowName}" ` : ''}flow completed within ${timeout / 1000}s`,
    }, json);
    process.exit(1);
  }

  const passed = expectSuccess ? result.success : result.failed;

  output({
    status: passed ? 'pass' : 'fail',
    flow: result.flow,
    success: result.success,
    duration: result.duration,
    failReason: result.failReason,
    hops: result.hops,
    expected: expectSuccess ? 'success' : 'failure',
  }, json);

  process.exit(passed ? 0 : 1);
}

function getFlag(args, flag) {
  if (!args) return null;
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] || null : null;
}

function output(data, asJson) {
  if (asJson) {
    console.log(JSON.stringify(data));
  } else {
    if (data.error) {
      console.error(`  \x1b[31m✗ ${data.error}\x1b[0m`);
      return;
    }
    const icon = data.status === 'pass' ? '\x1b[32m✓\x1b[0m' :
                 data.status === 'timeout' ? '\x1b[33m⏱\x1b[0m' : '\x1b[31m✗\x1b[0m';
    console.log(`  ${icon} ${data.status.toUpperCase()}: ${data.message || data.flow || ''}`);
    if (data.duration) console.log(`    Duration: ${data.duration}s`);
    if (data.failReason) console.log(`    Reason: \x1b[31m${data.failReason}\x1b[0m`);
    if (data.expected) console.log(`    Expected: ${data.expected} | Got: ${data.success ? 'success' : 'failure'}`);
  }
}
