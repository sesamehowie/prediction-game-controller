import axios from "axios";

export async function getPythUpdateData(pricefeedId) {
    const response = await axios.get(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${pricefeedId}`);
    return response.data.binary.data[0]
}