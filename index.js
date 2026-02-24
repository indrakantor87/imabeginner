const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const TradingView = require('@mathieuc/tradingview');
const chalk = require('chalk');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const xml2js = require('xml2js');
const { RSI, MACD, BollingerBands, ATR, EMA, ADX } = require('technicalindicators');
const localtunnel = require('localtunnel'); // Added for Remote Access
const os = require('os'); // Added for Local IP

// --- ERROR HANDLING ---
process.on('uncaughtException', (err) => {
    console.error(chalk.red('UNCAUGHT EXCEPTION:'), err);
});
process.on('unhandledRejection', (reason, p) => {
    console.error(chalk.red('UNHANDLED REJECTION:'), reason);
});
process.on('exit', (code) => {
    console.log(chalk.red(`PROCESS EXITING with code: ${code}`));
});
process.on('SIGINT', () => {
    console.log(chalk.yellow('Received SIGINT. Shutting down gracefully...'));
    process.exit(0);
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Heartbeat
let tvUpdateCount = 0;
setInterval(() => {
    const uptime = process.uptime().toFixed(0);
    const mem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    console.log(chalk.gray(`[HEARTBEAT] Uptime: ${uptime}s | Mem: ${mem}MB | TV Updates: ${tvUpdateCount}`));
    tvUpdateCount = 0; // Reset counter
}, 10000);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- CONFIGURATION ---
const CONFIG = {
    // Removed specific providers to allow auto-selection (better stability)
    pairs: ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDCAD', 'USDJPY', 'USDCHF', 'BTCUSD', 'GBPJPY'],
    mode: 'AUTO',
    priceSource: 'MT5',
    timeframe: {
        entry: '15',
        trend: '60',
        predatorEntry: '5'
    },
    balance: 100,
    lotSize: 0.01,
    leverage: 500,
    maxDailyLoss: 100,
    dailyProfitTarget: 10,
    dailyLoss: 0,
    autoCompound: true,       // Enable Money Management
    riskFactor: 150,          // Equity required for 0.01 lot (e.g. $150 = 0.01 lot)
    maxSpread: 25,
    trailingStop: true,
    atrPeriod: 14,
    slMultiplier: 2.0,
    tpMultiplier: 3.0,
    newsFilter: true,
    newsBlockMinutes: 30,
    lowBandwidth: false,
    enableRemote: true,
    useVirtualSL: true,
    virtualSLMultiplier: 1.0,
    emergencySLMultiplier: 2.5,
    slRandomOffsetFactor: 0.2,
    minAtrFraction: 0.0005,
    maxAtrFraction: 0.0012,
    minAtrEntryFraction: 0.0006,
    globalLossStreakLimit: 5,
    globalLossStreakCooldownMinutes: 180,
    tradingHours: {
        start: 0,
        end: 24
    }
};

const HISTORY_FILE = 'trade_history.json';
const BRAIN_FILE = 'brain.json';

// --- STATE ---
let marketData = { pairs: {} };
let account = {
    balance: CONFIG.balance,
    equity: CONFIG.balance,
    positions: []
};
let stats = { wins: 0, losses: 0, totalProfit: 0, dailyProfit: 0, dailyDate: null };
let pairStats = {};
let tradeHistory = [];
let brain = { pairs: {}, global: { wins: 0, losses: 0, totalProfit: 0 } };
let pendingPairs = new Set(); // Spam Protection
let lastTradeTime = {}; // Cooldown Timer
let pairLossStreak = {};
let pairCooldownUntil = {};
let globalLossStreak = 0;
let globalCooldownUntil = 0;

// MT5 Bridge State
let signalQueue = [];
let signalIdCounter = 1;
let mt5LastSeen = 0;
let lastCloseReasonByPair = {};
let mt5Ohlc = {};

// --- NEWS & PREDATOR STATE ---
let newsEvents = [];
let fomcState = {
    isStalking: false,
    eventTime: null,
    eventName: '',
    preNewsRange: { high: 0, low: 0, set: false }
};

// Helper: Parse FF Date (MM-DD-YYYY) to Date Object
function parseFFDate(dateStr, timeStr) {
    // Debug Log (Comment out later)
    // console.log(`Parsing Date: ${dateStr} Time: ${timeStr}`);
    
    if (!dateStr || !timeStr) return new Date();
    
    // Check format
    // Expected: 02-12-2026 (MM-DD-YYYY)
    const parts = dateStr.split('-');
    if (parts.length !== 3) return new Date();
    
    // Try to detect if it's already YYYY-MM-DD
    let y, m, d;
    if (parts[0].length === 4) {
        y = parts[0]; m = parts[1]; d = parts[2];
    } else {
        // Assume MM-DD-YYYY
        y = parts[2]; m = parts[0]; d = parts[1];
    }
    
    // Time: HH:mm:ss or HH:mm or h:mmam/pm
    // Convert 12h to 24h if needed
    let time24 = timeStr;
    if (timeStr.toLowerCase().includes('am') || timeStr.toLowerCase().includes('pm')) {
        const modifier = timeStr.slice(-2).toLowerCase();
        let [h, m] = timeStr.slice(0, -2).split(':');
        
        if (h === '12') h = '00';
        if (modifier === 'pm') h = parseInt(h, 10) + 12;
        
        time24 = `${h.toString().padStart(2, '0')}:${m}:00`;
    }
    
    const isoString = `${y}-${m}-${d}T${time24}`;
    const date = new Date(isoString);
    
    if (isNaN(date.getTime())) {
        console.error(`Invalid Date Parse: ${isoString} (Raw: ${dateStr} ${timeStr})`);
        return new Date(); // Fallback to now
    }
    
    return date;
}

async function fetchNews() {
    try {
        console.log(chalk.cyan('Fetching Forex Factory Calendar...'));
        const response = await axios.get('https://nfs.faireconomy.media/ff_calendar_thisweek.xml');
        const parser = new xml2js.Parser();
        parser.parseString(response.data, (err, result) => {
            if (err) {
                console.error('XML Parse Error:', err);
                return;
            }
            
            if (!result || !result.weeklyevents || !result.weeklyevents.event) return;

            const events = result.weeklyevents.event;
            const now = new Date();
            
            // Filter: FOMC or High Impact USD
            newsEvents = events.map(e => {
                return {
                    title: e.title[0],
                    country: e.country[0],
                    impact: e.impact[0],
                    date: parseFFDate(e.date[0], e.time[0])
                };
            }).filter(e => {
                // We only care about FUTURE events (or very recent ones)
                const timeDiff = e.date - now;
                // Keep events from -1 hour to +24 hours
                if (timeDiff < -3600000 || timeDiff > 86400000) return false;
                
                const isFOMC = e.title.includes('FOMC') || e.title.includes('Federal Funds Rate');
                const isHighImpact = e.impact === 'High' && e.country === 'USD';
                
                return isFOMC || isHighImpact;
            });
            
            console.log(chalk.cyan(`News Updated: ${newsEvents.length} relevant events found.`));
            if(newsEvents.length > 0) {
                console.log(chalk.gray(`Next: ${newsEvents[0].title} @ ${newsEvents[0].date.toLocaleTimeString()}`));
            }
        });
    } catch (e) {
        console.error('News Fetch Failed:', e.message);
    }
}

// Initial Fetch & Schedule
fetchNews();
setInterval(fetchNews, 60 * 60 * 1000); // Every hour

// Load History
if (fs.existsSync(HISTORY_FILE)) {
    try {
        tradeHistory = JSON.parse(fs.readFileSync(HISTORY_FILE));
    } catch (e) { console.error('Error loading history:', e); }
}

// Load Brain (Long-Term Memory)
if (fs.existsSync(BRAIN_FILE)) {
    try {
        const savedBrain = JSON.parse(fs.readFileSync(BRAIN_FILE));
        // Merge with default structure to ensure compatibility
        brain = { ...brain, ...savedBrain };
        
        // Restore Cooldowns from Brain
        if (brain.lastTradeTime) {
            lastTradeTime = brain.lastTradeTime;
            console.log(chalk.cyan(`Memory Restored: Cooldowns loaded for ${Object.keys(lastTradeTime).length} pairs.`));
        }
        if (brain.pairLossStreak) {
            pairLossStreak = brain.pairLossStreak;
        }
        if (brain.pairCooldownUntil) {
            pairCooldownUntil = brain.pairCooldownUntil;
        }
        if (typeof brain.globalLossStreak === 'number') {
            globalLossStreak = brain.globalLossStreak;
        }
        if (brain.globalCooldownUntil) {
            globalCooldownUntil = brain.globalCooldownUntil;
        }
    } catch (e) { console.error('Error loading brain:', e); }
}

// --- ROUTES ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/api/signal', (req, res) => {
    mt5LastSeen = Date.now();
    const lastId = parseInt(req.query.last_id) || 0;
    
    // Filter signals that the EA hasn't seen yet
    const unseenSignals = signalQueue.filter(s => s.id > lastId);

    if (unseenSignals.length > 0) {
        // PRIORITY LOGIC:
        // If there is an 'OPEN' signal, send it FIRST to ensure entries are not missed/delayed.
        // MODIFY signals can wait a bit, but OPEN signals are time-sensitive (15s timeout).
        const openSignal = unseenSignals.find(s => s.action === 'OPEN');
        
        if (openSignal) {
            res.json(openSignal);
        } else {
            // Otherwise, send the oldest unseen signal (FIFO)
            res.json(unseenSignals[0]);
        }
    } else {
        res.json({ id: 0 });
    }
});

app.post('/api/update_balance', (req, res) => {
    mt5LastSeen = Date.now(); // Update Last Seen
    
    // --- DEBUGGING: Raw MT5 data (disabled by default to avoid spam) ---
    // console.log('MT5 Raw Data:', JSON.stringify(req.body)); 
    
    const { balance, equity, positions } = req.body;
    if (balance !== undefined) account.balance = parseFloat(balance);
    if (equity !== undefined) account.equity = parseFloat(equity);
    
    // Update internal positions based on MT5 report
    if (positions && Array.isArray(positions)) {
        
        // Sync Logic: Check which pending pairs are now open
        positions.forEach(p => {
             // Find matching pair key (e.g. FOREXCOM:XAUUSD)
             const pairKey = Object.keys(marketData.pairs).find(k => {
                 // Clean both sides for flexible matching
                 // Bot Key: "FOREXCOM:XAUUSD" -> "xauusd"
                 // MT5 Symbol: "XAUUSD.m" -> "xauusd"
                 const botSymbol = k.includes(':') ? k.split(':')[1].toLowerCase() : k.toLowerCase();
                 const mt5Symbol = p.symbol.toLowerCase().replace('.m', '').replace('_i', '');
                 return botSymbol === mt5Symbol;
             });

             if (pairKey) {
                 if (pendingPairs.has(pairKey)) {
                     console.log(chalk.green(`CONFIRMED OPEN: ${pairKey}`));
                     pendingPairs.delete(pairKey);
                     // lastTradeTime[pairKey] = Date.now(); // Already set in openPosition (Optimistic)
                 }
             }
        });
        
        // Debug Log if positions mismatch
        // if (positions.length !== account.positions.filter(p => !p.ticket.toString().startsWith('PENDING')).length) {
        //    console.log(`Sync Mismatch: Bot has ${account.positions.length}, MT5 has ${positions.length}`);
        // }

        // 1. Get IDs of positions reported by MT5
        const mt5Tickets = new Set(positions.map(p => p.ticket.toString()));
        const mt5Symbols = new Set(positions.map(p => p.symbol.toLowerCase()));

        // 2. Filter existing bot positions
        // Keep positions that are:
        // a) CONFIRMED and present in MT5 report
        // b) PENDING (sent < 30s ago) - likely not yet reported by MT5
        // c) REMOVE CONFIRMED positions that are NOT in MT5 report (Manual Close detected)
        
        const now = Date.now();
        
        // --- DETECT CLOSED POSITIONS & SAVE HISTORY ---
        const closedPositions = account.positions.filter(p => {
            const isPending = p.ticket.toString().startsWith('PENDING-');
            if (isPending) return false; // Pending logic handled below
            return !mt5Tickets.has(p.ticket.toString()); // If not in MT5, it's closed
        });

        closedPositions.forEach(p => {
            // Only save if it has a valid profit (not 0, unless it broke even exactly)
            // We assume last known profit is the close profit (best guess without dedicated history endpoint)
            const profit = parseFloat(p.profit) || 0;
            
            console.log(chalk.yellow(`Position Closed: ${p.pair} (${p.ticket}) P/L: ${profit}`));
            
            // Start Cooldown
            lastTradeTime[p.pair] = Date.now();

            // Update Stats
            stats.totalProfit += profit;
            const todayStr = new Date().toISOString().slice(0, 10);
            if (stats.dailyDate !== todayStr) {
                stats.dailyDate = todayStr;
                stats.dailyProfit = 0;
            }
            stats.dailyProfit += profit;
            if (profit >= 0) stats.wins++; else stats.losses++;
            
            // UPDATE BRAIN
            updateBrain(p.pair, profit);

            // Add to History
            tradeHistory.unshift({
                ticket: p.ticket,
                pair: p.pair,
                type: p.type,
                mode: p.mode || 'UNKNOWN',
                openPrice: p.openPrice,
                lot: p.lot,
                profit: profit,
                closeTime: new Date().toISOString()
            });
            
            // Keep history limited to last 100
            if (tradeHistory.length > 100) tradeHistory.pop();
            
            // Save to File
            try {
                fs.writeFileSync(HISTORY_FILE, JSON.stringify(tradeHistory, null, 2));
            } catch (e) { console.error('Failed to save history:', e); }
        });
        
        // Update Filter (Remove closed positions from memory)
        account.positions = account.positions.filter(p => {
            const isPending = p.ticket.toString().startsWith('PENDING-');
            
            if (isPending) {
                // If pending for > 15 seconds, assume FAILED/REJECTED by MT5
                if (p.timestamp && (now - p.timestamp > 15000)) {
                    console.log(chalk.red(`Pending Timeout: ${p.pair} (${p.ticket}) - Removing`));
                    // Also clear pending lock so pair can re-trade
                    if (pendingPairs.has(p.pair)) {
                        pendingPairs.delete(p.pair);
                        console.log(chalk.red(`PENDING LOCK CLEARED: ${p.pair}`));
                    }
                    return false;
                }
                return true;
            } else {
                // It's a confirmed position (real ticket)
                // If MT5 says it's gone, it's gone.
                const existsInMt5 = mt5Tickets.has(p.ticket.toString());
                if (!existsInMt5) {
                     // Debug: Why is it removed?
                     // console.log(`Debug: Removing ${p.ticket} because it's not in MT5 list:`, Array.from(mt5Tickets));
                }
                return existsInMt5;
            }
        });

        // 3. Add new positions from MT5 that bot doesn't know about (e.g. manual opens, or just synced)
        // Also update profit for existing ones
        positions.forEach(mt5Pos => {
            // Find in account.positions
            const existing = account.positions.find(p => p.ticket.toString() === mt5Pos.ticket.toString());
            
            if (existing) {
                existing.profit = parseFloat(mt5Pos.profit);
                const newPrice = parseFloat(mt5Pos.open_price || mt5Pos.price || mt5Pos.openPrice);
                if (newPrice > 0) existing.openPrice = newPrice;
                if (!CONFIG.useVirtualSL && mt5Pos.sl !== undefined) existing.sl = parseFloat(mt5Pos.sl);
                if (mt5Pos.tp !== undefined) existing.tp = parseFloat(mt5Pos.tp);
                if (mt5Pos.volume !== undefined) existing.lot = parseFloat(mt5Pos.volume);
            } else {
                // New position from MT5 (could be manual or just missed sync)
                // We need to map symbol back to full pair name if possible
                // We try to match symbol with our CONFIG.pairs
                const pair = CONFIG.pairs.find(p => {
                    const cleanSymbol = p.includes(':') ? p.split(':')[1].toLowerCase() : p.toLowerCase();
                    const mt5Symbol = mt5Pos.symbol.toLowerCase();
                    // Match "EURUSD" with "EURUSD", "EURUSD.m", "EURUSDpro"
                    return mt5Symbol.includes(cleanSymbol) || cleanSymbol.includes(mt5Symbol);
                }) || `MT5:${mt5Pos.symbol}`;
                
                // --- FIX: INHERIT MODE FROM PENDING & CLEANUP DUPLICATES ---
                let mode = 'MANUAL'; // Default if no pending match
                let openPrice = parseFloat(mt5Pos.open_price);
                
                // Find matching pending position
                const pendingIdx = account.positions.findIndex(p => p.pair === pair && p.ticket.toString().startsWith('PENDING-'));
                let virtualSL = 0;
                if (pendingIdx !== -1) {
                    const pendingPos = account.positions[pendingIdx];
                    if (pendingPos.mode) mode = pendingPos.mode;
                    if (openPrice === 0 && pendingPos.openPrice > 0) openPrice = pendingPos.openPrice;
                    if (pendingPos.virtualSL) virtualSL = pendingPos.virtualSL;
                    account.positions.splice(pendingIdx, 1);
                }
                
                account.positions.push({
                    ticket: mt5Pos.ticket,
                    pair: pair,
                    type: mt5Pos.type === 0 ? 'BUY' : 'SELL', // 0=BUY, 1=SELL usually
                    mode: mode,
                    openPrice: openPrice,
                    lot: parseFloat(mt5Pos.volume),
                    profit: parseFloat(mt5Pos.profit),
                    sl: CONFIG.useVirtualSL ? virtualSL : parseFloat(mt5Pos.sl || 0),
                    tp: parseFloat(mt5Pos.tp || 0)
                });
            }
        });
    }

    // Emit Update
    io.emit('update', {
        pairs: marketData.pairs,
        account: account,
        lastSync: mt5LastSeen // Send Sync Time
    });
    
    res.json({ status: 'ok' });
});

app.post('/api/mt5/price', (req, res) => {
    const { symbol, timeframe, candles } = req.body || {};
    if (!symbol || !timeframe || !Array.isArray(candles) || candles.length === 0) {
        return res.json({ status: 'no-data' });
    }

    const pairKey = Object.keys(marketData.pairs).find(k => {
        const botSymbol = k.includes(':') ? k.split(':')[1].toLowerCase() : k.toLowerCase();
        const mt5Symbol = symbol.toLowerCase().replace('.m', '').replace('_i', '');
        return botSymbol === mt5Symbol;
    }) || symbol;

    if (!mt5Ohlc[pairKey]) mt5Ohlc[pairKey] = {};
    if (!mt5Ohlc[pairKey][timeframe]) mt5Ohlc[pairKey][timeframe] = { periods: [], lastUpdate: 0 };

    const store = mt5Ohlc[pairKey][timeframe];
    const maxLen = 300;

    candles.forEach(c => {
        if (c && typeof c.close === 'number') {
            const p = {
                time: c.time,
                open: c.open,
                max: c.high !== undefined ? c.high : c.max,
                min: c.low !== undefined ? c.low : c.min,
                close: c.close
            };
            store.periods.push(p);
            if (store.periods.length > maxLen) store.periods.shift();
        }
    });

    store.lastUpdate = Date.now();
    res.json({ status: 'ok' });
});

// --- SOCKET ---
io.on('connection', (socket) => {
    console.log(chalk.green('UI Connected'));
    
    // Prepare initial market data from cache
    const cachedMarket = {};
    Object.keys(marketData.pairs).forEach(p => {
        if (marketData.pairs[p].lastState) {
            cachedMarket[p] = {
                state: marketData.pairs[p].lastState,
                time: marketData.pairs[p].lastTime
            };
        }
    });

    socket.emit('init', {
        config: CONFIG,
        account,
        stats,
        history: tradeHistory,
        lastSync: mt5LastSeen,
        market: cachedMarket // SEND CACHED DATA
    });
    
    socket.on('updateSettings', (data) => {
        CONFIG.balance = parseFloat(data.balance);
        CONFIG.lotSize = parseFloat(data.lotSize) || 0.01;
        CONFIG.leverage = parseFloat(data.leverage);
        
        // Reset Account
        account.balance = CONFIG.balance;
        account.equity = CONFIG.balance;
        account.positions = [];
        stats = { wins: 0, losses: 0, totalProfit: 0 };
        tradeHistory = [];
        if (fs.existsSync(HISTORY_FILE)) fs.unlinkSync(HISTORY_FILE);
        
        io.emit('settingsUpdated', { 
            balance: CONFIG.balance, 
            lotSize: CONFIG.lotSize, 
            leverage: CONFIG.leverage, 
            mode: CONFIG.mode 
        });
        io.emit('log', `System Reset: Balance $${CONFIG.balance}, Lot ${CONFIG.lotSize}`);
    });

    socket.on('switchMode', (mode) => {
        CONFIG.mode = mode;
        io.emit('log', `Switched to ${mode} mode`);
        io.emit('settingsUpdated', { mode: CONFIG.mode });
    });
    
    socket.on('manualClose', (ticket) => {
        console.log(chalk.yellow(`MANUAL CLOSE REQUEST: Ticket ${ticket}`));
        closePosition(ticket, 'User Manual Close');
        io.emit('log', `Manual Close Requested for Ticket ${ticket}`);
    });
});

// --- TRADING VIEW ---
let tvClient = null;
let lastDataTime = Date.now();
// tvUpdateCount is already declared globally

// Self-Healing Watchdog: Restarts TV Client if no data for 60s
setInterval(() => {
    const silence = Date.now() - lastDataTime;
    if (silence > 60000) {
        console.log(chalk.red(`⚠️ WATCHDOG: Connection Dead (${Math.round(silence/1000)}s silence). Restarting...`));
        initTradingView();
        lastDataTime = Date.now(); // Reset to prevent double restart
    }
}, 10000);

function initTradingView() {
    // Reset Watchdog IMMEDIATELY to prevent loop
    lastDataTime = Date.now(); 

    if (tvClient) {
        console.log(chalk.yellow('Restarting TradingView Client...'));
        try {
            tvClient.end(); // Close existing connection
            tvClient = null; // Clear reference
        } catch (e) { console.error('Error closing TV client:', e); }
    }

    console.log(chalk.cyan(`Connecting to TradingView (${CONFIG.pairs.length} pairs)...`));
    
    try {
        tvClient = new TradingView.Client();

        CONFIG.pairs.forEach((pair) => {
            marketData.pairs[pair] = { price: 0, spread: 0, oppositeCounter: 0 };

            const chartEntry = new tvClient.Session.Chart();
            chartEntry.setMarket(pair, {
                timeframe: CONFIG.timeframe.entry,
                range: 300
            });

            const chartScalp = new tvClient.Session.Chart();
            chartScalp.setMarket(pair, {
                timeframe: CONFIG.timeframe.predatorEntry,
                range: 300
            });
            
            chartEntry.onError((err) => {
                // console.error(`TV Error on ${pair} [ENTRY]:`, err.message);
            }); 
            chartScalp.onError((err) => {
                // console.error(`TV Error on ${pair} [SCALP]:`, err.message);
            }); 

            chartEntry.onUpdate(() => {
                lastDataTime = Date.now();
                tvUpdateCount++;
                if (!chartEntry.periods || chartEntry.periods.length === 0) return;
                analyzeMarket(pair, chartEntry.periods, chartScalp.periods || chartEntry.periods);
            });

            chartScalp.onUpdate(() => {
                lastDataTime = Date.now();
                tvUpdateCount++;
                if (!chartScalp.periods || chartScalp.periods.length === 0) return;
                analyzeMarket(pair, chartEntry.periods || chartScalp.periods, chartScalp.periods);
            });
        });
    } catch (error) {
        console.error(chalk.red('FATAL TV INIT ERROR:'), error);
        // Retry in 5s
        setTimeout(initTradingView, 5000);
    }
}

function analyzeMarket(pair, periods, scalpPeriods) {
    if (!periods || periods.length === 0) return;

    let entryPeriods = periods;
    let scalpSource = scalpPeriods;

    if (CONFIG.priceSource === 'MT5' && mt5Ohlc[pair]) {
        const entryKey = CONFIG.timeframe.entry.toString();
        const scalpKey = CONFIG.timeframe.predatorEntry.toString();
        if (mt5Ohlc[pair][entryKey] && mt5Ohlc[pair][entryKey].periods && mt5Ohlc[pair][entryKey].periods.length > 0) {
            entryPeriods = mt5Ohlc[pair][entryKey].periods;
        }
        if (mt5Ohlc[pair][scalpKey] && mt5Ohlc[pair][scalpKey].periods && mt5Ohlc[pair][scalpKey].periods.length > 0) {
            scalpSource = mt5Ohlc[pair][scalpKey].periods;
        }
    }

    const basePeriods = entryPeriods;
    if (!basePeriods || basePeriods.length === 0) return;

    const currentPrice = basePeriods[basePeriods.length - 1].close;
    const timeStr = new Date().toLocaleTimeString();

    const activePos = account.positions.find(p => p.pair === pair && !p.ticket.toString().startsWith('PENDING'));
    let positionType = null;
    let virtualSL = null;
    let brokerSL = null;
    let tpLevel = null;
    if (activePos) {
        positionType = activePos.type || null;
        if (typeof activePos.virtualSL === 'number') virtualSL = activePos.virtualSL;
        if (typeof activePos.sl === 'number') brokerSL = activePos.sl;
        if (typeof activePos.tp === 'number') tpLevel = activePos.tp;
    }
    const lastCloseInfo = lastCloseReasonByPair[pair] || null;

    io.emit('price', { pair, price: currentPrice, time: timeStr });

    let usedPeriods = basePeriods;
    if (CONFIG.mode === 'PREDATOR_SCALP' || (CONFIG.mode === 'AUTO' && scalpSource && scalpSource.length > 0)) {
        if (scalpSource && scalpSource.length >= 50) {
            usedPeriods = scalpSource;
        }
    }

    const closes = usedPeriods.map(p => p.close);
    const highs = usedPeriods.map(p => p.max);
    const lows = usedPeriods.map(p => p.min);
    
    // 0. IMMEDIATE PRICE UPDATE (Even with < 50 history)
    // If history is insufficient for indicators (<50), we STILL emit price but signal WAIT
        if (usedPeriods.length < 50) {
        // Throttle slightly (250ms) to avoid spam but feel "instant"
        if (!marketData.pairs[pair].lastEmit || Date.now() - marketData.pairs[pair].lastEmit > 250) {
             const updateData = {
                pair,
                price: currentPrice,
                signal: 'WAIT',
                reason: `Loading History (${usedPeriods.length}/50)`,
                rsi: 0,
                rsi: 0,
                account,
                positionType,
                virtualSL,
                brokerSL,
                tp: tpLevel,
                lastCloseReason: lastCloseInfo ? lastCloseInfo.reason : null
            };
            
            // Cache state
            marketData.pairs[pair].lastState = updateData;
            marketData.pairs[pair].lastTime = timeStr;
            
            io.emit('update', updateData);
            // Price already emitted at start
            marketData.pairs[pair].lastEmit = Date.now();
        }
        return; // STOP here (Indicators need 50+ data points)
    }

    // --- INDICATORS ---
    const inputRSI = { values: closes, period: 14 };
    const rsiValues = RSI.calculate(inputRSI);
    const curRSI = rsiValues[rsiValues.length - 1] || 50;

    const inputMACD = {
        values: closes,
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
        SimpleMAOscillator: false,
        SimpleMASignal: false
    };
    const macdValues = MACD.calculate(inputMACD);
    const curMACD = macdValues[macdValues.length - 1] || { histogram: 0 };
    
    const inputATR = { high: highs, low: lows, close: closes, period: 14 };
    const atrValues = ATR.calculate(inputATR);
    const currentATR = atrValues[atrValues.length - 1] || 1;

    // --- NEW INDICATORS FOR SNIPER/PREDATOR ---
    const inputEMA = { values: closes, period: 200 };
    const emaValues = EMA.calculate(inputEMA);
    const curEMA = emaValues[emaValues.length - 1] || currentPrice;

    const inputBB = { values: closes, period: 20, stdDev: 2 };
    const bbValues = BollingerBands.calculate(inputBB);
    const curBB = bbValues[bbValues.length - 1] || { lower: currentPrice * 0.99, upper: currentPrice * 1.01, middle: currentPrice };

    // --- NEW: ADX FOR TREND STRENGTH ---
    const inputADX = { high: highs, low: lows, close: closes, period: 14 };
    const adxValues = ADX.calculate(inputADX);
    const curADX = adxValues[adxValues.length - 1] || { adx: 0, pdi: 0, mdi: 0 };

    // --- SPREAD SIMULATION / FETCH ---
    // If spread is not available from TV, we default to 0.00010 (1 pip)
    let spread = marketData.pairs[pair].spread || 0.00010;

    // --- LOGIC ---
    let signal = 'WAIT';
    let reason = '';
    const isAutoMode = CONFIG.mode === 'AUTO';
    
    // --- AUTO MODE ADAPTATION ---
    let effectiveMode = CONFIG.mode;
    if (effectiveMode === 'AUTO') {
        // Adaptive Logic (Scalping + Reversal):
        // AUTO lebih selektif dengan ADX yang sedikit lebih tinggi
        const trendCutoff = 25;
        const strongTrendCutoff = 30;
        if (curADX.adx > strongTrendCutoff) {
            effectiveMode = 'PREDATOR_SCALP';
        } else if (curADX.adx < trendCutoff) {
            effectiveMode = 'SNIPER';
        } else {
            // Zona abu-abu: hindari entry di AUTO
            effectiveMode = 'NONE';
        }
    }

    // --- LOSS STREAK PROTECTION (PAIR COOLDOWN) ---
    const nowMs = Date.now();
    const cooldownUntil = pairCooldownUntil[pair] || 0;
    if (cooldownUntil && nowMs < cooldownUntil) {
        const minutesLeft = Math.max(1, Math.round((cooldownUntil - nowMs) / 60000));
        reason = `Pair Cooling Off (${minutesLeft}m) after loss streak`;
        const updateData = {
            pair,
            price: currentPrice,
            signal: 'WAIT',
            reason,
            rsi: curRSI,
            account,
            positionType,
            virtualSL,
            brokerSL,
            tp: tpLevel,
            lastCloseReason: lastCloseInfo ? lastCloseInfo.reason : null
        };
        marketData.pairs[pair].lastState = updateData;
        marketData.pairs[pair].lastTime = timeStr;
        io.emit('update', updateData);
        marketData.pairs[pair].lastEmit = nowMs;
        return;
    }

    // --- PREDATOR FOMC/NEWS STRATEGY ---
    // "Prepare for entry, then execute immediately when time is right"
    if (effectiveMode === 'PREDATOR') {
        const now = new Date();
        // Find nearest FOMC/High Impact event (-15m to +60m)
        const targetEvent = newsEvents.find(e => {
            const diff = (e.date - now) / 60000; // minutes
            return diff > -15 && diff < 60 && (e.title.includes('FOMC') || e.title.includes('Federal Funds'));
        });

        if (targetEvent) {
            const minutesToNews = (targetEvent.date - now) / 60000;

            // PHASE 1: PREPARE (Stalking Mode) - 30 mins before
            if (minutesToNews > 0 && minutesToNews <= 30) {
                if (!fomcState.isStalking) {
                    fomcState.isStalking = true;
                    fomcState.eventName = targetEvent.title;
                    console.log(chalk.magenta(`PREDATOR: Stalking ${targetEvent.title} (in ${minutesToNews.toFixed(1)}m)`));
                }

                // Update Range continuously until 1 min before news
                if (minutesToNews > 1) {
                    // Last 4 candles (approx 1 hour on M15)
                    const recentCandles = basePeriods.slice(-4);
                    fomcState.preNewsRange = {
                        high: Math.max(...recentCandles.map(c => c.max)),
                        low: Math.min(...recentCandles.map(c => c.min)),
                        set: true
                    };
                }

                signal = 'WAIT';
                reason = `Predator: Stalking ${targetEvent.title} (Range ${fomcState.preNewsRange.low.toFixed(5)} - ${fomcState.preNewsRange.high.toFixed(5)})`;
                io.emit('update', { 
                    pair, 
                    price: currentPrice, 
                    signal, 
                    reason, 
                    rsi: curRSI, 
                    account,
                    positionType,
                    virtualSL,
                    brokerSL,
                    tp: tpLevel,
                    lastCloseReason: lastCloseInfo ? lastCloseInfo.reason : null
                });
                return; // BLOCK normal trades
            }

            // PHASE 2: EXECUTION (0 to 15 mins after)
            if (minutesToNews <= 0 && minutesToNews > -15) {
                if (fomcState.preNewsRange.set) {
                    const range = fomcState.preNewsRange;
                    // aggressive breakout check
                    // If we are mostly flat, wait. If we break, GO.
                    
                    if (currentPrice > range.high) {
                        signal = 'BUY';
                        reason = `PREDATOR FOMC: Breakout UP (${currentPrice} > ${range.high})`;
                        // We do NOT return here, we let it fall through to send the signal
                        // BUT we must bypass other filters (Spread, RSI, etc)
                        // So we create a "FORCE" flag or just emit here?
                        
                        // Let's emit here to skip filters
                        const sl = currentPrice - (currentATR * 2); // Wider SL for news
                        const tp = currentPrice + (currentATR * 5); // Huge TP for news
                        
                        // Send Signal Directly (Bypassing Filters)
                        const tradeSignal = {
                            id: signalIdCounter++,
                            action: 'OPEN',
                            pair: pair,
                            type: 'BUY',
                            price: currentPrice,
                            sl: sl,
                            tp: tp,
                            lot: CONFIG.lotSize, // Could double lot size for predator? No, stick to config.
                            comment: 'Predator FOMC'
                        };
                        
                        signalQueue.push(tradeSignal);
                        io.emit('signal_log', `PREDATOR FOMC EXECUTION: BUY ${pair}`);
                        fomcState.preNewsRange.set = false; // Prevent double entry
                        fomcState.isStalking = false;
                        
                        // Cooldown
                        lastTradeTime[pair] = Date.now() + (15 * 60 * 1000); 
                        return;
                    } 
                    else if (currentPrice < range.low) {
                        signal = 'SELL';
                        reason = `PREDATOR FOMC: Breakout DOWN (${currentPrice} < ${range.low})`;
                        
                        const sl = currentPrice + (currentATR * 2);
                        const tp = currentPrice - (currentATR * 5);
                        
                        const tradeSignal = {
                            id: signalIdCounter++,
                            action: 'OPEN',
                            pair: pair,
                            type: 'SELL',
                            price: currentPrice,
                            sl: sl,
                            tp: tp,
                            lot: CONFIG.lotSize,
                            comment: 'Predator FOMC'
                        };
                        
                        signalQueue.push(tradeSignal);
                        io.emit('signal_log', `PREDATOR FOMC EXECUTION: SELL ${pair}`);
                        fomcState.preNewsRange.set = false;
                        fomcState.isStalking = false;
                        lastTradeTime[pair] = Date.now() + (15 * 60 * 1000);
                        return;
                    }
                    else {
                        signal = 'WAIT';
                        reason = `Predator: Waiting for Breakout... (${currentPrice})`;
                        io.emit('update', { 
                            pair, 
                            price: currentPrice, 
                            signal, 
                            reason, 
                            rsi: curRSI, 
                            account,
                            positionType,
                            virtualSL,
                            brokerSL,
                            tp: tpLevel,
                            lastCloseReason: lastCloseInfo ? lastCloseInfo.reason : null
                        });
                        return;
                    }
                }
            }
        }
    }

    // 1. SPREAD FILTER (Relaxed for Predator, lebih ketat untuk Scalper)
    let maxAllowedSpread = 0.00050; // 5 pips
    if (pair.includes('XAU')) maxAllowedSpread = 0.80; // 80 cents
    if (pair.includes('JPY')) maxAllowedSpread = 0.050; // 5 pips
    if (effectiveMode === 'PREDATOR_SCALP') {
        // Scalping butuh spread lebih ketat
        maxAllowedSpread *= 0.6;
        if (pair.includes('XAU')) maxAllowedSpread = 0.40;
        if (pair.includes('JPY')) maxAllowedSpread = 0.030;
    }
    
    if (spread > maxAllowedSpread) {
        // Skip
        reason = `Spread High: ${spread.toFixed(5)}`;
        io.emit('update', { 
            pair, 
            price: currentPrice, 
            signal, 
            reason, 
            rsi: curRSI, 
            account,
            positionType,
            virtualSL,
            brokerSL,
            tp: tpLevel,
            lastCloseReason: lastCloseInfo ? lastCloseInfo.reason : null
        });
        // Price already emitted at start
        return;
    }

    // 2. MACD THRESHOLD (Adjusted for Non-BTC & AUTO)
    const baseMacdThreshold = currentPrice > 500 ? 0.05 : 0.00001;
    const macdThreshold = isAutoMode ? baseMacdThreshold * 1.5 : baseMacdThreshold;
    const isMomentum = Math.abs(curMACD.histogram) > macdThreshold;

    // 3. ENTRY LOGIC
    
    // --- SAFETY: VOLATILITY GUARD (News/Flash Crash Filter) ---
    // User Update: "Ada pergerakan besar... harusnya entry" (Big Move = Entry Opportunity)
    // So we CHANGE this guard. Instead of blocking, we check if it's a "Breakout".
    
    const currentCandle = periods[periods.length - 1];
    const candleRange = currentCandle.max - currentCandle.min;
    
    // Default safe ATR (if ATR is 0, use 0.05% price)
    const safeAtrGuard = (currentATR && currentATR > 0) ? currentATR : (currentPrice * 0.0005);
    
    // "BIG MOVEMENT" DETECTOR (SMART MONEY)
    // If candle is HUGE (> 3x ATR), it might be a breakout.
    if (candleRange > (safeAtrGuard * 3.0)) {
        // Instead of blocking, let's see if we can ride it.
        // We only block if it's INSANE (> 6x ATR) which is likely a data error or extreme news whiplash.
        if (candleRange > (safeAtrGuard * 6.0)) {
            reason = `High Volatility (Extreme): Range ${candleRange.toFixed(5)} > 6x ATR`;
            lastTradeTime[pair] = Date.now() + (5 * 60 * 1000);
            io.emit('update', { 
                pair, 
                price: currentPrice, 
                signal: 'COOLDOWN', 
                reason, 
                rsi: curRSI, 
                account,
                positionType,
                virtualSL,
                brokerSL,
                tp: tpLevel,
                lastCloseReason: lastCloseInfo ? lastCloseInfo.reason : null
            });
            // Price already emitted at start
            return;
        }
        
        // MOMENTUM INJECTION (Smart Money Mode)
        // If Price is breaking bands + Big Candle -> FORCE ENTRY
        // We bypass RSI Overbought/Oversold because Smart Money pushes RSI to extremes.
        
        const isBullishCandle = currentPrice > currentCandle.open;
        const isBearishCandle = currentPrice < currentCandle.open;
        
        if (isBullishCandle && currentPrice > curBB.upper) {
             signal = 'BUY';
             reason = `SMART MONEY: Momentum Breakout (Range ${candleRange.toFixed(5)})`;
             // Boost ATR for SL/TP because volatility is high
        } else if (isBearishCandle && currentPrice < curBB.lower) {
             signal = 'SELL';
             reason = `SMART MONEY: Momentum Breakout (Range ${candleRange.toFixed(5)})`;
        }
    } else {
        // Standard Volatility Guard (Logic Below)
    }
    
    // --- MODE LOGIC ---
    if (signal === 'BUY' || signal === 'SELL') {
        // Already found Smart Money signal? Execute it.
    } else if (effectiveMode === 'PREDATOR' || effectiveMode === 'PREDATOR_SCALP') {
        // SMART PREDATOR (Momentum + Trend + Volatility)
        // AUTO mode: lebih ketat (ADX & MACD lebih tinggi)
        // Rule 2: RSI not overextended (Buy < 70, Sell > 30)
        // Rule 3: MACD matches EMA Trend
        // Rule 4 (NEW): EMA Separation (Avoid Flat/Choppy Trend)
        
        const baseTrendCutoff = 25;
        const trendCutoff = isAutoMode ? (effectiveMode === 'PREDATOR_SCALP' ? 30 : 27) : baseTrendCutoff;
        const isTrend = curADX.adx > trendCutoff;
        const isSafeRSI_Buy = curRSI < 70;
        const isSafeRSI_Sell = curRSI > 30;
        
        // EMA Separation Check (Is Trend Healthy?)
        // Ideally Price should be away from EMA, or EMA should be angled.
        // Simple check: Price vs EMA distance > 0.5 ATR
        const emaDist = Math.abs(currentPrice - curEMA);
        let emaBaseFactor = 0.5;
        if (effectiveMode === 'PREDATOR_SCALP') emaBaseFactor = isAutoMode ? 0.6 : 0.4;
        const emaFactor = isAutoMode ? emaBaseFactor + 0.1 : emaBaseFactor;
        const isHealthyTrend = emaDist > (safeAtrGuard * emaFactor);

        if (isTrend && isMomentum) {
            if (curMACD.histogram > macdThreshold && currentPrice > curEMA && isSafeRSI_Buy) {
                if(isHealthyTrend) {
                    signal = 'BUY';
                    reason = `Predator Buy (ADX ${curADX.adx.toFixed(1)})`;
                } else {
                    reason = `Wait: Trend Too Flat (EMA Proximity)`;
                }
            } else if (curMACD.histogram < -macdThreshold && currentPrice < curEMA && isSafeRSI_Sell) {
                if(isHealthyTrend) {
                    signal = 'SELL';
                    reason = `Predator Sell (ADX ${curADX.adx.toFixed(1)})`;
                } else {
                    reason = `Wait: Trend Too Flat (EMA Proximity)`;
                }
            } else {
                reason = `Wait: Trend Valid but RSI/EMA unsafe`;
            }
        } else {
            reason = `Wait: Low Trend (ADX ${curADX.adx.toFixed(1)})`;
        }
    } else {
        // SNIPER (Reversal + Volatility Filter + SMART MONEY REJECTION)
        // PILLAR 1: RSI Extremes (30/70)
        // PILLAR 2: Bollinger Band Interaction (Price <= Lower / Price >= Upper)
        // PILLAR 3: ADX Filter (Avoid strong trends > 40)
        // PILLAR 4: Smart Money Wick Rejection (Detect Institutional Entry)

        const isSafeTrend = curADX.adx < 40; 
        
        // --- SMART MONEY DETECTION (Liquidity Sweep) ---
        // Look for recent candle (last 1-2 periods) with long wick REJECTING the band
        const lastCandle = periods[periods.length - 1];
        const prevCandle = periods[periods.length - 2]; // Sometimes rejection happened 1 min ago
        
        // Helper to check rejection
        function checkSmartRejection(c, type) {
            if (!c) return false;
            const totalSize = c.max - c.min;
            if (totalSize === 0) return false;
            
            const upperWick = c.max - Math.max(c.open, c.close);
            const lowerWick = Math.min(c.open, c.close) - c.min;
            const wickRatio = 0.30; // RELAXED: 30% of candle must be wick (Was 35%)

            if (type === 'BUY') {
                // Long Lower Wick + Low touched BB Lower
                return (lowerWick / totalSize > wickRatio) && (c.min <= curBB.lower * 1.0005);
            } else {
                // Long Upper Wick + High touched BB Upper
                return (upperWick / totalSize > wickRatio) && (c.max >= curBB.upper * 0.9995);
            }
        }

        const isSmartBuy = checkSmartRejection(lastCandle, 'BUY') || checkSmartRejection(prevCandle, 'BUY');
        const isSmartSell = checkSmartRejection(lastCandle, 'SELL') || checkSmartRejection(prevCandle, 'SELL');
        
        // SAFETY: Avoid Huge Momentum Candles for Reversal
        // If current candle is huge (Body > 2x ATR), don't fight it yet.
        const bodySize = Math.abs(currentCandle.open - currentCandle.close);
        const isHugeMomentum = bodySize > (safeAtrGuard * 2.0);

        // TREND FILTER: Only Trade WITH the 200 EMA (Buy dips in Uptrend, Sell rallies in Downtrend)
        const isBullishTrend = currentPrice > curEMA;
        const isBearishTrend = currentPrice < curEMA;

        if (curRSI < 30 && currentPrice <= curBB.lower) {
            if (isSafeTrend) {
                if (isSmartBuy && !isHugeMomentum && isBullishTrend) {
                    signal = 'BUY';
                    reason = `Sniper Buy (Smart Money Rejection + RSI ${curRSI.toFixed(1)} + Trend OK)`;
                } else {
                    if(isHugeMomentum) reason = `Wait: Momentum Too Strong (Big Body)`;
                    else if(!isBullishTrend) reason = `Wait: Counter-Trend (Price < EMA 200)`;
                    else reason = `Wait: Need Smart Wick Rejection`;
                }
            } else {
                reason = `Wait: Trend Too Strong (ADX ${curADX.adx.toFixed(1)})`;
            }
        } else if (curRSI > 70 && currentPrice >= curBB.upper) {
            if (isSafeTrend) {
                if (isSmartSell && !isHugeMomentum && isBearishTrend) {
                    signal = 'SELL';
                    reason = `Sniper Sell (Smart Money Rejection + RSI ${curRSI.toFixed(1)} + Trend OK)`;
                } else {
                    if(isHugeMomentum) reason = `Wait: Momentum Too Strong (Big Body)`;
                    else if(!isBearishTrend) reason = `Wait: Counter-Trend (Price > EMA 200)`;
                    else reason = `Wait: Need Smart Wick Rejection`;
                }
            } else {
                reason = `Wait: Trend Too Strong (ADX ${curADX.adx.toFixed(1)})`;
            }
        } else {
            reason = `Wait: RSI ${curRSI.toFixed(2)} | BB Range`;
        }
    }

    // --- 4. EXECUTION
    const existing = account.positions.find(p => p.pair === pair);
    const isPending = pendingPairs.has(pair);
    
    // --- SMART EXIT: OPPOSITE SIGNAL ---
    // If we have a BUY but signal is SELL (and strong), Close BUY immediately.
    // Grace Period: Don't close within 60s of entry (let trade breathe)
    
    let canCloseOpposite = true;
    if (existing) {
        // MT5 position timestamp might be seconds/ms. JS uses ms.
        // Assuming pos.timestamp (from openPosition/MT5 sync) is ms.
        const openTime = existing.timestamp || Date.now();
        const tradeAge = Date.now() - openTime; 
        if (tradeAge < 60000) { // 60s Grace Period
            canCloseOpposite = false;
        }
    }

    if (existing && !isPending && signal !== 'WAIT') {
         // Initialize counter if missing
         if (marketData.pairs[pair].oppositeCounter === undefined) marketData.pairs[pair].oppositeCounter = 0;

         // Check Reversal Persistence
         let isOpposite = false;
         if (existing.type === 'BUY' && signal === 'SELL') isOpposite = true;
         if (existing.type === 'SELL' && signal === 'BUY') isOpposite = true;
         
         if (isOpposite) {
             marketData.pairs[pair].oppositeCounter++;
         } else {
             marketData.pairs[pair].oppositeCounter = 0;
         }

         if (isOpposite && marketData.pairs[pair].oppositeCounter >= 3 && canCloseOpposite) {
             if (existing.type === 'BUY') {
                 closePosition(existing.ticket, 'Opposite Signal Detected (SELL) - Confirmed');
             } else {
                 closePosition(existing.ticket, 'Opposite Signal Detected (BUY) - Confirmed');
             }
             marketData.pairs[pair].oppositeCounter = 0; // Reset
         }
    } else {
        // Reset if pending or WAIT (to be safe)
        if (marketData.pairs[pair] && marketData.pairs[pair].oppositeCounter !== undefined) {
            marketData.pairs[pair].oppositeCounter = 0;
        }
    }
    
    // Cooldown Check (Mode-based)
    const lastTime = lastTradeTime[pair] || 0;
    let cooldownMs = 10 * 60 * 1000; // Default 10 menit
    if (effectiveMode === 'PREDATOR_SCALP') {
        cooldownMs = 5 * 60 * 1000; // Scalping lebih cepat
    }
    const inCooldown = (Date.now() - lastTime) < cooldownMs;

    if (signal !== 'WAIT') {
        if (!existing && !isPending && !inCooldown) {
            openPosition(pair, signal, currentPrice, timeStr, currentATR, effectiveMode);
        } else if (isPending) {
            reason = 'Pending Execution...';
        } else if (inCooldown) {
            const remaining = Math.ceil((cooldownMs - (Date.now() - lastTime)) / 60000);
            reason = `Cooldown (${remaining}m)`;
        }
    }
    
    // --- MANAGE OPEN POSITIONS (Secure Profit & Trailing Stop) ---
    managePositions(pair, currentPrice, curRSI, curBB, currentATR);

    // --- THROTTLE EMITS ---
    // Price updates are very frequent. We throttle them to once per 500ms per pair.
    if (!marketData.pairs[pair].lastEmit || Date.now() - marketData.pairs[pair].lastEmit > 500) {
        const updateData = {
            pair,
            price: currentPrice,
            signal: (isPending ? 'PENDING' : (inCooldown ? 'COOLDOWN' : signal)),
            reason,
            rsi: curRSI,
            account,
            positionType,
            virtualSL,
            brokerSL,
            tp: tpLevel,
            lastCloseReason: lastCloseInfo ? lastCloseInfo.reason : null
        };
        
        // CACHE LATEST STATE
        marketData.pairs[pair].lastState = updateData;
        marketData.pairs[pair].lastTime = timeStr;

        io.emit('update', updateData);
        // Price already emitted at start
        marketData.pairs[pair].lastEmit = Date.now();
    }
}

function openPosition(pair, type, price, time, atr, mode = 'PREDATOR') {
    
    // --- CONNECTION GUARD ---
    // If MT5 hasn't sent a heartbeat in > 60s, block trading.
    const msSinceSync = Date.now() - mt5LastSeen;
    if (msSinceSync > 60000) {
        console.log(chalk.red(`BLOCKED: MT5 Connection Lost (Last seen ${Math.round(msSinceSync/1000)}s ago)`));
        return;
    }

    // --- SAFETY: MAX DAILY LOSS / PROFIT TARGET CHECK ---
    const todayStr = new Date().toISOString().slice(0, 10);
    if (stats.dailyDate !== todayStr) {
        stats.dailyDate = todayStr;
        stats.dailyProfit = 0;
    }
    if (stats.dailyProfit <= -CONFIG.maxDailyLoss) {
        console.log(chalk.red(`BLOCKED: Max Daily Loss Reached ($${stats.dailyProfit.toFixed(2)})`));
        return;
    }
    if (stats.dailyProfit >= CONFIG.dailyProfitTarget) {
        console.log(chalk.green(`BLOCKED: Daily Profit Target Reached ($${stats.dailyProfit.toFixed(2)})`));
        return;
    }
    if (globalCooldownUntil && Date.now() < globalCooldownUntil) {
        const minutesLeft = Math.max(1, Math.round((globalCooldownUntil - Date.now()) / 60000));
        console.log(chalk.red(`BLOCKED: Global Loss Streak Cooldown (${minutesLeft}m remaining)`));
        return;
    }

    const now = new Date();
    const hour = now.getHours();
    if (hour < CONFIG.tradingHours.start || hour >= CONFIG.tradingHours.end) {
        console.log(chalk.yellow(`BLOCKED: Outside trading hours (${hour}h)`));
        return;
    }

    console.log(chalk.green(`OPEN ${type} ${pair} @ ${price}`));

    const minAtr = price * CONFIG.minAtrFraction;
    const maxAtr = price * CONFIG.maxAtrFraction;
    
    let safeAtr = (atr && atr > 0) ? atr : minAtr;
    if (safeAtr < minAtr) {
        console.log(chalk.yellow(`ATR too small (${safeAtr.toFixed(5)}), boosting to min (${minAtr.toFixed(5)})`));
        safeAtr = minAtr;
    }
    
    if (safeAtr > maxAtr) {
        console.log(chalk.yellow(`ATR too huge (${safeAtr.toFixed(5)}), capping at max (${maxAtr.toFixed(5)})`));
        safeAtr = maxAtr;
    }

    let slMult = CONFIG.slMultiplier;
    let tpMult = CONFIG.tpMultiplier;

    // Satu logika umum: SL & TP berbasis ATR (tidak tergantung mode)
    // Penyesuaian ringan hanya berdasarkan karakter pair (JPY, XAU, dll)
    if (pair.includes('JPY')) {
        // JPY cenderung volatil tapi range per pip kecil → tambah sedikit ruang
        slMult *= 1.1; // SL ≈ 2.2 ATR
        tpMult *= 1.1; // TP ≈ 3.3 ATR
    }
    if (pair.includes('XAU')) {
        // Emas sangat volatile → SL sedikit lebih kecil agar resiko terkendali, TP tetap lebar
        slMult *= 0.9; // SL ≈ 1.8 ATR
        tpMult *= 1.0; // TP ≈ 3.0 ATR
    }

    const slDist = safeAtr * slMult;
    const tpDist = safeAtr * tpMult;
    
    console.log(chalk.magenta(`📊 CALC DETAIL [${pair}][${mode}]: Price=${price} | ATR=${atr ? atr.toFixed(5) : 'N/A'} | SafeATR=${safeAtr.toFixed(5)} | SL_Dist=${slDist.toFixed(5)} | TP_Dist=${tpDist.toFixed(5)}`));
    console.log(chalk.gray(`Logic Check: Multipliers SL=${slMult} TP=${tpMult}`));

    // --- PRICE ADAPTATION (TV vs MT5) ---
    // If the price from TV (Signal) is different from MT5 real-time, adjust SL/TP.
    // However, we don't always have real-time MT5 quote here.
    // STRATEGY: We send the SL/TP *DISTANCES* to the MT5 bot, not just absolute prices.
    // BUT since we can't easily change the MQ5, we try to use the latest known price from MT5 if available.
    
    // Check if we have a recent quote from MT5 (via heartbeat/sync) - Implementation simplified:
    // We assume 'price' passed here is the TRIGGER price (TV).
    // If we rely on TV price for SL/TP, and MT5 price is different, we might have invalid SL/TP.
    // FIX: We will recalculate SL/TP based on the *execution* price logic in MT5 if possible, 
    // OR we just ensure we are sending the levels relative to the TV price but understanding the gap.
    
    // BETTER FIX: The user wants "smart adjustment". 
    // Let's check if we have any recent position for this pair to gauge the price difference? 
    // No, that's unreliable.
    // Instead, we trust the 'price' passed in (which is the Signal Price).
    // The MT5 bot (FBSBot) usually executes at Market.
    // If the gap is huge, the trade might be risky.
    
    // Let's implement a 'Gap Check' if we had MT5 feed. 
    // Since we don't have a live tick feed from MT5 in this Node code (it's one-way mostly),
    // we focus on the SL/TP *Ratio* which is robust.
    
    let slPrice = 0;
    let tpPrice = 0;

    if (type === 'BUY') {
        slPrice = price - slDist;
        tpPrice = price + tpDist;
    } else if (type === 'SELL') {
        slPrice = price + slDist;
        tpPrice = price - tpDist;
    }

    let virtualSL = slPrice;

    if (CONFIG.slRandomOffsetFactor > 0) {
        const offset = safeAtr * CONFIG.slRandomOffsetFactor;
        const rand = Math.random();
        const adj = offset * rand;
        if (type === 'BUY') {
            virtualSL = slPrice - adj;
        } else if (type === 'SELL') {
            virtualSL = slPrice + adj;
        }
    }

    let brokerSL = slPrice;
    if (CONFIG.useVirtualSL) {
        const emergencyDist = safeAtr * CONFIG.emergencySLMultiplier;
        if (type === 'BUY') {
            brokerSL = price - emergencyDist;
        } else if (type === 'SELL') {
            brokerSL = price + emergencyDist;
        }
    }

    // Round to reasonable precision (5 decimals covers most forex)
    slPrice = parseFloat(slPrice.toFixed(5));
    tpPrice = parseFloat(tpPrice.toFixed(5));
    virtualSL = parseFloat(virtualSL.toFixed(5));
    brokerSL = parseFloat(brokerSL.toFixed(5));

    // --- MONEY MANAGEMENT (LOT SIZE CALCULATION) ---
    let finalLot = CONFIG.lotSize;
    if (CONFIG.autoCompound) {
        // Formula: Floor(Equity / RiskFactor) * 0.01
        // Example: Equity $880 / 150 = 5.86 -> 5 * 0.01 = 0.05 Lot
        const calculatedLot = Math.floor(account.equity / CONFIG.riskFactor) * 0.01;
        finalLot = Math.max(0.01, calculatedLot); // Minimum 0.01
        finalLot = parseFloat(finalLot.toFixed(2));
        console.log(chalk.magenta(`Money Management: Equity $${account.equity} -> Lot ${finalLot}`));
    }
    
    const id = signalIdCounter++;
    
    // Mark as PENDING immediately to prevent spam
    if (pendingPairs.has(pair)) {
        console.log(chalk.yellow(`BLOCKED: Already Pending ${pair}`));
        return;
    }
    
    // Double Check Cooldown (Race Condition Safety)
    const lastTime = lastTradeTime[pair] || 0;
    let cooldownMs = 10 * 60 * 1000; // Default 10 menit
    if (mode === 'PREDATOR_SCALP') {
        cooldownMs = 5 * 60 * 1000; // Scalping lebih cepat
    }
    if ((Date.now() - lastTime) < cooldownMs) {
        console.log(chalk.yellow(`BLOCKED: Cooldown Active ${pair}`));
        return;
    }

    pendingPairs.add(pair);
    // OPTIMISTIC COOLDOWN: Start cooldown timer NOW.
    // This prevents the bot from firing another signal for this pair 
    // even if the trade tracking glitches or MT5 sync lags.
    lastTradeTime[pair] = Date.now();
    
    // --- PERSIST MEMORY (Prevent Amnesia on Restart) ---
    brain.lastTradeTime = lastTradeTime;
    try {
        fs.writeFileSync(BRAIN_FILE, JSON.stringify(brain, null, 2));
    } catch (e) { console.error('Failed to save brain cooldown:', e); }
    
    console.log(chalk.yellow(`PENDING LOCK & COOLDOWN START: ${pair}`));
    
    // Auto-unlock after 60s if no response (Safety)
    setTimeout(() => {
        if(pendingPairs.has(pair)) {
             console.log(chalk.red(`PENDING TIMEOUT: Unlocking ${pair}`));
             pendingPairs.delete(pair);
             // Note: We do NOT reset lastTradeTime here. 
             // If it failed, we still wait 15 mins. Better safe than spam.
        }
    }, 60000);

    signalQueue.push({
        id: id,
        action: 'OPEN',
        symbol: pair.includes(':') ? pair.split(':')[1] : pair,
        type: type,
        lot: finalLot,
        price: price, // Send Entry Price for Reference
        sl: CONFIG.useVirtualSL ? brokerSL : slPrice,
        tp: tpPrice
    });
    
    if (signalQueue.length > 50) signalQueue.shift();
    
    account.positions.push({
        ticket: 'PENDING-' + id,
        pair,
        type,
        mode, // Store Mode
        openPrice: price,
        virtualSL: virtualSL,
        lot: finalLot,
        profit: 0,
        timestamp: Date.now() // Add timestamp for timeout logic
    });
}

function updateBrain(pair, profit) {
    // Ensure pair exists in brain
    if (!brain.pairs) brain.pairs = {};
    if (!brain.pairs[pair]) {
        brain.pairs[pair] = { wins: 0, losses: 0, totalProfit: 0 };
    }
    if (!brain.pairLossStreak) brain.pairLossStreak = {};
    if (!brain.pairCooldownUntil) brain.pairCooldownUntil = {};
    if (pairLossStreak[pair] === undefined) pairLossStreak[pair] = 0;

    // Update Pair Stats
    brain.pairs[pair].totalProfit += profit;
    if (profit >= 0) {
        brain.pairs[pair].wins++;
        brain.global.wins++;
        pairLossStreak[pair] = 0;
        globalLossStreak = 0;
    } else {
        brain.pairs[pair].losses++;
        brain.global.losses++;
        pairLossStreak[pair] = (pairLossStreak[pair] || 0) + 1;
        globalLossStreak = (globalLossStreak || 0) + 1;
        if (pairLossStreak[pair] >= 3) {
            const cooldownMs = 60 * 60 * 1000; // 1 hour cooldown
            const until = Date.now() + cooldownMs;
            pairCooldownUntil[pair] = until;
            brain.pairCooldownUntil[pair] = until;
        }
        if (globalLossStreak >= CONFIG.globalLossStreakLimit) {
            const gMs = CONFIG.globalLossStreakCooldownMinutes * 60 * 1000;
            const gUntil = Date.now() + gMs;
            globalCooldownUntil = gUntil;
            brain.globalCooldownUntil = gUntil;
        }
    }
    
    brain.pairLossStreak = pairLossStreak;
    brain.globalLossStreak = globalLossStreak;
    
    // Update Global Profit
    brain.global.totalProfit += profit;

    // Save to File
    try {
        fs.writeFileSync(BRAIN_FILE, JSON.stringify(brain, null, 2));
    } catch (e) {
        console.error('Failed to save brain:', e);
    }
}

function managePositions(pair, currentPrice, rsi, bb, atr) {
    const pos = account.positions.find(p => p.pair === pair);
    if (!pos || pos.ticket.toString().startsWith('PENDING')) return;

    if (CONFIG.useVirtualSL && pos.virtualSL) {
        const vsl = parseFloat(pos.virtualSL);
        if (pos.type === 'BUY' && currentPrice <= vsl) {
            closePosition(pos.ticket, 'Virtual SL Hit');
            return;
        }
        if (pos.type === 'SELL' && currentPrice >= vsl) {
            closePosition(pos.ticket, 'Virtual SL Hit');
            return;
        }
    }

    // --- 1. BREAKEVEN / PARTIAL PROFIT STYLE ---
    // Geser SL ke sekitar BE + sedikit profit ketika harga sudah cukup jauh
    const modeForTrailing = pos.mode || CONFIG.mode;
    
    let currentSL = parseFloat(pos.sl) || 0;
    let currentTP = parseFloat(pos.tp) || 0;
    const openPrice = parseFloat(pos.openPrice);
    
    // Dynamic Distances based on ATR & mode
    // SNIPER  : lock profit lebih cepat, tapi tetap beri ruang
    // PREDATOR: lebih longgar, biar bisa ride trend
    // SCALP   : kombinasi – cepat BE, trailing agak longgar
    
    let activationDist = atr * 1.0;   // Jarak mulai trailing
    let trailingDist = atr * 1.2;     // Jarak SL dari harga saat trailing
    let stepDist = atr * 0.15;        // Minimal peningkatan SL
    let breakevenDist = atr * 0.8;    // Jarak untuk geser ke BE
    let beOffset = atr * 0.1;         // Sedikit profit di atas BE
    
    if (modeForTrailing === 'SNIPER') {
        activationDist = atr * 0.9;
        trailingDist = atr * 1.1;
        stepDist = atr * 0.12;
        breakevenDist = atr * 0.7;
    } else if (modeForTrailing === 'PREDATOR_SCALP') {
        activationDist = atr * 1.0;
        trailingDist = atr * 1.3;
        stepDist = atr * 0.12;
        breakevenDist = atr * 0.8;
    } else if (modeForTrailing === 'PREDATOR') {
        activationDist = atr * 1.2;
        trailingDist = atr * 1.6;
        stepDist = atr * 0.2;
        breakevenDist = atr * 1.0;
    }

    // XAUUSD Safety (Gold is volatile, give it more room)
    if (pair.includes('XAU')) {
        activationDist += (atr * 0.3);
        trailingDist += (atr * 0.5);
        breakevenDist += (atr * 0.3);
    }
    
    // Safety Buffer for Price Divergence (TV vs MT5)
    // We don't want to set SL too close to current price if TV lag exists.
    const priceBuffer = currentPrice * 0.0005; // 0.05% buffer

    let newSL = 0;
    let shouldModify = false;

    // --- Breakeven Step (gaya partial TP tanpa benar-benar close) ---
    if (!pos.breakEvenSet) {
        if (pos.type === 'BUY') {
            if (currentPrice >= (openPrice + breakevenDist)) {
                let beSL = openPrice + beOffset;
                if (beSL < currentPrice - priceBuffer) {
                    newSL = beSL;
                    shouldModify = true;
                    pos.breakEvenSet = true;
                }
            }
        } else if (pos.type === 'SELL') {
            if (currentPrice <= (openPrice - breakevenDist)) {
                let beSL = openPrice - beOffset;
                if (beSL > currentPrice + priceBuffer) {
                    newSL = beSL;
                    shouldModify = true;
                    pos.breakEvenSet = true;
                }
            }
        }
    }

    if (!shouldModify && pos.type === 'BUY') {
        // Condition: Price > Open + Activation
        if (currentPrice > (openPrice + activationDist)) {
            // Target SL: Price - TrailingDist
            let potentialSL = currentPrice - trailingDist;
            
            // Validation 1: New SL must be HIGHER than Current SL (Lock Profit)
            // If currentSL is 0 (no SL), any SL is an improvement.
            if (currentSL === 0 || potentialSL > (currentSL + stepDist)) {
                
                // Validation 2: SL must be below Current Price (Logic Check)
                if (potentialSL < (currentPrice - priceBuffer)) {
                    
                    // Validation 3: SL must not cross TP (if TP exists)
                    if (currentTP === 0 || potentialSL < currentTP) {
                        newSL = potentialSL;
                        shouldModify = true;
                    }
                }
            }
        }
    } else if (!shouldModify && pos.type === 'SELL') {
        // Condition: Price < Open - Activation
        if (currentPrice < (openPrice - activationDist)) {
            // Target SL: Price + TrailingDist
            let potentialSL = currentPrice + trailingDist;
            
            // Validation 1: New SL must be LOWER than Current SL
            // If currentSL is 0 (no SL), set it.
            if (currentSL === 0 || potentialSL < (currentSL - stepDist)) {
                
                // Validation 2: SL must be above Current Price
                if (potentialSL > (currentPrice + priceBuffer)) {
                    
                    // Validation 3: SL must not cross TP
                    if (currentTP === 0 || potentialSL > currentTP) {
                        newSL = potentialSL;
                        shouldModify = true;
                    }
                }
            }
        }
    }

    if (shouldModify) {
        // Round to 5 decimals
        newSL = parseFloat(newSL.toFixed(5));
        
        console.log(chalk.cyan(`Trailing Stop Triggered for ${pair} (${pos.ticket})`));
        console.log(chalk.gray(`   Price: ${currentPrice} | Old SL: ${currentSL} -> New SL: ${newSL}`));
        
        const id = signalIdCounter++;
        signalQueue.push({
            id: id,
            action: 'MODIFY',
            ticket: pos.ticket,
            sl: newSL,
            tp: currentTP // IMPORTANT: Send existing TP to preserve it
        });
        
        // Optimistic Update
        pos.sl = newSL;
    }

    // --- 3. SMART EXIT (Protect Profit from Reversal) ---
    // User Requirement: "jika harga open tidak kunjung mencapai tp dan ada indikasi pembalikan maka akan otomatis close"
    
    // Only active if decent profit (0.1%) OR trade has been running too long with no progress
    // SPECIAL RULE FOR GOLD (XAU): More breathing room (0.2%)
    let minProfitPoints = currentPrice * 0.001;
    if (pair.includes('XAU')) minProfitPoints = currentPrice * 0.002;

    let isProfit = false;
    
    // Check if we are in "Decent Profit" zone
    if (pos.type === 'BUY' && currentPrice > (pos.openPrice + minProfitPoints)) isProfit = true;
    if (pos.type === 'SELL' && currentPrice < (pos.openPrice - minProfitPoints)) isProfit = true;

    // Time-based Stagnation Check
    // If trade is older than 2 hours and profit is barely positive or negative, be sensitive to reversal
    const tradeDuration = Date.now() - (pos.timestamp || 0);
    const isStagnant = tradeDuration > (2 * 60 * 60 * 1000); 

    if (!isProfit && !isStagnant) return; 

    let closeReason = null;
    if (pos.type === 'BUY') {
        if (currentPrice < bb.middle) closeReason = 'Trend Reversal (Price < BB Middle)';
        else if (rsi < 40) closeReason = 'Momentum Loss (RSI < 40)'; // Dropped below neutral
    } else if (pos.type === 'SELL') {
        if (currentPrice > bb.middle) closeReason = 'Trend Reversal (Price > BB Middle)';
        else if (rsi > 60) closeReason = 'Momentum Gain (RSI > 60)'; // Rose above neutral
    }

    // XAUUSD SPECIAL: Ignore minor RSI flickers
    if (pair.includes('XAU') && closeReason && closeReason.includes('RSI')) {
        // Only close XAU on RSI if it's extreme (Reversal confirmed)
        if (pos.type === 'BUY' && rsi > 35) closeReason = null; // Ignore weak dip
        if (pos.type === 'SELL' && rsi < 65) closeReason = null; // Ignore weak rally
    }

    if (closeReason) {
        console.log(chalk.yellow(`🛡️ SMART EXIT: Closing ${pair} (${closeReason}) - Profit Protection/Stagnation`));
        const ticket = pos.ticket;
        const reason = closeReason;

        // ... existing close logic below ...

        closePosition(pos.ticket, closeReason);
    }
}

function closePosition(ticket, reason) {
    const pos = account.positions.find(p => p.ticket == ticket);
    if (!pos) {
        console.log(chalk.red(`Cannot close unknown ticket: ${ticket}`));
        return;
    }
    
    console.log(chalk.yellow(`CLOSING ${pos.pair} (Ticket ${ticket}) - Reason: ${reason}`));
    
    lastCloseReasonByPair[pos.pair] = {
        reason,
        time: new Date().toISOString()
    };
    io.emit('position_closed', {
        pair: pos.pair,
        ticket,
        reason,
        time: lastCloseReasonByPair[pos.pair].time
    });
    
    // Add to Signal Queue for MT5 to execute
    const id = signalIdCounter++;
    signalQueue.push({
        id: id,
        action: 'CLOSE',
        ticket: ticket,
        reason: reason
    });
    
    // Optimistic Update: Remove from local immediately
    // If it fails, MT5 will sync it back
    // account.positions = account.positions.filter(p => p.ticket != ticket);

    if (signalQueue.length > 50) signalQueue.shift();
}

server.listen(3006, async () => {
    console.log(chalk.blue(`🚀 Server running on http://localhost:3006`));
    console.log(chalk.cyan(`Bot Mode: ${CONFIG.mode}`));
    initTradingView();
    
    // --- 1. LOCAL WIFI ACCESS (Faster/Reliable) ---
    try {
        const interfaces = os.networkInterfaces();
        let localIP = 'localhost';
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    localIP = iface.address;
                    break;
                }
            }
        }
        console.log(chalk.green(`📱 ANDROID ACCESS (Same WiFi): http://${localIP}:3006`));
    } catch (e) {}

    // --- 2. REMOTE INTERNET ACCESS (Tunnel) ---
    if (CONFIG.enableRemote) {
        try {
            console.log(chalk.gray('🔄 Starting Remote Tunnel...'));
            const tunnel = await localtunnel({ port: 3006 });
            console.log(chalk.magenta(`🌍 ANDROID ACCESS (Anywhere): ${tunnel.url}`));
            
            tunnel.on('close', () => {
                console.log(chalk.yellow('⚠️ Remote Tunnel Closed'));
            });
        } catch (err) {
            console.error(chalk.red('❌ Failed to create remote tunnel:'), err.message);
        }
    }

    // --- AUTO-OPEN BROWSER (Desktop App Experience) ---
    const url = 'http://localhost:3006';
    const start = (process.platform == 'darwin'? 'open': process.platform == 'win32'? 'start': 'xdg-open');
    require('child_process').exec(start + ' ' + url);
});
