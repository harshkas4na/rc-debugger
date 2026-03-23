// Tier 4 #20: Share a flow trace as a self-contained HTML file

import { FlowStore } from '../monitor/store.js';
import { writeFileSync } from 'fs';
import { chainName, chainExplorerTxUrl } from '../lib/chains.js';

export default async function share(args) {
  const id = args[0];
  const outFile = args[1] || 'flow-trace.html';

  if (!id) {
    // List recent flows
    const store = new FlowStore();
    const recent = store.query({ limit: 10 });
    store.stop();

    if (recent.length === 0) {
      console.log('  No flow history found. Run rc-debug watch first.');
      return;
    }

    console.log('\n  \x1b[36m\x1b[1mRecent Flows\x1b[0m\n');
    for (const entry of recent) {
      const status = entry.failed ? '\x1b[31m✗\x1b[0m' : '\x1b[32m✓\x1b[0m';
      console.log(`  ${status} ${entry.id}  ${entry.flow}  ${entry.duration}s  ${entry.timestamp}`);
    }
    console.log('\n  Usage: rc-debug share <flow-id> [output.html]\n');
    return;
  }

  const store = new FlowStore();
  const entry = store.getById(id);
  store.stop();

  if (!entry) {
    console.error(`  Flow "${id}" not found in history.`);
    process.exit(1);
  }

  const html = generateShareHtml(entry);
  writeFileSync(outFile, html);
  console.log(`  \x1b[32m✓\x1b[0m Trace saved to ${outFile}`);
  console.log(`  Open in browser: file://${process.cwd()}/${outFile}`);
}

function generateShareHtml(entry) {
  const nodes = entry.nodes || {};
  const status = entry.failed ? 'FAILED' : 'SUCCESS';
  const statusColor = entry.failed ? '#f85149' : '#3fb950';

  const nodeRows = Object.entries(nodes).map(([key, node]) => {
    const label = { origin: 'Origin Event', rcWatch: 'RC react()', callback: 'Callback', dest: 'Dest Execution' }[key] || key;
    const stateColor = { success: '#3fb950', failed: '#f85149', progress: '#d29922', idle: '#484f58' }[node.state] || '#484f58';
    const data = node.data || {};
    let details = '';
    if (data.txHash || data.hash) {
      const tx = data.txHash || data.hash;
      const url = data.chainId ? chainExplorerTxUrl(data.chainId, tx) : null;
      details += `<div class="detail">TX: ${url ? `<a href="${url}" target="_blank">${tx}</a>` : tx}</div>`;
    }
    if (data.chainName || data.chainId) details += `<div class="detail">Chain: ${data.chainName || chainName(data.chainId) || data.chainId}</div>`;
    if (data.blockNumber) details += `<div class="detail">Block: ${data.blockNumber}</div>`;
    if (data.gasUsed) details += `<div class="detail">Gas: ${data.gasUsed.toLocaleString()}</div>`;
    if (data.revertReason) details += `<div class="detail" style="color:#f85149">Revert: ${escHtml(data.revertReason)}</div>`;
    if (data.error) details += `<div class="detail" style="color:#f85149">Error: ${escHtml(data.error)}</div>`;
    if (data.type) details += `<div class="detail">Type: ${data.type}</div>`;
    if (data.callbacks?.length) {
      for (const cb of data.callbacks) {
        details += `<div class="detail">Callback: ${cb.fnName || cb.selector} → ${chainName(cb.chainId) || cb.chainId} (${cb.contract?.slice(0, 12)}...)</div>`;
      }
    }

    const time = node.timestamp ? new Date(node.timestamp).toLocaleTimeString() : '';
    return `<div class="node-row">
      <div class="node-dot" style="background:${stateColor}"></div>
      <div class="node-info">
        <div class="node-label">${label} <span class="node-time">${time}</span></div>
        ${details}
      </div>
    </div>`;
  }).join('<div class="node-line"></div>');

  const hopsHtml = (entry.hops || []).length > 0
    ? `<div class="section"><h3>Self-Callback Hops</h3>${entry.hops.map(h =>
        `<div class="hop">${h.type}: ${h.fnName || h.selector || '?'}</div>`
      ).join('')}</div>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RC Flow Trace: ${escHtml(entry.flow)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'SF Mono', 'Fira Code', monospace; background: #0d1117; color: #c9d1d9; padding: 24px; max-width: 700px; margin: 0 auto; font-size: 13px; }
  h1 { color: #58a6ff; font-size: 18px; margin-bottom: 4px; }
  .meta { color: #8b949e; margin-bottom: 20px; }
  .status { font-weight: bold; color: ${statusColor}; }
  .section { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .section h3 { color: #58a6ff; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; }
  .node-row { display: flex; gap: 12px; align-items: flex-start; }
  .node-dot { width: 12px; height: 12px; border-radius: 50%; margin-top: 3px; flex-shrink: 0; }
  .node-label { font-weight: bold; margin-bottom: 4px; }
  .node-time { color: #8b949e; font-weight: normal; font-size: 11px; }
  .node-line { width: 2px; height: 16px; background: #30363d; margin-left: 5px; }
  .detail { color: #8b949e; font-size: 12px; padding: 1px 0; word-break: break-all; }
  .detail a { color: #58a6ff; text-decoration: none; }
  .detail a:hover { text-decoration: underline; }
  .hop { color: #bc8cff; padding: 2px 0; }
  .footer { color: #484f58; text-align: center; margin-top: 24px; font-size: 11px; }
</style>
</head>
<body>
  <h1>${escHtml(entry.flow)}</h1>
  <div class="meta">
    <span class="status">${status}</span> · ${entry.duration}s · ${entry.timestamp}
    ${entry.failReason ? `<br>Failure: <span style="color:#f85149">${escHtml(entry.failReason)}</span>` : ''}
  </div>
  <div class="section">
    <h3>Flow Pipeline</h3>
    ${nodeRows}
  </div>
  ${hopsHtml}
  <div class="footer">Generated by RC Debugger · ${new Date().toISOString()}</div>
</body>
</html>`;
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
