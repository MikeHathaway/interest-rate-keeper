import { type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { type HexAddress } from "../types.js";

function resolvePrivateKeyCandidate(env: NodeJS.ProcessEnv): string | undefined {
  return env.AJNA_KEEPER_PRIVATE_KEY ?? env.PRIVATE_KEY;
}

export function resolveAjnaPrivateKey(
  env: NodeJS.ProcessEnv = process.env
): Hex | undefined {
  const candidate = resolvePrivateKeyCandidate(env);
  if (!candidate) {
    return undefined;
  }

  if (!/^0x[a-fA-F0-9]{64}$/.test(candidate)) {
    throw new Error("private key must be a 32-byte hex string");
  }

  return candidate as Hex;
}

export function requireAjnaPrivateKey(
  env: NodeJS.ProcessEnv = process.env
): Hex {
  const privateKey = resolveAjnaPrivateKey(env);
  if (!privateKey) {
    throw new Error(
      "live Ajna execution requires AJNA_KEEPER_PRIVATE_KEY or PRIVATE_KEY in the environment"
    );
  }

  return privateKey;
}

export function resolveAjnaSignerAddress(
  env: NodeJS.ProcessEnv = process.env
): HexAddress | undefined {
  const privateKey = resolveAjnaPrivateKey(env);
  if (!privateKey) {
    return undefined;
  }

  return privateKeyToAccount(privateKey).address as HexAddress;
}
