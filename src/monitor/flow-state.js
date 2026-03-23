// Flow instance state machine — tracks each live flow execution through its steps

/**
 * Node states
 */
export const STATE = {
  IDLE:       'idle',       // ○ gray
  WAITING:    'waiting',    // ◌ dim
  PROGRESS:   'progress',   // ◐ yellow
  SUCCESS:    'success',    // ● green
  FAILED:     'failed',     // ● red
};

/**
 * A FlowInstance represents one execution of a flow
 * (one origin event → RC → callback → dest execution)
 */
export class FlowInstance {
  constructor(flow, triggerId) {
    this.flow = flow;
    this.id = `${flow.id}:${triggerId}`;
    this.triggerId = triggerId;
    this.startTime = Date.now();
    this.endTime = null;

    // 4 nodes
    this.nodes = {
      origin:   { state: STATE.IDLE, data: null, label: 'Origin Event' },
      rcWatch:  { state: STATE.IDLE, data: null, label: 'RC react()' },
      callback: { state: STATE.IDLE, data: null, label: 'Callback' },
      dest:     { state: STATE.IDLE, data: null, label: 'Dest Exec' },
    };

    // For self-callback chains
    this.hops = [];
    this.completed = false;
    this.failed = false;
    this.failReason = null;
  }

  setOriginDetected(data) {
    this.nodes.origin.state = STATE.SUCCESS;
    this.nodes.origin.data = data;
    this.nodes.origin._timestamp = Date.now();
    this.nodes.rcWatch.state = STATE.PROGRESS;
  }

  setRcObserved(data) {
    this.nodes.rcWatch.state = STATE.SUCCESS;
    this.nodes.rcWatch.data = data;
    this.nodes.rcWatch._timestamp = Date.now();
    this.nodes.callback.state = STATE.PROGRESS;
  }

  setCallbackEmitted(data) {
    this.nodes.callback.state = STATE.SUCCESS;
    this.nodes.callback.data = data;
    this.nodes.callback._timestamp = Date.now();
    this.nodes.dest.state = STATE.PROGRESS;
  }

  setDestExecuted(data) {
    this.nodes.dest.state = data.success !== false ? STATE.SUCCESS : STATE.FAILED;
    this.nodes.dest.data = data;
    this.nodes.dest._timestamp = Date.now();
    this.completed = true;
    this.failed = data.success === false;
    this.failReason = data.revertReason || null;
    this.endTime = Date.now();
  }

  setFailed(step, reason) {
    const node = this.nodes[step];
    if (node) {
      node.state = STATE.FAILED;
      node.data = { error: reason };
    }
    this.completed = true;
    this.failed = true;
    this.failReason = reason;
    this.endTime = Date.now();
  }

  addHop(hopData) {
    this.hops.push(hopData);
  }

  get duration() {
    const end = this.endTime || Date.now();
    return ((end - this.startTime) / 1000).toFixed(1);
  }

  get stateSymbols() {
    return Object.values(this.nodes).map(n => {
      switch (n.state) {
        case STATE.SUCCESS:  return '{green-fg}\u25CF{/green-fg}';
        case STATE.FAILED:   return '{red-fg}\u25CF{/red-fg}';
        case STATE.PROGRESS: return '{yellow-fg}\u25D0{/yellow-fg}';
        case STATE.WAITING:  return '{white-fg}\u25CC{/white-fg}';
        default:             return '{white-fg}\u25CB{/white-fg}';
      }
    });
  }

  get summaryLine() {
    const symbols = Object.values(this.nodes).map(n => {
      switch (n.state) {
        case STATE.SUCCESS:  return '\x1b[32m\u25CF\x1b[0m';
        case STATE.FAILED:   return '\x1b[31m\u25CF\x1b[0m';
        case STATE.PROGRESS: return '\x1b[33m\u25D0\x1b[0m';
        case STATE.WAITING:  return '\x1b[90m\u25CC\x1b[0m';
        default:             return '\x1b[90m\u25CB\x1b[0m';
      }
    }).join(' \u2500\u25B6 ');

    const ts = new Date(this.startTime).toLocaleTimeString();
    const status = this.failed ? '\x1b[31m\u2717\x1b[0m' : this.completed ? '\x1b[32m\u2713\x1b[0m' : '\x1b[33m\u2026\x1b[0m';

    return `${ts}  ${status} ${this.flow.name}  ${symbols}  (${this.duration}s)`;
  }
}

/**
 * FlowTracker manages all active and recent flow instances
 */
export class FlowTracker {
  constructor(maxHistory = 50) {
    this.active = new Map();     // id → FlowInstance
    this.history = [];           // completed instances
    this.maxHistory = maxHistory;
    this.listeners = [];
  }

  onChange(fn) {
    this.listeners.push(fn);
  }

  emit() {
    for (const fn of this.listeners) fn();
  }

  start(flow, triggerId) {
    const instance = new FlowInstance(flow, triggerId);
    this.active.set(instance.id, instance);
    this.emit();
    return instance;
  }

  complete(instance) {
    if (instance._completed) return; // Guard against double-completion
    instance._completed = true;
    this.active.delete(instance.id);
    this.history.unshift(instance);
    if (this.history.length > this.maxHistory) this.history.pop();
    this.emit();
  }

  getActive() {
    return [...this.active.values()];
  }

  getHistory() {
    return this.history;
  }

  getAll() {
    return [...this.active.values(), ...this.history];
  }
}
