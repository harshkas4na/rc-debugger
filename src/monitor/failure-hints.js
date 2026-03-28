// Maps known failure patterns to actionable diagnostic hints
// Includes debt-aware diagnostics and CallbackFailure event detection

const FAILURE_PATTERNS = [
  // ── Debt / funding related ────────────────────────────────────────────
  {
    match: (step, msg) => step === 'dest' && msg.includes('Callback not found') && msg.includes('timeout'),
    hint: (ctx) => {
      const lines = [
        'Possible causes:',
      ];
      // Prioritize debt/funding if we know about it
      if (ctx.rcDebt > 0) {
        lines.push(`  (!) RC is IN DEBT (${ctx.rcDebt.toPrecision(3)} REACT) — callbacks are blocked until debt is cleared`);
        lines.push('      Fix: call coverDebt() or send REACT to the system contract');
      }
      if (ctx.rcBalance !== undefined && ctx.rcBalance <= 0) {
        lines.push('  (!) RC has 0 REACT balance — cannot pay for callback delivery');
        lines.push('      Fix: fund RC with lREACT faucet (testnet) or depositTo()');
      }
      lines.push('  (1) RC underfunded — no REACT to pay for callback delivery');
      lines.push('  (2) Gas limit too low' + (ctx.gasLimit ? ` (current: ${ctx.gasLimit})` : '') + ' — minimum is 100,000');
      lines.push('  (3) CC rejects callback — check authorizedSenderOnly uses the correct callback proxy address');
      lines.push('  (4) CC function missing address as first param (RVM ID slot)');
      lines.push('  Run `rc-debug diagnose` to check funding and proxy config');
      return lines.join('\n');
    },
  },

  // ── CallbackFailure event detected ────────────────────────────────────
  {
    match: (step, msg) => msg.includes('CallbackFailure'),
    hint: (ctx) => {
      const lines = [
        'A CallbackFailure event was emitted — the callback was delivered but the destination contract reverted.',
        '',
        'Common causes:',
      ];
      if (ctx.ccDebt > 0) {
        lines.push(`  (!) CC is IN DEBT (${ctx.ccDebt.toPrecision(3)} ETH) — the system blocks callbacks to indebted contracts`);
        lines.push('      Fix: send ETH to the system contract or call coverDebt() on the CC');
      }
      lines.push('  (1) Wrong RVM ID address — the CC\'s authorizedSenderOnly check is failing');
      lines.push('      The _callbackSender in AbstractCallback must be the Callback Proxy for the dest chain, NOT your wallet');
      lines.push('  (2) CC function missing address as first param (RVM ID slot)');
      lines.push('      Every callback function must have address as its first parameter');
      lines.push('  (3) CC function reverted — a require() or assert() in the CC logic failed');
      lines.push('  (4) Gas limit too low — the callback ran out of gas mid-execution');
      if (ctx.gasLimit && ctx.gasLimit < 200000) {
        lines.push(`      Current gas limit: ${ctx.gasLimit} — try increasing to 1,000,000+`);
      }
      lines.push('');
      lines.push('  Check the dest chain tx for revert details, or run `rc-debug diagnose`');
      return lines.join('\n');
    },
  },

  // ── Dest callback failed (tx found but reverted) ─────────────────────
  {
    match: (step, msg) => step === 'dest' && (msg.includes('FAILED') || msg.includes('reverted')),
    hint: (ctx) => {
      const lines = [
        'Callback was delivered to the destination chain but the transaction reverted.',
        '',
        'Possible causes:',
      ];
      if (ctx.ccDebt > 0) {
        lines.push(`  (!) CC is IN DEBT — callbacks are blocked for indebted contracts`);
      }
      lines.push('  (1) CC\'s authorizedSenderOnly check failed — _callbackSender must be the Callback Proxy address for this chain');
      lines.push('  (2) CC function missing address as first param — all callback functions need address (RVM ID) as first parameter');
      lines.push('  (3) Business logic revert — a require()/assert() in the CC function failed');
      lines.push('  (4) Insufficient gas — try increasing CALLBACK_GAS_LIMIT in your RC');
      lines.push('');
      lines.push('  Check the revert reason above for details');
      return lines.join('\n');
    },
  },

  // ── No callbacks emitted ──────────────────────────────────────────────
  {
    match: (step, msg) => step === 'callback' && msg.includes('No callbacks or logs emitted'),
    hint: (ctx) => {
      const lines = [
        'RC react() ran successfully but emitted no Callback events.',
        '',
        'Check:',
      ];
      if (ctx.rcDebt > 0) {
        lines.push(`  (!) RC is IN DEBT (${ctx.rcDebt.toPrecision(3)} REACT) — subscribers in debt are skipped by the system`);
        lines.push('      This means react() may not be receiving events at all');
      }
      lines.push('  (1) Does react() match the event topic_0? Verify with: cast keccak "EventName(type1,type2)"');
      lines.push('  (2) Is react() reading state written after deploy? ReactVM state is frozen at deploy time');
      lines.push('  (3) Are there conditional guards in react() that filtered this event out?');
      return lines.join('\n');
    },
  },

  // ── Self-callback delivery failed ─────────────────────────────────────
  {
    match: (step, msg) => msg.includes('Self-callback delivery failed'),
    hint: (ctx) => {
      const lines = [
        'Self-callback to RC reverted on delivery.',
        '',
        'Check:',
        '  (1) Does the persist function have address as first param? (RVM ID slot)',
        '  (2) Is the function signature in abi.encodeWithSignature() exact?',
        '  (3) Does the function have the callbackOnly modifier?',
        '  (4) Is the RC address correct in: emit Callback(block.chainid, address(this), ...)',
      ];
      if (ctx.rcDebt > 0) {
        lines.push('');
        lines.push(`  (!) RC is IN DEBT — self-callbacks may be blocked`);
      }
      return lines.join('\n');
    },
  },

  // ── Self-callback revert ──────────────────────────────────────────────
  {
    match: (step, msg) => msg.includes('Self-callback revert'),
    hint: () => [
      'Self-callback persist function reverted with an error.',
      '  Persist functions (callbackOnly) run on Reactive Network, not in ReactVM.',
      '  State written here is invisible to react() — this is expected.',
      '  But subscription changes via service.subscribe() DO take effect.',
    ].join('\n'),
  },

  // ── RC transaction reverted ───────────────────────────────────────────
  {
    match: (step, msg) => step === 'rcWatch' && (msg.includes('reverted') || msg.includes('Panic')),
    hint: (ctx) => {
      const lines = [
        'RC transaction reverted — react() itself failed.',
        '',
        'Check:',
      ];
      if (ctx.rcDebt > 0) {
        lines.push(`  (!) RC is IN DEBT (${ctx.rcDebt.toPrecision(3)} REACT) — this may cause the system to skip or fail transactions`);
      }
      lines.push('  (1) Does the LogRecord match expected format? (topic count, data encoding)');
      lines.push('  (2) Are there require() or assert() statements in react() that might fail?');
      lines.push('  (3) Is react() accessing an array out of bounds or dividing by zero?');
      lines.push('  (4) Panic(0x01)=assert, Panic(0x11)=overflow, Panic(0x12)=div-by-zero, Panic(0x32)=array-oob');
      return lines.join('\n');
    },
  },

  // ── RC out of gas ─────────────────────────────────────────────────────
  {
    match: (step, msg) => step === 'rcWatch' && msg.includes('gas'),
    hint: () => [
      'RC transaction ran out of gas. ReactVM max gas is 900,000 units.',
      '  (1) Simplify react() logic — avoid loops or heavy computation',
      '  (2) Move complex logic to the CC side via callback',
    ].join('\n'),
  },
];

/**
 * Check if dest execution logs contain a CallbackFailure event
 * CallbackFailure(address indexed target, bytes payload)
 * topic_0: keccak256("CallbackFailure(address,bytes)")
 */
const CALLBACK_FAILURE_TOPIC = '0x'; // Will match by name instead

export function hasCallbackFailure(logs) {
  if (!logs?.length) return false;
  return logs.some(log =>
    log.name === 'CallbackFailure' ||
    log.name?.includes('CallbackFailure') ||
    log.name?.includes('PaymentFailure')
  );
}

export function diagnoseFailure(step, rawMessage, context = {}) {
  for (const pattern of FAILURE_PATTERNS) {
    if (pattern.match(step, rawMessage)) {
      return {
        message: rawMessage,
        hint: pattern.hint(context),
      };
    }
  }
  return { message: rawMessage, hint: null };
}
