const admin = require('firebase-admin');

// 1. Initialize Firebase Securely from GitHub Secrets
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// 2. Config - Top 3 Major Quotex Pairs
const COINS = ['EUR/USD', 'GBP/USD', 'USD/JPY'];
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
        if (i < period - 1 || !sma[i]) {
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

// 3. Ultra-High-Activity Binary Options Signal Logic
function analyzeCandle(data, symbol) {
    const closes = data.map(c => c.close);
    const highs = data.map(c => c.high);
    const lows = data.map(c => c.low);
    
    const idx = closes.length - 1; 
    
    // Calculate indicators
    const rsiArray = calcRSI(closes, 14);
    const bbArray = calcBB(closes, 20, 2);
    
    const rsi = rsiArray[rsiArray.length - 1];
    const bb = bbArray[bbArray.length - 1];

    if (!rsi || !bb.upper || !bb.lower) return null;

    let probability = 50;
    let signal = null;

    // Detect general directional momentum
    const isPushingDown = lows[idx] < closes[idx - 1];
    const isPushingUp = highs[idx] > closes[idx - 1];

    if (isPushingDown) {
        signal = 'CALL'; // Expecting a bounce up
        probability += 5; 
        
        // Add points if it's nearing the bottom band
        if (lows[idx] <= bb.lower * 1.0005) probability += 15;
        
        // Add points for low RSI
        if (rsi < 45) probability += Math.min(25, (45 - rsi) * 1.5);
        
    } else if (isPushingUp) {
        signal = 'PUT'; // Expecting a rejection down
        probability += 5;
        
        // Add points if it's nearing the top band
        if (highs[idx] >= bb.upper * 0.9995) probability += 15;
        
        // Add points for high RSI
        if (rsi > 55) probability += Math.min(25, (rsi - 55) * 1.5);
    }

    // LOWERED THRESHOLD: Fire a signal if probability is just 55% or higher
    if (signal && probability >= 55) {
        return { signal, probability: Math.min(98, Math.round(probability)) };
    }
    
    return null;
}

// 4. MAIN BINARY ENGINE LOOP
async function runBinaryBot() {
    console.log("🚀 Waking up Forex Binary Engine...");
    if (!API_KEY) {
        console.error("❌ ERROR: TWELVE_DATA_API_KEY secret is missing inside GitHub!");
        return;
    }
    
    const signalsRef = db.collection('binary_signals');
    
    // A. Clean out older PENDING signals to prevent cluttering the interface
    const oldPendingSnap = await signalsRef.where('status', '==', 'PENDING').get();
    const nowTime = Date.now();
    for (const doc of oldPendingSnap.docs) {
        const d = doc.data();
        if (nowTime - d.timestamp > 10 * 60 * 1000) { 
            await signalsRef.doc(doc.id).update({ status: 'EXPIRED' });
        }
    }

    // B. Fetch fresh pending entries for standard win/loss evaluation
    const pendingSnap = await signalsRef.where('status', '==', 'PENDING').get();
    const pendingTrades = [];
    pendingSnap.forEach(doc => pendingTrades.push({ id: doc.id, ...doc.data() }));

    for (const symbol of COINS) {
        try {
            console.log(`Scanning historical bars for ${symbol}...`);
            
            // ✅ EXACT FIX: Removed the invalid /api/v1/ path from the URL
            const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=5min&outputsize=40&apikey=${API_KEY}`;
            const res = await fetch(url);
            
            if (!res.ok) throw new Error(`HTTP Error Status: ${res.status}`);
            const json = await res.json();
            
            // Log any API-level errors so they don't fail silently
            if (json.status === 'error') {
                console.error(`TwelveData API Error for ${symbol}: ${json.message}`);
                continue;
            }
            if (!json.values || json.values.length === 0) {
                console.error(`No data returned for ${symbol}`);
                continue;
            }

            // Twelve Data provides data newest-to-oldest; reverse it to chronology order
            const data = json.values.map(c => ({
                time: new Date(c.datetime).getTime(),
                open: parseFloat(c.open),
                high: parseFloat(c.high),
                low: parseFloat(c.low),
                close: parseFloat(c.close)
            })).reverse();

            const closedCandles = data.slice(0, -1); 
            const justClosedCandle = closedCandles[closedCandles.length - 1];
            const activelyFormingCandle = data[data.length - 1];

            // --- RECONCILIATION LOOP ---
            const activeCoinTrades = pendingTrades.filter(t => t.symbol === symbol);
            for (const trade of activeCoinTrades) {
                if (justClosedCandle.time >= trade.targetCandleTime) {
                    const isGreen = justClosedCandle.close > justClosedCandle.open;
                    const isRed = justClosedCandle.close < justClosedCandle.open;
                    
                    let result = 'LOSS';
                    if ((trade.signal === 'CALL' && isGreen) || (trade.signal === 'PUT' && isRed)) result = 'WIN';
                    else if (justClosedCandle.close === justClosedCandle.open) result = 'TIE';

                    await signalsRef.doc(trade.id).update({ 
                        status: result, 
                        closePrice: justClosedCandle.close,
                        resolvedAt: Date.now()
                    });
                    console.log(`🏁 Resolved ${symbol}: ${result}`);
                }
            }

            // --- GENERATE ACTIVE SIGNALS ---
            if (activeCoinTrades.length === 0) {
                const analysis = analyzeCandle(closedCandles, symbol);
                
                if (analysis) {
                    const newSignal = {
                        symbol: symbol,
                        signal: analysis.signal,
                        probability: analysis.probability,
                        status: 'PENDING',
                        timestamp: Date.now(),
                        targetCandleTime: activelyFormingCandle.time,
                        entryPrice: activelyFormingCandle.open
                    };
                    await signalsRef.add(newSignal);
                    console.log(`🎯 Signal Sent: ${symbol} -> ${analysis.signal} (${analysis.probability}%)`);
                } else {
                    console.log(`No clear setup for ${symbol} right now.`);
                }
            }
            
            // Wait 8 seconds between requests to perfectly respect Twelve Data's free tier limits
            await new Promise(r => setTimeout(r, 8000)); 
            
        } catch (e) {
            console.error(`⚠️ Skipping ${symbol} iteration:`, e.message);
        }
    }
    console.log("💤 Scanning cycle finished.");
}

runBinaryBot();
