// --- server.js --- CORRECTED TO HANDLE WITHDRAWALS AND AVOID DUPLICATES

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const { Telegraf } = require('telegraf');
const path = require('path');
const http = require('http');
const { Server } = require("socket.io");
const jwt = require('jsonwebtoken');

const User = require('./models/user');
const Transaction = require('./models/transaction');

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID;
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// API ROUTES
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/game', require('./routes/gameRoutes'));
app.use('/api/user', require('./routes/userRoutes'));

// --- DATABASE CONNECTION (Defined once, correctly) ---
const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('MongoDB Connected...');
    } catch (err) {
        console.error('MongoDB Connection Error:', err.message);
        process.exit(1);
    }
};

// --- REAL-TIME & TELEGRAM LOGIC ---
const userSockets = new Map();
io.on('connection', (socket) => {
    console.log(`[Socket] A user connected: ${socket.id}`);
    socket.on('authenticate', (token) => {
        try {
            if (!token) return;
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            userSockets.set(decoded.user.id, socket.id);
            console.log(`[Socket] Authenticated user ${decoded.user.id} on socket ${socket.id}`);
        } catch (error) { console.log('[Socket] Authentication failed.'); }
    });
    socket.on('disconnect', () => {
        for (let [userId, socketId] of userSockets.entries()) {
            if (socketId === socket.id) { userSockets.delete(userId); console.log(`[Socket] User ${userId} disconnected.`); break; }
        }
    });
});

bot.on('callback_query', async (ctx) => {
    if (String(ctx.callbackQuery.from.id) !== String(ADMIN_TELEGRAM_ID)) {
        return ctx.answerCbQuery("You are not authorized for this action.");
    }
    
    const [action, transactionId] = ctx.callbackQuery.data.split('_');

    const transaction = await Transaction.findById(transactionId).populate('user');
    if (!transaction || transaction.status !== 'Pending') {
        return ctx.answerCbQuery('This request is already processed or invalid.');
    }

    const user = transaction.user;
    const userSocketId = userSockets.get(user._id.toString());
    
    // Deposit Logic
    if (action === 'verify') {
        transaction.status = 'Completed';
        user.balance += transaction.amount;
        await transaction.save();
        await user.save();
        await ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n--- ✅ VERIFIED by Admin ---`);
        if (userSocketId) {
            io.to(userSocketId).emit('depositApproved', { message: `Your deposit of ${transaction.amount.toFixed(2)} ETB was approved!`, newBalance: user.balance });
        }
    } else if (action === 'reject') {
        transaction.verificationAttempts += 1;
        if (transaction.verificationAttempts >= 3) {
            transaction.status = 'Failed';
            user.isBlocked = true;
            await user.save();
            await ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n--- ❌ REJECTED & BLOCKED by Admin ---`);
            if (userSocketId) io.to(userSocketId).emit('depositRejected', { final: true });
        } else {
            const attemptsLeft = 3 - transaction.verificationAttempts;
            await ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n--- ❌ REJECTED by Admin ---`);
            if (userSocketId) io.to(userSocketId).emit('depositRejected', { final: false, attemptsLeft });
        }
        await transaction.save();
    } 
    // Withdrawal Logic
    else if (action === 'approve-withdraw') {
        if (user.balance < transaction.amount) {
            await ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n--- ⚠️ ERROR: User has insufficient funds! ---`);
            return ctx.answerCbQuery('Action failed: Insufficient funds.');
        }
        transaction.status = 'Completed';
        user.balance -= transaction.amount;
        transaction.amount = -transaction.amount; // Store as negative for history
        await transaction.save();
        await user.save();
        await ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n--- ✅ WITHDRAWAL APPROVED by Admin ---`);
        if(userSocketId) io.to(userSocketId).emit('withdrawalApproved', { message: `Your withdrawal of ${Math.abs(transaction.amount).toFixed(2)} ETB was approved.`, newBalance: user.balance });
    } else if (action === 'decline-withdraw') {
        transaction.status = 'Failed';
        await transaction.save();
        await ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n--- ❌ WITHDRAWAL DECLINED by Admin ---`);
        if(userSocketId) io.to(userSocketId).emit('withdrawalDeclined', { message: 'Your withdrawal request was declined.' });
    }
});

// Logic to handle user sharing their contact
bot.on('contact', async (ctx) => {
    const contact = ctx.message.contact;
    const chatId = ctx.chat.id;
    const phoneNumber = contact.phone_number.replace(/\D/g, '');

    if (contact.user_id !== ctx.from.id) {
        return ctx.reply('For security, you can only share your own contact number using the button.');
    }
    try {
        await User.findOneAndUpdate(
            { phone: phoneNumber },
            { $set: { telegramChatId: chatId } },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        console.log(`[Bot] Linked phone ${phoneNumber} to Chat ID ${chatId}.`);
        await ctx.reply(`Thank you! Your phone number is now linked. You can return to the website and continue registration.`);
    } catch (error) {
        console.error('[Bot] Error saving contact to DB:', error);
        await ctx.reply('Sorry, a server error occurred. Please try again later.');
    }
});

// START SERVER
const startServer = async () => {
    await connectDB();
    server.listen(PORT, () => console.log(`[SERVER] HTTP & Socket.IO server running on http://localhost:${PORT}`));
    bot.launch().then(() => console.log('[BOT] Telegram bot listener is running...'));
};

startServer();

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));