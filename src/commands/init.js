// Interactive setup — creates .rc-debug.json

import prompts from 'prompts';
import ora from 'ora';
import { saveConfig, configExists, defaultConfig } from '../lib/config.js';
import { allChains, RN_CHAIN_IDS, chainName } from '../lib/chains.js';
import { fetchAbi, findLocalArtifact, loadAbiFromFile, listLocalArtifacts } from '../lib/abi-resolver.js';
import { rnkGetRvmId, rnkGetSubscribers, ethBlockNumber } from '../lib/rpc.js';

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
  const ans = await prompts({
    type: 'text', name: 'rcAddress', message: 'RC deployed address',
    validate: v => /^0x[0-9a-fA-F]{40}$/.test(v) || 'Enter a valid address (0x...)',
  });
  if (!ans.rcAddress) return;
  config.contracts.rc = { address: ans.rcAddress, chainId: network === 'mainnet' ? 1597 : 5318007 };

  await manualSetup(config);

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

// ─── Manual setup ─────────────────────────────────────────────────────

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
    const fetchSpinner = ora({ text: `${role}: fetching ABI from block explorer...`, prefixText: ' ', color: 'cyan' }).start();
    const abi = await fetchAbi(chainId, address);
    if (abi) { resolvedAbis.set(address.toLowerCase(), abi); fetchSpinner.succeed(`${role}: ABI loaded from explorer`); continue; }
    fetchSpinner.warn(`${role}: not verified on explorer`);

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
  let warnings = 0;

  const rcSpinner = ora({ text: 'Checking RC on Reactive Network...', prefixText: ' ', color: 'cyan' }).start();
  try {
    const rvmId = await rnkGetRvmId(config.contracts.rc.address, config.network);
    if (rvmId) {
      rcSpinner.succeed(`RC found — RVM: ${rvmId.slice(0, 12)}...`);
      const subSpinner = ora({ text: 'Checking subscriptions...', prefixText: ' ', color: 'cyan' }).start();
      try {
        const subs = await rnkGetSubscribers(rvmId, config.network);
        const count = subs?.length || 0;
        if (count > 0) subSpinner.succeed(`${count} subscription(s) found`);
        else { subSpinner.warn('No subscriptions found'); warnings++; }
      } catch { subSpinner.warn('Could not check subscriptions'); warnings++; }
    } else {
      rcSpinner.fail('RC not found on Reactive Network'); warnings++;
    }
  } catch (err) {
    rcSpinner.fail(`RC check failed: ${err.message.slice(0, 60)}`); warnings++;
  }

  for (const [role, c] of Object.entries(config.contracts)) {
    if (!c?.address || !c.chainId || role === 'rc') continue;
    const chainSpinner = ora({ text: `Checking ${role} chain (${chainName(c.chainId)})...`, prefixText: ' ', color: 'cyan' }).start();
    try {
      const block = await ethBlockNumber(c.chainId);
      if (block > 0) chainSpinner.succeed(`${role} chain: ${chainName(c.chainId)} (block ${block.toLocaleString()})`);
      else { chainSpinner.warn(`${role} chain unreachable`); warnings++; }
    } catch { chainSpinner.fail(`${role} chain RPC unreachable`); warnings++; }
  }

  if (warnings > 0) {
    console.log(`\n  \x1b[33m${warnings} warning(s)\x1b[0m`);
    const { proceed } = await prompts({
      type: 'confirm', name: 'proceed', message: 'Save config anyway?', initial: true,
    });
    if (!proceed) { console.log('  Aborted.'); process.exit(0); }
  }
}
