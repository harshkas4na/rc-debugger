// Main blessed TUI dashboard — Reactscan-inspired dark theme

import blessed from 'blessed';
import { renderFlowGraph } from './flow-graph.js';
import { STATE } from '../monitor/flow-state.js';
import { chainName, chainExplorerTxUrl, rnChainId, SYSTEM_CONTRACTS } from '../lib/chains.js';
import { formatArgs } from '../lib/decoder.js';
import { ethGetBalance, ethCall } from '../lib/rpc.js';

// ─── Spinner frames for TUI ─────────────────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ─── Theme constants ────────────────────────────────────────────────────────

const THEME = {
  bg: 'black',
  fg: '#aaaaaa',
  border: '#444444',
  borderFocus: '#888888',
  accent: '#00cc66',     // green for success/active
  warn: '#ccaa00',       // yellow
  fail: '#cc3333',       // red
  muted: '#666666',      // grey for secondary text
  label: '#888888',
  header: '#111111',
  statusBg: '#1a1a1a',
  sectionHeader: '#888888',
};

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
    this.filter = null;

    // Live contract data (refreshed periodically)
    this._liveData = { rcBalance: null, rcDebt: null, ccBalance: null, subsStatus: null };
    this._liveRefreshing = false;
    this._spinnerTick = 0;
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
    // ─── Header ─────────────────────────────────────────────
    this.header = blessed.box({
      parent: this.screen,
      top: 0, left: 0, width: '100%', height: 5,
      tags: true,
      style: { fg: 'white', bg: THEME.header },
    });

    // ─── Flows & Subscriptions (top panel) ──────────────────
    this.flowPanel = blessed.box({
      parent: this.screen,
      top: 5, left: 0, width: '100%', height: '35%-5',
      border: { type: 'line' }, tags: true,
      scrollable: true, alwaysScroll: true,
      scrollbar: { ch: '\u2588', style: { bg: THEME.muted } },
      label: ' // FLOWS & SUBSCRIPTIONS ',
      keys: true, vi: true, mouse: true,
      style: {
        bg: THEME.bg, fg: THEME.fg,
        border: { fg: THEME.border },
        label: { fg: THEME.sectionHeader, bold: true },
      },
    });

    // ─── Activity Log (middle panel) ────────────────────────
    this.activityPanel = blessed.list({
      parent: this.screen,
      top: '35%', left: 0, width: '100%', height: '30%',
      border: { type: 'line' }, tags: true,
      scrollable: true, alwaysScroll: true,
      scrollbar: { ch: '\u2588', style: { bg: THEME.muted } },
      label: ' // ACTIVITY ',
      keys: true, vi: true, mouse: true,
      style: {
        bg: THEME.bg, fg: THEME.fg,
        border: { fg: THEME.border },
        label: { fg: THEME.sectionHeader, bold: true },
        selected: { bg: '#222222', fg: 'white' },
        item: { fg: THEME.fg },
      },
    });

    // ─── Detail Panel (bottom panel) ────────────────────────
    this.detailPanel = blessed.box({
      parent: this.screen,
      top: '65%', left: 0, width: '100%', height: '35%-1',
      border: { type: 'line' }, tags: true,
      scrollable: true, alwaysScroll: true,
      scrollbar: { ch: '\u2588', style: { bg: THEME.muted } },
      label: ' // DETAILS ',
      keys: true, vi: true, mouse: true,
      style: {
        bg: THEME.bg, fg: THEME.fg,
        border: { fg: THEME.border },
        label: { fg: THEME.sectionHeader, bold: true },
      },
    });

    // ─── Status Bar ─────────────────────────────────────────
    this.statusBar = blessed.box({
      parent: this.screen,
      bottom: 0, left: 0, width: '100%', height: 1,
      tags: true,
      style: { fg: '#888888', bg: THEME.statusBg },
    });
  }

  _wireEvents() {
    this._panels = [this.flowPanel, this.activityPanel, this.detailPanel];
    this._panelIdx = 1;

    this.screen.key(['q', 'C-c'], () => {
      this.orchestrator.stop();
      process.exit(0);
    });

    this.activityPanel.on('select item', (item, index) => {
      this.selectedActivity = index;
      this.selectedNode = 0;
      this._renderDetail();
      this.screen.render();
    });

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

    this.screen.key(['tab'], () => {
      this._panelIdx = (this._panelIdx + 1) % this._panels.length;
      this._panels[this._panelIdx].focus();
      this._updateFocusBorders();
      this._renderStatusBar();
      this.screen.render();
    });

    this.screen.key(['S-tab'], () => {
      this._panelIdx = (this._panelIdx + this._panels.length - 1) % this._panels.length;
      this._panels[this._panelIdx].focus();
      this._updateFocusBorders();
      this._renderStatusBar();
      this.screen.render();
    });

    this.screen.key(['r'], () => { this._renderAll(); });

    this.screen.key(['t'], () => {
      const all = this._filteredInstances();
      const inst = all[this.selectedActivity];
      if (!inst) return;
      this._renderFullTrace(inst);
      this.screen.render();
    });

    this.screen.key(['f'], () => {
      const filters = [null, 'ok', 'fail', 'active'];
      const idx = filters.indexOf(this.filter);
      this.filter = filters[(idx + 1) % filters.length];
      this.selectedActivity = 0;
      this.activityPanel.setLabel(
        this.filter ? ` // ACTIVITY [${this.filter.toUpperCase()}] ` : ' // ACTIVITY '
      );
      this._renderActivity();
      this._renderDetail();
      this.screen.render();
    });

    this._diagnosing = false;
    this.screen.key(['d'], async () => {
      if (this._diagnosing) return;
      this._diagnosing = true;
      this.detailPanel.setContent('  {grey-fg}// Running diagnostics...{/grey-fg}');
      this.screen.render();
      try {
        const { quickDiagnose } = await import('../commands/diagnose.js');
        const results = await quickDiagnose(this.config);
        const lines = ['', '  {bold}// QUICK DIAGNOSTICS{/bold}', ''];
        for (const r of results) {
          const sym = r.status === 'pass' ? '{green-fg}v{/green-fg}' :
                      r.status === 'warn' ? '{yellow-fg}!{/yellow-fg}' :
                      '{red-fg}x{/red-fg}';
          lines.push(`  ${sym} ${r.detail}`);
        }
        if (results.length === 0) lines.push('  {grey-fg}No checks available{/grey-fg}');
        this.detailPanel.setContent(lines.join('\n'));
      } catch (err) {
        this.detailPanel.setContent(`  {red-fg}Diagnostics error: ${err.message}{/red-fg}`);
      }
      this._diagnosing = false;
      this.screen.render();
    });

    for (let i = 0; i < this._panels.length; i++) {
      this._panels[i].on('focus', () => {
        this._panelIdx = i;
        this._updateFocusBorders();
        this._renderStatusBar();
        this.screen.render();
      });
    }

    this.tracker.onChange(() => { this._renderAll(); });
  }

  _updateFocusBorders() {
    for (let i = 0; i < this._panels.length; i++) {
      this._panels[i].style.border.fg = i === this._panelIdx ? THEME.borderFocus : THEME.border;
    }
  }

  _renderAll() {
    this._renderHeader();
    this._renderFlows();
    this._renderActivity();
    this._renderDetail();
    this.screen.render();
  }

  // ─── Live data refresh ────────────────────────────────────

  _spinnerFrame() {
    this._spinnerTick = (this._spinnerTick + 1) % SPINNER_FRAMES.length;
    return SPINNER_FRAMES[this._spinnerTick];
  }

  async _refreshLiveData() {
    this._liveRefreshing = true;
    const rnCid = rnChainId(this.config.network);
    const rcAddr = this.config.contracts.rc?.address;
    const ccAddr = this.config.contracts.callback?.address;
    const ccChainId = this.config.contracts.callback?.chainId;

    if (rcAddr) {
      try {
        const hex = await ethGetBalance(rnCid, rcAddr);
        this._liveData.rcBalance = Number(BigInt(hex || '0x0')) / 1e18;
      } catch {}
      try {
        const paddedAddr = rcAddr.slice(2).toLowerCase().padStart(64, '0');
        const data = '0x2ecd4e7d' + paddedAddr;
        const result = await ethCall(rnCid, { to: SYSTEM_CONTRACTS.callbackProxy, data }, 'latest');
        this._liveData.rcDebt = Number(BigInt(result || '0x0')) / 1e18;
      } catch {}
    }
    if (ccAddr && ccChainId) {
      try {
        const hex = await ethGetBalance(ccChainId, ccAddr);
        this._liveData.ccBalance = Number(BigInt(hex || '0x0')) / 1e18;
      } catch {}
    }

    const subs = this.detection.subscriptions || [];
    this._liveData.subsStatus = {
      active: subs.filter(s => !s.isCron && !s.isSystem).length,
      cron: subs.filter(s => s.isCron).length,
      total: subs.length,
    };

    this._liveRefreshing = false;
    if (this.screen) { this._renderHeader(); this.screen.render(); }
  }

  // ─── Header ───────────────────────────────────────────────

  _renderHeader() {
    const net = this.config.network.toUpperCase();
    const rc = this.config.contracts.rc.address;
    const rcShort = rc ? `${rc.slice(0, 10)}...${rc.slice(-6)}` : '?';
    const flowCount = this.detection.flows.length;
    const active = this.tracker.getActive().length;
    const rcHealthy = this.orchestrator.rcWatcher.healthy;
    const healthDot = rcHealthy ? '{green-fg}v{/green-fg}' : '{red-fg}x{/red-fg}';

    const refreshIndicator = this._liveRefreshing ? `  {cyan-fg}${this._spinnerFrame()} refreshing...{/cyan-fg}` : '';
    const line1 = `  {bold}RC Debugger{/bold}  {grey-fg}|{/grey-fg}  ${net}  {grey-fg}|{/grey-fg}  RC: {white-fg}${rcShort}{/white-fg}  {grey-fg}|{/grey-fg}  ${flowCount} flow(s)  {grey-fg}|{/grey-fg}  ${active} active  {grey-fg}|{/grey-fg}  ${healthDot} ${this.config.pollInterval / 1000}s poll${refreshIndicator}`;

    // Stats line
    let line2 = '';
    if (this.stats) {
      const s = this.stats;
      const rateColor = s.successRate >= 90 ? 'green' : s.successRate >= 50 ? 'yellow' : 'red';
      line2 = `  {grey-fg}${s.totalFlows} traced  |  {${rateColor}-fg}${s.successRate}% success{/${rateColor}-fg}  |  avg ${s.avgDuration}s  |  last ${s.timeSinceLastFlow}  |  up ${s.uptime}{/grey-fg}`;
    }

    // Funding line
    const ld = this._liveData;
    const parts = [];
    if (ld.rcBalance !== null) {
      const b = ld.rcBalance;
      const s = b === 0 ? '0' : b < 0.0001 ? b.toExponential(1) : b.toPrecision(4);
      const c = b === 0 ? 'red' : b < 0.1 ? 'yellow' : 'green';
      parts.push(`{bold}RC:{/bold} {${c}-fg}${s} REACT{/${c}-fg}`);
    }
    if (ld.rcDebt !== null && ld.rcDebt > 0) {
      parts.push(`{red-fg}{bold}!! DEBT: ${ld.rcDebt.toPrecision(3)} REACT{/bold} — callbacks blocked, subscriptions inactive{/red-fg}`);
    }
    if (ld.ccBalance !== null) {
      const b = ld.ccBalance;
      const s = b === 0 ? '0' : b < 0.0001 ? b.toExponential(1) : b.toPrecision(4);
      const c = b === 0 ? 'yellow' : 'green';
      const ch = chainName(this.config.contracts.callback?.chainId);
      parts.push(`{bold}CC:{/bold} {${c}-fg}${s} ETH{/${c}-fg} {grey-fg}(${ch}){/grey-fg}`);
    }
    if (ld.subsStatus) {
      const ss = ld.subsStatus;
      const sp = [];
      if (ss.active > 0) sp.push(`{green-fg}${ss.active} event{/green-fg}`);
      if (ss.cron > 0) sp.push(`{magenta-fg}${ss.cron} cron{/magenta-fg}`);
      parts.push(sp.length > 0 ? `{bold}Subs:{/bold} ${sp.join('+')}` : '{bold}Subs:{/bold} {red-fg}none{/red-fg}');
    }
    const line3 = parts.length > 0 ? `  ${parts.join('  {grey-fg}|{/grey-fg}  ')}` : '';

    this.header.setContent(line1 + '\n' + line2 + '\n' + line3);
  }

  // ─── Flows & Subscriptions ────────────────────────────────

  _renderFlows() {
    const activeInstances = this.tracker.getActive();
    const lines = [];

    // Flows
    if (this.detection.flows.length > 0) {
      for (const flow of this.detection.flows) {
        const activeInst = activeInstances.find(i => i.flow.id === flow.id);
        const flowLines = renderFlowGraph(flow, activeInst, this.config, this.detection.subscriptions);
        lines.push(...flowLines, '');
      }
    } else {
      lines.push('  {grey-fg}No flows detected. Run rc-debug add-flow to add one.{/grey-fg}');
      lines.push('');
    }

    // Subscriptions table
    const subs = this.detection.subscriptions || [];
    lines.push(`  {bold}// SUBSCRIPTIONS{/bold}  {grey-fg}(${subs.length}){/grey-fg}`);
    lines.push('');

    if (subs.length > 0) {
      // Check debt status to determine subscription health
      const ld = this._liveData;
      const rcInDebt = ld.rcDebt !== null && ld.rcDebt > 0;
      const rcEmpty = ld.rcBalance !== null && ld.rcBalance <= 0;

      // Debt warning banner
      if (rcInDebt) {
        lines.push('  {red-fg}{bold}!! RC IS IN DEBT — All subscriptions are effectively INACTIVE{/bold}{/red-fg}');
        lines.push('  {red-fg}   Subscribers in debt are skipped by the Reactive Network.{/red-fg}');
        lines.push('  {yellow-fg}   Fix: call coverDebt() or send REACT to the system contract to clear debt{/yellow-fg}');
        lines.push('');
      } else if (rcEmpty) {
        lines.push('  {yellow-fg}{bold}! RC balance is 0 — Subscriptions will become inactive when debt accrues{/bold}{/yellow-fg}');
        lines.push('  {yellow-fg}   Fund your RC with lREACT (testnet) or depositTo() (mainnet){/yellow-fg}');
        lines.push('');
      }

      // Build lookup maps
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
      const addrRoles = new Map();
      for (const [role, c] of Object.entries(this.config.contracts)) {
        if (c?.address) addrRoles.set(c.address.toLowerCase(), role.toUpperCase());
      }

      // Table header
      lines.push('  {grey-fg}# STATUS          # CHAIN            # EVENT                    # CONTRACT{/grey-fg}');
      lines.push('');

      for (const sub of subs) {
        // Status — show INACTIVE if RC in debt or balance is 0
        const status = rcInDebt
          ? '{red-fg}x INACTIVE{/red-fg}'
          : rcEmpty
            ? '{yellow-fg}! AT RISK{/yellow-fg} '
            : '{green-fg}v ACTIVE{/green-fg} ';

        // Chain
        const chain = chainName(sub.chainId);

        // Event name
        let eventStr;
        if (sub.isCron) {
          eventStr = `{magenta-fg}${sub.cronName}{/magenta-fg} {grey-fg}(cron){/grey-fg}`;
        } else {
          const known = topicNames.get(sub.topic0?.toLowerCase());
          if (known) {
            eventStr = `{cyan-fg}${known.name}{/cyan-fg} {grey-fg}(${known.role}){/grey-fg}`;
          } else {
            eventStr = `{grey-fg}${sub.topic0?.slice(0, 14)}...{/grey-fg}`;
          }
        }

        // Contract
        const contractRole = addrRoles.get(sub.contract?.toLowerCase());
        const contractStr = contractRole
          ? `{white-fg}${sub.contract?.slice(0, 12)}...{/white-fg} {grey-fg}[${contractRole}]{/grey-fg}`
          : sub.contract && sub.contract !== '0x0000000000000000000000000000000000000000'
            ? `{grey-fg}${sub.contract?.slice(0, 12)}...{/grey-fg}`
            : '{grey-fg}any contract{/grey-fg}';

        lines.push(`  ${status}    ${chain.padEnd(18)} ${eventStr}`);
        lines.push(`                    {grey-fg}topic_0: ${sub.topic0?.slice(0, 30)}...{/grey-fg}`);
        lines.push(`                    {grey-fg}contract: ${contractStr}{/grey-fg}`);
        lines.push('');
      }
    } else {
      lines.push('  {red-fg}No subscriptions found for this RC.{/red-fg}');
      lines.push('  {grey-fg}Check: RC constructor has subscribe() calls inside if(!vm) guard{/grey-fg}');
    }

    this.flowPanel.setContent(lines.join('\n'));
  }

  // ─── Filter helper ────────────────────────────────────────

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

  // ─── Activity Log ─────────────────────────────────────────

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
      if (inst.failed) status = '{red-fg}x FAIL{/red-fg}';
      else if (inst.completed) status = '{green-fg}v OK{/green-fg}  ';
      else status = `{yellow-fg}${this._spinnerFrame()} ...{/yellow-fg} `;

      const hops = inst.hops.length > 0 ? ` {magenta-fg}[${inst.hops.length} hop]{/magenta-fg}` : '';
      items.push(`  {grey-fg}${ts}{/grey-fg}  ${status}  {bold}{white-fg}${inst.flow.name}{/white-fg}{/bold}  ${nodeSymbols}${hops}  {grey-fg}${inst.duration}s{/grey-fg}`);
    }

    if (items.length === 0) {
      items.push(`  {cyan-fg}${this._spinnerFrame()}{/cyan-fg} {grey-fg}Waiting for events... Trigger a transaction to see flows here.{/grey-fg}`);
    }

    this.activityPanel.setItems(items);
  }

  // ─── Detail Panel ─────────────────────────────────────────

  _renderDetail() {
    const all = this._filteredInstances();
    const inst = all[this.selectedActivity];

    if (!inst) {
      this.detailPanel.setContent('\n  {grey-fg}Select an activity entry.  \u2190\u2192 cycle nodes.  t = full trace  d = diagnose{/grey-fg}');
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
      const sym = n.state === STATE.SUCCESS ? '{green-fg}\u25CF{/green-fg}' :
                  n.state === STATE.FAILED ? '{red-fg}\u25CF{/red-fg}' :
                  n.state === STATE.PROGRESS ? '{yellow-fg}\u25D0{/yellow-fg}' :
                  '{grey-fg}\u25CB{/grey-fg}';
      return i === nodeIdx
        ? `{white-fg}{bold}[ ${sym} ${n.label} ]{/bold}{/white-fg}`
        : `  ${sym} {grey-fg}${n.label}{/grey-fg}  `;
    }).join('');

    lines.push('');
    lines.push(`  ${selectorBar}`);
    lines.push('  {grey-fg}' + '\u2500'.repeat(64) + '{/grey-fg}');

    if (!node.data) {
      if (node.state === STATE.PROGRESS) {
        lines.push(`  {cyan-fg}${this._spinnerFrame()} Processing...{/cyan-fg} {grey-fg}Waiting for data from chain...{/grey-fg}`);
      } else {
        lines.push('  {grey-fg}No data yet for this step.{/grey-fg}');
      }
    } else {
      const data = node.data;

      if (nodeKey === 'origin') {
        if (data.type === 'cron') {
          lines.push('  {bold}Type:{/bold}    {magenta-fg}Cron trigger{/magenta-fg}');
          if (data.txNumber) lines.push(`  {bold}RC TX:{/bold}   #${data.txNumber}`);
        } else {
          lines.push(`  {bold}Chain:{/bold}   {white-fg}${data.chainName || chainName(data.chainId) || '?'}{/white-fg}`);
          if (data.txHash) {
            lines.push(`  {bold}TX:{/bold}      {white-fg}${data.txHash}{/white-fg}`);
            const url = chainExplorerTxUrl(data.chainId, data.txHash);
            if (url) lines.push(`  {bold}Link:{/bold}    {blue-fg}${url}{/blue-fg}`);
          }
          if (data.blockNumber) lines.push(`  {bold}Block:{/bold}   ${data.blockNumber}`);
        }
      }

      if (nodeKey === 'rcWatch') {
        if (data.error) {
          // Failed at react() — show plain English context
          lines.push(`  {red-fg}{bold}react() failed:{/bold} ${data.error}{/red-fg}`);
          const ld = this._liveData;
          if (ld.rcDebt > 0) {
            lines.push('');
            lines.push(`  {red-fg}{bold}!! RC is in debt (${ld.rcDebt.toPrecision(3)} REACT){/bold}{/red-fg}`);
            lines.push('  {yellow-fg}   Debt causes the system to skip subscriptions — react() may not fire correctly{/yellow-fg}');
          }
          if (ld.rcBalance !== null && ld.rcBalance <= 0) {
            lines.push('');
            lines.push('  {yellow-fg}{bold}! RC balance is 0 REACT{/bold} — fund to prevent further failures{/yellow-fg}');
          }
        }
        lines.push(`  {bold}TX #:{/bold}    {white-fg}${data.txNumber}{/white-fg}`);
        if (data.hash) lines.push(`  {bold}Hash:{/bold}    {white-fg}${data.hash}{/white-fg}`);
        if (data.gasUsed && data.gasLimit) {
          const pct = Math.round((data.gasUsed / data.gasLimit) * 100);
          const gasColor = pct >= 90 ? 'red' : pct >= 70 ? 'yellow' : 'green';
          lines.push(`  {bold}Gas:{/bold}     {${gasColor}-fg}${data.gasUsed.toLocaleString()} / ${data.gasLimit.toLocaleString()} (${pct}%){/${gasColor}-fg}`);
        }
        if (data.logs?.length) {
          lines.push(`  {bold}Events:{/bold}  ${data.logs.length}`);
          for (const log of data.logs.slice(0, 6)) {
            lines.push(`           {cyan-fg}\u2022{/cyan-fg} ${log.name || 'Unknown'}`);
            if (log.args && !log.unknown) {
              const args = formatArgs(log.args);
              for (const [k, v] of Object.entries(args).slice(0, 3)) {
                const val = typeof v === 'string' && v.length > 40 ? v.slice(0, 40) + '...' : v;
                lines.push(`             {grey-fg}${k}:{/grey-fg} {yellow-fg}${val}{/yellow-fg}`);
              }
            }
          }
        }
      }

      if (nodeKey === 'callback') {
        if (data.callbacks?.length) {
          lines.push(`  {bold}Callbacks:{/bold} ${data.callbacks.length}`);
          for (const cb of data.callbacks) {
            const isSelf = cb.chainId === 5318007 || cb.chainId === 1597;
            const tag = isSelf ? '{magenta-fg}SELF{/magenta-fg}' : '{green-fg}DEST{/green-fg}';
            lines.push(`           [${tag}] ${chainName(cb.chainId)} \u2192 {yellow-fg}${cb.fnName || cb.selector}{/yellow-fg}`);
            lines.push(`           {grey-fg}contract: ${cb.contract || 'N/A'}  gas: ${cb.gasLimit || '?'}{/grey-fg}`);
          }
        }
        if (inst.hops.length > 0) {
          lines.push(`  {bold}Hops:{/bold}    ${inst.hops.length}`);
          for (const hop of inst.hops) {
            const ic = hop.type === 'self-delivered' ? '{green-fg}v{/green-fg}' : '{magenta-fg}\u25B6{/magenta-fg}';
            lines.push(`           ${ic} ${hop.type}: ${hop.fnName || hop.selector || ''}`);
          }
        }
      }

      if (nodeKey === 'dest') {
        if (data.success !== undefined) {
          const st = data.success ? '{green-fg}v SUCCESS{/green-fg}' : '{red-fg}x FAILED{/red-fg}';
          lines.push(`  {bold}Status:{/bold}  ${st}`);
          // Show plain English failure context
          if (!data.success) {
            const ld = this._liveData;
            if (ld.rcDebt > 0) {
              lines.push('');
              lines.push(`  {red-fg}{bold}!! RC is in debt (${ld.rcDebt.toPrecision(3)} REACT){/bold} — this is likely why the callback failed{/red-fg}`);
              lines.push('  {yellow-fg}   Clear debt with coverDebt() or send REACT to system contract{/yellow-fg}');
            }
            // Check for CallbackFailure in logs
            if (data.logs?.some(l => l.name === 'CallbackFailure' || l.name?.includes('CallbackFailure'))) {
              lines.push('');
              lines.push('  {red-fg}{bold}CallbackFailure detected{/bold} — callback was delivered but CC reverted{/red-fg}');
              lines.push('  {yellow-fg}   Likely causes: wrong _callbackSender, missing address first param, or CC logic error{/yellow-fg}');
            }
            if (data.logs?.some(l => l.name === 'PaymentFailure' || l.name?.includes('PaymentFailure'))) {
              lines.push('');
              lines.push('  {red-fg}{bold}PaymentFailure detected{/bold} — contract could not pay for callback gas{/red-fg}');
              lines.push('  {yellow-fg}   The contract has been blacklisted. Fund it and call coverDebt() to restore{/yellow-fg}');
            }
          }
        }
        if (data.selfCallbackOnly || data.selfCallbackComplete) {
          lines.push('  {bold}Type:{/bold}    {magenta-fg}Self-callback{/magenta-fg} {grey-fg}(state persistence on RN){/grey-fg}');
        }
        if (data.observationOnly) {
          lines.push('  {bold}Type:{/bold}    {grey-fg}Observation only (no callbacks emitted){/grey-fg}');
        }
        if (data.chainName) lines.push(`  {bold}Chain:{/bold}   {white-fg}${data.chainName}{/white-fg}`);
        if (data.txHash) {
          lines.push(`  {bold}TX:{/bold}      {white-fg}${data.txHash}{/white-fg}`);
          const url = chainExplorerTxUrl(data.chainId, data.txHash);
          if (url) lines.push(`  {bold}Link:{/bold}    {blue-fg}${url}{/blue-fg}`);
        }
        if (data.blockNumber) lines.push(`  {bold}Block:{/bold}   ${data.blockNumber}`);
        if (data.gasUsed) lines.push(`  {bold}Gas:{/bold}     ${data.gasUsed.toLocaleString()}`);
        if (data.revertReason) lines.push(`  {bold}Revert:{/bold}  {red-fg}${data.revertReason}{/red-fg}`);
        if (data.logs?.length) {
          lines.push(`  {bold}Events:{/bold}  ${data.logs.length}`);
          for (const log of data.logs.slice(0, 5)) {
            lines.push(`           {cyan-fg}\u2022{/cyan-fg} ${log.name || 'Unknown'}`);
          }
        }
        if (data.error) lines.push(`  {red-fg}Error: ${data.error}{/red-fg}`);
      }
    }

    // Show live system health context for failed flows
    if (inst.failed) {
      const ld2 = this._liveData;
      if (ld2.rcDebt > 0 || (ld2.rcBalance !== null && ld2.rcBalance <= 0)) {
        lines.push('');
        lines.push('  {red-fg}{bold}// SYSTEM HEALTH{/bold}{/red-fg}');
        if (ld2.rcDebt > 0) {
          lines.push(`  {red-fg}RC DEBT: ${ld2.rcDebt.toPrecision(3)} REACT — subscriptions inactive, callbacks blocked{/red-fg}`);
          lines.push('  {yellow-fg}Fix: call coverDebt() or send REACT to system contract (0x...fffFfF){/yellow-fg}');
        }
        if (ld2.rcBalance !== null && ld2.rcBalance <= 0) {
          lines.push('  {yellow-fg}RC BALANCE: 0 REACT — fund RC to resume operations{/yellow-fg}');
        }
      }
    }

    if (inst.failReason) {
      lines.push('');
      lines.push(`  {red-fg}{bold}// FAILURE{/bold}{/red-fg}`);
      lines.push(`  {red-fg}${inst.failReason}{/red-fg}`);
      if (inst.failHint) {
        lines.push('');
        lines.push('  {yellow-fg}{bold}// HINTS{/bold}');
        for (const h of inst.failHint.split('\n')) {
          lines.push(`  ${h}`);
        }
        lines.push('{/yellow-fg}');
      }
    }

    this.detailPanel.setContent(lines.join('\n'));
  }

  // ─── Full Trace View ──────────────────────────────────────

  _renderFullTrace(inst) {
    const lines = [];
    lines.push('');
    lines.push(`  {bold}// FULL TRACE: {white-fg}${inst.flow.name}{/white-fg}{/bold}`);
    lines.push(`  {grey-fg}Duration: ${inst.duration}s  |  ${inst.completed ? (inst.failed ? '{red-fg}FAILED{/red-fg}' : '{green-fg}SUCCESS{/green-fg}') : '{yellow-fg}IN PROGRESS{/yellow-fg}'}{/grey-fg}`);
    lines.push('  {grey-fg}' + '\u2500'.repeat(64) + '{/grey-fg}');

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

      const offset = node._timestamp ? `+${((node._timestamp - t0) / 1000).toFixed(1)}s` : '';
      const delta = node._timestamp && prevTime ? `{grey-fg}(\u0394 ${((node._timestamp - prevTime) / 1000).toFixed(1)}s){/grey-fg}` : '';
      if (node._timestamp) prevTime = node._timestamp;

      let detail = '';
      if (node.data) {
        if (node.data.txHash) detail = ` {grey-fg}tx:${node.data.txHash.slice(0, 14)}...{/grey-fg}`;
        else if (node.data.hash) detail = ` {grey-fg}tx:${node.data.hash.slice(0, 14)}...{/grey-fg}`;
        else if (node.data.txNumber) detail = ` {grey-fg}rc#${node.data.txNumber}{/grey-fg}`;
        if (node.data.type === 'cron') detail = ' {magenta-fg}(cron tick){/magenta-fg}';

        if (node.data.gasUsed && node.data.gasLimit) {
          const pct = Math.round((node.data.gasUsed / node.data.gasLimit) * 100);
          const gasColor = pct >= 90 ? 'red' : pct >= 70 ? 'yellow' : 'green';
          detail += ` {${gasColor}-fg}gas:${pct}%{/${gasColor}-fg}`;
        } else if (node.data.gasUsed) {
          detail += ` {grey-fg}gas:${node.data.gasUsed.toLocaleString()}{/grey-fg}`;
        }

        if (node.data.revertReason) detail += ` {red-fg}revert: ${node.data.revertReason}{/red-fg}`;

        if (node.data.txHash && node.data.chainId) {
          const url = chainExplorerTxUrl(node.data.chainId, node.data.txHash);
          if (url) detail += `\n           {blue-fg}${url}{/blue-fg}`;
        }
      }

      const timeStr = offset ? `{cyan-fg}${offset.padEnd(7)}{/cyan-fg}` : '       ';
      lines.push(`  ${timeStr} ${symbol} {white-fg}${labels[i]}{/white-fg}${detail} ${delta}`);
      if (i < nodeKeys.length - 1) {
        lines.push('           {grey-fg}\u2502{/grey-fg}');
      }
    }

    if (inst.hops.length > 0) {
      lines.push('');
      lines.push(`  {bold}// SELF-CALLBACK CHAIN{/bold}  {grey-fg}(${inst.hops.length} hop(s)){/grey-fg}`);
      for (const hop of inst.hops) {
        const ic = hop.type === 'self-delivered' ? '{green-fg}v{/green-fg}' : '{magenta-fg}\u25B6{/magenta-fg}';
        lines.push(`  ${ic} ${hop.type}: ${hop.fnName || hop.selector || ''}`);
      }
    }

    if (inst.failed) {
      const ld3 = this._liveData;
      if (ld3.rcDebt > 0 || (ld3.rcBalance !== null && ld3.rcBalance <= 0)) {
        lines.push('');
        lines.push('  {red-fg}{bold}// SYSTEM HEALTH{/bold}{/red-fg}');
        if (ld3.rcDebt > 0) lines.push(`  {red-fg}RC DEBT: ${ld3.rcDebt.toPrecision(3)} REACT — subscriptions inactive, callbacks blocked{/red-fg}`);
        if (ld3.rcBalance !== null && ld3.rcBalance <= 0) lines.push('  {yellow-fg}RC BALANCE: 0 REACT — fund to resume{/yellow-fg}');
      }
    }

    if (inst.failReason) {
      lines.push('');
      lines.push(`  {red-fg}{bold}// FAILURE{/bold}{/red-fg}`);
      lines.push(`  {red-fg}${inst.failReason}{/red-fg}`);
      if (inst.failHint) {
        lines.push('');
        lines.push('  {yellow-fg}{bold}// HINTS{/bold}');
        for (const h of inst.failHint.split('\n')) lines.push(`  ${h}`);
        lines.push('{/yellow-fg}');
      }
    }

    this.detailPanel.setContent(lines.join('\n'));
  }

  // ─── Status Bar ───────────────────────────────────────────

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
