# RC Debugger

Interactive debugger and real-time monitor for [Reactive Network](https://reactive.network) cross-chain flows. Traces the complete lifecycle of a reactive callback — from origin chain event, through RC observation on the ReactVM, to callback execution on the destination chain.

```
Origin Event ───▶ RC react() ───▶ Callback Emit ───▶ Dest Execution
  Sepolia            ReactVM          emit CB           Base Sepolia
```

## Why

Debugging Reactive Network contracts is hard. An origin event fires on one chain, the RC processes it on the Reactive Network, and a callback executes on a completely different chain. If something breaks, you're left grepping block explorers across three chains. RC Debugger watches all three in real time and shows you exactly where a flow succeeded or failed — with decoded events, revert reasons, gas usage, and explorer links.

## Features

- **Live TUI Dashboard** — 4-panel blessed terminal UI with real-time flow tracking, node-by-node status, and keyboard navigation
- **Web Dashboard** — Browser-based alternative with Server-Sent Events for live updates
- **Auto-Discovery** — Point it at an RC address and it finds subscriptions, callback targets, and builds the flow graph automatically
- **Transaction Tracing** — One-off trace of any origin tx through the full RC pipeline
- **Self-Callback Chain Tracking** — Follows multi-hop self-callback chains (RC → RC → RC → Dest)
- **Cron Flow Support** — Detects and monitors cron-triggered reactive flows (every block, 10, 100, 1000, 10000 blocks)
- **CI Integration** — `assert` command waits for a flow completion and exits 0/1 for use in test pipelines
- **Revert Decoding** — Decodes `Error(string)` and `Panic(uint256)` revert reasons from failed callbacks
- **Shell Hooks** — Run commands on flow success/failure (Slack notifications, alerts, etc.)
- **Shareable Reports** — Export completed flow traces as self-contained HTML files

## Supported Chains

| Network | Chain ID | Type |
|---------|----------|------|
| Reactive Mainnet | 1597 | Reactive Network |
| Reactive Lasna (testnet) | 5318007 | Reactive Network |
| Ethereum | 1 | Mainnet |
| Base | 8453 | Mainnet |
| Arbitrum | 42161 | Mainnet |
| Optimism | 10 | Mainnet |
| Polygon | 137 | Mainnet |
| Avalanche | 43114 | Mainnet |
| Sepolia | 11155111 | Testnet |
| Base Sepolia | 84532 | Testnet |
| Arbitrum Sepolia | 421614 | Testnet |

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

Auto-discovery mode (recommended) — provide your RC address and the tool discovers subscriptions, callback targets, and ABIs:

```bash
rc-debug init --rc 0xYourReactiveContractAddress
```

Or run the interactive setup wizard:

```bash
rc-debug init
```

This creates a `.rc-debug.json` config file in your project directory. The wizard will:
- Ask for your network (Lasna testnet or Reactive mainnet)
- Resolve the RVM ID from your RC address
- Fetch active subscriptions from the Reactive Network
- Discover callback targets from recent RC transactions
- Resolve ABIs from local Foundry/Hardhat artifacts or block explorers
- Validate all contracts are reachable on-chain

### 2. Watch

Launch the live terminal dashboard:

```bash
rc-debug watch
```

Or the web dashboard:

```bash
rc-debug watch --web
rc-debug watch --web --port 8080
```

Log all traces to a JSONL file:

```bash
rc-debug watch --log traces.jsonl
```

### 3. Dashboard Navigation

| Key | Action |
|-----|--------|
| `Tab` / `Shift-Tab` | Cycle focus between Flows, Activity, Details panels |
| `Up` / `Down` | Scroll within focused panel |
| `Left` / `Right` | Cycle through flow nodes (Origin → RC → Callback → Dest) |
| `t` | Show full trace timeline for selected flow |
| `f` | Cycle filter: All → OK → Fail → Active |
| `r` | Force refresh |
| `q` / `Ctrl-C` | Quit |

## Commands

### `rc-debug init`

Interactive setup that creates `.rc-debug.json`.

```bash
rc-debug init                    # Interactive wizard
rc-debug init --rc 0xABC...     # Auto-discovery from RC address
```

### `rc-debug watch`

Launch the real-time monitoring dashboard.

```bash
rc-debug watch                   # TUI dashboard
rc-debug watch --web             # Web dashboard (default port 4040)
rc-debug watch --port 8080       # Custom web port
rc-debug watch --log traces.jsonl # Log traces to JSONL file
```

### `rc-debug trace --tx <hash>`

One-off trace of a specific origin transaction through the full flow pipeline. Shows each step: origin event, RC observation, callback emission, and destination execution.

```bash
rc-debug trace --tx 0x123abc...
```

### `rc-debug status`

Display current config, RVM ID, detected subscriptions, callback patterns, and flow graph without starting the monitor.

```bash
rc-debug status
```

### `rc-debug add-flow`

Manually define a custom flow when auto-detection doesn't cover your use case.

```bash
rc-debug add-flow
```

### `rc-debug share`

Export a completed flow trace from history as a self-contained HTML file.

```bash
rc-debug share                           # List recent flows
rc-debug share flow-0:0x123 trace.html   # Export specific flow
```

### `rc-debug assert`

CI mode — waits for a flow to complete and exits with a status code. Designed for use in test pipelines.

```bash
# Wait up to 30s for any flow, expect success
rc-debug assert --timeout 30

# Wait for a specific flow, output JSON
rc-debug assert --flow "Greet" --timeout 60 --json

# Expect failure (e.g., testing revert scenarios)
rc-debug assert --flow "BadCall" --expect-fail --timeout 30

# Verbose mode (progress to stderr)
rc-debug assert --flow "Transfer" --timeout 30 --json --verbose
```

| Flag | Description |
|------|-------------|
| `--flow NAME` | Match flow by name (substring match) |
| `--timeout SEC` | Max seconds to wait (default: 60) |
| `--expect-success` | Exit 0 if flow succeeds (default) |
| `--expect-fail` | Exit 0 if flow fails |
| `--json` | Output JSON for CI parsing |
| `--verbose`, `-v` | Show progress to stderr |

Exit codes: `0` = matched expected outcome, `1` = mismatch or timeout.

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

| Field | Description |
|-------|-------------|
| `network` | `"lasna"` (testnet) or `"mainnet"` |
| `contracts.rc` | Reactive Contract on Reactive Network |
| `contracts.origin` | Contract on origin chain that emits trigger events |
| `contracts.callback` | Callback Contract on destination chain |
| `singleton` | `true` if origin and callback are the same contract on the same chain |
| `customFlows` | Manually defined flows (from `add-flow`) |
| `pollInterval` | Polling interval in ms (default: 3000) |
| `hooks.onSuccess` | Shell command to run on flow success |
| `hooks.onFailure` | Shell command to run on flow failure |

### Shell Hooks

Hook commands receive environment variables:

| Variable | Description |
|----------|-------------|
| `RC_FLOW_NAME` | Name of the completed flow |
| `RC_FLOW_STATUS` | `"success"` or `"failure"` |
| `RC_FLOW_DURATION` | Duration in seconds |
| `RC_FAIL_REASON` | Failure reason (if failed) |

Example:

```json
{
  "hooks": {
    "onFailure": "curl -X POST https://hooks.slack.com/... -d '{\"text\": \"Flow failed: $RC_FLOW_NAME — $RC_FAIL_REASON\"}'",
    "onSuccess": "echo \"$RC_FLOW_NAME completed in ${RC_FLOW_DURATION}s\" >> flow.log"
  }
}
```

## Architecture

```
bin/rc-debug.js          CLI entry point — dispatches to command handlers

src/
├── commands/            CLI command implementations
│   ├── init.js          Interactive setup + auto-discovery
│   ├── watch.js         Dashboard launcher (TUI + web modes)
│   ├── trace.js         One-off transaction trace
│   ├── status.js        Config and flow summary
│   ├── add-flow.js      Manual flow definition
│   ├── share.js         HTML report export
│   └── assert.js        CI integration
│
├── analysis/            Static analysis and detection
│   ├── abi-parser.js    ABI loading, event/function extraction
│   ├── subscription.js  RN subscription querying (rnk_getSubscribers)
│   └── flow-detector.js Combines ABI + subscriptions into flow graph
│
├── monitor/             Real-time polling and state tracking
│   ├── orchestrator.js  Central state machine — matches events across chains
│   ├── origin-watcher.js  Polls origin chain for trigger events
│   ├── rc-watcher.js    Polls Reactive Network for RC transactions
│   ├── dest-watcher.js  Polls destination chain for callback execution
│   ├── flow-state.js    FlowInstance lifecycle (4-node state machine)
│   ├── stats.js         Aggregate metrics (success rate, avg duration)
│   ├── store.js         Persistent JSON history (~/.rc-debug/history/)
│   ├── logger.js        JSONL trace logger
│   └── hooks.js         Shell command execution on flow events
│
├── lib/                 Core utilities
│   ├── chains.js        Chain registry, RPC endpoints, explorer URLs
│   ├── rpc.js           JSON-RPC with retry/fallback for rnk_* and eth_*
│   ├── decoder.js       ABI-based event decoding via viem
│   ├── abi-resolver.js  ABI resolution: local artifacts → explorer → cache
│   └── config.js        .rc-debug.json management
│
├── ui/                  Terminal interface
│   ├── dashboard.js     Blessed TUI (4 panels + keyboard navigation)
│   └── flow-graph.js    ASCII flow graph renderer
│
└── web/                 Web interface
    └── server.js        HTTP server with SSE streaming
```

### How Monitoring Works

1. **OriginWatcher** polls origin chain(s) for events matching subscribed topics via `eth_getLogs`
2. **RcWatcher** polls Reactive Network for new RC transactions via `rnk_getHeadNumber` + `rnk_getTransactions`
3. **Orchestrator** matches origin events to RC transactions by `refTx`, then extracts `Callback` events from RC logs
4. **DestWatcher** searches the destination chain for callback execution (two-phase: log search, then block scan fallback)
5. **FlowTracker** manages the state machine for each flow instance through 4 nodes: `Origin → RC → Callback → Dest`

Self-callback chains (RC emitting callbacks targeting itself) are tracked as hops and followed until a destination callback or completion.

## Web API

When running with `--web`, the server exposes:

| Endpoint | Description |
|----------|-------------|
| `GET /` | HTML dashboard |
| `GET /api/stream` | Server-Sent Events (real-time updates) |
| `GET /api/state` | Current monitoring state as JSON |
| `GET /api/history?limit=N&offset=N` | Paginated flow history |
| `GET /api/flow?id=FLOW_ID` | Single flow details |

## Data Storage

| Path | Description |
|------|-------------|
| `.rc-debug.json` | Project config (gitignored) |
| `~/.rc-debug/abi-cache/` | Cached ABIs from block explorers |
| `~/.rc-debug/history/flows.json` | Persistent flow history (up to 500 entries) |

## License

GPL-2.0-or-later
