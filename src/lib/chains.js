// Chain configurations for Reactive Network + supported EVM chains

const CHAINS = {
  // Reactive Network
  1597:      { name: 'Reactive Mainnet', rpcs: ['https://mainnet-rpc.rnk.dev/'], explorer: 'https://reactscan.net', blockTime: 1 },
  5318007:   { name: 'Reactive Lasna',   rpcs: ['https://lasna-rpc.rnk.dev/'],   explorer: 'https://lasna.reactscan.net', blockTime: 1 },
  // Mainnets
  1:         { name: 'Ethereum',       rpcs: ['https://eth.llamarpc.com', 'https://rpc.ankr.com/eth'],                    explorer: 'https://etherscan.io',          blockTime: 12 },
  8453:      { name: 'Base',           rpcs: ['https://mainnet.base.org', 'https://base.llamarpc.com'],                   explorer: 'https://basescan.org',           blockTime: 2 },
  42161:     { name: 'Arbitrum',       rpcs: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum.llamarpc.com'],            explorer: 'https://arbiscan.io',            blockTime: 0.25 },
  10:        { name: 'Optimism',       rpcs: ['https://mainnet.optimism.io', 'https://optimism.llamarpc.com'],             explorer: 'https://optimistic.etherscan.io', blockTime: 2 },
  137:       { name: 'Polygon',        rpcs: ['https://polygon-rpc.com', 'https://rpc.ankr.com/polygon'],                 explorer: 'https://polygonscan.com',        blockTime: 2 },
  43114:     { name: 'Avalanche',      rpcs: ['https://api.avax.network/ext/bc/C/rpc'],                                    explorer: 'https://snowtrace.io',           blockTime: 2 },
  // Testnets
  11155111:  { name: 'Sepolia',        rpcs: ['https://rpc.sepolia.org', 'https://ethereum-sepolia-rpc.publicnode.com'],   explorer: 'https://sepolia.etherscan.io',    blockTime: 12 },
  84532:     { name: 'Base Sepolia',   rpcs: ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'],      explorer: 'https://sepolia.basescan.org',    blockTime: 2 },
  421614:    { name: 'Arb Sepolia',    rpcs: ['https://sepolia-rollup.arbitrum.io/rpc'],                                   explorer: 'https://sepolia.arbiscan.io',     blockTime: 0.25 },
};

const RN_CHAIN_IDS = new Set([1597, 5318007]);

const SYSTEM_CONTRACTS = {
  cronService:   '0x0000000000000000000000000000000000ffffff',
  callbackProxy: '0x0000000000000000000000000000000000fffFfF',
};

const rpcOverrides = new Map();

export function chainName(chainId) {
  return CHAINS[chainId]?.name || `Chain ${chainId}`;
}

export function chainRpcs(chainId) {
  const override = rpcOverrides.get(Number(chainId));
  if (override) return [override];
  return CHAINS[Number(chainId)]?.rpcs || [];
}

export function isRnChainId(chainId) {
  return RN_CHAIN_IDS.has(Number(chainId));
}

export function rnChainId(network) {
  return network === 'mainnet' ? 1597 : 5318007;
}

export function chainExplorerTxUrl(chainId, txHash) {
  const chain = CHAINS[Number(chainId)];
  if (!chain?.explorer) return null;
  return `${chain.explorer}/tx/${txHash}`;
}

export function setRpcOverride(chainId, url) {
  rpcOverrides.set(Number(chainId), url);
}

export function allChains() {
  return Object.entries(CHAINS).map(([id, c]) => ({ chainId: Number(id), ...c }));
}

export { CHAINS, SYSTEM_CONTRACTS, RN_CHAIN_IDS };
