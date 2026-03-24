// Main blessed TUI dashboard

import blessed from 'blessed';
import { renderFlowGraph } from './flow-graph.js';
import { STATE } from '../monitor/flow-state.js';
import { chainName, chainExplorerTxUrl, rnChainId, SYSTEM_CONTRACTS } from '../lib/chains.js';
import { formatArgs } from '../lib/decoder.js';
import { ethGetBalance, ethCall } from '../lib/rpc.js';

export class Dashboard {
  constructor(config, detection, orchestrator, opts = {}) {
    this.config = config;
    this.detection = detection;
    this.orchestrator = orchestrator;
    this.tracker = orchestrator.tracker;
    this.stats = opts.stats || null;
    this.logger = opts.logger || null;
    this.selectedActivity = 0;
    this.selectedNode = null;
    this.filter = null; // Tier 3 #11: 'all' | 'ok' | 'fail' | 'active'

    // Live contract data (refreshed periodically)
    this._liveData = { rcBalance: null, rcDebt: null, ccBalance: null, subsStatus: null };
    this._refreshLiveData();
    this._liveInterval = setInterval(() => this._refreshLiveData(), 30000);

    this._createScreen();
    this._createWidgets();
    this._wireEvents();
  }

  _createScreen() {
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'RC Debugger',
      fullUnicode: true,
    });
  }

  _createWidgets() {
    // ─── Header (4 rows: title + stats + funding + subs) ─────
    this.header = blessed.box({
      parent: this.screen,
      top: 0, left: 0, width: '100%', height: 5,
      tags: true,
      style: { fg: 'white', bg: 'blue' },
    });

    // ─── Flow Graph Panel ────────────────────────────────────
    this.flowPanel = blessed.box({
      parent: this.screen,
      top: 5, left: 0, width: '100%', height: '35%-5',
      border: { type: 'line' }, tags: true,
      scrollable: true, alwaysScroll: true,
      scrollbar: { ch: '\u2588', style: { bg: 'grey' } },
      label: ' Flows & Subscriptions ',
      keys: true, vi: true, mouse: true,
      style: { border: { fg: 'cyan' }, label: { fg: 'cyan', bold: true } },
    });

    // ─── Activity Log ────────────────────────────────────────
    this.activityPanel = blessed.list({
      parent: this.screen,
      top: '35%', left: 0, width: '100%', height: '30%',
      border: { type: 'line' }, tags: true,
      scrollable: true, alwaysScroll: true,
      scrollbar: { ch: '\u2588', style: { bg: 'grey' } },
      label: ' Activity ',
      keys: true, vi: true, mouse: true,
      style: {
        border: { fg: 'yellow' }, label: { fg: 'yellow', bold: true },
        selected: { bg: 'grey', fg: 'white' }, item: { fg: 'white' },
      },
    });

    // ─── Detail Panel ────────────────────────────────────────
    this.detailPanel = blessed.box({
      parent: this.screen,
      top: '65%', left: 0, width: '100%', height: '35%-1',
      border: { type: 'line' }, tags: true,
      scrollable: true, alwaysScroll: true,
      scrollbar: { ch: '\u2588', style: { bg: 'grey' } },
      label: ' Details ',
      keys: true, vi: true, mouse: true,
      style: { border: { fg: 'green' }, label: { fg: 'green', bold: true } },
    });

    // ─── Status Bar ──────────────────────────────────────────
    this.statusBar = blessed.box({
      parent: this.screen,
      bottom: 0, left: 0, width: '100%', height: 1,
      tags: true,
      style: { fg: 'black', bg: 'white' },
    });
  }

  _wireEvents() {
    // Track focusable panels for Tab cycling
    this._panels = [this.flowPanel, this.activityPanel, this.detailPanel];
    this._panelIdx = 1; // start on activity

    this.screen.key(['q', 'C-c'], () => {
      this.orchestrator.stop();
      process.exit(0);
    });

    // Sync selectedActivity when user navigates the list with keyboard/mouse
    this.activityPanel.on('select item', (item, index) => {
      this.selectedActivity = index;
      this.selectedNode = 0;
      this._renderDetail();
      this.screen.render();
    });

    // Left/Right only cycle nodes when activity or detail panel is focused
    this.screen.key(['left'], () => {
      if (this.screen.focused === this.flowPanel) return;
      if (this.selectedNode === null) this.selectedNode = 0;
      else this.selectedNode = Math.max(0, this.selectedNode - 1);
      this._renderDetail();
      this.screen.render();
    });

    this.screen.key(['right'], () => {
      if (this.screen.focused === this.flowPanel) return;
      if (this.selectedNode === null) this.selectedNode = 0;
      else this.selectedNode = Math.min(3, this.selectedNode + 1);
      this._renderDetail();
      this.screen.render();
    });

    // Tab cycles through all three panels
    this.screen.key(['tab'], () => {
      this._panelIdx = (this._panelIdx + 1) % this._panels.length;
      this._panels[this._panelIdx].focus();
      this._updateFocusBorders();
      this._renderStatusBar();
      this.screen.render();
    });

    // Shift-Tab cycles backwards
    this.screen.key(['S-tab'], () => {
      this._panelIdx = (this._panelIdx + this._panels.length - 1) % this._panels.length;
      this._panels[this._panelIdx].focus();
      this._updateFocusBorders();
      this._renderStatusBar();
      this.screen.render();
    });

    this.screen.key(['r'], () => {
      this._renderAll();
    });

    // 't' to show full trace of selected flow
    this.screen.key(['t'], () => {
      const all = this._filteredInstances();
      const inst = all[this.selectedActivity];
      if (!inst) return;
      this._renderFullTrace(inst);
      this.screen.render();
    });

    // Tier 3 #11: 'f' to cycle filter (all → ok → fail → active → all)
    this.screen.key(['f'], () => {
      const filters = [null, 'ok', 'fail', 'active'];
      const idx = filters.indexOf(this.filter);
      this.filter = filters[(idx + 1) % filters.length];
      this.selectedActivity = 0;
      this.activityPanel.setLabel(
        this.filter ? ` Activity [${this.filter.toUpperCase()}] ` : ' Activity '
      );
      this._renderActivity();
      this._renderDetail();
      this.screen.render();
    });

    // 'd' to run quick diagnostics on current config
    this._diagnosing = false;
    this.screen.key(['d'], async () => {
      if (this._diagnosing) return;
      this._diagnosing = true;
      this.detailPanel.setContent('  {yellow-fg}Running diagnostics...{/yellow-fg}');
      this.screen.render();
      try {
        const { quickDiagnose } = await import('../commands/diagnose.js');
        const results = await quickDiagnose(this.config);
        const lines = ['  {bold}{cyan-fg}Quick Diagnostics{/cyan-fg}{/bold}', ''];
        for (const r of results) {
          const sym = r.status === 'pass' ? '{green-fg}\u2713{/green-fg}' :
                      r.status === 'warn' ? '{yellow-fg}\u26A0{/yellow-fg}' :
                      '{red-fg}\u2717{/red-fg}';
          lines.push(`  ${sym} ${r.detail}`);
        }
        if (results.length === 0) lines.push('  {grey-fg}No checks available (missing config){/grey-fg}');
        this.detailPanel.setContent(lines.join('\n'));
      } catch (err) {
        this.detailPanel.setContent(`  {red-fg}Diagnostics error: ${err.message}{/red-fg}`);
      }
      this._diagnosing = false;
      this.screen.render();
    });

    // Track focus changes from mouse clicks too
    for (let i = 0; i < this._panels.length; i++) {
      this._panels[i].on('focus', () => {
        this._panelIdx = i;
        this._updateFocusBorders();
        this._renderStatusBar();
        this.screen.render();
      });
    }

    this.tracker.onChange(() => {
      this._renderAll();
    });
  }

  _updateFocusBorders() {
    const colors = ['cyan', 'yellow', 'green'];
    for (let i = 0; i < this._panels.length; i++) {
      const isFocused = i === this._panelIdx;
      this._panels[i].style.border.fg = isFocused ? 'white' : colors[i];
      this._panels[i].style.border.bold = isFocused;
    }
  }

  _renderAll() {
    this._renderHeader();
    this._renderFlows();
    this._renderActivity();
    this._renderDetail();
    this.screen.render();
  }

  // ─── Live data refresh (balances, debt, subs) ─────────────

  async _refreshLiveData() {
    const rnCid = rnChainId(this.config.network);
    const rcAddr = this.config.contracts.rc?.address;
    const ccAddr = this.config.contracts.callback?.address;
    const ccChainId = this.config.contracts.callback?.chainId;

    // RC balance
    if (rcAddr) {
      try {
        const hex = await ethGetBalance(rnCid, rcAddr);
        this._liveData.rcBalance = Number(BigInt(hex || '0x0')) / 1e18;
      } catch { /* keep previous value */ }

      // RC debt
      try {
        const paddedAddr = rcAddr.slice(2).toLowerCase().padStart(64, '0');
        const data = '0x2ecd4e7d' + paddedAddr;
        const result = await ethCall(rnCid, { to: SYSTEM_CONTRACTS.callbackProxy, data }, 'latest');
        this._liveData.rcDebt = Number(BigInt(result || '0x0')) / 1e18;
      } catch { /* keep previous value */ }
    }

    // CC balance
    if (ccAddr && ccChainId) {
      try {
        const hex = await ethGetBalance(ccChainId, ccAddr);
        this._liveData.ccBalance = Number(BigInt(hex || '0x0')) / 1e18;
      } catch { /* keep previous value */ }
    }

    // Subscription count from detection
    const subs = this.detection.subscriptions || [];
    const activeSubs = subs.filter(s => !s.isCron && !s.isSystem);
    const cronSubs = subs.filter(s => s.isCron);
    this._liveData.subsStatus = { active: activeSubs.length, cron: cronSubs.length, total: subs.length };

    // Re-render header if screen exists
    if (this.screen) {
      this._renderHeader();
      this.screen.render();
    }
  }

  // ─── Header with stats ─────────────────────────────────────

  _renderHeader() {
    const net = this.config.network.toUpperCase();
    const rc = this.config.contracts.rc.address;
    const rcShort = rc ? `${rc.slice(0, 8)}...${rc.slice(-4)}` : '?';
    const flowCount = this.detection.flows.length;
    const active = this.tracker.getActive().length;
    const rcHealthy = this.orchestrator.rcWatcher.healthy;
    const healthDot = rcHealthy ? '{green-fg}\u25CF{/green-fg}' : '{red-fg}\u25CF{/red-fg}';

    let line1 = `  {bold}RC Debugger{/bold}  ` +
      `{cyan-fg}|{/cyan-fg} ${net} ` +
      `{cyan-fg}|{/cyan-fg} RC: ${rcShort} ` +
      `{cyan-fg}|{/cyan-fg} ${flowCount} flow(s) ` +
      `{cyan-fg}|{/cyan-fg} ${active} active ` +
      `{cyan-fg}|{/cyan-fg} ${healthDot} polling ${this.config.pollInterval / 1000}s`;

    // Line 2: Stats
    let line2 = '';
    if (this.stats) {
      const s = this.stats;
      const rateColor = s.successRate >= 90 ? 'green' : s.successRate >= 50 ? 'yellow' : 'red';
      line2 = `  {grey-fg}${s.totalFlows} traced | {${rateColor}-fg}${s.successRate}% success{/${rateColor}-fg}` +
        ` | avg ${s.avgDuration}s | last ${s.timeSinceLastFlow} | up ${s.uptime}{/grey-fg}`;
    }

    // Line 3: Funding + Subscriptions
    let line3 = '';
    const ld = this._liveData;
    if (ld.rcBalance !== null || ld.subsStatus) {
      const parts = [];

      // RC balance
      if (ld.rcBalance !== null) {
        const balStr = ld.rcBalance < 0.0001 ? ld.rcBalance.toExponential(1) : ld.rcBalance.toPrecision(4);
        const balColor = ld.rcBalance === 0 ? 'red' : ld.rcBalance < 0.1 ? 'yellow' : 'green';
        parts.push(`RC: {${balColor}-fg}${balStr} REACT{/${balColor}-fg}`);
      }

      // RC debt
      if (ld.rcDebt !== null && ld.rcDebt > 0) {
        parts.push(`{red-fg}debt: ${ld.rcDebt.toPrecision(3)} REACT{/red-fg}`);
      }

      // CC balance
      if (ld.ccBalance !== null) {
        const ccChain = chainName(this.config.contracts.callback?.chainId);
        const ccStr = ld.ccBalance === 0 ? '0' : ld.ccBalance < 0.0001 ? ld.ccBalance.toExponential(1) : ld.ccBalance.toPrecision(4);
        const ccColor = ld.ccBalance === 0 ? 'yellow' : 'green';
        parts.push(`CC: {${ccColor}-fg}${ccStr} ETH{/${ccColor}-fg} {grey-fg}(${ccChain}){/grey-fg}`);
      }

      // Subscriptions
      if (ld.subsStatus) {
        const ss = ld.subsStatus;
        const subParts = [];
        if (ss.active > 0) subParts.push(`{green-fg}${ss.active} event{/green-fg}`);
        if (ss.cron > 0) subParts.push(`{magenta-fg}${ss.cron} cron{/magenta-fg}`);
        if (subParts.length > 0) {
          parts.push(`subs: ${subParts.join('+')}`);
        } else {
          parts.push('{red-fg}subs: none{/red-fg}');
        }
      }

      line3 = `  ${parts.join('  {grey-fg}|{/grey-fg}  ')}`;
    }

    this.header.setContent(line1 + '\n' + line2 + '\n' + line3);
  }

  // ─── Flow Graph + Subscriptions ────────────────────────────

  _renderFlows() {
    const activeInstances = this.tracker.getActive();
    const lines = [];

    // ── Flows section ──
    for (const flow of this.detection.flows) {
      const activeInst = activeInstances.find(i => i.flow.id === flow.id);
      const flowLines = renderFlowGraph(flow, activeInst, this.config, this.detection.subscriptions);
      lines.push(...flowLines, '');
    }

    if (this.detection.flows.length === 0) {
      lines.push('{grey-fg}  No flows detected. Run rc-debug add-flow to add one.{/grey-fg}');
      lines.push('');
    }

    // ── Subscriptions section ──
    const subs = this.detection.subscriptions || [];
    if (subs.length > 0) {
      lines.push('  {bold}{underline}Subscriptions{/underline}{/bold}');
      lines.push('');

      // Build topic → event name map from contracts
      const topicNames = new Map();
      const contracts = this.detection.contracts;
      if (contracts) {
        for (const role of ['origin', 'callback', 'rc']) {
          const c = contracts[role];
          if (c?.topicMap) {
            for (const [topic, ev] of c.topicMap) {
              topicNames.set(topic, { name: ev.name, sig: ev.signature, role });
            }
          }
        }
      }

      // Contract address → role name map
      const addrRoles = new Map();
      for (const [role, c] of Object.entries(this.config.contracts)) {
        if (c?.address) addrRoles.set(c.address.toLowerCase(), role.toUpperCase());
      }

      for (const sub of subs) {
        const statusDot = '{green-fg}\u25CF{/green-fg}';
        const chain = chainName(sub.chainId);

        // Resolve event name from topic
        let eventLabel;
        if (sub.isCron) {
          eventLabel = `{magenta-fg}${sub.cronName}{/magenta-fg} {grey-fg}(cron){/grey-fg}`;
        } else {
          const known = topicNames.get(sub.topic0?.toLowerCase());
          if (known) {
            eventLabel = `{cyan-fg}${known.name}{/cyan-fg} {grey-fg}(${known.role}){/grey-fg}`;
          } else {
            eventLabel = `{grey-fg}${sub.topic0?.slice(0, 18)}...{/grey-fg}`;
          }
        }

        // Resolve contract name
        const contractRole = addrRoles.get(sub.contract?.toLowerCase());
        const contractLabel = contractRole
          ? `{yellow-fg}${sub.contract?.slice(0, 10)}...{/yellow-fg} {grey-fg}[${contractRole}]{/grey-fg}`
          : sub.contract ? `{grey-fg}${sub.contract?.slice(0, 10)}...{/grey-fg}` : '{grey-fg}any{/grey-fg}';

        lines.push(`  ${statusDot} ACTIVE  {white-fg}${chain.padEnd(14)}{/white-fg} ${eventLabel}`);
        lines.push(`             contract: ${contractLabel}  topic_0: {grey-fg}${sub.topic0?.slice(0, 22)}...{/grey-fg}`);
        lines.push('');
      }
    } else {
      lines.push('  {red-fg}No subscriptions found for this RC{/red-fg}');
    }

    this.flowPanel.setContent(lines.join('\n'));
  }

  // ─── Tier 3 #11: Filter helper ─────────────────────────────

  _filteredInstances() {
    const all = this.tracker.getAll();
    if (!this.filter) return all;
    return all.filter(inst => {
      if (this.filter === 'ok') return inst.completed && !inst.failed;
      if (this.filter === 'fail') return inst.failed;
      if (this.filter === 'active') return !inst.completed;
      return true;
    });
  }

  // ─── Activity Log ──────────────────────────────────────────

  _renderActivity() {
    const all = this._filteredInstances();
    const items = [];

    for (const inst of all) {
      const ts = new Date(inst.startTime).toLocaleTimeString();
      const nodeSymbols = Object.values(inst.nodes).map(n => {
        switch (n.state) {
          case STATE.SUCCESS:  return '{green-fg}\u25CF{/green-fg}';
          case STATE.FAILED:   return '{red-fg}\u25CF{/red-fg}';
          case STATE.PROGRESS: return '{yellow-fg}\u25D0{/yellow-fg}';
          default:             return '{grey-fg}\u25CB{/grey-fg}';
        }
      }).join('{grey-fg}\u2500\u25B6{/grey-fg}');

      let status;
      if (inst.failed) status = '{red-fg}\u2717 FAIL{/red-fg}';
      else if (inst.completed) status = '{green-fg}\u2713 OK{/green-fg}';
      else status = '{yellow-fg}\u2026 ..{/yellow-fg}';

      const hops = inst.hops.length > 0 ? ` {magenta-fg}[${inst.hops.length} hop]{/magenta-fg}` : '';
      items.push(`  ${ts}  ${status}  {bold}${inst.flow.name}{/bold}  ${nodeSymbols}${hops}  {grey-fg}(${inst.duration}s){/grey-fg}`);
    }

    if (items.length === 0) {
      items.push('  {grey-fg}Waiting for events... Trigger a transaction to see flows here.{/grey-fg}');
    }

    this.activityPanel.setItems(items);
  }

  // ─── Detail Panel (with Tier 2 #6: explorer links) ────────

  _renderDetail() {
    const all = this._filteredInstances();
    const inst = all[this.selectedActivity];

    if (!inst) {
      this.detailPanel.setContent('  {grey-fg}Select an activity entry. \u2190\u2192 cycle nodes. t=full trace{/grey-fg}');
      return;
    }

    const nodeKeys = ['origin', 'rcWatch', 'callback', 'dest'];
    const nodeIdx = this.selectedNode ?? 0;
    const nodeKey = nodeKeys[nodeIdx];
    const node = inst.nodes[nodeKey];
    const lines = [];

    // Node selector bar
    const selectorBar = nodeKeys.map((k, i) => {
      const n = inst.nodes[k];
      const symbol = n.state === STATE.SUCCESS ? '{green-fg}\u25CF{/green-fg}' :
                     n.state === STATE.FAILED ? '{red-fg}\u25CF{/red-fg}' :
                     n.state === STATE.PROGRESS ? '{yellow-fg}\u25D0{/yellow-fg}' :
                     '{grey-fg}\u25CB{/grey-fg}';
      return i === nodeIdx ? `{underline}${symbol} ${n.label}{/underline}` : `${symbol} ${n.label}`;
    }).join('   ');

    lines.push(`  ${selectorBar}`);
    lines.push('  ' + '\u2500'.repeat(60));

    if (!node.data) {
      lines.push('  {grey-fg}No data yet for this step.{/grey-fg}');
    } else {
      const data = node.data;

      if (nodeKey === 'origin') {
        if (data.type === 'cron') {
          lines.push('  {bold}Type:{/bold}    {magenta-fg}Cron trigger{/magenta-fg}');
          if (data.txNumber) lines.push(`  {bold}RC TX:{/bold}   #${data.txNumber}`);
        } else {
          lines.push(`  {bold}Chain:{/bold}    ${data.chainName || chainName(data.chainId) || '?'}`);
          if (data.txHash) {
            lines.push(`  {bold}TX:{/bold}      ${data.txHash}`);
            const url = chainExplorerTxUrl(data.chainId, data.txHash);
            if (url) lines.push(`  {bold}Explorer:{/bold} {blue-fg}${url}{/blue-fg}`);
          }
          if (data.blockNumber) lines.push(`  {bold}Block:{/bold}   ${data.blockNumber}`);
        }
      }

      if (nodeKey === 'rcWatch') {
        lines.push(`  {bold}TX #:{/bold}    ${data.txNumber}`);
        if (data.hash) lines.push(`  {bold}Hash:{/bold}    ${data.hash}`);
        if (data.gasUsed && data.gasLimit) {
          const pct = Math.round((data.gasUsed / data.gasLimit) * 100);
          const gasColor = pct >= 90 ? 'red' : pct >= 70 ? 'yellow' : 'green';
          lines.push(`  {bold}Gas:{/bold}     {${gasColor}-fg}${data.gasUsed.toLocaleString()} / ${data.gasLimit.toLocaleString()} (${pct}%){/${gasColor}-fg}`);
        }
        if (data.logs?.length) {
          lines.push(`  {bold}Events ({/bold}${data.logs.length}{bold}):{/bold}`);
          for (const log of data.logs.slice(0, 6)) {
            lines.push(`    {cyan-fg}\u2022{/cyan-fg} ${log.name || 'Unknown'}`);
            if (log.args && !log.unknown) {
              const args = formatArgs(log.args);
              for (const [k, v] of Object.entries(args).slice(0, 4)) {
                const val = typeof v === 'string' && v.length > 44 ? v.slice(0, 44) + '...' : v;
                lines.push(`      ${k}: {yellow-fg}${val}{/yellow-fg}`);
              }
            }
          }
        }
      }

      if (nodeKey === 'callback') {
        if (data.callbacks?.length) {
          lines.push(`  {bold}Callbacks ({/bold}${data.callbacks.length}{bold}):{/bold}`);
          for (const cb of data.callbacks) {
            const isSelf = cb.chainId === 5318007 || cb.chainId === 1597;
            const tag = isSelf ? '{magenta-fg}[SELF]{/magenta-fg}' : '{green-fg}[DEST]{/green-fg}';
            lines.push(`    ${tag} ${chainName(cb.chainId)} \u2192 {yellow-fg}${cb.fnName || cb.selector}{/yellow-fg}`);
            lines.push(`      Contract: ${cb.contract || 'N/A'} | Gas: ${cb.gasLimit || '?'}`);
          }
        }
        // Show hops
        if (inst.hops.length > 0) {
          lines.push(`  {bold}Hops ({/bold}${inst.hops.length}{bold}):{/bold}`);
          for (const hop of inst.hops) {
            const icon = hop.type === 'self-delivered' ? '{green-fg}\u2713{/green-fg}' : '{magenta-fg}\u25B6{/magenta-fg}';
            lines.push(`    ${icon} ${hop.type}: ${hop.fnName || hop.selector || ''}`);
          }
        }
      }

      if (nodeKey === 'dest') {
        if (data.success !== undefined) {
          lines.push(`  {bold}Status:{/bold}  ${data.success ? '{green-fg}SUCCESS{/green-fg}' : '{red-fg}FAILED{/red-fg}'}`);
        }
        if (data.selfCallbackOnly || data.selfCallbackComplete) {
          lines.push('  {bold}Type:{/bold}    Self-callback (state persistence on RN)');
        }
        if (data.observationOnly) {
          lines.push('  {bold}Type:{/bold}    Observation only (no callbacks emitted)');
        }
        if (data.chainName) lines.push(`  {bold}Chain:{/bold}   ${data.chainName}`);
        if (data.txHash) {
          lines.push(`  {bold}TX:{/bold}     ${data.txHash}`);
          const url = chainExplorerTxUrl(data.chainId, data.txHash);
          if (url) lines.push(`  {bold}Explorer:{/bold} {blue-fg}${url}{/blue-fg}`);
        }
        if (data.blockNumber) lines.push(`  {bold}Block:{/bold}  ${data.blockNumber}`);
        if (data.gasUsed) lines.push(`  {bold}Gas:{/bold}    ${data.gasUsed.toLocaleString()}`);
        if (data.revertReason) lines.push(`  {bold}Revert:{/bold} {red-fg}${data.revertReason}{/red-fg}`);
        if (data.logs?.length) {
          lines.push(`  {bold}Events ({/bold}${data.logs.length}{bold}):{/bold}`);
          for (const log of data.logs.slice(0, 5)) {
            lines.push(`    {cyan-fg}\u2022{/cyan-fg} ${log.name || 'Unknown'}`);
          }
        }
        if (data.error) lines.push(`  {red-fg}Error: ${data.error}{/red-fg}`);
      }
    }

    if (inst.failReason) {
      lines.push('');
      lines.push(`  {red-fg}{bold}Failure:{/bold} ${inst.failReason}{/red-fg}`);
      if (inst.failHint) {
        lines.push('');
        lines.push('  {yellow-fg}{bold}Hints:{/bold}');
        for (const h of inst.failHint.split('\n')) {
          lines.push(`  ${h}`);
        }
        lines.push('{/yellow-fg}');
      }
    }

    this.detailPanel.setContent(lines.join('\n'));
  }

  // ─── Full trace view (press 't') with Tier 3 #12 timeline ──

  _renderFullTrace(inst) {
    const lines = [];
    lines.push(`  {bold}{cyan-fg}Full Trace: ${inst.flow.name}{/cyan-fg}{/bold}`);
    lines.push(`  Duration: ${inst.duration}s | ${inst.completed ? (inst.failed ? '{red-fg}FAILED{/red-fg}' : '{green-fg}SUCCESS{/green-fg}') : '{yellow-fg}IN PROGRESS{/yellow-fg}'}`);
    lines.push('  ' + '\u2500'.repeat(60));

    // Tier 3 #12: Timeline with relative timestamps
    const t0 = inst.startTime;
    const nodeKeys = ['origin', 'rcWatch', 'callback', 'dest'];
    const labels = ['Origin Event', 'RC react()', 'Callback Emit', 'Dest Execution'];
    let prevTime = t0;

    for (let i = 0; i < nodeKeys.length; i++) {
      const node = inst.nodes[nodeKeys[i]];
      const symbol = node.state === STATE.SUCCESS ? '{green-fg}\u25CF{/green-fg}' :
                     node.state === STATE.FAILED ? '{red-fg}\u25CF{/red-fg}' :
                     node.state === STATE.PROGRESS ? '{yellow-fg}\u25D0{/yellow-fg}' :
                     '{grey-fg}\u25CB{/grey-fg}';

      // Tier 3 #12: Time offset from start
      const offset = node._timestamp ? `+${((node._timestamp - t0) / 1000).toFixed(1)}s` : '';
      const delta = node._timestamp && prevTime ? `{grey-fg}(\u0394 ${((node._timestamp - prevTime) / 1000).toFixed(1)}s){/grey-fg}` : '';
      if (node._timestamp) prevTime = node._timestamp;

      let detail = '';
      if (node.data) {
        if (node.data.txHash) detail = ` tx:${node.data.txHash.slice(0, 14)}...`;
        else if (node.data.hash) detail = ` tx:${node.data.hash.slice(0, 14)}...`;
        else if (node.data.txNumber) detail = ` rc#${node.data.txNumber}`;
        if (node.data.type === 'cron') detail = ' (cron tick)';

        // Tier 3 #13: Gas analysis
        if (node.data.gasUsed && node.data.gasLimit) {
          const pct = Math.round((node.data.gasUsed / node.data.gasLimit) * 100);
          const gasColor = pct >= 90 ? 'red' : pct >= 70 ? 'yellow' : 'green';
          detail += ` {${gasColor}-fg}gas:${pct}%{/${gasColor}-fg}`;
        } else if (node.data.gasUsed) {
          detail += ` gas:${node.data.gasUsed.toLocaleString()}`;
        }

        if (node.data.revertReason) detail += ` {red-fg}revert: ${node.data.revertReason}{/red-fg}`;

        if (node.data.txHash && node.data.chainId) {
          const url = chainExplorerTxUrl(node.data.chainId, node.data.txHash);
          if (url) detail += `\n           {blue-fg}${url}{/blue-fg}`;
        }
      }

      const timeStr = offset ? `{cyan-fg}${offset.padEnd(6)}{/cyan-fg} ` : '       ';
      lines.push(`  ${timeStr}${symbol} ${labels[i]}${detail} ${delta}`);
      if (i < nodeKeys.length - 1) {
        lines.push('         {grey-fg}\u2502{/grey-fg}');
      }
    }

    // Hops
    if (inst.hops.length > 0) {
      lines.push('');
      lines.push(`  {bold}Self-Callback Chain ({/bold}${inst.hops.length} hop(s){bold}):{/bold}`);
      for (const hop of inst.hops) {
        const icon = hop.type === 'self-delivered' ? '{green-fg}\u2713{/green-fg}' : '{magenta-fg}\u25B6{/magenta-fg}';
        lines.push(`    ${icon} ${hop.type}: ${hop.fnName || hop.selector || ''}`);
      }
    }

    if (inst.failReason) {
      lines.push('');
      lines.push(`  {red-fg}{bold}Failure:{/bold} ${inst.failReason}{/red-fg}`);
      if (inst.failHint) {
        lines.push('');
        lines.push('  {yellow-fg}{bold}Hints:{/bold}');
        for (const h of inst.failHint.split('\n')) {
          lines.push(`  ${h}`);
        }
        lines.push('{/yellow-fg}');
      }
    }

    this.detailPanel.setContent(lines.join('\n'));
  }

  // ─── Status Bar ────────────────────────────────────────────

  _renderStatusBar() {
    const logInfo = this.logger ? ` | log: ${this.logger.filePath}` : '';
    const filterInfo = this.filter ? ` | filter: ${this.filter}` : '';
    const panelNames = ['Flows+Subs', 'Activity', 'Details'];
    const focusInfo = ` [{bold}${panelNames[this._panelIdx]}{/bold}]`;
    this.statusBar.setContent(
      ' {bold}Tab{/bold}:Panel  {bold}\u2191\u2193{/bold}:Scroll  {bold}\u2190\u2192{/bold}:Node  {bold}t{/bold}:Trace  {bold}f{/bold}:Filter  {bold}d{/bold}:Diagnose  {bold}r{/bold}:Refresh  {bold}q{/bold}:Quit' + filterInfo + logInfo + focusInfo
    );
  }

  render() {
    this._renderHeader();
    this._renderFlows();
    this._renderActivity();
    this._renderDetail();
    this._renderStatusBar();
    this._panels[this._panelIdx].focus();
    this._updateFocusBorders();
    this.screen.render();
  }

  destroy() {
    if (this._liveInterval) clearInterval(this._liveInterval);
    this.screen.destroy();
  }
}
