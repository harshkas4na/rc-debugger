// Maps known failure patterns to actionable diagnostic hints

const FAILURE_PATTERNS = [
  {
    match: (step, msg) => step === 'dest' && msg.includes('Callback not found') && msg.includes('timeout'),
    hint: (ctx) => {
      const lines = [
        'Possible causes:',
        '  (1) RC underfunded — no REACT to pay for callback delivery',
        '  (2) Gas limit too low' + (ctx.gasLimit ? ` (current: ${ctx.gasLimit})` : '') + ' — minimum is 100,000',
        '  (3) CC rejects callback — check authorizedSenderOnly uses the correct callback proxy address',
        '  (4) CC function missing address as first param (RVM ID slot)',
      ];
      lines.push('  Run `rc-debug diagnose` to check funding and proxy config');
      return lines.join('\n');
    },
  },
  {
    match: (step, msg) => step === 'callback' && msg.includes('No callbacks or logs emitted'),
    hint: () => [
      'RC react() ran successfully but emitted no Callback events. Check:',
      '  (1) Does react() match the event topic_0? Verify with: cast keccak "EventName(type1,type2)"',
      '  (2) Is react() reading state written after deploy? ReactVM state is frozen at deploy time',
      '  (3) Are there conditional guards in react() that filtered this event out?',
    ].join('\n'),
  },
  {
    match: (step, msg) => msg.includes('Self-callback delivery failed'),
    hint: () => [
      'Self-callback to RC reverted on delivery. Check:',
      '  (1) Does the persist function have address as first param? (RVM ID slot)',
      '  (2) Is the function signature in abi.encodeWithSignature() exact?',
      '  (3) Does the function have the callbackOnly modifier?',
      '  (4) Is the RC address correct in: emit Callback(block.chainid, address(this), ...)',
    ].join('\n'),
  },
  {
    match: (step, msg) => msg.includes('Self-callback revert'),
    hint: () => [
      'Self-callback persist function reverted with an error.',
      '  Persist functions (callbackOnly) run on Reactive Network, not in ReactVM.',
      '  State written here is invisible to react() — this is expected.',
      '  But subscription changes via service.subscribe() DO take effect.',
    ].join('\n'),
  },
  {
    match: (step, msg) => step === 'rcWatch' && (msg.includes('reverted') || msg.includes('Panic')),
    hint: () => [
      'RC transaction reverted — react() itself failed. Check:',
      '  (1) Does the LogRecord match expected format? (topic count, data encoding)',
      '  (2) Are there require() or assert() statements in react() that might fail?',
      '  (3) Is react() accessing an array out of bounds or dividing by zero?',
      '  (4) Panic(0x01)=assert, Panic(0x11)=overflow, Panic(0x12)=div-by-zero, Panic(0x32)=array-oob',
    ].join('\n'),
  },
  {
    match: (step, msg) => step === 'rcWatch' && msg.includes('gas'),
    hint: () => [
      'RC transaction ran out of gas. ReactVM max gas is 900,000 units.',
      '  (1) Simplify react() logic — avoid loops or heavy computation',
      '  (2) Move complex logic to the CC side via callback',
    ].join('\n'),
  },
];

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
