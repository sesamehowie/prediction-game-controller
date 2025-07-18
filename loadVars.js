import dotenv from 'dotenv';
import { readJson } from './utils/readFile.js';
dotenv.config();

export function loadVariables() {
    const operatorKey = process.env.OPERATOR_PRIVATE_KEY;
    const monadRpc = process.env.MONAD_RPC;
    const predictionGameAddress = process.env.CONTRACT_ADDRESS;
    const pythOracleAddress = process.env.PYTH_ORACLE_ADDRESS;
    const priceFeedId = process.env.PRICE_FEED_ID;
    const abiPath = "./abi/PredictionGame.json";
    const abi = readJson(abiPath);
    const pythAbi = [
        "function getUpdateFee(bytes[] calldata updateData) external view returns (uint256 feeAmount)"
    ];
    return [operatorKey, monadRpc, predictionGameAddress, pythOracleAddress, priceFeedId, abiPath, abi, pythAbi];
}