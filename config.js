import { readJson } from './utils/readFile.js';

export const operatorKey = "0xb5b3d1198ce1b0a3e0e300601a7cfcd6f8a0f9bb449ec45e4877242f721b52a5";
export const monadRpc = "https://rpc.ankr.com/monad_testnet";
export const predictionGameAddress = "0x2923557BAEaa714D28851d658dAEC8E6a6a19717";
export const pythOracleAddress = "0x2880aB155794e7179c9eE2e38200202908C17B43";
export const priceFeedId = "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";

export const abiPath = "./abi/PredictionGame.json";
export const abi = readJson(abiPath);

export const pythAbi = [
  "function getUpdateFee(bytes[] calldata updateData) external view returns (uint256 feeAmount)"
];