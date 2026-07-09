const admin = require('firebase-admin');

// 1. Initialize Firebase Securely from GitHub Secrets
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// 2. Config for Forex
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

// 3. Binary Options Signal Logic (Dynamic Confidence)
function analyzeCandle(data, symbol) {
    const closes = data.map(c => c.close);
    const opens = data.map(c => c.open);
    const highs = data.map(c => c.high);
    const lows = data.map(c => c.low);
    
    // Twelve Data sends closed candles, so the last candle is our trigger candle
    const idx = closes.length - 1; 
    const pIdx = idx - 1; 
    
    // Baseline Confidence
    let probability = 50; 
    let signal = null;

    const currClose = closes[idx], currOpen = opens[idx], currHigh = highs[idx], currLow = lows[idx];
    const prevClose = closes[pIdx], prevOpen = opens[pIdx];
    
    // Direction Bias
    const isBullish = currClose > currOpen;
    const isBearish = currClose < currOpen;

    // Pattern Check
    const bullishEngulfing = prevClose < prevOpen && currClose > currOpen && currClose > prevOpen && currOpen < prevClose;
    const bearishEngulfing = prevClose > prevOpen && currClose < currOpen && currClose < prevOpen && currOpen > prevClose;

    // Indicators
    const rsi = calcRSI(closes)[idx];
    const bb = calcBB(closes)[idx];
    const sma = calcSMA(closes, 5)[idx]; 

    // --- DYNAMIC CONFIDENCE SCORING ---
    
    if (isBullish) {
        signal = 'CALL';
        if (currClose > sma) probability += 8; // Trend confirmation
        if (bullishEngulfing) probability += 15; // Strong pattern
        
        // Dynamic RSI Score (Max +15%)
        // The closer RSI gets to 30, the higher the score.
        if (rsi < 45) {
            const rsiBonus = Math.min(15, (45 - rsi) * 0.8);
            probability += rsiBonus;
        }
        
        // Dynamic Bollinger Bounce (Max +15%)
        // Measures how close the wick got to piercing the bottom band
        const distanceToLower = (currLow - bb.lower) / bb.lower;
        if (distanceToLower <= 0) probability += 15; 
        else if (distanceToLower <= 0.0005) probability += 10; 
        else if (distanceToLower <= 0.001) probability += 5; 
        
    } else if (isBearish) {
        signal = 'PUT';
        if (currClose < sma) probability += 8; // Trend confirmation
        if (bearishEngulfing) probability += 15; // Strong pattern
        
        // Dynamic RSI Score (Max +15%)
        // The closer RSI gets to 70, the higher the score
        if (rsi > 55) {
            const rsiBonus = Math.min(15, (rsi - 55) * 0.8);
            probability += rsiBonus;
        }
        
        // Dynamic Bollinger Rejection (Max +15%)
        const distanceToUpper = (bb.upper - currHigh) / bb.upper;
        if (distanceToUpper <= 0) probability += 15;
        else if (distanceToUpper <= 0.0005) probability += 10;
        else if (distanceToUpper <= 0.001) probability += 5;
    }

    // Ensure probability doesn't exceed realistic numbers (Cap at 99%)
    probability = Math.min(99, Math.round(probability));

    // Threshold: Only fire if confidence is 75% or higher
    if (probability >= 75) return { signal, probability };
    
    // Uncomment the line below if you want to FORCE fake test signals right now
    // return { signal: Math.random() > 0.5 ? 'CALL' : 'PUT', probability: Math.floor(Math.random() * (99 - 75 + 1) + 75) };

    return null;
}

// 4. MAIN FOREX BINARY ENGINE LOOP
async function runBinaryBot() {
    console.log("🚀 Waking up Forex Binary Engine...");
    const signalsRef = db.collection('binary_signals');
    
    if (!API_KEY) {
        console.error("❌ ERROR: TWELVE_DATA_API_KEY is missing from GitHub Secrets.");
        return;
    }

    const pendingSnap = await signalsRef.where('status', '==', 'PENDING').get();
    const pendingTrades = [];
    pendingSnap.forEach(doc => pendingTrades.push({ id: doc.id, ...doc.data() }));

    for (const symbol of PAIRS) {
        try {
            // Twelve Data API for Forex
            const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=5min&outputsize=40&apikey=${API_KEY}`;
            const res = await fetch(url);
            const raw = await res.json();
            
            if (raw.status === "error") throw new Error(`API Error: ${raw.message}`);

            // Twelve Data returns newest candles first, so we MUST .reverse() them for math calculations
            const data = raw.values.reverse().map(c => ({ 
                time: new Date(c.datetime).getTime(), 
                open: parseFloat(c.open), high: parseFloat(c.high), low: parseFloat(c.low), close: parseFloat(c.close)
            }));
            
            const closedCandles = data; 
            const justClosedCandle = closedCandles[closedCandles.length - 1];
            
            // Calculate when the NEXT candle (the one we are predicting) will close
            const nextCandleTime = justClosedCandle.time + (5 * 60 * 1000);

            // --- RECONCILIATION LOOP ---
            const activeCoinTrades = pendingTrades.filter(t => t.symbol === symbol);
            for (const trade of activeCoinTrades) {
                // If the candle we predicted just finished closing
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
                        status: result, closePrice: justClosedCandle.close, resolvedAt: Date.now()
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
                        probability: analysis.probability, // Dynamic precise percentage
                        status: 'PENDING',
                        timestamp: Date.now(),
                        targetCandleTime: nextCandleTime,
                        entryPrice: justClosedCandle.close
                    };
                    await signalsRef.add(newSignal);
                    console.log(`✅ Fired Forex Prediction: ${symbol} ${analysis.signal} at ${analysis.probability}%`);
                }
            }
            
            // Respect API limits (Twelve Data free tier is 8 requests/minute)
            await new Promise(r => setTimeout(r, 8000)); 
            
        } catch (e) {
            console.error(`Error processing ${symbol}:`, e.message);
        }
    }
    console.log("💤 Forex Binary Engine finished.");
}

runBinaryBot();
