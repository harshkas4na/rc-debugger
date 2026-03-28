#!/usr/bin/env node

const [,, command, ...args] = process.argv;

const commands = {
  init:       () => import('../src/commands/init.js'),
  watch:      () => import('../src/commands/watch.js'),
  'add-flow': () => import('../src/commands/add-flow.js'),
  status:     () => import('../src/commands/status.js'),
  trace:      () => import('../src/commands/trace.js'),
  share:      () => import('../src/commands/share.js'),
  assert:     () => import('../src/commands/assert.js'),
  diagnose:   () => import('../src/commands/diagnose.js'),
};

if (!command || command === '--help' || command === '-h') {
  console.log(`
  rc-debug — Interactive debugger for Reactive Network flows

  Commands:
    init              Interactive setup — specify contracts manually
    watch             Launch live TUI dashboard
    watch --log FILE  Log all traces to JSONL file
    diagnose          Run health checks (config, RPC, balance, debt, subs)
    status            Show config + detected flows summary
    trace --tx HASH   One-off trace of a specific transaction
    add-flow          Add a custom flow pattern
    share [ID] [FILE] Export a flow trace as shareable HTML
    assert            CI mode — wait for flow, exit 0/1

  Assert flags:
    --flow NAME       Match flow by name (substring)
    --timeout SEC     Max seconds to wait (default: 60)
    --expect-success  Exit 0 if flow succeeds (default)
    --expect-fail     Exit 0 if flow fails
    --json            Output JSON for CI parsing
    --verbose         Show progress to stderr

  Examples:
    rc-debug init
    rc-debug diagnose
    rc-debug watch --log traces.jsonl
    rc-debug assert --flow Greet --timeout 30 --json
    rc-debug trace --tx 0x123...
`);
  process.exit(0);
}

if (!commands[command]) {
  console.error(`Unknown command: ${command}\nRun rc-debug --help for usage.`);
  process.exit(1);
}

try {
  const mod = await commands[command]();
  await mod.default(args);
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
