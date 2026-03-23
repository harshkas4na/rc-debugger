# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**rc-debugger** is an interactive debugger and monitoring tool for Reactive Network cross-chain flows. It traces the complete lifecycle of reactive callbacks: origin chain event → Reactive Contract (RC) observation → callback execution on destination chain.

## Commands

```bash
# Run the live TUI dashboard
npm start                          # or: node bin/rc-debug.js watch

# Interactive setup (creates .rc-debug.json config)
npm run init                       # or: node bin/rc-debug.js init
node bin/rc-debug.js init --rc 0xABC...   # auto-discovery mode

# Other commands
node bin/rc-debug.js status        # show config + detected flows
node bin/rc-debug.js trace --tx HASH      # one-off transaction trace
node bin/rc-debug.js add-flow      # manually define a custom flow
node bin/rc-debug.js share [ID] [FILE]    # export flow as HTML
node bin/rc-debug.js assert --flow NAME --timeout 30 --json  # CI mode
node bin/rc-debug.js watch --web --port 4040  # web dashboard via SSE
```

No build step — pure ESM JavaScript (`"type": "module"`), requires Node >= 18.

## Architecture

### Data Flow (watch command)

```
OriginWatcher (polls origin chain for subscribed events)
        ↓ origin event detected
Orchestrator (central state machine, matches events across chains)
        ↓ matches refTx
RcWatcher (polls Reactive Network for new txs via rnk_* RPC)
        ↓ extracts Callback events
DestWatcher (two-phase: logs search then block scan on dest chain)
        ↓ callback execution found
FlowTracker → FlowStore (persist) / StatsTracker / Logger / HookRunner
        ↓
Dashboard (blessed TUI, 1s refresh) or WebServer (SSE stream)
```

### Source Layout

- **`src/lib/`** — Core utilities: chain registry (`chains.js`), JSON-RPC with retry/fallback (`rpc.js`), ABI decoding via viem (`decoder.js`), ABI auto-resolution from explorers + local artifacts (`abi-resolver.js`), config management (`config.js`)
- **`src/analysis/`** — Static analysis: ABI parsing (`abi-parser.js`), subscription querying via `rnk_getSubscribers()` (`subscription.js`), flow detection that orchestrates both into matched flows (`flow-detector.js`)
- **`src/monitor/`** — Real-time polling: three watchers (origin/RC/dest), orchestrator state machine, FlowInstance lifecycle (4 nodes: origin→rcWatch→callback→dest, each idle/waiting/progress/success/failed), persistent JSON store (`~/.rc-debug/history/flows.json`), JSONL logger, shell hook runner
- **`src/ui/`** — Blessed TUI dashboard with 4 panels + ASCII flow graph renderer. Keyboard: q=quit, ↑↓=select, ←→=cycle nodes, t=trace, f=filter
- **`src/web/`** — Lightweight HTTP server (no framework): SSE at `/api/stream`, REST at `/api/state`, `/api/history`, `/api/flow`
- **`src/commands/`** — CLI commands dispatched by `bin/rc-debug.js`
- **`bin/rc-debug.js`** — Entry point, dynamic imports for each command

### Key Patterns

- **Self-callback loops**: When callback targets the Reactive Network itself (chainId matches RN), orchestrator queues it as a pending self-callback and continues tracking hops
- **Two-phase destination search**: DestWatcher tries log filtering first (fast), falls back to block scanning for callback proxy transactions
- **ABI resolution chain**: local Foundry `out/` → Hardhat `artifacts/` → block explorer API → disk cache at `~/.rc-debug/abi-cache/`
- **Orchestrator flow matching**: Uses `topic0:chainId` composite keys for O(1) event-to-flow lookup
- **Subscription drift detection**: `watch` command re-checks subscriptions every 5 minutes

### Reactive Network Specifics

- Chain IDs: 5318007 (Lasna testnet), 1597 (mainnet)
- Custom RPC methods: `rnk_getHeadNumber()`, `rnk_getTransactions()`, `rnk_getSubscribers()`
- Callback event topic: `0x8dd725...` (system event emitted by RC on callback dispatch)
- Cron subscriptions identified by 5 specific topic hashes (every block through every 10k blocks)

### Configuration

`.rc-debug.json` in project root (gitignored). Defines network, contract addresses/ABIs, custom flows, poll interval, and shell hooks (`onSuccess`/`onFailure`).
