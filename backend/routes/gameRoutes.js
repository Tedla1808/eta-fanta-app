// --- backend/routes/gameRoutes.js --- UPDATED

const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const User = require('../models/user');
const Bet = require('../models/bet');
const { protect } = require('../middleware/authMiddleware');

const TOTAL_BOXES = 100;

// SERVER-SIDE definition of costs and commissions.
const SLOT_CONFIG = {
    slot1: { cost: 20, commission: 0.30 },
    slot2: { cost: 50, commission: 0.25 },
    slot3: { cost: 80, commission: 0.20 },
    slot4: { cost: 100, commission: 0.15 },
    slot5: { cost: 150, commission: 0.10 },
};

// GET /api/game/slots
router.get('/slots', protect, async (req, res) => {
    try {
        const allBets = await Bet.find({ isSettled: false }).lean();
        const unavailableBoxesBySlot = allBets.reduce((acc, bet) => {
            if (!acc[bet.slotId]) acc[bet.slotId] = [];
            acc[bet.slotId].push(bet.boxId);
            return acc;
        }, {});
        
        const slotStatus = {};
        for (const slotId in SLOT_CONFIG) {
            const unavailableBoxes = unavailableBoxesBySlot[slotId] || [];
            slotStatus[slotId] = {
                percentage: Math.round((unavailableBoxes.length / TOTAL_BOXES) * 100),
                unavailableBoxes: unavailableBoxes,
                cost: SLOT_CONFIG[slotId].cost
            };
        }
        res.status(200).json(slotStatus);
    } catch (error) {
        console.error("Error fetching slot statuses:", error);
        res.status(500).json({ message: "Server error fetching slot statuses." });
    }
});

// POST /api/game/bet (WITH NEW SETTLEMENT LOGIC)
router.post('/bet', protect, async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const { bets } = req.body;
        const userId = req.user.id;
        if (!bets || Object.keys(bets).length === 0) {
            return res.status(400).json({ message: "No bets provided." });
        }
        const user = await User.findById(userId).session(session);
        if (!user) return res.status(404).json({ message: "User not found." });

        let totalCost = 0;
        const betsToCreate = [];
        const slotsInvolved = new Set();
        for (const slotId in bets) {
            if (!SLOT_CONFIG[slotId]) return res.status(400).json({ message: `Invalid slot ID: ${slotId}` });
            const costPerBox = SLOT_CONFIG[slotId].cost;
            slotsInvolved.add(slotId);
            for (const boxId of bets[slotId]) {
                totalCost += costPerBox;
                betsToCreate.push({ user: userId, slotId, boxId, cost: costPerBox });
            }
        }
        if (user.balance < totalCost) {
            return res.status(400).json({ message: `Insufficient balance. You need ${totalCost.toFixed(2)} ETB.` });
        }
        const existingBets = await Bet.find({ $or: betsToCreate.map(b => ({ slotId: b.slotId, boxId: b.boxId })) }).session(session);
        if (existingBets.length > 0) {
            throw new Error(`Sorry, at least one selection was just taken.`);
        }
        user.balance -= totalCost;
        await user.save({ session });
        await Bet.insertMany(betsToCreate, { session });

        // --- NEW: GAME SETTLEMENT LOGIC ---
        for (const slotId of slotsInvolved) {
            const betCount = await Bet.countDocuments({ slotId }).session(session);
            if (betCount >= TOTAL_BOXES) {
                console.log(`[SETTLEMENT] Slot ${slotId} is full. Picking a winner...`);
                const slotBets = await Bet.find({ slotId }).session(session);
                const winningBet = slotBets[Math.floor(Math.random() * slotBets.length)];
                const { cost, commission } = SLOT_CONFIG[slotId];
                const totalJackpot = cost * TOTAL_BOXES;
                const prizeAmount = totalJackpot - (totalJackpot * commission);
                await User.findByIdAndUpdate(winningBet.user, { $inc: { balance: prizeAmount } }).session(session);
                const bulkOps = slotBets.map(bet => ({
                    updateOne: {
                        filter: { _id: bet._id },
                        update: { $set: { isSettled: true, isWinner: bet._id.equals(winningBet._id), prizeAmount: bet._id.equals(winningBet._id) ? prizeAmount : 0 } }
                    }
                }));
                await Bet.bulkWrite(bulkOps, { session });
                console.log(`[SETTLEMENT] Winner for ${slotId} is User ${winningBet.user}. Prize: ${prizeAmount} ETB.`);
            }
        }
        await session.commitTransaction();
        res.status(201).json({ message: "Bet placed successfully!", newBalance: user.balance });
    } catch (error) {
        await session.abortTransaction();
        console.error("Error placing bet:", error);
        res.status(500).json({ message: error.message || "A server error occurred." });
    } finally {
        session.endSession();
    }
});

module.exports = router;