// .rc-debug.json config file management

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const CONFIG_NAME = '.rc-debug.json';

export function configPath(dir = process.cwd()) {
  return resolve(dir, CONFIG_NAME);
}

export function configExists(dir) {
  return existsSync(configPath(dir));
}

export function loadConfig(dir) {
  const p = configPath(dir);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8'));
    // Tier 3 #14: Normalize multi-RC format
    // Support both { contracts: { rc: {...} } } and { contracts: { rcs: [...] } }
    if (raw.contracts?.rcs?.length && !raw.contracts?.rc) {
      // Multi-RC: use first as primary, keep all in rcs array
      raw.contracts.rc = raw.contracts.rcs[0];
    }
    return raw;
  } catch {
    return null;
  }
}

export function saveConfig(config, dir) {
  writeFileSync(configPath(dir), JSON.stringify(config, null, 2) + '\n');
}

export function defaultConfig() {
  return {
    network: 'lasna',
    contracts: {
      rc:       { address: '', chainId: null },
      origin:   { address: '', chainId: null },
      callback: { address: '', chainId: null },
    },
    singleton: false,
    customFlows: [],
    pollInterval: 3000,
    // Tier 3 #15: Notification hooks
    hooks: {
      onFailure: null,  // shell command, e.g. "curl -X POST https://slack.webhook/..."
      onSuccess: null,  // shell command
    },
  };
}

export function validateConfig(config) {
  const errors = [];
  if (!config.network) errors.push('Missing network (mainnet/lasna)');
  else if (config.network !== 'mainnet' && config.network !== 'lasna') errors.push(`Invalid network "${config.network}" — must be "mainnet" or "lasna"`);
  if (!config.contracts?.rc?.address) errors.push('Missing RC address');
  if (config.singleton) {
    if (!config.contracts.origin?.address) errors.push('Missing origin/callback address');
  } else {
    if (!config.contracts.origin?.address) errors.push('Missing origin contract address');
    if (!config.contracts.callback?.address) errors.push('Missing callback contract address');
  }
  return errors;
}

/**
 * Get all RC configs (for multi-RC support)
 * Returns array of { address, chainId, name? }
 */
export function getAllRcs(config) {
  if (config.contracts?.rcs?.length) {
    return config.contracts.rcs;
  }
  if (config.contracts?.rc?.address) {
    return [config.contracts.rc];
  }
  return [];
}
