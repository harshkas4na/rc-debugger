// Auto-resolve ABIs from block explorers (Etherscan etc.) with disk cache

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CACHE_DIR = join(homedir(), '.rc-debug', 'abi-cache');

const EXPLORER_APIS = {
  1:        'https://api.etherscan.io/api',
  8453:     'https://api.basescan.org/api',
  42161:    'https://api.arbiscan.io/api',
  10:       'https://api-optimistic.etherscan.io/api',
  137:      'https://api.polygonscan.com/api',
  43114:    'https://api.snowtrace.io/api',
  11155111: 'https://api-sepolia.etherscan.io/api',
  84532:    'https://api-sepolia.basescan.org/api',
  421614:   'https://api-sepolia.arbiscan.io/api',
};

// ─── Cache ──────────────────────────────────────────────────────────────

function cacheDir(chainId) {
  const dir = join(CACHE_DIR, String(chainId));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getCachedAbi(chainId, address) {
  const file = join(cacheDir(chainId), `${address.toLowerCase()}.json`);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function setCachedAbi(chainId, address, abi) {
  const file = join(cacheDir(chainId), `${address.toLowerCase()}.json`);
  writeFileSync(file, JSON.stringify(abi, null, 2));
}

// ─── Etherscan ABI fetch ────────────────────────────────────────────────

export async function fetchAbi(chainId, address) {
  const apiBase = EXPLORER_APIS[chainId];
  if (!apiBase) return null;

  // Check cache
  const cached = getCachedAbi(chainId, address);
  if (cached) return cached;

  const apiKey = process.env.ETHERSCAN_API_KEY || '';
  const url = `${apiBase}?module=contract&action=getabi&address=${address}${apiKey ? '&apikey=' + apiKey : ''}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) return null;
    const json = await res.json();
    if (json.status !== '1' || !json.result) return null;

    const abi = JSON.parse(json.result);
    if (!Array.isArray(abi)) return null;

    setCachedAbi(chainId, address, abi);
    return abi;
  } catch {
    return null;
  }
}

// ─── Local artifact search ──────────────────────────────────────────────

/**
 * Scan Foundry out/ and Hardhat artifacts/ for ALL compiled contract ABIs.
 * Returns Map<contractName, { abi, path }>
 */
function scanLocalArtifacts() {
  const cwd = process.cwd();
  const results = new Map();

  // Foundry: out/<ContractName>.sol/<ContractName>.json
  const foundryOut = join(cwd, 'out');
  if (existsSync(foundryOut)) {
    try {
      const dirs = readdirSync(foundryOut, { withFileTypes: true });
      for (const d of dirs) {
        if (!d.isDirectory() || !d.name.endsWith('.sol')) continue;
        const contractName = d.name.replace('.sol', '');
        const jsonPath = join(foundryOut, d.name, `${contractName}.json`);
        if (existsSync(jsonPath)) {
          try {
            const raw = JSON.parse(readFileSync(jsonPath, 'utf8'));
            const abi = Array.isArray(raw) ? raw : raw.abi;
            if (Array.isArray(abi) && abi.length > 0) {
              results.set(contractName, { abi, path: jsonPath });
            }
          } catch {}
        }
      }
    } catch {}
  }

  // Hardhat: artifacts/contracts/<ContractName>.sol/<ContractName>.json
  const hardhatArtifacts = join(cwd, 'artifacts', 'contracts');
  if (existsSync(hardhatArtifacts)) {
    try {
      const dirs = readdirSync(hardhatArtifacts, { withFileTypes: true });
      for (const d of dirs) {
        if (!d.isDirectory() || !d.name.endsWith('.sol')) continue;
        const contractName = d.name.replace('.sol', '');
        const jsonPath = join(hardhatArtifacts, d.name, `${contractName}.json`);
        if (existsSync(jsonPath)) {
          try {
            const raw = JSON.parse(readFileSync(jsonPath, 'utf8'));
            const abi = Array.isArray(raw) ? raw : raw.abi;
            if (Array.isArray(abi) && abi.length > 0) {
              results.set(contractName, { abi, path: jsonPath });
            }
          } catch {}
        }
      }
    } catch {}
  }

  return results;
}

// Cache the scan so we don't re-scan for each contract
let _artifactCache = null;
function getArtifactCache() {
  if (!_artifactCache) _artifactCache = scanLocalArtifacts();
  return _artifactCache;
}

/**
 * Try to find a local artifact. Tries exact name match first,
 * then scans all artifacts if the name contains keywords like "Reactive", "Callback".
 * The `hint` parameter can be "rc", "origin", or "callback" to help match.
 */
export function findLocalArtifact(addressOrName, hint) {
  const cache = getArtifactCache();
  if (cache.size === 0) return null;

  // If it's a contract name, try direct match
  if (addressOrName && !addressOrName.startsWith('0x')) {
    if (cache.has(addressOrName)) return cache.get(addressOrName);
  }

  // Hint-based matching: "rc" → look for "Reactive", "callback" → "Callback", etc.
  if (hint) {
    const hintPatterns = {
      rc: ['reactive', 'rc', 'reactor'],
      origin: ['origin', 'source', 'trigger', 'callback', 'greeter', 'demo'],
      callback: ['callback', 'cc', 'destination', 'greeter', 'demo'],
    };
    const patterns = hintPatterns[hint] || [];
    for (const [name, entry] of cache) {
      const lower = name.toLowerCase();
      for (const p of patterns) {
        if (lower.includes(p)) return entry;
      }
    }
  }

  return null;
}

/**
 * Get all locally available artifacts
 */
export function listLocalArtifacts() {
  return getArtifactCache();
}

/**
 * Load ABI from a specific file path (Foundry/Hardhat artifact or raw ABI)
 */
export function loadAbiFromFile(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    const abi = Array.isArray(raw) ? raw : raw.abi;
    return Array.isArray(abi) ? abi : null;
  } catch {
    return null;
  }
}
