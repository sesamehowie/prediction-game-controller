import { getPythUpdateData } from './utils/hermesApi.js';
import { sleep } from './utils/sleep.js';
import { ethers } from "ethers";
import { loadVariables } from './loadVars.js';

async function waitForTimestamp(provider, targetTimestamp, buffer = 2) {
    while (true) {
        const currentBlock = await provider.getBlock("latest");
        const currentTimestamp = BigInt(currentBlock.timestamp);
        const target = BigInt(targetTimestamp);

        if (currentTimestamp >= target) {
            console.log(`Target timestamp reached. Current: ${currentTimestamp.toString()}, Target: ${target.toString()}`);
            break;
        }

        const timeToWait = Number(target - currentTimestamp) + buffer;
        console.log(`Waiting ${timeToWait} seconds until timestamp ${target.toString()}...`);
        await sleep(Math.min(timeToWait, 10));
    }
}

async function play(vars) {
    const [operatorKey, monadRpc, predictionGameAddress, pythOracleAddress, priceFeedId, abiPath, abi, pythAbi] = vars;

    if (operatorKey && monadRpc && predictionGameAddress && pythOracleAddress && priceFeedId && abiPath && abi && pythAbi) {
        console.log("Variables successfully loaded!");
    }

    const provider = new ethers.JsonRpcProvider(monadRpc);
    const operatorWallet = new ethers.Wallet(operatorKey, provider);
    const gameContract = new ethers.Contract(predictionGameAddress, abi, operatorWallet);
    const pythContract = new ethers.Contract(pythOracleAddress, pythAbi, operatorWallet);

    if (provider && operatorWallet && gameContract && pythContract) {
        console.log("Provider, wallet and contract instances successfully initialized!")
    }

    try {
        const genesisStarted = await gameContract.genesisStarted();
        const genesisLocked = await gameContract.genesisLocked();

        if (Number(genesisStarted) === 0) {
            console.log("Genesis hadn't started yet, calling genesisStartRound...");
            const tx = await gameContract.genesisStartRound();
            await tx.wait();
            console.log("GenesisStartRound - Completed!");
            await sleep(2);
            return;
        }

        if (Number(genesisLocked) === 0) {
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
        const previousRound = await gameContract.rounds(currentRoundId - 1n);

        console.log(`Current Round ID: ${currentRoundId.toString()}`);
        console.log(`Current Round Lock Timestamp: ${currentRound.lockTimestamp.toString()}`);
        console.log(`Previous Round Close Timestamp: ${previousRound.closeTimestamp.toString()}`);

        const currentBlock = await provider.getBlock("latest");
        const currentTimestamp = BigInt(currentBlock.timestamp);
        console.log(`Current Timestamp: ${currentTimestamp.toString()}`);

        if (currentTimestamp < currentRound.lockTimestamp) {
            await waitForTimestamp(provider, currentRound.lockTimestamp);
        }

        if (currentTimestamp < previousRound.closeTimestamp) {
            console.log("Previous round not ready to close yet, waiting...");
            await waitForTimestamp(provider, previousRound.closeTimestamp);
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
                console.error("Error fetching update data from Hermes API:", fetchError);
                if (attempt === 3) throw fetchError;
                await sleep(2);
            }
        }

        if (!hermesData) {
            throw new Error("Failed to get Hermes data after 3 attempts");
        }

        const updateData = ["0x".concat(hermesData)];
        console.log("Got Hermes Data!");

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
        try {
            const tx = await gameContract.executeRound(updateData, {
                value: updateFee,
                gasLimit: 1000000
            });
            console.log("Transaction sent, waiting for confirmation...");
            const receipt = await tx.wait();

            console.log(`Successfully executed round! TX: ${receipt.hash}`);

            const updatedPreviousRound = await gameContract.rounds(currentRoundId - 1n);
            console.log(`Previous round (${(currentRoundId - 1n).toString()}) close price: ${updatedPreviousRound.closePrice.toString()}`);

            const updatedCurrentRound = await gameContract.rounds(currentRoundId);
            console.log(`Current round (${currentRoundId.toString()}) lock price: ${updatedCurrentRound.lockPrice.toString()}`);

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
    const vars = loadVariables();
    let consecutiveErrors = 0;

    while (true) {
        try {
            const success = await play(vars);
            if (success) {
                consecutiveErrors = 0;
                console.log("\n=== Round execution successful, waiting for next round ===\n");
                await sleep(20);
            } else {
                console.log("\n=== Round not ready yet, checking again soon ===\n");
                await sleep(5);
            }
        } catch (error) {
            consecutiveErrors++;
            console.error(`Error in main loop (attempt ${consecutiveErrors}):`, error);

            if (consecutiveErrors >= 5) {
                console.error("Too many consecutive errors, exiting...");
                process.exit(1);
            }

            await sleep(10);
        }
    }
}

loop();