import { describe, expect, it } from "vitest";
import { base, mainnet } from "viem/chains";

import { MULTICALL3_ADDRESS, resolveViemChain } from "../src/ajna/viem-chain.js";

// Ethereum addresses are case-insensitive; viem/chains ships multicall3 with
// lowercase addresses while our own synthesized chains use EIP-55 checksummed
// mixed case. Compare case-insensitively throughout.
function addressesMatch(a: string | undefined, b: string): boolean {
  return a !== undefined && a.toLowerCase() === b.toLowerCase();
}

describe("resolveViemChain", () => {
  it("returns the known Base chain with multicall3 wired in", () => {
    const chain = resolveViemChain(base.id);
    expect(chain.id).toBe(base.id);
    expect(addressesMatch(chain.contracts?.multicall3?.address, MULTICALL3_ADDRESS)).toBe(true);
  });

  it("returns the known Mainnet chain with multicall3 wired in", () => {
    const chain = resolveViemChain(mainnet.id);
    expect(chain.id).toBe(mainnet.id);
    expect(addressesMatch(chain.contracts?.multicall3?.address, MULTICALL3_ADDRESS)).toBe(true);
  });

  it("synthesizes an unknown chain with multicall3 and the supplied rpcUrl", () => {
    const chain = resolveViemChain(31337, "http://localhost:8545");
    expect(chain.id).toBe(31337);
    expect(chain.name).toBe("chain-31337");
    expect(chain.contracts?.multicall3?.address).toBe(MULTICALL3_ADDRESS);
    expect(chain.rpcUrls.default.http).toEqual(["http://localhost:8545"]);
  });

  it("synthesizes an unknown chain without rpcUrl (empty http array)", () => {
    const chain = resolveViemChain(99999);
    expect(chain.id).toBe(99999);
    expect(chain.rpcUrls.default.http).toEqual([]);
    expect(chain.contracts?.multicall3?.address).toBe(MULTICALL3_ADDRESS);
  });
});
