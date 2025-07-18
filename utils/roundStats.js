export function printRunResults(txHash, round) {
    console.log("\n\nFinal round stats:");
    console.log("Result hash:", `https://testnet.monadexplorer.com/tx/${txHash}`);
    console.log("Epoch:", parseInt(round[0]));
    console.log('Start timestamp', parseInt(round[1]));
    console.log("Lock timestamp:", parseInt([round[2]]));
    console.log("Close timestamp:", parseInt(round[3]));
    console.log("Lock Price:", parseInt(round[4]));
    console.log("Close Price:", parseInt(round[5]));
    console.log("Total Amount:", parseInt(round[6]));
    console.log("Pump Amount:", parseInt(round[7]), ", Dump amount:", parseInt(round[8]));
    console.log("Total payout:", parseInt(round[8]));
    console.log("Winner Index:", parseInt(round[9]));
    console.log("Settled:", round[10]);
    console.log("Cancelled:", round[11], '\n\n');
}