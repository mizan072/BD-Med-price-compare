const admin = require('firebase-admin');

// 1. Initialize Firebase Securely
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// 2. DEDICATED MODE: Only USD/JPY
const COINS = ['USD/JPY'];
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

// 3. Signal Logic (Returns CALL, PUT, or NO TRADE)
function analyzeCandle(data) {
    const closes = data.map(c => c.close);
    const highs = data.map(c => c.high);
    const lows = data.map(c => c.low);
    const idx = closes.length - 1; 
    
    const rsiArray = calcRSI(closes, 14);
    const bbArray = calcBB(closes, 20, 2);
    
    const rsi = rsiArray[rsiArray.length - 1];
    const bb = bbArray[bbArray.length - 1];

    if (!rsi || !bb.upper || !bb.lower) return { signal: 'NO TRADE', probability: 0, reason: 'Calculating Indicators' };

    let probability = 50;
    let signal = null;

    const touchesLowerBB = lows[idx] <= bb.lower * 1.0002;
    const touchesUpperBB = highs[idx] >= bb.upper * 0.9998;

    if (touchesLowerBB) {
        signal = 'CALL';
        probability += 20; 
        if (rsi < 40) probability += Math.min(25, (40 - rsi) * 1.5);
    } else if (touchesUpperBB) {
        signal = 'PUT';
        probability += 20;
        if (rsi > 60) probability += Math.min(25, (rsi - 60) * 1.5);
    }

    if (signal && probability >= 55) {
        return { signal, probability: Math.min(98, Math.round(probability)), reason: 'Setup Found' };
    }
    
    return { signal: 'NO TRADE', probability: 0, reason: 'Market Flat / No Setup' };
}

// 4. MAIN ENGINE
async function runBinaryBot() {
    console.log("🚀 Waking up USD/JPY Binary Engine...");
    
    const signalsRef = db.collection('binary_signals');
    
    // Cleanup old pending trades (Stuck data)
    const oldPendingSnap = await signalsRef.where('status', '==', 'PENDING').get();
    const nowTime = Date.now();
    for (const doc of oldPendingSnap.docs) {
        if (nowTime - doc.data().timestamp > 25 * 60 * 1000) { 
            await signalsRef.doc(doc.id).update({ status: 'EXPIRED' });
        }
    }

    // Get Active Pending Trades to Resolve
    const pendingSnap = await signalsRef.where('status', '==', 'PENDING').get();
    const pendingTrades = [];
    pendingSnap.forEach(doc => pendingTrades.push({ id: doc.id, ...doc.data() }));

    for (const symbol of COINS) {
        try {
            console.log(`Fetching USD/JPY...`);
            const res = await fetch(`https://api.twelvedata.com/time_series?symbol=${symbol}&interval=5min&outputsize=40&timezone=UTC&apikey=${API_KEY}`);
            const json = await res.json();
            
            const data = json.values.map(c => ({
                time: new Date(c.datetime.replace(' ', 'T') + 'Z').getTime(),
                open: parseFloat(c.open),
                high: parseFloat(c.high),
                low: parseFloat(c.low),
                close: parseFloat(c.close)
            })).reverse();

            const closedCandles = data.slice(0, -1); 
            const justClosedCandle = closedCandles[closedCandles.length - 1];
            const activelyFormingCandle = data[data.length - 1];

            // 1. RECONCILE PAST TRADES
            const activeTrades = pendingTrades.filter(t => t.symbol === symbol);
            for (const trade of activeTrades) {
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
                }
            }

            // 2. ANALYZE CURRENT MARKET
            if (activeTrades.length === 0) {
                const analysis = analyzeCandle(closedCandles);
                
                const newRecord = {
                    symbol: symbol,
                    signal: analysis.signal,
                    probability: analysis.probability,
                    status: analysis.signal === 'NO TRADE' ? 'NO TRADE' : 'PENDING',
                    timestamp: Date.now(),
                    targetCandleTime: activelyFormingCandle.time,
                    entryPrice: activelyFormingCandle.open,
                    reason: analysis.reason
                };
                
                await signalsRef.add(newRecord);
                console.log(`🎯 Market Analyzed: ${analysis.signal}`);
            }
            
        } catch (e) {
            console.error(`⚠️ Error:`, e.message);
        }
    }
}

runBinaryBot();
