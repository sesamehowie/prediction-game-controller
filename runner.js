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
const operatorKey = process.env.OPERATOR_PRIVATE_KEY;
const monadRpc = process.env.MONAD_RPC;
const predictionGameAddress = process.env.CONTRACT_ADDRESS;
const pythOracleAddress = process.env.PYTH_ORACLE_ADDRESS;
const priceFeedId = process.env.PRICE_FEED_ID;
const predictionGameAbi = readJson(abiPath);
const pythAbi = [
  "function getUpdateFee(bytes[] calldata updateData) external view returns (uint256 feeAmount)",
];

const provider = new ethers.JsonRpcProvider(monadRpc);
const multicallProvider = MulticallProvider.MulticallWrapper.wrap(provider);
const operatorWallet = new ethers.Wallet(operatorKey, provider);
const gameContract = new ethers.Contract(
  predictionGameAddress,
  predictionGameAbi,
  operatorWallet
);
const wrappedGameContract = new ethers.Contract(
  predictionGameAddress,
  predictionGameAbi,
  multicallProvider
);
const pythContract = new ethers.Contract(
  pythOracleAddress,
  pythAbi,
  operatorWallet
);

const btcExpo = 8;
const monExpo = 18;

const app = express();
const port = parseInt(process.env.PORT);

app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
  max: 5,
  idleTimeoutMillis: 30000,
  retryDelay: 1000,
});

pool.on("connect", (client) => {
  client
    .query("SET client_encoding TO UTF8")
    .catch((err) => console.error("Failed to set encoding:", err.message));
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

async function processRoundStatsAndPush(roundId) {
  console.log("Parsing data for round no.", roundId);

  try {
    let insertUserData;
    const round = await gameContract.rounds(roundId);
    const startTimestamp = new Date(parseInt(round[1]));
    const lockPrice = (parseInt(round[4]) / 10 ** btcExpo).toFixed(4);
    const closePrice = (parseInt(round[5]) / 10 ** btcExpo).toFixed(4);
    const betVolume = (parseInt(round[6]) / 10 ** monExpo).toFixed(4);
    const pumpAmount = (parseInt(round[7]) / 10 ** monExpo).toFixed(4);
    const dumpAmount = (parseInt(round[8]) / 10 ** monExpo).toFixed(4);
    const totalPayout = (parseInt(round[9]) / 10 ** monExpo).toFixed(4);
    const oracleCalled = round[10];
    const rewardsCalculated = round[11];
    const roundCancelled = round[12];
    const winnerPosition = betPositionNames[parseInt(round[13])];

    console.log("Start timestamp: ", startTimestamp);
    console.log("Lock price:", lockPrice);
    console.log("Close price:", closePrice);
    console.log("Bet volume:", betVolume);
    console.log("Pump amount:", pumpAmount);
    console.log("Dump amount:", dumpAmount);
    console.log("Total payout:", totalPayout);
    console.log("Oracle called:", oracleCalled);
    console.log("Rewards calculated:", rewardsCalculated);
    console.log("Round Cancelled:", roundCancelled);
    console.log("Winner position", winnerPosition);

    const usersInRound = await gameContract.getUsersInRound(roundId);
    const userCount = usersInRound.length;
    console.log(`Users in round ${roundId}: ${userCount}`);

    if (userCount > 0) {
      const betCalls = usersInRound.map((user) =>
        wrappedGameContract.userBetsInRound(roundId, user)
      );

      const betResults = await Promise.all(
        betCalls.map((call) =>
          call.catch((error) => {
            console.error(`Error fetching bet for user: ${error.message}`);
          })
        )
      );

      const userBets = usersInRound.map((user, index) => ({
        user,
        bet: betResults[index] ? betResults[index] : "None",
      }));

      insertUserData = userBets.map((userData) => {
        const userAddress = userData.user.toLowerCase();
        const userPumpAmount = (
          parseInt(userData.bet[0]) /
          10 ** monExpo
        ).toFixed(4);
        const userDumpAmount = (
          parseInt(userData.bet[1]) /
          10 ** monExpo
        ).toFixed(4);

        const userPayout =
          winnerPosition === "pump" && parseFloat(userPumpAmount) > 0
            ? (userPumpAmount * 1.9).toFixed(4)
            : winnerPosition === "dump" && parseFloat(userPumpAmount) > 0
            ? (parseFloat(userDumpAmount) * 1.9).toFixed(4)
            : winnerPosition === "none"
            ? parseFloat(userPumpAmount) + parseFloat(userDumpAmount)
            : "0.0000";

        return [
          roundId,
          userAddress,
          userPumpAmount,
          userDumpAmount,
          userPayout,
        ];
      });
    }

    try {
      await withDbClient(async (client) => {
        const query = `INSERT INTO prediction_games (
                    round_id,
                    start_timestamp,
                    lock_price,
                    close_price,
                    bet_volume,
                    pump_amount,
                    dump_amount,
                    total_payout,
                    oracle_called,
                    rewards_calculated,
                    round_cancelled,
                    winner_position
                ) VALUES
                ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`;

        await client.query(query, [
          roundId,
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
      });

      console.log(`Round ${roundId} successfully recorded!`);
    } catch (err) {
      console.error(`Failed to record round ${roundId}: ${err}`);
    }

    if (insertUserData) {
      try {
        await withDbClient(async (client) => {
          const queryText = `INSERT INTO prediction_players (
                    round_id, player_address, pump_amount, dump_amount, payout
                    ) VALUES ${insertUserData
                      .map(
                        (_, index) =>
                          `($${index * 5 + 1}, $${index * 5 + 2}, $${
                            index * 5 + 3
                          }, $${index * 5 + 4}, $${index * 5 + 5})`
                      )
                      .join(", ")}
                    `;
          const queryValues = insertUserData.flat();
          await client.query(queryText, queryValues);
          console.log("Inserted values into the players table.");
        });
      } catch (err) {
        console.error("Error inserting users to the table:", err);
      }
    }

    return true;
  } catch (error) {
    console.error(`Error processing round ${roundId}: ${error}`);
    return false;
  }
}

async function waitForTimestamp(provider, targetTimestamp, buffer = 2) {
  while (true) {
    const currentBlock = await provider.getBlock("latest");
    const currentTimestamp = BigInt(currentBlock.timestamp);
    const target = BigInt(targetTimestamp) - 1n;

    if (currentTimestamp >= target) {
      console.log(
        `Target timestamp reached. Current: ${currentTimestamp}, Target: ${target}`
      );
      break;
    }

    const timeToWaitBigInt = target - currentTimestamp;
    const timeToWait = Number(timeToWaitBigInt > 10n ? 10n : timeToWaitBigInt); // ограничим максимум 10 секунд

    console.log(
      `Current ts ${currentTimestamp} Waiting ${timeToWait} seconds until timestamp ${target}...`
    );
    await sleep(timeToWait);
  }
}

export async function play() {
  try {
    const genesisStarted = await gameContract.genesisStarted();
    const genesisLocked = await gameContract.genesisLocked();

    if (!genesisStarted) {
      console.log("Genesis not started yet, calling genesisStartRound...");
      const tx = await gameContract.genesisStartRound();
      await tx.wait();
      console.log("GenesisStartRound - Completed!");
      await sleep(2);
      return;
    }

    if (!genesisLocked) {
      console.log("Genesis not locked yet, waiting for lock timestamp...");
      const currentRoundId = await gameContract.currentRoundId();
      const round = await gameContract.rounds(currentRoundId);

      await waitForTimestamp(provider, round.lockTimestamp);

      console.log("Getting Pyth update data...");
      const hermesResponse = await getPythUpdateData(priceFeedId);
      const updateData = ["0x".concat(hermesResponse)];

      console.log("Calling genesisLockRound...");
      const tx = await gameContract.genesisLockRound(updateData, { value: 1 });
      await tx.wait();
      console.log("GenesisLockRound - Complete!");
    }

    console.log("Executing normal round...");
    const currentRoundId = await gameContract.currentRoundId();
    const currentRound = await gameContract.rounds(currentRoundId);
    const previousRound = await gameContract.rounds(currentRoundId.sub(1)); // BigNumber

    const currentBlock = await provider.getBlock("latest");
    const currentTimestamp = BigInt(currentBlock.timestamp);

    if (currentTimestamp < BigInt(currentRound.lockTimestamp)) {
      await waitForTimestamp(provider, currentRound.lockTimestamp);
    }

    console.log("Fetching Pyth update data...");
    let hermesData;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`Requesting Hermes API, attempt ${attempt}...`);
        const response = await getPythUpdateData(priceFeedId);
        if (response) {
          hermesData = response;
          break;
        }
      } catch (fetchError) {
        console.error(
          "Error fetching update data from Hermes API:",
          fetchError
        );
        if (attempt === 3) throw fetchError;
        await sleep(2);
      }
    }

    if (!hermesData) {
      throw new Error("Failed to get Hermes data after 3 attempts");
    }

    const updateData = ["0x".concat(hermesData)];

    let updateFee;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        updateFee = await pythContract.getUpdateFee(updateData);
        console.log(`Pyth update fee: ${updateFee.toString()} wei`);
        break;
      } catch (err) {
        console.error("Failed to get update fee:", err);
        if (attempt === 3) throw err;
        await sleep(2);
      }
    }

    console.log("Executing round with updated price data...");
    console.log("Current timestamp:", Date.now());
    console.log("Round lock timestamp:", BigInt(currentRound.lockTimestamp));
    try {
      const tx = await gameContract.executeRound(updateData, {
        value: updateFee,
      });
      console.log("Transaction sent, waiting for confirmation...");
      const receipt = await tx.wait();

      console.log(`Successfully executed round! TX: ${receipt}`);
      const loggedRoundId = currentRoundId.sub(1);
      const updatedPreviousRound = await gameContract.rounds(loggedRoundId);
      console.log(
        `Previous round (${currentRoundId
          .sub(1)
          .toString()}) close price: ${updatedPreviousRound.closePrice.toString()}`
      );

      let recordResult;

      for (let attempt = 1; attempt < 4; attempt++) {
        recordResult = await processRoundStatsAndPush(loggedRoundId);
        if (recordResult) {
          break;
        } else {
          await sleep(1);
          continue;
        }
      }

      if (recordResult) {
        console.log(`Successfully recorded round ${loggedRoundId}!`);
      } else {
        console.warn(`Round ${loggedRoundId} has not been recorded.`);
      }

      const parsedRoundData = parseRoundStats(loggedRoundId);

      const updatedCurrentRound = await gameContract.rounds(currentRoundId);
      console.log(
        `Current round (${currentRoundId.toString()}) lock price: ${updatedCurrentRound.lockPrice.toString()}`
      );

      const currentPrice = await gameContract.currentPrice();
      console.log(`Contract current price: ${currentPrice.toString()}`);

      return true;
    } catch (execError) {
      console.error("Error executing round:", execError);

      if (execError.message && execError.message.includes("timestamp")) {
        console.log("Timing issue detected, will retry in next iteration");
        return false;
      }

      throw execError;
    }
  } catch (error) {
    console.error("Unexpected error in play function:", error);
    return false;
  }
}

async function loop() {
  let consecutiveErrors = 0;

  while (true) {
    try {
      const success = await play();
      if (success) {
        consecutiveErrors = 0;
        console.log(
          "\n=== Round execution successful, waiting for next round ===\n"
        );
        await sleep(20);
      } else {
        console.log("\n=== Round not ready yet, checking again soon ===\n");
        await sleep(5);
      }
    } catch (error) {
      consecutiveErrors++;
      console.error(
        `Error in main loop (attempt ${consecutiveErrors}):`,
        error
      );

      if (consecutiveErrors >= 20) {
        console.error("Too many consecutive errors, exiting...");
        process.exit(1);
      }

      await sleep(10);
    }
  }
}

async function setupPredictionDatabase() {
  try {
    await pool.query(`
            CREATE TABLE IF NOT EXISTS prediction_games (
                id SERIAL PRIMARY KEY,
                round_id INTEGER NOT NULL UNIQUE,
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
                winner_position CHAR(4) NOT NULL
            )`);

    await pool.query(`
            CREATE TABLE IF NOT EXISTS prediction_players (
                id SERIAL PRIMARY KEY,
                round_id INTEGER NOT NULL,
                player_address CHAR(42) NOT NULL,
                pump_amount DECIMAL(12, 8) NOT NULL,
                dump_amount DECIMAL(12, 8) NOT NULL,
                payout DECIMAL(12, 8) NOT NULL,
                FOREIGN KEY (round_id) REFERENCES prediction_games(round_id) ON DELETE CASCADE
            )
            `);
  } catch (error) {
    console.log("Failed to setup Prediction Game tables:", error);
    throw error;
  }
}

app.listen(port, async () => {
  console.log("Controller running on port", port);
  if (predictionGameAddress) {
    await setupPredictionDatabase();
  }
  loop();
});
