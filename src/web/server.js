// Tier 4 #19: Web dashboard server
// Lightweight Express-free HTTP server using Node built-in http module.
// Serves SSE stream for real-time flow updates + static HTML dashboard.

import { createServer } from 'http';
import { chainName, chainExplorerTxUrl } from '../lib/chains.js';

export class WebServer {
  constructor(orchestrator, detection, store, stats, port = 4040) {
    this.orchestrator = orchestrator;
    this.detection = detection;
    this.store = store;
    this.stats = stats;
    this.port = port;
    this.clients = new Set();

    this.server = createServer((req, res) => this._handle(req, res));

    // Push updates to SSE clients on tracker change
    this.orchestrator.tracker.onChange(() => {
      this._broadcast();
    });
  }

  start() {
    this.server.listen(this.port, () => {});
    return this.port;
  }

  stop() {
    for (const res of this.clients) {
      try { res.end(); } catch {}
    }
    this.server.close();
  }

  _handle(req, res) {
    const url = new URL(req.url, `http://localhost:${this.port}`);

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (url.pathname === '/api/stream') return this._handleSSE(req, res);
    if (url.pathname === '/api/state') return this._handleState(req, res);
    if (url.pathname === '/api/history') return this._handleHistory(req, res);
    if (url.pathname === '/api/flow') return this._handleFlow(req, res);
    if (url.pathname === '/' || url.pathname === '/index.html') return this._serveDashboard(res);

    res.writeHead(404);
    res.end('Not found');
  }

  _handleSSE(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));

    // Send initial state
    res.write(`data: ${JSON.stringify(this._getState())}\n\n`);
  }

  _broadcast() {
    const data = JSON.stringify(this._getState());
    for (const client of this.clients) {
      try { client.write(`data: ${data}\n\n`); } catch {}
    }
  }

  _handleState(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this._getState()));
  }

  _handleHistory(req, res) {
    const url = new URL(req.url, `http://localhost:${this.port}`);
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const status = url.searchParams.get('status');
    const entries = this.store ? this.store.query({ status, limit }) : [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(entries));
  }

  _handleFlow(req, res) {
    const url = new URL(req.url, `http://localhost:${this.port}`);
    const id = url.searchParams.get('id');
    const entry = this.store?.getById(id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(entry || { error: 'not found' }));
  }

  _getState() {
    const active = this.orchestrator.tracker.getActive().map(i => serializeInst(i));
    const history = this.orchestrator.tracker.getHistory().slice(0, 20).map(i => serializeInst(i));
    return {
      flows: this.detection.flows.map(f => ({
        id: f.id, name: f.name,
        trigger: { type: f.trigger.type, chainId: f.trigger.chainId, eventName: f.trigger.eventName },
        callback: f.callback ? { type: f.callback.type, chainId: f.callback.chainId, fnName: f.callback.fnName } : null,
      })),
      active,
      history,
      stats: this.stats ? {
        total: this.stats.totalFlows,
        successRate: this.stats.successRate,
        avgDuration: this.stats.avgDuration,
        uptime: this.stats.uptime,
      } : null,
      storedCount: this.store?.count || 0,
    };
  }

  _serveDashboard(res) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(DASHBOARD_HTML.replace('__PORT__', String(this.port)));
  }
}

function serializeInst(inst) {
  return {
    id: inst.id,
    flow: inst.flow.name,
    startTime: inst.startTime,
    duration: inst.duration,
    completed: inst.completed,
    failed: inst.failed,
    failReason: inst.failReason,
    hops: inst.hops.length,
    nodes: Object.fromEntries(
      Object.entries(inst.nodes).map(([k, n]) => [k, {
        state: n.state,
        label: n.label,
        txHash: n.data?.txHash || n.data?.hash || null,
        chainId: n.data?.chainId || null,
        explorerUrl: (n.data?.txHash && n.data?.chainId)
          ? chainExplorerTxUrl(n.data.chainId, n.data.txHash) : null,
      }])
    ),
  };
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RC Debugger</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'SF Mono', 'Fira Code', monospace; background: #0d1117; color: #c9d1d9; font-size: 13px; }
  .header { background: #161b22; padding: 12px 20px; border-bottom: 1px solid #30363d; display: flex; justify-content: space-between; align-items: center; }
  .header h1 { font-size: 16px; color: #58a6ff; }
  .stats { color: #8b949e; font-size: 12px; }
  .stats .ok { color: #3fb950; } .stats .fail { color: #f85149; }
  .container { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: #30363d; }
  .panel { background: #0d1117; padding: 16px; min-height: 200px; }
  .panel h2 { font-size: 13px; color: #58a6ff; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 1px; }
  .flow-card { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px; margin-bottom: 8px; }
  .flow-card .name { font-weight: bold; color: #c9d1d9; margin-bottom: 6px; }
  .nodes { display: flex; align-items: center; gap: 4px; font-size: 12px; }
  .node { display: flex; align-items: center; gap: 3px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .dot.success { background: #3fb950; } .dot.failed { background: #f85149; }
  .dot.progress { background: #d29922; } .dot.idle { background: #484f58; }
  .arrow { color: #484f58; }
  .activity-item { padding: 8px 0; border-bottom: 1px solid #21262d; display: flex; align-items: center; gap: 8px; cursor: pointer; }
  .activity-item:hover { background: #161b22; }
  .time { color: #8b949e; font-size: 11px; min-width: 70px; }
  .status-ok { color: #3fb950; } .status-fail { color: #f85149; } .status-progress { color: #d29922; }
  .duration { color: #8b949e; font-size: 11px; }
  .detail-panel { grid-column: 1 / -1; }
  .detail-content { background: #161b22; border-radius: 6px; padding: 16px; }
  .detail-row { display: flex; gap: 12px; padding: 3px 0; }
  .detail-label { color: #8b949e; min-width: 80px; }
  .detail-value { color: #c9d1d9; word-break: break-all; }
  .detail-value a { color: #58a6ff; text-decoration: none; }
  .detail-value a:hover { text-decoration: underline; }
  .empty { color: #484f58; text-align: center; padding: 40px; }
  @media (max-width: 768px) { .container { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="header">
  <h1>RC Debugger</h1>
  <div class="stats" id="stats">Connecting...</div>
</div>
<div class="container">
  <div class="panel" id="flows-panel"><h2>Flows</h2><div id="flows" class="empty">Loading...</div></div>
  <div class="panel" id="activity-panel"><h2>Activity</h2><div id="activity" class="empty">Waiting for events...</div></div>
  <div class="panel detail-panel"><h2>Details</h2><div id="detail" class="detail-content"><div class="empty">Select a flow to see details</div></div></div>
</div>
<script>
const port = __PORT__;
let state = null;
let selectedId = null;

const es = new EventSource('/api/stream');
es.onmessage = (e) => { state = JSON.parse(e.data); render(); };
es.onerror = () => { document.getElementById('stats').textContent = 'Disconnected — retrying...'; };

function render() {
  if (!state) return;
  // Stats
  const s = state.stats;
  const statsEl = document.getElementById('stats');
  if (s) {
    statsEl.innerHTML = s.total + ' flows | <span class="ok">' + s.successRate + '% success</span> | avg ' + s.avgDuration + 's | up ' + s.uptime + ' | stored: ' + state.storedCount;
  }
  // Flows
  const flowsEl = document.getElementById('flows');
  if (state.flows.length === 0) { flowsEl.innerHTML = '<div class="empty">No flows detected</div>'; }
  else {
    flowsEl.innerHTML = state.flows.map(f => {
      const active = state.active.find(a => a.flow === f.name);
      const nodes = active ? active.nodes : { origin:{state:'idle'}, rcWatch:{state:'idle'}, callback:{state:'idle'}, dest:{state:'idle'} };
      return '<div class="flow-card"><div class="name">' + esc(f.name) + '</div>' +
        '<div class="nodes">' + renderNodes(nodes) + '</div></div>';
    }).join('');
  }
  // Activity
  const all = [...state.active, ...state.history];
  const actEl = document.getElementById('activity');
  if (all.length === 0) { actEl.innerHTML = '<div class="empty">Waiting for events...</div>'; }
  else {
    actEl.innerHTML = all.map(inst => {
      const cls = inst.failed ? 'status-fail' : inst.completed ? 'status-ok' : 'status-progress';
      const icon = inst.failed ? '✗' : inst.completed ? '✓' : '…';
      const t = new Date(inst.startTime).toLocaleTimeString();
      return '<div class="activity-item" onclick="select(\\'' + esc(inst.id) + '\\')">' +
        '<span class="time">' + t + '</span>' +
        '<span class="' + cls + '">' + icon + '</span>' +
        '<span>' + esc(inst.flow) + '</span>' +
        '<span class="nodes">' + renderNodes(inst.nodes) + '</span>' +
        '<span class="duration">' + inst.duration + 's</span></div>';
    }).join('');
  }
  // Detail
  if (selectedId) renderDetail();
}

function renderNodes(nodes) {
  const keys = ['origin','rcWatch','callback','dest'];
  return keys.map((k,i) => {
    const n = nodes[k] || {state:'idle'};
    const dot = '<span class="dot ' + n.state + '"></span>';
    return (i > 0 ? '<span class="arrow">→</span>' : '') + '<span class="node">' + dot + '</span>';
  }).join('');
}

function select(id) {
  selectedId = id;
  renderDetail();
}

function renderDetail() {
  const all = [...(state?.active||[]), ...(state?.history||[])];
  const inst = all.find(a => a.id === selectedId);
  const el = document.getElementById('detail');
  if (!inst) { el.innerHTML = '<div class="empty">Select a flow</div>'; return; }
  let html = '<div class="detail-row"><div class="detail-label">Flow</div><div class="detail-value">' + esc(inst.flow) + '</div></div>';
  html += '<div class="detail-row"><div class="detail-label">Status</div><div class="detail-value ' + (inst.failed?'status-fail':'status-ok') + '">' + (inst.failed?'FAILED':'OK') + '</div></div>';
  html += '<div class="detail-row"><div class="detail-label">Duration</div><div class="detail-value">' + inst.duration + 's</div></div>';
  if (inst.failReason) html += '<div class="detail-row"><div class="detail-label">Reason</div><div class="detail-value status-fail">' + esc(inst.failReason) + '</div></div>';
  if (inst.hops > 0) html += '<div class="detail-row"><div class="detail-label">Hops</div><div class="detail-value">' + inst.hops + ' self-callback(s)</div></div>';
  for (const [k, n] of Object.entries(inst.nodes)) {
    if (!n.txHash) continue;
    const link = n.explorerUrl ? '<a href="' + n.explorerUrl + '" target="_blank">' + n.txHash.slice(0,18) + '...</a>' : n.txHash.slice(0,18) + '...';
    html += '<div class="detail-row"><div class="detail-label">' + (n.label||k) + '</div><div class="detail-value">' + link + '</div></div>';
  }
  el.innerHTML = html;
}

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
</script>
</body>
</html>`;
