# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**rc-debugger** is an interactive debugger and monitoring tool for Reactive Network cross-chain flows. It traces the complete lifecycle of reactive callbacks: origin chain event → Reactive Contract (RC) observation → callback execution on destination chain.

## Commands

```bash
# Run the live TUI dashboard (runs pre-flight diagnostics first)
npm start                          # or: node bin/rc-debug.js watch

# Run health checks without starting the monitor
node bin/rc-debug.js diagnose

# Interactive setup (creates .rc-debug.json config)
npm run init                       # or: node bin/rc-debug.js init
node bin/rc-debug.js init --rc 0xABC...   # auto-discovery mode

# Other commands
node bin/rc-debug.js status        # show config + detected flows
node bin/rc-debug.js trace --tx HASH      # one-off transaction trace
node bin/rc-debug.js add-flow      # manually define a custom flow
node bin/rc-debug.js share [ID] [FILE]    # export flow as HTML
node bin/rc-debug.js assert --flow NAME --timeout 30 --json  # CI mode
```

No build step — pure ESM JavaScript (`"type": "module"`), requires Node >= 18.

## Architecture

### Data Flow (watch command)

```
Pre-flight diagnostics (quickDiagnose: RC balance, debt, CC balance, proxy)
        ↓
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
Dashboard (blessed TUI, Reactscan-inspired dark theme, 1s refresh)
```

### Source Layout

- **`src/lib/`** — Core utilities: chain registry with callback proxy addresses (`chains.js`), JSON-RPC with retry/fallback including `ethGetBalance`/`ethGetCode` (`rpc.js`), ABI decoding via viem (`decoder.js`), ABI auto-resolution from explorers + local artifacts (`abi-resolver.js`), config management (`config.js`)
- **`src/analysis/`** — Static analysis: ABI parsing (`abi-parser.js`), subscription querying filtered by RC address via `rnk_getSubscribers()` (`subscription.js`), flow detection that orchestrates both into matched flows (`flow-detector.js`)
- **`src/monitor/`** — Real-time polling: three watchers (origin/RC/dest), orchestrator state machine with failure hints (`failure-hints.js`), FlowInstance lifecycle (4 nodes: origin→rcWatch→callback→dest), persistent JSON store, JSONL logger, shell hook runner
- **`src/ui/`** — Blessed TUI dashboard (Reactscan dark theme, `//` section headers) with flow graph + subscription table + live balance/debt display. Keyboard: Tab=panel, ↑↓=scroll, ←→=node, t=trace, f=filter, d=diagnose, r=refresh, q=quit
- **`src/commands/`** — CLI commands dispatched by `bin/rc-debug.js`, including `diagnose.js` (17 health checks) and `watch.js` (pre-flight + TUI)
- **`bin/rc-debug.js`** — Entry point, dynamic imports for each command

### Key Patterns

- **Pre-flight diagnostics**: `watch` runs `quickDiagnose()` before starting the dashboard — checks RC balance, debt, CC balance, callback proxy
- **Failure hints**: `failure-hints.js` maps 6 failure patterns to actionable debugging advice, shown in the detail panel when flows fail
- **Self-callback loops**: When callback targets the Reactive Network itself (chainId matches RN), orchestrator queues it as a pending self-callback and continues tracking hops
- **Two-phase destination search**: DestWatcher tries log filtering first (fast), falls back to block scanning for callback proxy transactions
- **ABI resolution chain**: local Foundry `out/` → Hardhat `artifacts/` → block explorer API → disk cache at `~/.rc-debug/abi-cache/`
- **Orchestrator flow matching**: Uses `topic0:chainId` composite keys for O(1) event-to-flow lookup
- **Subscription filtering**: `fetchSubscriptions()` filters by RC address (via `rvmContract` field) to exclude other contracts sharing the same RVM
- **Live balance refresh**: Dashboard header refreshes RC balance, debt, and CC balance every 30 seconds

### Reactive Network Specifics

- Chain IDs: 5318007 (Lasna testnet), 1597 (mainnet)
- Custom RPC methods: `rnk_getHeadNumber()`, `rnk_getTransactions()`, `rnk_getSubscribers()`
- System contract: `0x0000000000000000000000000000000000fffFfF` (callback proxy + debt queries)
- Debt check: `debts(address)` selector `0x2ecd4e7d` on system contract
- Callback proxy addresses per chain stored in `chains.js` (Sepolia, Base Sepolia, Ethereum, Base, Arbitrum, Avalanche)
- Cron subscriptions identified by 5 specific topic hashes (every block through every 10k blocks)
- Mainnet/testnet mixing detection in diagnose command

### Configuration

`.rc-debug.json` in project root (gitignored). Defines network, contract addresses/ABIs, custom flows, poll interval, and shell hooks (`onSuccess`/`onFailure`).
