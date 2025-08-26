import { getPythUpdateData } from "./utils/hermesApi.js";
import { sleep } from "./utils/sleep.js";
import { ethers } from "ethers";
import express from "express";
import { Pool } from "pg";
import dotenv from "dotenv";
import { readJson } from "./utils/readFile.js";
import MulticallProvider from "ethers-multicall-provider";

dotenv.config();

const betPositionNames = ["none", "pump", "dump"];
const abiPath = "./abi/PredictionGame.json";
const monadRpc = process.env.MONAD_RPC;
const pythOracleAddress = process.env.PYTH_ORACLE_ADDRESS;
const predictionGameAbi = readJson(abiPath);
const pythAbi = ["function getUpdateFee(bytes[] calldata updateData) external view returns (uint256 feeAmount)"];

// Configuration for 3 tokens with separate private keys
const TOKENS = [
  {
    name: "BTC",
    pair: "BTC/USD",
    gameType: 2,
    contractAddress: process.env.BTC_CONTRACT_ADDRESS,
    priceFeedId: process.env.BTC_PRICE_FEED_ID,
    priceExpo: 8,
    operatorPrivateKey: process.env.BTC_OPERATOR_PRIVATE_KEY,
  },
  {
    name: "ETH",
    pair: "ETH/USD",
    gameType: 2,
    contractAddress: process.env.ETH_CONTRACT_ADDRESS,
    priceFeedId: process.env.ETH_PRICE_FEED_ID,
    priceExpo: 8,
    operatorPrivateKey: process.env.ETH_OPERATOR_PRIVATE_KEY,
  },
  {
    name: "SOL",
    pair: "SOL/USD",
    gameType: 2,
    contractAddress: process.env.SOL_CONTRACT_ADDRESS,
    priceFeedId: process.env.SOL_PRICE_FEED_ID,
    priceExpo: 8,
    operatorPrivateKey: process.env.SOL_OPERATOR_PRIVATE_KEY,
  },
];

const monExpo = 18;

const provider = new ethers.JsonRpcProvider(monadRpc);
const multicallProvider = MulticallProvider.MulticallWrapper.wrap(provider);

// Create wallets, contracts, and pyth contracts for each token
const operatorWallets = {};
const gameContracts = {};
const wrappedGameContracts = {};
const pythContracts = {};

TOKENS.forEach((token) => {
  // Create separate wallet for each token
  operatorWallets[token.name] = new ethers.Wallet(token.operatorPrivateKey, provider);

  // Create game contracts with token-specific wallet
  gameContracts[token.name] = new ethers.Contract(token.contractAddress, predictionGameAbi, operatorWallets[token.name]);

  // Create wrapped contracts for multicall
  wrappedGameContracts[token.name] = new ethers.Contract(token.contractAddress, predictionGameAbi, multicallProvider);

  // Create pyth contracts with token-specific wallet
  pythContracts[token.name] = new ethers.Contract(pythOracleAddress, pythAbi, operatorWallets[token.name]);
});

const app = express();
const port = parseInt(process.env.PORT);

app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 1500,
  max: 10,
  idleTimeoutMillis: 3000,
  retryDelay: 1000,
});

pool.on("connect", (client) => {
  client.query("SET client_encoding TO UTF8").catch((err) => console.error("Failed to set encoding:", err.message));
});

pool.on("error", (err, client) => {
  console.error("Unexpected error on idle client:", err);
});

const withDbClient = async (operation) => {
  let client;
  try {
    client = await pool.connect();
    return await operation(client);
  } catch (error) {
    console.error("Database operation failed:", error.message);
    throw error;
  } finally {
    if (client) client.release();
  }
};

async function processRoundStatsAndPush(tokenConfig, roundId) {
  console.log(`[${tokenConfig.name}] Parsing data for round no.`, roundId);

  try {
    let insertUserData;
    const gameContract = gameContracts[tokenConfig.name];
    const wrappedGameContract = wrappedGameContracts[tokenConfig.name];

    const round = await gameContract.rounds(roundId);
    const startTimestamp = new Date(parseInt(round[1]));
    const lockPrice = (parseInt(round[4]) / 10 ** tokenConfig.priceExpo).toFixed(4);
    const closePrice = (parseInt(round[5]) / 10 ** tokenConfig.priceExpo).toFixed(4);
    const betVolume = (parseInt(round[6]) / 10 ** monExpo).toFixed(4);
    const pumpAmount = (parseInt(round[7]) / 10 ** monExpo).toFixed(4);
    const dumpAmount = (parseInt(round[8]) / 10 ** monExpo).toFixed(4);
    const totalPayout = (parseInt(round[9]) / 10 ** monExpo).toFixed(4);
    const oracleCalled = round[10];
    const rewardsCalculated = round[11];
    const roundCancelled = round[12];
    const winnerPosition = betPositionNames[parseInt(round[13])];

    console.log(`[${tokenConfig.name}] Start timestamp:`, startTimestamp);
    console.log(`[${tokenConfig.name}] Lock price:`, lockPrice);
    console.log(`[${tokenConfig.name}] Close price:`, closePrice);
    console.log(`[${tokenConfig.name}] Bet volume:`, betVolume);
    console.log(`[${tokenConfig.name}] Winner position:`, winnerPosition);

    const usersInRound = await gameContract.getUsersInRound(roundId);
    const userCount = usersInRound.length;
    console.log(`[${tokenConfig.name}] Users in round ${roundId}: ${userCount}`);

    if (userCount > 0) {
      const betCalls = usersInRound.map((user) => wrappedGameContract.userBetsInRound(roundId, user));

      const betResults = await Promise.all(
        betCalls.map((call) =>
          call.catch((error) => {
            console.error(`[${tokenConfig.name}] Error fetching bet for user: ${error.message}`);
          })
        )
      );

      const userBets = usersInRound.map((user, index) => ({
        user,
        bet: betResults[index] ? betResults[index] : "None",
      }));

      insertUserData = userBets.map((userData) => {
        const userAddress = userData.user.toLowerCase();
        const userPumpAmount = (parseInt(userData.bet[0]) / 10 ** monExpo).toFixed(4);
        const userDumpAmount = (parseInt(userData.bet[1]) / 10 ** monExpo).toFixed(4);

        const userPayout =
          winnerPosition === "pump" && parseFloat(userPumpAmount) > 0
            ? (userPumpAmount * 1.9).toFixed(4)
            : winnerPosition === "dump" && parseFloat(userDumpAmount) > 0
            ? (parseFloat(userDumpAmount) * 1.9).toFixed(4)
            : winnerPosition === "none"
            ? parseFloat(userPumpAmount) + parseFloat(userDumpAmount)
            : "0.0000";

        return [roundId, userAddress, userPumpAmount, userDumpAmount, userPayout];
      });
    }

    try {
      let insertedGameId;

      await withDbClient(async (client) => {
        const query = `
            INSERT INTO prediction_games (
              game_type, round_id, pair, start_timestamp, lock_price, close_price,
              bet_volume, pump_amount, dump_amount, total_payout, oracle_called,
              rewards_calculated, round_cancelled, winner_position
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
            RETURNING id
        `;

        const result = await client.query(query, [
          tokenConfig.gameType,
          roundId,
          tokenConfig.pair,
          startTimestamp,
          lockPrice,
          closePrice,
          betVolume,
          pumpAmount,
          dumpAmount,
          totalPayout,
          oracleCalled,
          rewardsCalculated,
          roundCancelled,
          winnerPosition,
        ]);

        insertedGameId = result.rows[0].id;
      });

      console.log(`[${tokenConfig.name}] Round ${roundId} successfully recorded!`);

      if (insertUserData && insertedGameId) {
        await withDbClient(async (client) => {
          const queryText = `
INSERT INTO prediction_players (
  game_id, player_address, pump_amount, dump_amount, payout
) VALUES ${insertUserData.map((_, i) => `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`).join(", ")}
`;
          const queryValues = insertUserData.map((row) => [insertedGameId, row[1], row[2], row[3], row[4]]).flat();

          await client.query(queryText, queryValues);
        });

        console.log(`[${tokenConfig.name}] Inserted values into the players table.`);
      }
    } catch (err) {
      console.error(`[${tokenConfig.name}] Error:`, err);
    }

    return true;
  } catch (error) {
    console.error(`[${tokenConfig.name}] Error processing round ${roundId}: ${error}`);
    return false;
  }
}

async function waitForTimestamp(provider, targetTimestamp, tokenConfig) {
  while (true) {
    const currentBlock = await provider.getBlock("latest");
    const currentTimestamp = BigInt(currentBlock.timestamp);
    const target = BigInt(targetTimestamp);

    if (currentTimestamp >= target) {
      console.log(`[${tokenConfig.name}] Target timestamp reached. Current: ${currentTimestamp}, Target: ${target}`);
      break;
    }

    const timeToWaitBigInt = target - currentTimestamp;
    const timeToWait = Number(timeToWaitBigInt > 5n ? 5n : timeToWaitBigInt);

    console.log(`[${tokenConfig.name}] Current ${currentTimestamp} => waiting ${timeToWait} seconds until ${target}`);
    await sleep(timeToWait);
  }
}

async function handleGenesis(tokenConfig) {
  const gameContract = gameContracts[tokenConfig.name];
  const operatorWallet = operatorWallets[tokenConfig.name];
  const genesisStarted = await gameContract.genesisStarted();
  const genesisLocked = await gameContract.genesisLocked();

  if (!genesisStarted) {
    console.log(`[${tokenConfig.name}] Genesis not started yet, calling genesisStartRound...`);
    const nonce = await provider.getTransactionCount(operatorWallet.address, "pending");

    const tx = await gameContract.genesisStartRound({
      nonce: nonce,
    });

    await tx.wait();
    console.log(`[${tokenConfig.name}] GenesisStartRound - Completed!`);
    return { type: "genesis_started" };
  }

  if (!genesisLocked) {
    console.log(`[${tokenConfig.name}] Genesis not locked yet, waiting for lock timestamp...`);
    const currentRoundId = await gameContract.currentRoundId();
    const round = await gameContract.rounds(currentRoundId);

    await waitForTimestamp(provider, round.lockTimestamp, tokenConfig);

    console.log(`[${tokenConfig.name}] Getting Pyth update data...`);
    const hermesResponse = await getPythUpdateData(tokenConfig.priceFeedId);
    const updateData = ["0x".concat(hermesResponse)];

    console.log(`[${tokenConfig.name}] Calling genesisLockRound...`);
    const nonce = await provider.getTransactionCount(operatorWallet.address, "pending");

    const tx = await gameContract.genesisLockRound(updateData, {
      value: 1,
      nonce: nonce,
    });
    await tx.wait();
    console.log(`[${tokenConfig.name}] GenesisLockRound - Complete!`);
    return { type: "genesis_locked" };
  }

  return { type: "ready_for_normal" };
}

async function cancelRound(tokenConfig, roundId, updateData, updateFee) {
  const gameContract = gameContracts[tokenConfig.name];
  const operatorWallet = operatorWallets[tokenConfig.name];

  try {
    console.log(`[${tokenConfig.name}] Cancelling round ${roundId}...`);

    let attempt = 0;
    let receipt;
    const maxAttempts = 5;

    while (attempt < maxAttempts) {
      attempt++;

      try {
        // Get current nonce for this specific wallet
        const nonce = await provider.getTransactionCount(operatorWallet.address, "pending");

        const tx = await gameContract.cancelRound(roundId, updateData, {
          value: updateFee,
          nonce: nonce,
        });

        receipt = await tx.wait();
        console.log(`[${tokenConfig.name}] Successfully cancelled round ${roundId}! TX: ${receipt.hash}`);
        break;
      } catch (err) {
        if (err.message.includes("Another transaction has higher priority") || err.message.includes("replacement transaction underpriced")) {
          console.warn(`[${tokenConfig.name}] Transaction conflict, retrying attempt ${attempt}...`);
          await sleep(2);
          continue;
        } else {
          throw err;
        }
      }
    }

    if (!receipt) {
      throw new Error("Failed to send cancelRound transaction after multiple attempts.");
    }
  } catch (cancelError) {
    console.error(`[${tokenConfig.name}] Error cancelling round ${roundId}:`, cancelError);
    throw cancelError;
  }
}

async function executeNormalRound(tokenConfig) {
  const gameContract = gameContracts[tokenConfig.name];
  const operatorWallet = operatorWallets[tokenConfig.name];
  const pythContract = pythContracts[tokenConfig.name];

  console.log(`[${tokenConfig.name}] Executing normal round...`);
  const currentRoundId = parseInt(await gameContract.currentRoundId());
  const currentRound = await gameContract.rounds(currentRoundId);

  const currentBlock = await provider.getBlock("latest");
  const currentTimestamp = BigInt(currentBlock.timestamp);

  if (currentTimestamp < BigInt(currentRound.lockTimestamp)) {
    await waitForTimestamp(provider, currentRound.lockTimestamp, tokenConfig);
  }

  let hermesData;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`[${tokenConfig.name}] Requesting Hermes API, attempt ${attempt}...`);
      const response = await getPythUpdateData(tokenConfig.priceFeedId);
      if (response) {
        hermesData = response;
        break;
      }
    } catch (fetchError) {
      console.error(`[${tokenConfig.name}] Error fetching update data from Hermes API:`, fetchError);
      if (attempt === 3) throw fetchError;
      await sleep(2);
    }
  }

  if (!hermesData) {
    throw new Error(`[${tokenConfig.name}] Failed to get Hermes data after 3 attempts`);
  }

  const updateData = ["0x".concat(hermesData)];

  let updateFee;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      updateFee = await pythContract.getUpdateFee(updateData);
      break;
    } catch (err) {
      console.error(`[${tokenConfig.name}] Failed to get update fee:`, err);
      if (attempt === 3) throw err;
      await sleep(2);
    }
  }

  console.log(`[${tokenConfig.name}] Executing round with updated price data...`);
  try {
    let nonce = await provider.getTransactionCount(operatorWallet.address, "pending");

    try {
      const tx = await gameContract.executeRound(updateData, {
        value: updateFee,
        nonce,
      });
      const receipt = await tx.wait();
      console.log(`[${tokenConfig.name}] Successfully executed round! TX: ${receipt.hash}`);
    } catch (err) {
      if (err.message.includes("Can only lock round within extended buffer")) {
        await cancelRound(tokenConfig, currentRoundId - 1, updateData, updateFee);
      } else if (err.message.includes("higher priority")) {
        nonce++;
        console.log(`[${tokenConfig.name}] Retrying transaction with new nonce`);
        const tx = await gameContract.executeRound(updateData, {
          value: updateFee,
          nonce,
        });
        const receipt = await tx.wait();
        console.log(`[${tokenConfig.name}] Successfully executed round! TX: ${receipt.hash}`);
      }
    }

    const loggedRoundId = currentRoundId - 1;
    const updatedPreviousRound = await gameContract.rounds(loggedRoundId);
    console.log(`[${tokenConfig.name}] Previous round (${loggedRoundId}) close price: ${updatedPreviousRound.closePrice.toString()}`);

    let recordResult;
    for (let attempt = 1; attempt < 4; attempt++) {
      recordResult = await processRoundStatsAndPush(tokenConfig, loggedRoundId);
      if (recordResult) {
        break;
      } else {
        await sleep(1);
        continue;
      }
    }

    if (recordResult) {
      console.log(`[${tokenConfig.name}] Successfully recorded round ${loggedRoundId}!`);
    } else {
      console.warn(`[${tokenConfig.name}] Round ${loggedRoundId} has not been recorded.`);
    }

    const updatedCurrentRound = await gameContract.rounds(currentRoundId);
    console.log(`[${tokenConfig.name}] Current round (${currentRoundId}) lock price: ${updatedCurrentRound.lockPrice.toString()}`);

    const currentPrice = await gameContract.currentPrice();
    console.log(`[${tokenConfig.name}] Contract current price: ${currentPrice.toString()}`);

    return { success: true, roundExecuated: true };
  } catch (execError) {
    console.log(execError.message.includes("Can only lock round within extended buffer"));

    if (execError.message && execError.message.includes("Can only lock round within extended buffer")) {
      console.log(`[${tokenConfig.name}] Extended buffer error detected, attempting to cancel round...`);

      try {
        const roundToCancel = currentRoundId - 1;
        await cancelRound(tokenConfig, roundToCancel, updateData, updateFee);
        return { success: true, roundExecuted: false, roundCancelled: true };
      } catch (cancelError) {
        console.error(`[${tokenConfig.name}] Failed to cancel round:`, cancelError);
        return {
          success: false,
          roundExecuted: false,
          error: `Failed to cancel round: ${cancelError.message}`,
        };
      }
    }

    if (execError.message && execError.message.includes("timestamp")) {
      console.log(`[${tokenConfig.name}] Timing issue detected, will retry in next iteration`);
      return { success: false, roundExecuted: false, retry: true };
    }

    throw execError;
  }
}

async function playToken(tokenConfig) {
  try {
    const genesisStatus = await handleGenesis(tokenConfig);

    if (genesisStatus.type !== "ready_for_normal") {
      return {
        success: true,
        roundExecuted: false,
        action: genesisStatus.type,
      };
    }

    return await executeNormalRound(tokenConfig);
  } catch (error) {
    console.error(`[${tokenConfig.name}] Unexpected error in playToken:`, error);
    return { success: false, roundExecuted: false, error: error.message };
  }
}

export async function playAllTokens() {
  console.log("=== Starting parallel execution for all tokens ===");

  const results = await Promise.allSettled(TOKENS.map((tokenConfig) => playToken(tokenConfig)));

  let overallSuccess = false;
  let anyRoundExecuted = false;

  results.forEach((result, index) => {
    const tokenName = TOKENS[index].name;

    if (result.status === "fulfilled") {
      const { success, roundExecuted, roundCancelled, action, error } = result.value;
      console.log(
        `[${tokenName}] Result: success=${success}, roundExecuted=${roundExecuted}, roundCancelled=${roundCancelled || false}, action=${
          action || "normal"
        }`
      );

      if (success) overallSuccess = true;
      if (roundExecuted) anyRoundExecuted = true;

      if (error) {
        console.error(`[${tokenName}] Error: ${error}`);
      }
    } else {
      console.error(`[${tokenName}] Promise rejected:`, result.reason);
    }
  });

  console.log(`=== Parallel execution completed. Overall success: ${overallSuccess}, Any round executed: ${anyRoundExecuted} ===`);

  return { success: overallSuccess, anyRoundExecuted };
}

async function loop() {
  let consecutiveErrors = 0;

  while (true) {
    try {
      const result = await playAllTokens();

      if (result.success) {
        consecutiveErrors = 0;
        if (result.anyRoundExecuted) {
          console.log("\n=== Round execution successful for one or more tokens, waiting for next round ===\n");
          await sleep(5);
        } else {
          console.log("\n=== Genesis operations completed, checking again soon ===\n");
          await sleep(3);
        }
      } else {
        console.log("\n=== No rounds ready yet, checking again soon ===\n");
        await sleep(3);
      }
    } catch (error) {
      consecutiveErrors++;
      console.error(`Error in main loop (attempt ${consecutiveErrors}):`, error);

      if (consecutiveErrors >= 20) {
        console.error("Too many consecutive errors, exiting...");
        process.exit(1);
      }

      await sleep(5);
    }
  }
}

async function setupPredictionDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS prediction_game_types (
        id SERIAL PRIMARY KEY,
        name VARCHAR(50) NOT NULL UNIQUE
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS prediction_games (
          id SERIAL PRIMARY KEY,
          game_type INTEGER NOT NULL,
          round_id INTEGER NOT NULL,
          pair TEXT NOT NULL,
          start_timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
          lock_price DECIMAL(12, 4) NOT NULL,
          close_price DECIMAL(12, 4) NOT NULL,
          bet_volume DECIMAL(12, 8) NOT NULL,
          pump_amount DECIMAL(12, 8) NOT NULL,
          dump_amount DECIMAL(12, 8) NOT NULL,
          total_payout DECIMAL(12, 8) NOT NULL,
          oracle_called BOOLEAN NOT NULL,
          rewards_calculated BOOLEAN NOT NULL,
          round_cancelled BOOLEAN NOT NULL,
          winner_position CHAR(4) NOT NULL,
          FOREIGN KEY (game_type) REFERENCES prediction_game_types(id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS prediction_players (
        id SERIAL PRIMARY KEY,
        game_id INTEGER NOT NULL,
        player_address CHAR(42) NOT NULL,
        pump_amount DECIMAL(12, 8) NOT NULL,
        dump_amount DECIMAL(12, 8) NOT NULL,
        payout DECIMAL(12, 8) NOT NULL,
        FOREIGN KEY (game_id) REFERENCES prediction_game_types(id)
      )
    `);

    console.log("Database tables setup completed for all tokens");
  } catch (error) {
    console.log("Failed to setup Prediction Game tables:", error);
    throw error;
  }
}

// Function to display wallet addresses for verification
function displayWalletAddresses() {
  console.log("\n=== Wallet Addresses for Each Token ===");
  TOKENS.forEach((token) => {
    const wallet = operatorWallets[token.name];
    console.log(`[${token.name}] Wallet Address: ${wallet.address}`);
  });
  console.log("=========================================\n");
}

app.listen(port, async () => {
  console.log("Multi-token Controller running on port", port);

  // Validate that all required environment variables are present
  const missingVars = [];
  TOKENS.forEach((token) => {
    if (!token.contractAddress) missingVars.push(`${token.name}_CONTRACT_ADDRESS`);
    if (!token.priceFeedId) missingVars.push(`${token.name}_PRICE_FEED_ID`);
    if (!token.operatorPrivateKey) missingVars.push(`${token.name}_OPERATOR_PRIVATE_KEY`);
  });

  if (missingVars.length > 0) {
    console.error("Missing required environment variables:", missingVars);
    process.exit(1);
  }

  // Display wallet addresses for verification
  displayWalletAddresses();

  await setupPredictionDatabase();
  loop();
});
