// Diagnose command — run health checks on RC/CC setup without starting the monitor

import chalk from 'chalk';
import { loadConfig, validateConfig } from '../lib/config.js';
import { resolveRvmId, fetchSubscriptions, discoverCallbackPatterns } from '../analysis/subscription.js';
import { analyzeContracts } from '../analysis/abi-parser.js';
import { chainName, rnChainId, callbackProxyAddress, isTestnet, isMainnet, isRnChainId, reactscanUrl, SYSTEM_CONTRACTS } from '../lib/chains.js';
import {
  ethBlockNumber, ethGetBalance, ethGetCode, ethCall, ethGetLogs,
} from '../lib/rpc.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatEth(hexOrBigint) {
  const wei = typeof hexOrBigint === 'string' ? BigInt(hexOrBigint || '0x0') : hexOrBigint;
  const eth = Number(wei) / 1e18;
  if (eth === 0) return '0';
  if (eth < 0.0001) return eth.toExponential(2);
  if (eth < 1) return eth.toPrecision(4);
  return eth.toFixed(4);
}

function shortAddr(addr) {
  if (!addr) return '???';
  return addr.slice(0, 8) + '...' + addr.slice(-4);
}

function icon(status) {
  if (status === 'pass') return chalk.green('\u2713');
  if (status === 'warn') return chalk.yellow('\u26A0');
  return chalk.red('\u2717');
}

// ─── Check runner ───────────────────────────────────────────────────────────

async function runAllChecks(config) {
  const results = [];
  const add = (group, label, status, detail) => results.push({ group, label, status, detail });

  const rnCid = rnChainId(config.network);
  const rcAddr = config.contracts.rc?.address;
  const originAddr = config.contracts.origin?.address;
  const originChainId = config.contracts.origin?.chainId;
  const ccAddr = config.contracts.callback?.address;
  const ccChainId = config.contracts.callback?.chainId;

  // ── Config ──────────────────────────────────────────────────────────────

  add('Config', 'config-valid', 'pass', '.rc-debug.json valid');
  add('Config', 'network', 'pass', `Network: ${config.network} (${chainName(rnCid)})`);

  // Mainnet/testnet mixing check
  const allChainIds = [originChainId, ccChainId].filter(Boolean);
  const hasTestnet = allChainIds.some(id => isTestnet(id));
  const hasMainnet = allChainIds.some(id => isMainnet(id));
  if (hasTestnet && hasMainnet) {
    add('Config', 'network-mix', 'fail', 'Mainnet and testnet chains are mixed — this will silently fail. All chains must be same tier.');
  } else if (config.network === 'lasna' && hasMainnet) {
    add('Config', 'network-mix', 'fail', `RC on Lasna testnet but destination on mainnet chain (${allChainIds.filter(isMainnet).map(chainName).join(', ')}) — use matching tiers`);
  } else if (config.network === 'mainnet' && hasTestnet) {
    add('Config', 'network-mix', 'fail', `RC on Reactive Mainnet but destination on testnet chain (${allChainIds.filter(isTestnet).map(chainName).join(', ')}) — use matching tiers`);
  }

  // ── Connectivity ────────────────────────────────────────────────────────

  try {
    const block = await ethBlockNumber(rnCid);
    add('Connectivity', 'rn-rpc', 'pass', `${chainName(rnCid)} RPC (block ${block.toLocaleString()})`);
  } catch (err) {
    add('Connectivity', 'rn-rpc', 'fail', `${chainName(rnCid)} RPC unreachable: ${err.message}`);
  }

  if (originChainId) {
    try {
      const block = await ethBlockNumber(originChainId);
      add('Connectivity', 'origin-rpc', 'pass', `${chainName(originChainId)} (${originChainId}) RPC (block ${block.toLocaleString()})`);
    } catch (err) {
      add('Connectivity', 'origin-rpc', 'fail', `${chainName(originChainId)} RPC unreachable: ${err.message}`);
    }
  }

  if (ccChainId && ccChainId !== originChainId) {
    try {
      const block = await ethBlockNumber(ccChainId);
      add('Connectivity', 'dest-rpc', 'pass', `${chainName(ccChainId)} (${ccChainId}) RPC (block ${block.toLocaleString()})`);
    } catch (err) {
      add('Connectivity', 'dest-rpc', 'fail', `${chainName(ccChainId)} RPC unreachable: ${err.message}`);
    }
  }

  // ── Contracts deployed ──────────────────────────────────────────────────

  if (rcAddr) {
    try {
      const code = await ethGetCode(rnCid, rcAddr);
      if (code && code !== '0x' && code.length > 2) {
        add('Contracts', 'rc-code', 'pass', `RC ${shortAddr(rcAddr)} deployed on ${chainName(rnCid)}`);
      } else {
        add('Contracts', 'rc-code', 'fail', `RC ${shortAddr(rcAddr)} has no code on ${chainName(rnCid)} — not deployed`);
      }
    } catch (err) {
      add('Contracts', 'rc-code', 'fail', `RC code check failed: ${err.message}`);
    }
  }

  if (originAddr && originChainId) {
    try {
      const code = await ethGetCode(originChainId, originAddr);
      if (code && code !== '0x' && code.length > 2) {
        add('Contracts', 'origin-code', 'pass', `Origin ${shortAddr(originAddr)} deployed on ${chainName(originChainId)}`);
      } else {
        add('Contracts', 'origin-code', 'fail', `Origin ${shortAddr(originAddr)} has no code on ${chainName(originChainId)} — not deployed`);
      }
    } catch (err) {
      add('Contracts', 'origin-code', 'fail', `Origin code check failed: ${err.message}`);
    }
  }

  if (ccAddr && ccChainId) {
    try {
      const code = await ethGetCode(ccChainId, ccAddr);
      if (code && code !== '0x' && code.length > 2) {
        add('Contracts', 'cc-code', 'pass', `CC ${shortAddr(ccAddr)} deployed on ${chainName(ccChainId)}`);
      } else {
        add('Contracts', 'cc-code', 'fail', `CC ${shortAddr(ccAddr)} has no code on ${chainName(ccChainId)} — not deployed`);
      }
    } catch (err) {
      add('Contracts', 'cc-code', 'fail', `CC code check failed: ${err.message}`);
    }
  }

  // ── Funding ─────────────────────────────────────────────────────────────

  if (rcAddr) {
    // RC REACT balance
    try {
      const balHex = await ethGetBalance(rnCid, rcAddr);
      const bal = BigInt(balHex || '0x0');
      const ethBal = formatEth(bal);
      if (bal === 0n) {
        add('Funding', 'rc-balance', 'fail', `RC balance: 0 REACT — cannot pay for callbacks. Fund with lREACT faucet or depositTo()`);
      } else if (bal < BigInt('100000000000000000')) { // 0.1 ETH
        add('Funding', 'rc-balance', 'warn', `RC balance: ${ethBal} REACT — low, may run out soon`);
      } else {
        add('Funding', 'rc-balance', 'pass', `RC balance: ${ethBal} REACT`);
      }
    } catch (err) {
      add('Funding', 'rc-balance', 'fail', `RC balance check failed: ${err.message}`);
    }

    // RC debt via system contract debts(address)
    try {
      const paddedAddr = rcAddr.slice(2).toLowerCase().padStart(64, '0');
      const data = '0x2ecd4e7d' + paddedAddr;
      const result = await ethCall(rnCid, { to: SYSTEM_CONTRACTS.callbackProxy, data }, 'latest');
      const debt = BigInt(result || '0x0');
      if (debt > 0n) {
        add('Funding', 'rc-debt', 'warn', `RC debt: ${formatEth(debt)} REACT — outstanding debt, RC may be inactive. Call coverDebt() or depositTo()`);
      } else {
        add('Funding', 'rc-debt', 'pass', `RC debt: 0 REACT`);
      }
    } catch {
      add('Funding', 'rc-debt', 'warn', 'RC debt check unavailable (system contract call failed)');
    }

    // CC balance on dest chain
    if (ccAddr && ccChainId) {
      try {
        const balHex = await ethGetBalance(ccChainId, ccAddr);
        const bal = BigInt(balHex || '0x0');
        const ethBal = formatEth(bal);
        if (bal === 0n) {
          add('Funding', 'cc-balance', 'warn', `CC balance: 0 ETH on ${chainName(ccChainId)} (may need funds for internal calls)`);
        } else {
          add('Funding', 'cc-balance', 'pass', `CC balance: ${ethBal} ETH on ${chainName(ccChainId)}`);
        }
      } catch (err) {
        add('Funding', 'cc-balance', 'fail', `CC balance check failed: ${err.message}`);
      }
    }
  }

  // ── Subscriptions ───────────────────────────────────────────────────────

  let rvmId = null;
  let subs = [];

  if (rcAddr) {
    try {
      rvmId = await resolveRvmId(rcAddr, config.network);
      if (rvmId) {
        add('Subscriptions', 'rvm-id', 'pass', `RVM ID: ${shortAddr(rvmId)}`);
      } else {
        add('Subscriptions', 'rvm-id', 'fail', `RC ${shortAddr(rcAddr)} has no RVM on ${config.network} — not registered`);
      }
    } catch (err) {
      add('Subscriptions', 'rvm-id', 'fail', `RVM resolution failed: ${err.message}`);
    }
  }

  // ABI analysis (needed for multiple checks below)
  let contracts = null;
  try {
    contracts = await analyzeContracts(config, () => {});
  } catch {}

  if (rvmId) {
    try {
      subs = await fetchSubscriptions(rvmId, config.network, rcAddr);
      if (subs.length > 0) {
        add('Subscriptions', 'subs-count', 'pass', `${subs.length} subscription(s) found for this RC`);
      } else {
        add('Subscriptions', 'subs-count', 'fail', 'No subscriptions found — RC constructor may be missing subscribe() calls or if(!vm) guard');
      }
    } catch (err) {
      add('Subscriptions', 'subs-count', 'fail', `Subscription fetch failed: ${err.message}`);
    }

    // Topic validation against ABIs (deduplicated)
    if (subs.length > 0 && contracts) {
      const allTopics = new Map();
      for (const role of ['origin', 'callback', 'rc']) {
        const c = contracts[role];
        if (c?.topicMap) {
          for (const [topic, ev] of c.topicMap) allTopics.set(topic, { event: ev, role });
        }
      }

      // Build contract address → role name map
      const addrRoles = new Map();
      for (const [role, c] of Object.entries(config.contracts)) {
        if (c?.address) addrRoles.set(c.address.toLowerCase(), role);
      }

      const seenTopics = new Map();
      for (const sub of subs) {
        const t = sub.topic0?.toLowerCase() || '';
        const prev = seenTopics.get(t);
        if (prev) { prev.count++; } else {
          seenTopics.set(t, { count: 1, isCron: sub.isCron, cronName: sub.cronName, topic0: sub.topic0, chainId: sub.chainId, contract: sub.contract });
        }
      }

      let unknownCount = 0;
      for (const [topic, info] of seenTopics) {
        const countSuffix = info.count > 1 ? ` (${info.count}x)` : '';
        const chain = chainName(info.chainId);
        const contractRole = addrRoles.get(info.contract?.toLowerCase());
        const contractLabel = contractRole ? `${shortAddr(info.contract)} [${contractRole}]` : shortAddr(info.contract);
        if (info.isCron) {
          add('Subscriptions', `topic-${topic.slice(0, 10)}`, 'pass',
            `ACTIVE  ${info.cronName} (cron)${countSuffix}`);
        } else {
          const known = allTopics.get(topic);
          if (known) {
            add('Subscriptions', `topic-${topic.slice(0, 10)}`, 'pass',
              `ACTIVE  ${chain}  ${known.event.name}(${known.event.inputs.map(i => i.type).join(',')})  on ${contractLabel}${countSuffix}`);
          } else {
            unknownCount += info.count;
          }
        }
      }
      if (unknownCount > 0) {
        add('Subscriptions', 'unknown-topics', 'warn',
          `${unknownCount} subscription(s) with topics not in any loaded ABI`);
      }
    }
  }

  // ── Callbacks ───────────────────────────────────────────────────────────

  if (ccChainId) {
    const proxy = callbackProxyAddress(ccChainId);
    if (proxy) {
      add('Callbacks', 'proxy', 'pass', `Callback Proxy for ${chainName(ccChainId)}: ${proxy}`);
    } else if (!isRnChainId(ccChainId)) {
      add('Callbacks', 'proxy', 'fail', `No known Callback Proxy for ${chainName(ccChainId)} (${ccChainId}) — callbacks cannot be delivered to this chain`);
    }

    // Verify callback proxy actually has code on the dest chain
    if (proxy && !isRnChainId(ccChainId)) {
      try {
        const proxyCode = await ethGetCode(ccChainId, proxy);
        if (proxyCode && proxyCode !== '0x' && proxyCode.length > 2) {
          add('Callbacks', 'proxy-deployed', 'pass', `Callback Proxy has code on ${chainName(ccChainId)}`);
        } else {
          add('Callbacks', 'proxy-deployed', 'fail', `Callback Proxy ${shortAddr(proxy)} has NO code on ${chainName(ccChainId)} — callbacks will fail`);
        }
      } catch {
        add('Callbacks', 'proxy-deployed', 'warn', `Could not verify Callback Proxy deployment on ${chainName(ccChainId)}`);
      }
    }
  }

  // Callback selector validation — do callback function selectors exist in CC ABI?
  let patterns = [];
  if (rvmId) {
    try {
      patterns = await discoverCallbackPatterns(rvmId, config.network);
      if (patterns.length > 0) {
        add('Callbacks', 'patterns', 'pass', `${patterns.length} callback pattern(s) in recent RC txs`);
      } else {
        add('Callbacks', 'patterns', 'warn', 'No callback patterns found — RC may have never fired or has no recent activity');
      }
    } catch {
      add('Callbacks', 'patterns', 'warn', 'Could not scan for callback patterns');
    }

    // Validate callback selectors — only check patterns targeting our known contracts
    if (patterns.length > 0 && contracts) {
      const ccSelectorMap = contracts.callback?.selectorMap;
      const rcSelectorMap = contracts.rc?.selectorMap;
      const rcLower = rcAddr?.toLowerCase();
      const ccLower = ccAddr?.toLowerCase();

      for (const p of patterns) {
        if (!p.selector || p.selector === '0x00000000') continue;

        // Filter: only validate patterns targeting our RC (self) or CC (dest)
        const destLower = p.destContract?.toLowerCase();
        if (p.isSelfCallback && destLower !== rcLower) continue;
        if (!p.isSelfCallback && destLower !== ccLower) continue;

        const targetMap = p.isSelfCallback ? rcSelectorMap : ccSelectorMap;
        const targetRole = p.isSelfCallback ? 'RC' : 'CC';
        if (targetMap) {
          const fn = targetMap.get(p.selector.toLowerCase());
          if (fn) {
            add('Callbacks', `sel-${p.selector}`, 'pass',
              `${p.isSelfCallback ? '[SELF]' : '[DEST]'} ${p.selector} \u2192 ${fn.name}(${fn.inputs.map(i => i.type).join(',')}) in ${targetRole} ABI`);
            // Check if first param is address (RVM ID slot)
            if (fn.inputs.length === 0 || fn.inputs[0].type !== 'address') {
              add('Callbacks', `sel-${p.selector}-addr`, 'warn',
                `${fn.name}() missing address as first param — callbacks require address (RVM ID) as first parameter`);
            }
          } else {
            add('Callbacks', `sel-${p.selector}`, 'warn',
              `${p.isSelfCallback ? '[SELF]' : '[DEST]'} ${p.selector} not found in ${targetRole} ABI — function selector mismatch (typo in abi.encodeWithSignature?)`);
          }
        }
      }
    }
  }

  // ── Origin events ───────────────────────────────────────────────────────

  if (originAddr && originChainId && subs.length > 0) {
    try {
      const currentBlock = await ethBlockNumber(originChainId);
      const eventSubs = subs.filter(s => !s.isCron && String(s.chainId) === String(originChainId));
      const topics = eventSubs.map(s => s.topic0).filter(Boolean);

      if (topics.length > 0) {
        const fromBlock = Math.max(0, currentBlock - 1000);
        const logs = await ethGetLogs({
          fromBlock: '0x' + fromBlock.toString(16),
          toBlock: 'latest',
          address: originAddr,
          topics: [topics],
        }, originChainId);

        if (logs && logs.length > 0) {
          add('Origin', 'recent-events', 'pass', `${logs.length} matching event(s) in last 1000 blocks on ${chainName(originChainId)}`);
        } else {
          add('Origin', 'recent-events', 'warn', `No matching events in last 1000 blocks on ${chainName(originChainId)} — no recent triggers`);
        }
      }
    } catch {
      add('Origin', 'recent-events', 'warn', 'Could not check for recent origin events');
    }
  }

  // ── Reactscan ─────────────────────────────────────────────────────────

  if (rcAddr) {
    add('Links', 'reactscan', 'pass', `Reactscan: ${reactscanUrl(config.network, rcAddr)}`);
  }

  return results;
}

// ─── Quick diagnose (for dashboard 'd' key) ─────────────────────────────────

export async function quickDiagnose(config) {
  const results = [];
  const add = (group, label, status, detail) => results.push({ group, label, status, detail });

  const rnCid = rnChainId(config.network);
  const rcAddr = config.contracts.rc?.address;
  const ccAddr = config.contracts.callback?.address;
  const ccChainId = config.contracts.callback?.chainId;

  // RC balance
  if (rcAddr) {
    try {
      const balHex = await ethGetBalance(rnCid, rcAddr);
      const bal = BigInt(balHex || '0x0');
      const ethBal = formatEth(bal);
      if (bal === 0n) {
        add('Funding', 'rc-balance', 'fail', `RC balance: 0 REACT`);
      } else if (bal < BigInt('100000000000000000')) {
        add('Funding', 'rc-balance', 'warn', `RC balance: ${ethBal} REACT (low)`);
      } else {
        add('Funding', 'rc-balance', 'pass', `RC balance: ${ethBal} REACT`);
      }
    } catch {
      add('Funding', 'rc-balance', 'fail', 'RC balance check failed');
    }

    // RC debt
    try {
      const paddedAddr = rcAddr.slice(2).toLowerCase().padStart(64, '0');
      const data = '0x2ecd4e7d' + paddedAddr;
      const result = await ethCall(rnCid, { to: SYSTEM_CONTRACTS.callbackProxy, data }, 'latest');
      const debt = BigInt(result || '0x0');
      if (debt > 0n) {
        add('Funding', 'rc-debt', 'warn', `RC debt: ${formatEth(debt)} REACT`);
      } else {
        add('Funding', 'rc-debt', 'pass', 'RC debt: 0 REACT');
      }
    } catch {
      add('Funding', 'rc-debt', 'warn', 'RC debt check unavailable');
    }
  }

  // CC balance
  if (ccAddr && ccChainId) {
    try {
      const balHex = await ethGetBalance(ccChainId, ccAddr);
      const bal = BigInt(balHex || '0x0');
      if (bal === 0n) {
        add('Funding', 'cc-balance', 'warn', `CC balance: 0 ETH on ${chainName(ccChainId)}`);
      } else {
        add('Funding', 'cc-balance', 'pass', `CC balance: ${formatEth(bal)} ETH on ${chainName(ccChainId)}`);
      }
    } catch {
      add('Funding', 'cc-balance', 'fail', 'CC balance check failed');
    }
  }

  // Callback proxy
  if (ccChainId) {
    const proxy = callbackProxyAddress(ccChainId);
    if (proxy) {
      add('Proxy', 'proxy', 'pass', `Proxy for ${chainName(ccChainId)}: ${shortAddr(proxy)}`);
    } else {
      add('Proxy', 'proxy', 'fail', `No known proxy for ${chainName(ccChainId)}`);
    }
  }

  return results;
}

// ─── CLI entry point ────────────────────────────────────────────────────────

export default async function diagnose() {
  const config = loadConfig();
  if (!config) {
    console.log(`\n  ${chalk.red('\u2717')} No .rc-debug.json found. Run ${chalk.bold('rc-debug init')} first.\n`);
    process.exit(1);
  }

  const errors = validateConfig(config);
  if (errors.length) {
    console.log(`\n  ${chalk.red('\u2717')} Config validation failed:`);
    for (const e of errors) console.log(`    ${chalk.red('\u2717')} ${e}`);
    console.log(`\n  Fix these issues or re-run ${chalk.bold('rc-debug init')}\n`);
    process.exit(1);
  }

  console.log(`\n  ${chalk.cyan.bold('rc-debug diagnose')}\n`);

  const results = await runAllChecks(config);

  // Print grouped
  let currentGroup = null;
  for (const r of results) {
    if (r.group !== currentGroup) {
      currentGroup = r.group;
      console.log(`\n  ${chalk.bold(r.group)}`);
    }
    console.log(`    ${icon(r.status)} ${r.detail}`);
  }

  // Summary
  const passed = results.filter(r => r.status === 'pass').length;
  const warned = results.filter(r => r.status === 'warn').length;
  const failed = results.filter(r => r.status === 'fail').length;

  console.log('');
  console.log(`  ${chalk.bold('Summary:')} ${chalk.green(passed + ' passed')}${warned ? ', ' + chalk.yellow(warned + ' warning(s)') : ''}${failed ? ', ' + chalk.red(failed + ' failed') : ''}`);
  console.log('');

  process.exit(failed > 0 ? 1 : 0);
}
