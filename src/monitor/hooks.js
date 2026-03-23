// Tier 3 #15: Notification hooks — execute shell commands on flow events

import { exec } from 'child_process';

export class HookRunner {
  constructor(hooks) {
    this.hooks = hooks || {};
  }

  onFlowComplete(instance) {
    if (instance.failed && this.hooks.onFailure) {
      this._run(this.hooks.onFailure, instance);
    }
    if (!instance.failed && instance.completed && this.hooks.onSuccess) {
      this._run(this.hooks.onSuccess, instance);
    }
  }

  _run(command, instance) {
    // Substitute variables in the command
    const env = {
      ...process.env,
      RC_FLOW_NAME: instance.flow.name,
      RC_FLOW_STATUS: instance.failed ? 'failed' : 'success',
      RC_FLOW_DURATION: instance.duration,
      RC_FAIL_REASON: instance.failReason || '',
      RC_TRIGGER_ID: instance.triggerId || '',
    };

    try {
      exec(command, { env, timeout: 10000 }, (err) => {
        // Silent — hooks shouldn't break the dashboard
      });
    } catch {
      // Ignore hook errors
    }
  }
}
