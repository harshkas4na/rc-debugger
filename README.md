# RC Debugger

Interactive debugger and real-time monitor for [Reactive Network](https://reactive.network) cross-chain flows. Traces the complete lifecycle of a reactive callback — from origin chain event, through RC observation on the ReactVM, to callback execution on the destination chain.

```
Origin Event ──▶ RC react() ──▶ Callback ──▶ Dest Execution
  Sepolia          ReactVM        emit CB      Base Sepolia
```

## Why

Debugging Reactive Network contracts is hard. An origin event fires on one chain, the RC processes it on the Reactive Network, and a callback executes on a completely different chain. If something breaks, you're left grepping block explorers across three chains. RC Debugger watches all three in real time and shows you exactly where a flow succeeded or failed — with decoded events, revert reasons, gas usage, and actionable hints.

## Features

- **Smart Diagnostics** — `diagnose` command checks 17 health indicators: RC balance, debt, contract deployment, subscriptions, callback proxy, topic validation, selector matching, and mainnet/testnet mixing
- **Pre-flight Checks** — `watch` automatically checks RC funding, debt, CC balance, and proxy config before starting the dashboard
- **Failure Hints** — When flows fail, the dashboard shows actionable causes (underfunded RC, wrong proxy, missing address param, ReactVM state isolation)
- **Live TUI Dashboard** — Reactscan-inspired dark theme with real-time flow tracking, subscription table, live balance display, and keyboard navigation
- **Auto-Discovery** — Point it at an RC address and it finds subscriptions, callback targets, and builds the flow graph automatically
- **Transaction Tracing** — One-off trace of any origin tx through the full RC pipeline
- **Self-Callback Chain Tracking** — Follows multi-hop self-callback chains (RC → RC → RC → Dest)
- **Cron Flow Support** — Detects and monitors cron-triggered reactive flows
- **CI Integration** — `assert` command waits for a flow completion and exits 0/1 for test pipelines
- **Revert Decoding** — Decodes `Error(string)` and `Panic(uint256)` revert reasons from failed callbacks
- **Shell Hooks** — Run commands on flow success/failure (Slack notifications, alerts, etc.)
- **Shareable Reports** — Export completed flow traces as self-contained HTML files

## Supported Chains

| Network | Chain ID | Callback Proxy |
|---------|----------|---------------|
| Reactive Mainnet | 1597 | `0x00...fffFfF` |
| Reactive Lasna (testnet) | 5318007 | `0x00...fffFfF` |
| Ethereum | 1 | `0x1D52...D76` |
| Base | 8453 | `0x0D3E...947` |
| Arbitrum | 42161 | `0x4730...42E` |
| Avalanche | 43114 | `0x934E...CDa` |
| Sepolia | 11155111 | `0xc9f3...bDA` |
| Base Sepolia | 84532 | `0xa6eA...5a6` |
| Optimism | 10 | — |
| Polygon | 137 | — |
| Arbitrum Sepolia | 421614 | — |

## Prerequisites

- **Node.js >= 18**
- A deployed **Reactive Contract (RC)** on Reactive Network
- A deployed **Callback Contract (CC)** on a destination chain

## Installation

```bash
git clone https://github.com/harshkas4na/rc-debugger rc-debugger
cd rc-debugger
npm install
```

To make `rc-debug` available globally:

```bash
npm link
```

## Quick Start

### 1. Initialize

```bash
rc-debug init --rc 0xYourReactiveContractAddress
```

Or run the interactive setup wizard:

```bash
rc-debug init
```

### 2. Diagnose

Run health checks before monitoring:

```bash
rc-debug diagnose
```

```
  // CONFIG
    v .rc-debug.json valid
    v Network: lasna (Reactive Lasna)

  // CONNECTIVITY
    v Reactive Lasna RPC (block 2,853,232)
    v Base Sepolia (84532) RPC (block 39,287,138)

  // FUNDING
    ! RC balance: 0.08588 REACT — low, may run out soon
    v RC debt: 0 REACT
    v CC balance: 1.00e-5 ETH on Base Sepolia

  // SUBSCRIPTIONS
    v 1 subscription(s) found for this RC
    v ACTIVE  Base Sepolia  Greet(address,string)  on 0x0000de...3886 [callback]

  // CALLBACKS
    v Callback Proxy for Base Sepolia: 0xa6eA49...
    v [DEST] 0x828fe5be → acknowledge(address,address,string) in CC ABI

  // LINKS
    v Reactscan: https://lasna.reactscan.net/address/0xccc2F2...
```

### 3. Watch

```bash
rc-debug watch
```

The dashboard runs pre-flight checks (balance, debt, proxy) before starting, then launches the TUI.

Log all traces to a JSONL file:

```bash
rc-debug watch --log traces.jsonl
```

### 4. Dashboard Navigation

| Key | Action |
|-----|--------|
| `Tab` / `Shift-Tab` | Cycle focus between Flows+Subs, Activity, Details panels |
| `Up` / `Down` | Scroll within focused panel |
| `Left` / `Right` | Cycle through flow nodes (Origin → RC → Callback → Dest) |
| `t` | Show full trace timeline for selected flow |
| `f` | Cycle filter: All → OK → Fail → Active |
| `d` | Run quick diagnostics (balance, debt, proxy) |
| `r` | Force refresh |
| `q` / `Ctrl-C` | Quit |

## Commands

### `rc-debug diagnose`

Run 17 health checks without starting the monitor. Checks config, RPC connectivity, contract deployment, RC balance/debt, CC balance, subscriptions, topic validation, callback proxy, selector matching, mainnet/testnet consistency, and recent origin events.

```bash
rc-debug diagnose
```

Exit code: `0` = all passed, `1` = failures found.

### `rc-debug watch`

Launch the real-time monitoring dashboard. Runs pre-flight diagnostics automatically.

```bash
rc-debug watch                   # TUI dashboard
rc-debug watch --log traces.jsonl # Log traces to JSONL file
```

### `rc-debug init`

Interactive setup that creates `.rc-debug.json`.

```bash
rc-debug init                    # Interactive wizard
rc-debug init --rc 0xABC...     # Auto-discovery from RC address
```

### `rc-debug trace --tx <hash>`

One-off trace of a specific origin transaction through the full flow pipeline.

```bash
rc-debug trace --tx 0x123abc...
```

### `rc-debug status`

Display current config, RVM ID, detected subscriptions, callback patterns, and flow graph without starting the monitor.

### `rc-debug add-flow`

Manually define a custom flow when auto-detection doesn't cover your use case.

### `rc-debug share`

Export a completed flow trace from history as a self-contained HTML file.

```bash
rc-debug share flow-0:0x123 trace.html
```

### `rc-debug assert`

CI mode — waits for a flow to complete and exits with a status code.

```bash
rc-debug assert --flow "Greet" --timeout 60 --json
rc-debug assert --expect-fail --timeout 30
```

| Flag | Description |
|------|-------------|
| `--flow NAME` | Match flow by name (substring match) |
| `--timeout SEC` | Max seconds to wait (default: 60) |
| `--expect-success` | Exit 0 if flow succeeds (default) |
| `--expect-fail` | Exit 0 if flow fails |
| `--json` | Output JSON for CI parsing |
| `--verbose`, `-v` | Show progress to stderr |

## Configuration

`rc-debug init` generates a `.rc-debug.json` file:

```json
{
  "network": "lasna",
  "contracts": {
    "rc":       { "address": "0x...", "chainId": 5318007, "abi": [...] },
    "origin":   { "address": "0x...", "chainId": 11155111, "abi": [...] },
    "callback": { "address": "0x...", "chainId": 84532, "abi": [...] }
  },
  "singleton": false,
  "customFlows": [],
  "pollInterval": 3000,
  "hooks": {
    "onSuccess": null,
    "onFailure": null
  }
}
```

### Shell Hooks

Hook commands receive environment variables: `RC_FLOW_NAME`, `RC_FLOW_STATUS`, `RC_FLOW_DURATION`, `RC_FAIL_REASON`.

```json
{
  "hooks": {
    "onFailure": "curl -X POST https://hooks.slack.com/... -d '{\"text\": \"Flow failed: $RC_FLOW_NAME\"}'",
    "onSuccess": "echo \"$RC_FLOW_NAME completed in ${RC_FLOW_DURATION}s\" >> flow.log"
  }
}
```

## Architecture

```
bin/rc-debug.js          CLI entry point

src/
├── commands/            CLI commands
│   ├── init.js          Interactive setup + auto-discovery
│   ├── watch.js         Pre-flight diagnostics + TUI launcher
│   ├── diagnose.js      17 health checks (balance, debt, subs, proxy, selectors)
│   ├── trace.js         One-off transaction trace
│   ├── status.js        Config and flow summary
│   ├── add-flow.js      Manual flow definition
│   ├── share.js         HTML report export
│   └── assert.js        CI integration
│
├── analysis/            Static analysis
│   ├── abi-parser.js    ABI loading, event/function extraction
│   ├── subscription.js  RN subscription querying (filtered by RC address)
│   └── flow-detector.js Combines ABI + subscriptions into flow graph
│
├── monitor/             Real-time monitoring
│   ├── orchestrator.js  Central state machine with failure hints
│   ├── origin-watcher.js  Polls origin chain for trigger events
│   ├── rc-watcher.js    Polls Reactive Network for RC transactions
│   ├── dest-watcher.js  Polls destination chain for callback execution
│   ├── failure-hints.js Failure pattern → actionable hint mapping
│   ├── flow-state.js    FlowInstance lifecycle (4-node state machine)
│   ├── stats.js         Aggregate metrics
│   ├── store.js         Persistent JSON history
│   ├── logger.js        JSONL trace logger
│   └── hooks.js         Shell command execution on flow events
│
├── lib/                 Core utilities
│   ├── chains.js        Chain registry, callback proxy addresses, RPC endpoints
│   ├── rpc.js           JSON-RPC (rnk_* + eth_* including getBalance/getCode)
│   ├── decoder.js       ABI-based event decoding via viem
│   ├── abi-resolver.js  ABI resolution: local artifacts → explorer → cache
│   └── config.js        .rc-debug.json management
│
└── ui/                  Terminal interface
    ├── dashboard.js     Blessed TUI (Reactscan dark theme, live balances)
    └── flow-graph.js    ASCII flow graph renderer
```

## Data Storage

| Path | Description |
|------|-------------|
| `.rc-debug.json` | Project config (gitignored) |
| `~/.rc-debug/abi-cache/` | Cached ABIs from block explorers |
| `~/.rc-debug/history/flows.json` | Persistent flow history (up to 500 entries) |

## License

GPL-2.0-or-later
