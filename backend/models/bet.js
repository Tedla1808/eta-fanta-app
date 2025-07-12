// --- backend/models/bet.js --- UPDATED

const mongoose = require('mongoose');

const betSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    slotId: {
        type: String,
        required: true,
        index: true,
    },
    boxId: {
        type: String,
        required: true,
    },
    cost: {
        type: Number,
        required: true,
    },
    // ** NEW FIELDS TO TRACK OUTCOME **
    isWinner: {
        type: Boolean,
        default: false, // Will be true only for the winning bet
    },
    prizeAmount: {
        type: Number,
        default: 0, // Will hold the net prize for the winner
    },
    isSettled: {
        type: Boolean,
        default: false, // Becomes true once a slot is full and a winner is chosen
        index: true,
    }
}, { timestamps: true });

betSchema.index({ slotId: 1, boxId: 1 }, { unique: true });

const Bet = mongoose.model('Bet', betSchema);

module.exports = Bet;