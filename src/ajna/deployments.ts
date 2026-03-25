import type { HexAddress } from "../types.js";

export interface AjnaNetworkDeployment {
  chainId: number;
  erc20Factory: HexAddress;
  erc721Factory: HexAddress;
  poolInfoUtils: HexAddress;
  poolInfoUtilsMulticall: HexAddress;
  positionManager: HexAddress;
}

export const BASE_AJNA_DEPLOYMENT: AjnaNetworkDeployment = {
  chainId: 8453,
  erc20Factory: "0x214f62B5836D83f3D6c4f71F174209097B1A779C",
  erc721Factory: "0xeefEC5d1Cc4bde97279d01D88eFf9e0fEe981769",
  poolInfoUtils: "0x97fa9b0909C238D170C1ab3B5c728A3a45BBEcBa",
  poolInfoUtilsMulticall: "0x249BCE105719Ae4183204371697c2743800C225d",
  positionManager: "0x59710a4149A27585f1841b5783ac704a08274e64"
};
