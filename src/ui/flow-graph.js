// Render flow graph as node-connected ASCII art for blessed TUI

import { STATE } from '../monitor/flow-state.js';
import { chainName } from '../lib/chains.js';

/**
 * Render a single flow as a node graph
 * Returns array of blessed-tagged lines
 *
 *   Flow: Transfer -> processTransfer
 *   ● Origin Event  ───▶  ● RC react()  ───▶  ● Callback  ───▶  ● Dest Exec
 *   Sepolia                ReactVM              emit CB           Base Sepolia
 */
export function renderFlowGraph(flow, activeInstance, config, subscriptions) {
  const lines = [];

  // Flow title with subscription status
  const triggerType = flow.trigger.type === 'cron' ? '{magenta-fg}CRON{/magenta-fg}' :
                      flow.trigger.type === 'feedback' ? '{blue-fg}FEEDBACK{/blue-fg}' :
                      '{cyan-fg}EVENT{/cyan-fg}';

  // Check if this flow's trigger topic has an active subscription
  let subTag = '';
  if (subscriptions && flow.trigger.topic0) {
    const hasSub = subscriptions.some(s =>
      s.topic0?.toLowerCase() === flow.trigger.topic0.toLowerCase()
    );
    subTag = hasSub ? '  {green-fg}ACTIVE{/green-fg}' : '  {red-fg}NO SUB{/red-fg}';
  }

  lines.push(`  {bold}${flow.name}{/bold}  [${triggerType}]${subTag}${flow.isCustom ? '  {grey-fg}(custom){/grey-fg}' : ''}`);

  // Node symbols
  const nodes = getNodeStates(activeInstance);
  const arrow = '{grey-fg}\u2500\u2500\u2500\u25B6{/grey-fg}';

  // Top row: symbols + labels
  const nodeStr = [
    `${nodeSymbol(nodes[0])} Origin Event`,
    `${nodeSymbol(nodes[1])} RC react()`,
    `${nodeSymbol(nodes[2])} Callback`,
    `${nodeSymbol(nodes[3])} Dest Exec`,
  ];

  // Build the connected line
  lines.push(`  ${nodeStr[0]}  ${arrow}  ${nodeStr[1]}  ${arrow}  ${nodeStr[2]}  ${arrow}  ${nodeStr[3]}`);

  // Bottom row: chain labels
  const originChain = flow.trigger.type === 'cron' ? 'System Cron' : chainName(flow.trigger.chainId);
  const destChain = flow.callback?.type === 'self' ? 'RC (self)' :
                    flow.callback?.chainId ? chainName(flow.callback.chainId) : '?';

  const labels = [
    padRight(originChain, 14),
    padRight('ReactVM', 14),
    padRight('emit CB', 14),
    destChain,
  ];
  lines.push(`  {grey-fg}${labels[0]}        ${labels[1]}        ${labels[2]}        ${labels[3]}{/grey-fg}`);

  // Self-callback hops
  if (flow.selfCallbacks?.length > 0) {
    for (const sc of flow.selfCallbacks) {
      lines.push(`  {magenta-fg}  \u2514\u2500\u25B6 Self-CB: ${sc.fnName}{/magenta-fg}`);
    }
  }

  // Tier 3 #17: Feedback loop detection — if trigger is feedback type, show cycle arrow
  if (flow.trigger.type === 'feedback') {
    lines.push(`  {blue-fg}  \u21BA Feedback loop: Dest emits event \u2192 RC re-triggers{/blue-fg}`);
  }

  // Also detect if dest chain == origin chain and dest contract == origin contract (implicit feedback)
  if (flow.callback && flow.trigger.contract &&
      flow.callback.contract?.toLowerCase() === flow.trigger.contract?.toLowerCase() &&
      flow.callback.chainId === flow.trigger.chainId) {
    lines.push(`  {blue-fg}  \u21BA Cycle: callback targets the same origin contract{/blue-fg}`);
  }

  return lines;
}

function getNodeStates(instance) {
  if (!instance) {
    return [STATE.IDLE, STATE.IDLE, STATE.IDLE, STATE.IDLE];
  }
  return [
    instance.nodes.origin.state,
    instance.nodes.rcWatch.state,
    instance.nodes.callback.state,
    instance.nodes.dest.state,
  ];
}

function nodeSymbol(state) {
  switch (state) {
    case STATE.SUCCESS:  return '{green-fg}\u25CF{/green-fg}';
    case STATE.FAILED:   return '{red-fg}\u25CF{/red-fg}';
    case STATE.PROGRESS: return '{yellow-fg}\u25D0{/yellow-fg}';
    case STATE.WAITING:  return '{white-fg}\u25CC{/white-fg}';
    default:             return '{grey-fg}\u25CB{/grey-fg}';
  }
}

function padRight(str, len) {
  if (str.length >= len) return str;
  return str + ' '.repeat(len - str.length);
}

/**
 * Render a compact summary of all flows for status command
 */
export function renderFlowSummary(flows) {
  const lines = [];
  for (let i = 0; i < flows.length; i++) {
    const f = flows[i];
    const trigger = f.trigger.type === 'cron' ? `[CRON] ${f.trigger.eventName}` :
                    `[${chainName(f.trigger.chainId)}] ${f.trigger.eventName}`;
    const target = f.callback ?
      (f.callback.type === 'self' ? `[self] ${f.callback.fnName}` :
       `[${chainName(f.callback.chainId)}] ${f.callback.fnName}`) :
      '???';

    lines.push(`  ${i + 1}. ${trigger}  \u2192  RC react()  \u2192  ${target}`);
    if (f.selfCallbacks?.length) {
      for (const sc of f.selfCallbacks) {
        lines.push(`     \u2514\u2500 Self-CB: ${sc.fnName}`);
      }
    }
  }
  return lines;
}
