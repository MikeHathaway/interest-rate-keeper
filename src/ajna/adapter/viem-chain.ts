import { type Chain, defineChain } from "viem";
import { base, mainnet } from "viem/chains";

export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

const CHAIN_BY_ID = new Map<number, Chain>([
  [base.id, base],
  [mainnet.id, mainnet]
]);

export function resolveViemChain(chainId: number, rpcUrl?: string): Chain {
  const existing = CHAIN_BY_ID.get(chainId);
  if (existing) {
    return ensureMulticall3(existing);
  }

  // Unknown chain (e.g. local anvil with a custom id) — synthesize one with
  // Multicall3 wired in. Viem's multicall helper looks up
  // chain.contracts.multicall3.address; without it the helper throws.
  return defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: {
      name: "Ether",
      symbol: "ETH",
      decimals: 18
    },
    rpcUrls: {
      default: {
        http: rpcUrl ? [rpcUrl] : []
      }
    },
    contracts: {
      multicall3: {
        address: MULTICALL3_ADDRESS
      }
    }
  });
}

function ensureMulticall3(chain: Chain): Chain {
  if (chain.contracts?.multicall3?.address) {
    return chain;
  }

  return {
    ...chain,
    contracts: {
      ...chain.contracts,
      multicall3: {
        address: MULTICALL3_ADDRESS
      }
    }
  };
}
