// Add custom flow pattern interactively

import prompts from 'prompts';
import { loadConfig, saveConfig } from '../lib/config.js';
import { allChains, RN_CHAIN_IDS } from '../lib/chains.js';
import { toEventSelector } from 'viem';

const evmChains = allChains().filter(c => !RN_CHAIN_IDS.has(c.chainId));
const chainChoices = evmChains.map(c => ({ title: `${c.name} (${c.chainId})`, value: c.chainId }));

export default async function addFlow() {
  const config = loadConfig();
  if (!config) {
    console.error('  No .rc-debug.json found. Run \x1b[1mrc-debug init\x1b[0m first.');
    process.exit(1);
  }

  console.log('\n  \x1b[36m\x1b[1mAdd Custom Flow\x1b[0m\n');
  console.log('  Define a reactive flow the tool should monitor.\n');

  const answers = await prompts([
    {
      type: 'text',
      name: 'name',
      message: 'Flow name (e.g. "PriceAlert")',
      validate: v => v.length > 0 ? true : 'Name required',
    },
    {
      type: 'select',
      name: 'triggerType',
      message: 'Trigger type',
      choices: [
        { title: 'Event (from origin chain)', value: 'event' },
        { title: 'Cron (periodic)', value: 'cron' },
        { title: 'Feedback (from CC)', value: 'feedback' },
      ],
    },
  ]);

  if (!answers.name) return;

  let trigger;

  if (answers.triggerType === 'cron') {
    const { cronInterval } = await prompts({
      type: 'select',
      name: 'cronInterval',
      message: 'Cron interval',
      choices: [
        { title: 'Every block (~7s)', value: '0xf02d6ea5c22a71cffe930a4523fcb4f129be6c804db50e4202fb4e0b07ccb514' },
        { title: 'Every 10 blocks (~1m)', value: '0x04463f7c1651e6b9774d7f85c85bb94654e3c46ca79b0c16fb16d4183307b687' },
        { title: 'Every 100 blocks (~12m)', value: '0xb49937fb8970e19fd46d48f7e3fb00d659deac0347f79cd7cb542f0fc1503c70' },
        { title: 'Every 1000 blocks (~2h)', value: '0xe20b31294d84c3661ddc8f423abb9c70310d0cf172aa2714ead78029b325e3f4' },
        { title: 'Every 10000 blocks (~28h)', value: '0xd214e1d84db704ed42d37f538ea9bf71e44ba28bc1cc088b2f5deca654677a56' },
      ],
    });
    trigger = { type: 'cron', topic0: cronInterval, eventName: 'Cron' };
  } else {
    const triggerAnswers = await prompts([
      {
        type: 'text',
        name: 'eventSig',
        message: 'Event signature (e.g. "Transfer(address,address,uint256)")',
        validate: v => {
          if (!v.includes('(') || !v.includes(')')) return 'Use format: EventName(type1,type2)';
          try { toEventSelector(v); return true; }
          catch { return 'Invalid signature. Example: Transfer(address,address,uint256)'; }
        },
      },
      {
        type: 'autocomplete',
        name: 'chainId',
        message: 'Trigger chain',
        choices: chainChoices,
        suggest: (input, choices) =>
          choices.filter(c => c.title.toLowerCase().includes(input.toLowerCase())),
      },
      {
        type: 'text',
        name: 'contract',
        message: 'Trigger contract address',
        validate: v => /^0x[0-9a-fA-F]{40}$/.test(v) ? true : 'Enter a valid address',
      },
    ]);

    if (!triggerAnswers.eventSig) return;

    const topic0 = toEventSelector(triggerAnswers.eventSig);
    const eventName = triggerAnswers.eventSig.split('(')[0];

    trigger = {
      type: answers.triggerType,
      chainId: triggerAnswers.chainId,
      contract: triggerAnswers.contract.toLowerCase(),
      topic0,
      eventName,
    };
  }

  // Callback target
  const cbAnswers = await prompts([
    {
      type: 'text',
      name: 'fnSig',
      message: 'Callback function signature (e.g. "processTransfer(address,uint256)")',
      validate: v => v.includes('(') && v.includes(')') ? true : 'Use format: fnName(type1,type2)',
    },
    {
      type: 'autocomplete',
      name: 'chainId',
      message: 'Callback chain',
      choices: chainChoices,
      suggest: (input, choices) =>
        choices.filter(c => c.title.toLowerCase().includes(input.toLowerCase())),
    },
  ]);

  if (!cbAnswers.fnSig) return;

  const callback = {
    type: 'dest',
    chainId: cbAnswers.chainId,
    fn: cbAnswers.fnSig,
  };

  const flow = {
    name: answers.name,
    trigger,
    callback,
  };

  if (!config.customFlows) config.customFlows = [];
  config.customFlows.push(flow);
  saveConfig(config);

  console.log(`\n  \x1b[32m\u2713 Flow "${answers.name}" added.\x1b[0m`);
  console.log('  Run \x1b[1mrc-debug watch\x1b[0m to see it in the dashboard.\n');
}
