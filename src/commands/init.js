// Interactive setup — creates .rc-debug.json
// Supports two modes:
//   1. Auto-discovery: just provide RC address, tool figures out the rest
//   2. Manual: specify all contracts explicitly

import prompts from 'prompts';
import { saveConfig, configExists, defaultConfig } from '../lib/config.js';
import { allChains, RN_CHAIN_IDS, chainName, isRnChainId } from '../lib/chains.js';
import { fetchAbi, findLocalArtifact, loadAbiFromFile, listLocalArtifacts } from '../lib/abi-resolver.js';
import { rnkGetRvmId, rnkGetSubscribers, ethBlockNumber } from '../lib/rpc.js';
import { discoverCallbackPatterns, CRON_TOPICS } from '../analysis/subscription.js';

const evmChains = allChains().filter(c => !RN_CHAIN_IDS.has(c.chainId));
const chainChoices = evmChains.map(c => ({ title: `${c.name} (${c.chainId})`, value: c.chainId }));

export default async function init(args) {
  console.log('\n  \x1b[36m\x1b[1mRC Debugger — Setup\x1b[0m\n');

  if (configExists()) {
    const { overwrite } = await prompts({
      type: 'confirm', name: 'overwrite',
      message: '.rc-debug.json already exists. Overwrite?',
      initial: false,
    });
    if (!overwrite) { console.log('  Aborted.'); return; }
  }

  // Check for --rc flag (auto-discovery shortcut)
  const rcIdx = args?.indexOf('--rc');
  const rcFromFlag = rcIdx !== -1 && args[rcIdx + 1] ? args[rcIdx + 1] : null;

  const { mode } = rcFromFlag ? { mode: 'auto' } : await prompts({
    type: 'select',
    name: 'mode',
    message: 'Setup mode',
    choices: [
      { title: 'Auto-discover (just provide RC address)', value: 'auto' },
      { title: 'Manual (specify all contracts)', value: 'manual' },
    ],
  });
  if (!mode) return;

  const config = defaultConfig();

  // Network
  const { network } = await prompts({
    type: 'select', name: 'network', message: 'Network',
    choices: [
      { title: 'Lasna Testnet', value: 'lasna' },
      { title: 'Reactive Mainnet', value: 'mainnet' },
    ],
  });
  if (!network) return;
  config.network = network;

  // RC address
  let rcAddress = rcFromFlag;
  if (!rcAddress) {
    const ans = await prompts({
      type: 'text', name: 'rcAddress', message: 'RC deployed address',
      validate: v => /^0x[0-9a-fA-F]{40}$/.test(v) || 'Enter a valid address (0x...)',
    });
    rcAddress = ans.rcAddress;
  }
  if (!rcAddress) return;
  config.contracts.rc = { address: rcAddress, chainId: network === 'mainnet' ? 1597 : 5318007 };

  if (mode === 'auto') {
    await autoDiscover(config);
  } else {
    await manualSetup(config);
  }

  // Poll interval
  const { pollInterval } = await prompts({
    type: 'number', name: 'pollInterval', message: 'Poll interval (ms)',
    initial: 3000, min: 1000, max: 30000,
  });
  config.pollInterval = pollInterval || 3000;

  // Resolve ABIs
  await resolveAbis(config);

  // Validate on-chain
  await validateOnChain(config);

  // Save
  try {
    saveConfig(config);
    console.log('\n  \x1b[32m✓ Config saved to .rc-debug.json\x1b[0m');
    console.log('  Run \x1b[1mrc-debug watch\x1b[0m to start the dashboard.\n');
  } catch (err) {
    console.error(`\n  \x1b[31m✗ Failed to save config: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}

// ─── Tier 2 #5: Auto-discovery ─────────────────────────────────────────

async function autoDiscover(config) {
  console.log('\n  \x1b[90mAuto-discovering contracts from RC subscriptions...\x1b[0m');

  // Resolve RVM ID
  let rvmId;
  try {
    rvmId = await rnkGetRvmId(config.contracts.rc.address, config.network);
    if (!rvmId) throw new Error('RVM not found');
    console.log(`  RVM ID: ${rvmId}`);
  } catch (err) {
    console.error(`  \x1b[31m✗ Could not resolve RVM: ${err.message}\x1b[0m`);
    console.log('  Falling back to manual setup.\n');
    return manualSetup(config);
  }

  // Fetch subscriptions
  let subs;
  try {
    subs = await rnkGetSubscribers(rvmId, config.network);
    console.log(`  Found ${subs?.length || 0} subscriptions`);
  } catch {
    console.log('  \x1b[33m⚠ Could not fetch subscriptions\x1b[0m');
    return manualSetup(config);
  }

  if (!subs?.length) {
    console.log('  \x1b[33m⚠ No subscriptions found. RC may not be set up yet.\x1b[0m');
    return manualSetup(config);
  }

  // Extract unique contracts and chains from subscriptions
  const discovered = new Map(); // "chainId:contract" → { chainId, contract, topics[] }
  const cronSubs = [];

  for (const s of subs) {
    const chainId = Number(s.chainId);
    const contract = (s.contract || '').toLowerCase();
    const topic0 = Array.isArray(s.topics) ? (s.topics[0] || '') : '';

    if (isRnChainId(chainId)) {
      // System subscription (cron or self-callback target)
      if (CRON_TOPICS[topic0.toLowerCase()]) {
        cronSubs.push({ topic0, cronName: CRON_TOPICS[topic0.toLowerCase()] });
      }
      continue;
    }

    const key = `${chainId}:${contract}`;
    if (!discovered.has(key)) {
      discovered.set(key, { chainId, contract, topics: [] });
    }
    discovered.get(key).topics.push(topic0);
  }

  // Also discover callback targets from recent txs
  let callbackTargets = [];
  try {
    console.log('  Scanning recent transactions for callback targets...');
    callbackTargets = await discoverCallbackPatterns(rvmId, config.network, 30);
    if (callbackTargets.length) {
      console.log(`  Found ${callbackTargets.length} callback target(s)`);
    }
  } catch {}

  // Build a list of discovered contracts for the user to confirm
  console.log('\n  \x1b[1mDiscovered contracts:\x1b[0m');

  const originContracts = [...discovered.values()];
  const destContracts = callbackTargets
    .filter(cb => !cb.isSelfCallback)
    .map(cb => ({ chainId: cb.destChainId, contract: cb.destContract }));

  // Deduplicate dest contracts
  const destSeen = new Set();
  const uniqueDest = destContracts.filter(d => {
    const k = `${d.chainId}:${d.contract}`;
    if (destSeen.has(k)) return false;
    destSeen.add(k);
    return true;
  });

  // Show origins
  if (originContracts.length) {
    console.log('\n  \x1b[33mOrigin contracts (event sources):\x1b[0m');
    for (let i = 0; i < Math.min(originContracts.length, 10); i++) {
      const c = originContracts[i];
      console.log(`    ${i + 1}. ${c.contract} on ${chainName(c.chainId)} (${c.chainId}) — ${c.topics.length} topic(s)`);
    }
    if (originContracts.length > 10) {
      console.log(`    ... and ${originContracts.length - 10} more`);
    }
  }

  // Show destinations
  if (uniqueDest.length) {
    console.log('\n  \x1b[33mCallback targets (destinations):\x1b[0m');
    for (const d of uniqueDest) {
      console.log(`    → ${d.contract} on ${chainName(d.chainId)} (${d.chainId})`);
    }
  }

  if (cronSubs.length) {
    console.log(`\n  \x1b[35mCron subscriptions:\x1b[0m ${cronSubs.map(c => c.cronName).join(', ')}`);
  }

  // Let user pick the origin contract
  if (originContracts.length > 0) {
    const originChoices = originContracts.slice(0, 15).map((c, i) => ({
      title: `${c.contract.slice(0, 12)}... on ${chainName(c.chainId)} (${c.topics.length} topics)`,
      value: c,
    }));

    const { origin } = await prompts({
      type: 'select', name: 'origin',
      message: 'Select your origin contract',
      choices: originChoices,
    });

    if (origin) {
      config.contracts.origin = { address: origin.contract, chainId: origin.chainId };
    }
  }

  if (!config.contracts.origin?.address) {
    console.log('  \x1b[33m⚠ No origin contract selected.\x1b[0m');
    const ans = await prompts([
      { type: 'text', name: 'address', message: 'Origin contract address',
        validate: v => /^0x[0-9a-fA-F]{40}$/.test(v) || 'Enter a valid address' },
      { type: 'select', name: 'chainId', message: 'Origin chain', choices: chainChoices },
    ]);
    if (ans.address) config.contracts.origin = { address: ans.address, chainId: ans.chainId };
  }

  // Pick callback contract
  if (uniqueDest.length > 0) {
    const destChoices = uniqueDest.map(d => ({
      title: `${d.contract.slice(0, 12)}... on ${chainName(d.chainId)}`,
      value: d,
    }));

    const { dest } = await prompts({
      type: 'select', name: 'dest',
      message: 'Select your callback contract',
      choices: destChoices,
    });

    if (dest) {
      config.contracts.callback = { address: dest.contract, chainId: dest.chainId };
    }
  }

  if (!config.contracts.callback?.address) {
    // Check if singleton
    if (config.contracts.origin?.address) {
      const { isSingleton } = await prompts({
        type: 'confirm', name: 'isSingleton',
        message: 'Is the callback contract the same as the origin (singleton)?',
        initial: false,
      });
      if (isSingleton) {
        config.contracts.callback = { ...config.contracts.origin };
        config.singleton = true;
      } else {
        const ans = await prompts([
          { type: 'text', name: 'address', message: 'Callback contract address',
            validate: v => /^0x[0-9a-fA-F]{40}$/.test(v) || 'Enter a valid address' },
          { type: 'select', name: 'chainId', message: 'Callback chain', choices: chainChoices },
        ]);
        if (ans.address) config.contracts.callback = { address: ans.address, chainId: ans.chainId };
      }
    }
  }

  // Check if origin == callback on same chain (singleton)
  if (config.contracts.origin?.address?.toLowerCase() === config.contracts.callback?.address?.toLowerCase() &&
      config.contracts.origin?.chainId === config.contracts.callback?.chainId) {
    config.singleton = true;
  }
}

// ─── Manual setup (original flow) ──────────────────────────────────────

async function manualSetup(config) {
  const { singleton } = await prompts({
    type: 'confirm', name: 'singleton',
    message: 'Is the origin and callback the same contract (singleton)?',
    initial: false,
  });
  config.singleton = singleton;

  if (singleton) {
    console.log('\n  \x1b[33m▶ Origin + Callback Contract (singleton)\x1b[0m');
    const q = await prompts([
      { type: 'text', name: 'address', message: 'Contract deployed address',
        validate: v => /^0x[0-9a-fA-F]{40}$/.test(v) || 'Enter a valid address (0x...)' },
      { type: 'select', name: 'chainId', message: 'Contract chain', choices: chainChoices },
    ]);
    if (!q.address) return;
    config.contracts.origin = { address: q.address, chainId: q.chainId };
    config.contracts.callback = { address: q.address, chainId: q.chainId };
  } else {
    console.log('\n  \x1b[33m▶ Origin Contract\x1b[0m');
    const oq = await prompts([
      { type: 'text', name: 'address', message: 'Origin contract address',
        validate: v => /^0x[0-9a-fA-F]{40}$/.test(v) || 'Enter a valid address' },
      { type: 'select', name: 'chainId', message: 'Origin chain', choices: chainChoices },
    ]);
    if (oq.address) config.contracts.origin = { address: oq.address, chainId: oq.chainId };

    console.log('\n  \x1b[33m▶ Callback Contract (CC)\x1b[0m');
    const cq = await prompts([
      { type: 'text', name: 'address', message: 'Callback contract address',
        validate: v => /^0x[0-9a-fA-F]{40}$/.test(v) || 'Enter a valid address' },
      { type: 'select', name: 'chainId', message: 'Callback chain', choices: chainChoices },
    ]);
    if (cq.address) config.contracts.callback = { address: cq.address, chainId: cq.chainId };
  }
}

// ─── ABI resolution ────────────────────────────────────────────────────

async function resolveAbis(config) {
  console.log('\n  \x1b[90mResolving ABIs...\x1b[0m');

  const resolvedAbis = new Map();
  const resolvedArtifacts = new Map();
  const seen = new Set();
  const toResolve = [];

  for (const [role, c] of Object.entries(config.contracts)) {
    if (!c?.address) continue;
    const key = c.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    toResolve.push({ role, address: c.address, chainId: c.chainId });
  }

  const localArtifacts = listLocalArtifacts();
  const skipPrefixes = ['Abstract', 'I', 'Std', 'Test', 'Script', 'Vm', 'IMulticall'];
  const userContracts = [...localArtifacts.entries()].filter(([name]) =>
    !skipPrefixes.some(p => name.startsWith(p))
  );
  if (userContracts.length > 0) {
    console.log(`  Found ${userContracts.length} local contract artifacts`);
  }

  for (const { role, address, chainId } of toResolve) {
    // 1. Local artifact picker
    if (userContracts.length > 0) {
      const choices = [
        ...userContracts.map(([name, entry]) => ({
          title: name, value: entry,
          description: entry.path.split('/').slice(-2).join('/'),
        })),
        { title: '(skip — fetch from explorer)', value: null },
      ];
      const { picked } = await prompts({
        type: 'select', name: 'picked',
        message: `${role}: select contract artifact`,
        choices,
      });
      if (picked) {
        resolvedAbis.set(address.toLowerCase(), picked.abi);
        resolvedArtifacts.set(address.toLowerCase(), picked.path);
        console.log(`  \x1b[32m✓\x1b[0m ${picked.path.split('/').slice(-2).join('/')}`);
        continue;
      }
    }

    // 2. Etherscan
    process.stdout.write(`  ${role}: fetching from block explorer... `);
    const abi = await fetchAbi(chainId, address);
    if (abi) { resolvedAbis.set(address.toLowerCase(), abi); console.log('\x1b[32m✓\x1b[0m'); continue; }
    console.log('\x1b[33m✗ not verified\x1b[0m');

    // 3. Manual path
    const { artifactPath } = await prompts({
      type: 'text', name: 'artifactPath',
      message: `  ${role}: provide ABI path (or Enter to skip)`,
    });
    if (artifactPath) {
      const fileAbi = loadAbiFromFile(artifactPath);
      if (fileAbi) {
        resolvedAbis.set(address.toLowerCase(), fileAbi);
        resolvedArtifacts.set(address.toLowerCase(), artifactPath);
        console.log(`  \x1b[32m✓ Loaded\x1b[0m`);
      } else {
        console.log(`  \x1b[31m✗ Could not parse\x1b[0m`);
      }
    }
  }

  for (const c of Object.values(config.contracts)) {
    if (!c?.address) continue;
    const key = c.address.toLowerCase();
    if (resolvedAbis.has(key)) c.abi = resolvedAbis.get(key);
    if (resolvedArtifacts.has(key)) c.artifact = resolvedArtifacts.get(key);
  }
}

// ─── On-chain validation ───────────────────────────────────────────────

async function validateOnChain(config) {
  console.log('\n  \x1b[90mValidating on-chain...\x1b[0m');
  let warnings = 0;

  try {
    process.stdout.write('  RC on Reactive Network... ');
    const rvmId = await rnkGetRvmId(config.contracts.rc.address, config.network);
    if (rvmId) {
      console.log(`\x1b[32m✓\x1b[0m RVM: ${rvmId.slice(0, 12)}...`);
      try {
        const subs = await rnkGetSubscribers(rvmId, config.network);
        const count = subs?.length || 0;
        console.log(count > 0
          ? `  Subscriptions: \x1b[32m✓\x1b[0m ${count} found`
          : '  Subscriptions: \x1b[33m⚠ none found\x1b[0m');
        if (!count) warnings++;
      } catch { console.log('  Subscriptions: \x1b[33m⚠ could not check\x1b[0m'); warnings++; }
    } else {
      console.log('\x1b[31m✗ not found\x1b[0m'); warnings++;
    }
  } catch (err) {
    console.log(`\x1b[31m✗\x1b[0m ${err.message.slice(0, 60)}`); warnings++;
  }

  for (const [role, c] of Object.entries(config.contracts)) {
    if (!c?.address || !c.chainId || role === 'rc') continue;
    try {
      process.stdout.write(`  ${role} chain (${chainName(c.chainId)})... `);
      const block = await ethBlockNumber(c.chainId);
      console.log(block > 0 ? `\x1b[32m✓\x1b[0m block ${block.toLocaleString()}` : '\x1b[33m⚠ unreachable\x1b[0m');
      if (!block) warnings++;
    } catch { console.log('\x1b[31m✗ RPC unreachable\x1b[0m'); warnings++; }
  }

  if (warnings > 0) {
    console.log(`\n  \x1b[33m${warnings} warning(s)\x1b[0m`);
    const { proceed } = await prompts({
      type: 'confirm', name: 'proceed', message: 'Save config anyway?', initial: true,
    });
    if (!proceed) { console.log('  Aborted.'); process.exit(0); }
  }
}
