import crypto from "crypto";
import { ethers } from "ethers";

let dbPool;

async function initializeReferralService(pool) {
    dbPool = pool;
}

const COMMISSION_RATES = {
    prediction: 0.01
};

const MIN_VOLUME_FOR_ACCESS = 1;

async function getCurrentEpoch() {
    try {
        const now = new Date();
        const result = await dbPool.query(`
			SELECT * FROM referral_epochs 
			WHERE status = 'active' 
			AND start_date <= $1 
			AND end_date >= $1
			LIMIT 1
		`, [now]);

        if (result.rows.length === 0) {
            const startOfWeek = new Date(now);
            startOfWeek.setUTCHours(0, 0, 0, 0);
            startOfWeek.setUTCDate(startOfWeek.getUTCDate() - startOfWeek.getUTCDay());

            const endOfWeek = new Date(startOfWeek);
            endOfWeek.setUTCDate(endOfWeek.getUTCDate() + 6);
            endOfWeek.setUTCHours(23, 59, 59, 999);

            const newEpochResult = await dbPool.query(`
				INSERT INTO referral_epochs (start_date, end_date, status)
				VALUES ($1, $2, 'active')
				RETURNING *
			`, [startOfWeek, endOfWeek]);

            return newEpochResult.rows[0];
        }

        return result.rows[0];
    } catch (error) {
        console.error("Error getting current epoch:", error);
        throw error;
    }
}

async function checkReferrerAccess(referrerAddress) {
    try {
        const normalizedAddress = referrerAddress.toLowerCase();

        const totalVolumeQuery = `
			SELECT COALESCE(SUM(total_bet_volume), 0) as total_volume
			FROM user_game_stats ugs
			JOIN user_profiles up ON ugs.profile_id = up.id
			WHERE up.wallet_address = $1
		`;

        const result = await dbPool.query(totalVolumeQuery, [normalizedAddress]);
        const totalVolume = parseFloat(result.rows[0]?.total_volume || 0);

        return totalVolume >= MIN_VOLUME_FOR_ACCESS;
    } catch (error) {
        console.error("Error checking referrer access:", error);
        return false;
    }
}

async function updatePendingRewards(referrerAddress, earnedAmount) {
    try {
        await dbPool.query(`
			INSERT INTO referral_pending_rewards (referrer_address, total_pending)
			VALUES ($1, $2)
			ON CONFLICT (referrer_address)
			DO UPDATE SET 
				total_pending = referral_pending_rewards.total_pending + $2,
				last_updated = NOW()
		`, [referrerAddress.toLowerCase(), earnedAmount]);
    } catch (error) {
        console.error("Error updating pending rewards:", error);
        throw error;
    }
}

async function processReferralEarning(refereeAddress, gameType, betAmount) {
    try {
        const normalizedReferee = refereeAddress.toLowerCase();

        const referralResult = await dbPool.query(
            "SELECT referrer_address FROM referral_system WHERE referee_address = $1",
            [normalizedReferee]
        );

        if (referralResult.rows.length === 0) {
            return;
        }

        const referrerAddress = referralResult.rows[0].referrer_address;

        const hasAccess = await checkReferrerAccess(referrerAddress);
        if (!hasAccess) {
            return;
        }

        const currentEpoch = await getCurrentEpoch();

        const commissionRate = COMMISSION_RATES[gameType] || 0;
        const earnedAmount = betAmount * commissionRate;

        if (earnedAmount <= 0) {
            return;
        }

        await dbPool.query(`
			INSERT INTO referral_earnings 
			(referrer_address, referee_address, game_type, bet_volume, commission_rate, earned_amount, epoch_id)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
		`, [referrerAddress, normalizedReferee, gameType, betAmount, commissionRate, earnedAmount, currentEpoch.id]);

        await updatePendingRewards(referrerAddress, earnedAmount);

        console.log(`Referral earning processed: ${earnedAmount} MON for ${referrerAddress} from ${gameType}`);
    } catch (error) {
        console.error("Error processing referral earning:", error);
    }
}

export default {
    initializeReferralService,
    processReferralEarning,
    checkReferrerAccess,
    getCurrentEpoch,
    updatePendingRewards,
    COMMISSION_RATES
}; 