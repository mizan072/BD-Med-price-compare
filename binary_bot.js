const admin = require('firebase-admin');

// 1. Initialize Firebase Securely
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// 2. Config for Forex
// We track the 3 most popular Quotex pairs to stay well under the 800/day free limit
const PAIRS = ['EUR/USD', 'GBP/USD', 'USD/JPY'];
const API_KEY = process.env.TWELVE_DATA_API_KEY;

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
    
    // Twelve Data only gives us CLOSED candles on this specific endpoint query
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
    // ==========================================
    // return { signal: Math.random() > 0.5 ? 'CALL' : 'PUT', probability: Math.floor(Math.random() * (99 - 80 + 1) + 80) };

    if (probability >= 80) return { signal, probability };
    return null;
}

// 4. MAIN FOREX BINARY ENGINE LOOP
async function runBinaryBot() {
    console.log("🚀 Waking up Forex Binary Engine...");
    const signalsRef = db.collection('binary_signals');
    
    // Safety check for API Key
    if (!API_KEY) {
        console.error("❌ ERROR: TWELVE_DATA_API_KEY is missing from GitHub Secrets.");
        return;
    }

    // A. Read existing PENDING trades
    const pendingSnap = await signalsRef.where('status', '==', 'PENDING').get();
    const pendingTrades = [];
    pendingSnap.forEach(doc => pendingTrades.push({ id: doc.id, ...doc.data() }));

    // B. Fetch Data from Twelve Data API
    for (const symbol of PAIRS) {
        try {
            // Twelve Data API Endpoint for 5m Forex Data
            const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=5min&outputsize=40&apikey=${API_KEY}`;
            const res = await fetch(url);
            const raw = await res.json();
            
            if (raw.status === "error") throw new Error(`API Error: ${raw.message}`);

            // Twelve Data returns data from newest to oldest. We MUST reverse it for our TA functions.
            const data = raw.values.reverse().map(c => ({ 
                time: new Date(c.datetime).getTime(), 
                open: parseFloat(c.open), 
                high: parseFloat(c.high), 
                low: parseFloat(c.low), 
                close: parseFloat(c.close)
            }));
            
            // Twelve Data gives us only CLOSED candles in this specific format.
            // The last item in the array is the candle that JUST closed.
            const closedCandles = data; 
            const justClosedCandle = closedCandles[closedCandles.length - 1];
            
            // We are predicting the NEXT candle, which will open at the current time + 5 minutes
            const nextCandleTime = justClosedCandle.time + (5 * 60 * 1000);

            // --- RECONCILIATION LOOP (Check Wins/Losses) ---
            const activeCoinTrades = pendingTrades.filter(t => t.symbol === symbol);
            for (const trade of activeCoinTrades) {
                // If the candle that just closed is the one we were trying to predict
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
                    console.log(`Resolved ${symbol} Forex Trade: ${result}`);
                }
            }

            // --- PREDICT THE NEXT CANDLE ---
            if (activeCoinTrades.length === 0) {
                const analysis = analyzeCandle(closedCandles, symbol);
                
                if (analysis) {
                    const newSignal = {
                        symbol: symbol,
                        signal: analysis.signal,
                        probability: analysis.probability,
                        status: 'PENDING',
                        timestamp: Date.now(),
                        targetCandleTime: nextCandleTime,
                        entryPrice: justClosedCandle.close // Approximate entry
                    };
                    await signalsRef.add(newSignal);
                    console.log(`✅ Fired Forex Prediction: ${symbol} ${analysis.signal}`);
                }
            }
            
            // Twelve Data allows 8 requests per minute on free tier. Be polite.
            await new Promise(r => setTimeout(r, 8000)); 
            
        } catch (e) {
            console.error(`Error processing ${symbol}:`, e.message);
        }
    }
    
    console.log("💤 Forex Binary Engine finished.");
}

runBinaryBot();
