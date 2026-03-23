// Tier 2 #7: Flow statistics tracker

export class StatsTracker {
  constructor() {
    this.totalFlows = 0;
    this.successCount = 0;
    this.failCount = 0;
    this.durations = [];  // last 100 durations in ms
    this.lastFlowTime = null;
    this.startTime = Date.now();
  }

  record(instance) {
    this.totalFlows++;
    if (instance.failed) {
      this.failCount++;
    } else {
      this.successCount++;
    }
    if (instance.endTime && instance.startTime) {
      this.durations.push(instance.endTime - instance.startTime);
      if (this.durations.length > 100) this.durations.shift();
    }
    this.lastFlowTime = Date.now();
  }

  get successRate() {
    if (this.totalFlows === 0) return 100;
    return Math.round((this.successCount / this.totalFlows) * 100);
  }

  get avgDuration() {
    if (this.durations.length === 0) return 0;
    const sum = this.durations.reduce((a, b) => a + b, 0);
    return (sum / this.durations.length / 1000).toFixed(1);
  }

  get lastDuration() {
    if (this.durations.length === 0) return null;
    return (this.durations[this.durations.length - 1] / 1000).toFixed(1);
  }

  get uptime() {
    const ms = Date.now() - this.startTime;
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }

  get timeSinceLastFlow() {
    if (!this.lastFlowTime) return 'never';
    const ms = Date.now() - this.lastFlowTime;
    if (ms < 1000) return 'just now';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    return `${m}m ago`;
  }

  get summary() {
    const rate = this.totalFlows > 0 ? `${this.successRate}%` : '-';
    const avg = this.durations.length > 0 ? `${this.avgDuration}s` : '-';
    const last = this.lastDuration ? `${this.lastDuration}s` : '-';
    return `${this.totalFlows} flows | ${rate} success | avg ${avg} | last ${this.timeSinceLastFlow}`;
  }
}
