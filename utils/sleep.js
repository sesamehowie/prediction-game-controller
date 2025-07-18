export async function sleep(s) {
    return await new Promise(resolve => setTimeout(resolve, s * 1000));
}