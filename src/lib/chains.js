// Chain configurations for Reactive Network + supported EVM chains

const CHAINS = {
  // Reactive Network
  1597:      { name: 'Reactive Mainnet', rpcs: ['https://mainnet-rpc.rnk.dev/'], explorer: 'https://reactscan.net', blockTime: 1, callbackProxy: '0x0000000000000000000000000000000000fffFfF' },
  5318007:   { name: 'Reactive Lasna',   rpcs: ['https://lasna-rpc.rnk.dev/'],   explorer: 'https://lasna.reactscan.net', blockTime: 1, callbackProxy: '0x0000000000000000000000000000000000fffFfF' },
  // Mainnets
  1:         { name: 'Ethereum',       rpcs: ['https://eth.llamarpc.com', 'https://rpc.ankr.com/eth'],                    explorer: 'https://etherscan.io',          blockTime: 12, callbackProxy: '0x1D5267C1bb7D8bA68964dDF3990601BDB7902D76' },
  8453:      { name: 'Base',           rpcs: ['https://mainnet.base.org', 'https://base.llamarpc.com'],                   explorer: 'https://basescan.org',           blockTime: 2, callbackProxy: '0x0D3E76De6bC44309083cAAFdB49A088B8a250947' },
  42161:     { name: 'Arbitrum',       rpcs: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum.llamarpc.com'],            explorer: 'https://arbiscan.io',            blockTime: 0.25, callbackProxy: '0x4730c58FDA9d78f60c987039aEaB7d261aAd942E' },
  10:        { name: 'Optimism',       rpcs: ['https://mainnet.optimism.io', 'https://optimism.llamarpc.com'],             explorer: 'https://optimistic.etherscan.io', blockTime: 2 },
  137:       { name: 'Polygon',        rpcs: ['https://polygon-rpc.com', 'https://rpc.ankr.com/polygon'],                 explorer: 'https://polygonscan.com',        blockTime: 2 },
  43114:     { name: 'Avalanche',      rpcs: ['https://api.avax.network/ext/bc/C/rpc'],                                    explorer: 'https://snowtrace.io',           blockTime: 2, callbackProxy: '0x934Ea75496562D4e83E80865c33dbA600644fCDa' },
  // Testnets
  11155111:  { name: 'Sepolia',        rpcs: ['https://rpc.sepolia.org', 'https://ethereum-sepolia-rpc.publicnode.com'],   explorer: 'https://sepolia.etherscan.io',    blockTime: 12, callbackProxy: '0xc9f36411C9897e7F959D99ffca2a0Ba7ee0D7bDA' },
  84532:     { name: 'Base Sepolia',   rpcs: ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'],      explorer: 'https://sepolia.basescan.org',    blockTime: 2, callbackProxy: '0xa6eA49Ed671B8a4dfCDd34E36b7a75Ac79B8A5a6' },
  421614:    { name: 'Arb Sepolia',    rpcs: ['https://sepolia-rollup.arbitrum.io/rpc'],                                   explorer: 'https://sepolia.arbiscan.io',     blockTime: 0.25 },
};

const RN_CHAIN_IDS = new Set([1597, 5318007]);

const TESTNET_CHAIN_IDS = new Set([5318007, 11155111, 84532, 421614]);
const MAINNET_CHAIN_IDS = new Set([1597, 1, 8453, 42161, 10, 137, 43114]);

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

export function callbackProxyAddress(chainId) {
  return CHAINS[Number(chainId)]?.callbackProxy || null;
}

export function isTestnet(chainId) {
  return TESTNET_CHAIN_IDS.has(Number(chainId));
}

export function isMainnet(chainId) {
  return MAINNET_CHAIN_IDS.has(Number(chainId));
}

export function reactscanUrl(network, address) {
  const base = network === 'mainnet' ? 'https://reactscan.net' : 'https://lasna.reactscan.net';
  return `${base}/address/${address}`;
}

export function allChains() {
  return Object.entries(CHAINS).map(([id, c]) => ({ chainId: Number(id), ...c }));
}

export { CHAINS, SYSTEM_CONTRACTS, RN_CHAIN_IDS, TESTNET_CHAIN_IDS, MAINNET_CHAIN_IDS };
