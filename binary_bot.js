const admin = require('firebase-admin');

// 1. Initialize Firebase Securely from GitHub Secrets
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// 2. Config
const COINS = ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','AVAXUSDT','DOTUSDT','LINKUSDT'];

// --- Indicator Math Functions ---
function calcSMA(closes, period) {
    let sma = [];
    let sum = 0;
    for (let i = 0; i < closes.length; i++) {
        sum += closes[i];
        if (i >= period) sum -= closes[i - period];
        if (i >= period - 1) sma.push(sum / period);
        else sma.push(null);
    }
    return sma;
}

function calcBB(closes, period = 20, multiplier = 2) {
    let bb = [];
    const sma = calcSMA(closes, period);
    for (let i = 0; i < closes.length; i++) {
        if (i < period - 1) {
            bb.push({ upper: null, lower: null, mid: null });
            continue;
        }
        let variance = 0;
        for (let j = 0; j < period; j++) {
            variance += Math.pow(closes[i - j] - sma[i], 2);
        }
        const stdDev = Math.sqrt(variance / period);
        bb.push({
            upper: sma[i] + (stdDev * multiplier),
            lower: sma[i] - (stdDev * multiplier),
            mid: sma[i]
        });
    }
    return bb;
}

function calcRSI(closes, period = 14) {
    let rsi = [], gain = 0, loss = 0;
    for(let i=1; i<closes.length; i++) {
        let diff = closes[i] - closes[i-1];
        if(i <= period) {
            diff >= 0 ? gain+=diff : loss+=Math.abs(diff);
            if(i === period) rsi.push(loss===0?100:100-(100/(1+(gain/loss)))); else rsi.push(null);
        } else {
            gain = ((gain*(period-1)) + (diff>=0?diff:0))/period;
            loss = ((loss*(period-1)) + (diff<0?Math.abs(diff):0))/period;
            rsi.push(loss===0?100:100-(100/(1+(gain/loss))));
        }
    }
    return rsi;
}

// 3. Binary Options Signal Logic
function analyzeCandle(data, symbol) {
    const closes = data.map(c => c.close);
    const opens = data.map(c => c.open);
    const highs = data.map(c => c.high);
    const lows = data.map(c => c.low);
    
    const idx = closes.length - 1; // The candle that just perfectly closed
    const pIdx = idx - 1; // The candle before that
    
    let probability = 50;
    let signal = null;

    const currClose = closes[idx], currOpen = opens[idx], currHigh = highs[idx], currLow = lows[idx];
    const prevClose = closes[pIdx], prevOpen = opens[pIdx];
    
    // Engulfing Pattern Check
    const bullishEngulfing = prevClose < prevOpen && currClose > currOpen && currClose > prevOpen && currOpen < prevClose;
    const bearishEngulfing = prevClose > prevOpen && currClose < currOpen && currClose < prevOpen && currOpen > prevClose;

    // Indicators
    const rsi = calcRSI(closes)[idx];
    const bb = calcBB(closes)[idx];

    // Confluence Scoring
    if (bullishEngulfing && currLow <= bb.lower) {
        signal = 'CALL';
        probability += 30;
        if (rsi < 40) probability += 10;
    } else if (bearishEngulfing && currHigh >= bb.upper) {
        signal = 'PUT';
        probability += 30;
        if (rsi > 60) probability += 10;
    }

    // ==========================================
    // ⚠️ TEST MODE OVERRIDE (UNCOMMENT TO TEST UI)
    // Remove the two slashes '//' below to force the bot to spit out fake trades
    // ==========================================
    // return { signal: Math.random() > 0.5 ? 'CALL' : 'PUT', probability: Math.floor(Math.random() * (99 - 80 + 1) + 80) };

    if (probability >= 85) return { signal, probability };
    return null;
}

// 4. MAIN BINARY ENGINE LOOP
async function runBinaryBot() {
    console.log("🚀 Waking up Binary Engine...");
    const signalsRef = db.collection('binary_signals');
    
    // A. Read existing PENDING trades
    const pendingSnap = await signalsRef.where('status', '==', 'PENDING').get();
    const pendingTrades = [];
    pendingSnap.forEach(doc => pendingTrades.push({ id: doc.id, ...doc.data() }));

    for (const symbol of COINS) {
        try {
            // Fetch Binance Data using their public data-api
            const res = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=5m&limit=40`);
            if (!res.ok) throw new Error(`API HTTP Error: ${res.status}`);
            
            const raw = await res.json();
            if (!Array.isArray(raw)) throw new Error(`API Blocked/Invalid: ${JSON.stringify(raw)}`);

            // Binance always returns the actively forming, incomplete candle as the last item in the array.
            const data = raw.map(c => ({ 
                time: c[0], open: parseFloat(c[1]), high: parseFloat(c[2]), low: parseFloat(c[3]), close: parseFloat(c[4])
            }));
            
            // Isolate the perfectly closed candles from the actively forming one
            const closedCandles = data.slice(0, -1); 
            const justClosedCandle = closedCandles[closedCandles.length - 1];
            const activelyFormingCandle = data[data.length - 1];

            // --- RECONCILIATION LOOP (Check Wins/Losses) ---
            const activeCoinTrades = pendingTrades.filter(t => t.symbol === symbol);
            for (const trade of activeCoinTrades) {
                // Check if the candle that just closed is the exact one we predicted
                if (justClosedCandle.time >= trade.targetCandleTime) {
                    const isGreen = justClosedCandle.close > justClosedCandle.open;
                    const isRed = justClosedCandle.close < justClosedCandle.open;
                    
                    let result = 'LOSS';
                    if ((trade.signal === 'CALL' && isGreen) || (trade.signal === 'PUT' && isRed)) {
                        result = 'WIN';
                    } else if (justClosedCandle.close === justClosedCandle.open) {
                        result = 'TIE';
                    }

                    await signalsRef.doc(trade.id).update({ 
                        status: result, 
                        closePrice: justClosedCandle.close,
                        resolvedAt: Date.now()
                    });
                    console.log(`Resolved ${symbol} Binary Trade: ${result}`);
                }
            }

            // --- PREDICT THE NEXT CANDLE ---
            // Only search if there isn't already a pending trade for this coin
            if (activeCoinTrades.length === 0) {
                const analysis = analyzeCandle(closedCandles, symbol);
                
                if (analysis) {
                    // We are predicting the final closing color of the currently forming candle
                    const newSignal = {
                        symbol: symbol,
                        signal: analysis.signal,
                        probability: analysis.probability,
                        status: 'PENDING',
                        timestamp: Date.now(),
                        targetCandleTime: activelyFormingCandle.time, // Identifies which exact 5m candle we are predicting
                        entryPrice: activelyFormingCandle.open
                    };
                    await signalsRef.add(newSignal);
                    console.log(`✅ Fired Binary Prediction: ${symbol} ${analysis.signal}`);
                }
            }
            
            // API rate limit respect
            await new Promise(r => setTimeout(r, 200)); 
            
        } catch (e) {
            console.error(`Error processing ${symbol}:`, e.message);
        }
    }
    
    console.log("💤 Binary Engine finished.");
}

// Ensure function is called correctly at the end
runBinaryBot();
