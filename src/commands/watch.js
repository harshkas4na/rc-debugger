// Main watch command — launch the interactive TUI dashboard
// Supports:
//   --log <file>  JSON trace persistence (JSONL)
//   --web         Launch web dashboard instead of TUI (port 4040)
//   --port <N>    Custom web server port

import { loadConfig, validateConfig } from '../lib/config.js';
import { detectFlows } from '../analysis/flow-detector.js';
import { Orchestrator } from '../monitor/orchestrator.js';
import { Dashboard } from '../ui/dashboard.js';
import { StatsTracker } from '../monitor/stats.js';
import { FlowLogger } from '../monitor/logger.js';
import { FlowStore } from '../monitor/store.js';
import { HookRunner } from '../monitor/hooks.js';
import { fetchSubscriptions } from '../analysis/subscription.js';

export default async function watch(args) {
  const config = loadConfig();
  if (!config) {
    console.error('  No .rc-debug.json found. Run \x1b[1mrc-debug init\x1b[0m first.');
    process.exit(1);
  }

  const errors = validateConfig(config);
  if (errors.length) {
    console.error('  Config errors:');
    for (const e of errors) console.error(`    \x1b[31m\u2717\x1b[0m ${e}`);
    process.exit(1);
  }

  // Parse flags
  const logFile = getFlag(args, '--log');
  const webMode = args?.includes('--web');
  const webPort = parseInt(getFlag(args, '--port') || '4040');

  console.log('\n  \x1b[36m\x1b[1mRC Debugger\x1b[0m \u2014 Analyzing...\n');

  let detection;
  try {
    detection = await detectFlows(config, (msg) => {
      process.stdout.write(`  \x1b[90m\u25B6 ${msg}\x1b[0m\n`);
    });
  } catch (err) {
    console.error(`\n  \x1b[31mFailed to detect flows: ${err.message}\x1b[0m`);
    process.exit(1);
  }

  if (detection.flows.length === 0) {
    console.log('  \x1b[33mNo flows detected.\x1b[0m Use \x1b[1mrc-debug add-flow\x1b[0m to add manually.');
    console.log('  Starting anyway...\n');
  }

  // Create all trackers
  const stats = new StatsTracker();
  const store = new FlowStore();   // Tier 4 #18: persistent storage
  const hooks = new HookRunner(config.hooks);
  let logger = null;
  if (logFile) {
    try { logger = new FlowLogger(logFile); console.log(`  \x1b[90mLogging to ${logFile}\x1b[0m`); }
    catch (err) { console.error(`  \x1b[33m\u26A0 Log file error: ${err.message}\x1b[0m`); }
  }

  // Create orchestrator
  const orchestrator = new Orchestrator(config, detection);

  // Wire all plugins into tracker
  orchestrator.tracker.onChange(() => {
    const history = orchestrator.tracker.getHistory();
    for (const inst of history) {
      if (inst._recorded) continue;
      inst._recorded = true;
      stats.record(inst);
      store.add(inst);          // Tier 4 #18: persist
      if (logger) logger.log(inst);
      hooks.onFlowComplete(inst);
    }
  });

  // Start monitoring
  await orchestrator.start();

  // ─── Web mode (Tier 4 #19) ─────────────────────────────────
  if (webMode) {
    const { WebServer } = await import('../web/server.js');
    const web = new WebServer(orchestrator, detection, store, stats, webPort);
    web.start();
    console.log(`\n  \x1b[32m\x1b[1mWeb dashboard running at http://localhost:${webPort}\x1b[0m`);
    console.log('  Press Ctrl+C to stop.\n');

    process.on('SIGINT', () => {
      orchestrator.stop();
      web.stop();
      store.stop();
      process.exit(0);
    });
    return;
  }

  // ─── TUI mode (default) ────────────────────────────────────
  const dashboard = new Dashboard(config, detection, orchestrator, { stats, logger });
  dashboard.render();

  // Periodic refresh
  setInterval(() => {
    dashboard._renderHeader();
    dashboard._renderFlows();
    dashboard.screen.render();
  }, 1000);

  // Subscription drift detection (every 5 min)
  if (detection.rvmId) {
    let prevSubIds = new Set(detection.subscriptions.map(s => `${s.chainId}:${s.contract}:${s.topic0}`));

    setInterval(async () => {
      try {
        const currentSubs = await fetchSubscriptions(detection.rvmId, config.network, config.contracts.rc?.address);
        const currSubIds = new Set(currentSubs.map(s => `${s.chainId}:${s.contract}:${s.topic0}`));
        const added = [...currSubIds].filter(id => !prevSubIds.has(id));
        const removed = [...prevSubIds].filter(id => !currSubIds.has(id));

        if (added.length > 0 || removed.length > 0) {
          detection.subscriptions = currentSubs;
          const ts = new Date().toLocaleTimeString();
          if (added.length > 0) dashboard.activityPanel.addItem(`  ${ts}  {green-fg}\u2795 ${added.length} sub(s) added{/green-fg}`);
          if (removed.length > 0) dashboard.activityPanel.addItem(`  ${ts}  {red-fg}\u2796 ${removed.length} sub(s) removed{/red-fg}`);
          prevSubIds = currSubIds;
          dashboard.screen.render();
        }
      } catch {}
    }, 300000);
  }

  // Clean shutdown
  process.on('SIGINT', () => {
    orchestrator.stop();
    store.stop();
    dashboard.destroy();
    process.exit(0);
  });
}

function getFlag(args, flag) {
  if (!args) return null;
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] || null : null;
}
