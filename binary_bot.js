const admin = require('firebase-admin');

// Initialize Firebase Securely from GitHub Secrets
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// Target high-liquidity assets for binary predictability
const COINS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','AVAXUSDT'];

// Probability Threshold: Only fire if we have >= 80% confluence
const MIN_PROBABILITY = 80;

// --- INDICATOR MATH FUNCTIONS ---

function calcRSI(closes, period=14) {
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

function calcBollingerBands(closes, period=20, multiplier=2) {
    let upper = [], lower = [], sma = [];
    for(let i=0; i<closes.length; i++) {
        if (i < period - 1) {
            upper.push(null); lower.push(null); sma.push(null);
            continue;
        }
        let slice = closes.slice(i - period + 1, i + 1);
        let mean = slice.reduce((a, b) => a + b, 0) / period;
        let variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
        let stdDev = Math.sqrt(variance);
        
        sma.push(mean);
        upper.push(mean + (multiplier * stdDev));
        lower.push(mean - (multiplier * stdDev));
    }
    return { upper, lower, sma };
}

// --- BINARY OPTIONS SCORING ALGORITHM ---

function analyzeNextCandle(data) {
    // We analyze the last completely closed candle
    // (If the bot runs at 12:05:15, data[data.length-2] is the 12:00 candle that just closed)
    const closedIdx = data.length - 2; 
    const prevIdx = closedIdx - 1;

    const curr = data[closedIdx];
    const prev = data[prevIdx];
    
    // Arrays for indicator math up to the closed candle
    const closes = data.slice(0, closedIdx + 1).map(d => d.close);
    
    const rsiArr = calcRSI(closes, 14);
    const bb = calcBollingerBands(closes, 20, 2);
    
    const rsi = rsiArr[rsiArr.length - 1];
    const upperBB = bb.upper[bb.upper.length - 1];
    const lowerBB = bb.lower[bb.lower.length - 1];

    // Candlestick Anatomy
    const body = Math.abs(curr.close - curr.open);
    const isGreen = curr.close > curr.open;
    const isRed = curr.close < curr.open;
    const upperWick = curr.high - Math.max(curr.open, curr.close);
    const lowerWick = Math.min(curr.open, curr.close) - curr.low;

    // Confluence Scoring
    let callScore = 50;
    let putScore = 50;

    // 1. Engulfing Patterns (+20 points)
    const prevBody = Math.abs(prev.close - prev.open);
    const isBullishEngulfing = prev.close < prev.open && curr.close > curr.open && curr.close > prev.open && curr.open < prev.close;
    const isBearishEngulfing = prev.close > prev.open && curr.close < curr.open && curr.close < prev.open && curr.open > prev.close;
    
    if (isBullishEngulfing && body > prevBody) callScore += 20;
    if (isBearishEngulfing && body > prevBody) putScore += 20;

    // 2. Rejection Wicks / Pin Bars (+15 points)
    // Hammer: Long lower wick, small body
    if (lowerWick > body * 2 && upperWick < body) callScore += 15;
    // Shooting Star: Long upper wick, small body
    if (upperWick > body * 2 && lowerWick < body) putScore += 15;

    // 3. Bollinger Band Extremes (+15 points)
    // Price pushed outside lower band, likely to snap back up
    if (curr.low < lowerBB) callScore += 15;
    // Price pushed outside upper band, likely to snap back down
    if (curr.high > upperBB) putScore += 15;

    // 4. RSI Momentum (+10 points)
    if (rsi < 40) callScore += 10;
    if (rsi > 60) putScore += 10;

    // Evaluation
    if (callScore >= MIN_PROBABILITY) return { signal: 'CALL', probability: callScore };
    if (putScore >= MIN_PROBABILITY) return { signal: 'PUT', probability: putScore };
    
    // TEMPORARY TEST OVERRIDE: Uncomment the next line to force a random signal for testing
    // return { signal: Math.random() > 0.5 ? 'CALL' : 'PUT', probability: Math.floor(Math.random() * (99 - 80 + 1) + 80) };

    return null;
}

// --- MAIN CLOUD ENGINE LOOP ---

async function runBinaryBot() {
    console.log("⚡ Waking up Binary Options Engine...");
    const now = Date.now();
    const signalsRef = db.collection('binary_signals');
    
    // A. Read existing PENDING binary trades from database
    const pendingSnap = await signalsRef.where('status', '==', 'PENDING').get();
    const pendingTrades = [];
    pendingSnap.forEach(doc => pendingTrades.push({ id: doc.id, ...doc.data() }));
    console.log(`Tracking ${pendingTrades.length} unresolved predictions.`);

    for (const symbol of COINS) {
        try {
            // Fetch live data from Binance Public API
            const res = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=5m&limit=50`);
            if (!res.ok) throw new Error(`API HTTP Error: ${res.status}`);
            
            const raw = await res.json();
            if (!Array.isArray(raw)) throw new Error(`API Blocked/Invalid: ${JSON.stringify(raw)}`);

            const data = raw.map(c => ({ 
                time: c[0], open: parseFloat(c[1]), high: parseFloat(c[2]), low: parseFloat(c[3]), close: parseFloat(c[4]), vol: parseFloat(c[5]) 
            }));

            // --- RECONCILIATION LOOP: Determine Win/Loss for previous predictions ---
            const symbolPending = pendingTrades.filter(t => t.symbol === symbol);
            
            for (const trade of symbolPending) {
                // Find the specific candle the bot predicted
                // The target candle is the one that started at trade.targetCandleTime
                const resolutionCandle = data.find(c => c.time === trade.targetCandleTime);
                
                if (resolutionCandle) {
                    // Make sure this candle is completely closed
                    // If the next candle exists in the array, the resolution candle is safely closed
                    const isClosed = data[data.length - 1].time > resolutionCandle.time;
                    
                    if (isClosed) {
                        const isGreen = resolutionCandle.close > resolutionCandle.open;
                        const isRed = resolutionCandle.close < resolutionCandle.open;
                        
                        let result = 'DRAW';
                        if (trade.signal === 'CALL' && isGreen) result = 'WIN';
                        if (trade.signal === 'CALL' && isRed) result = 'LOSS';
                        if (trade.signal === 'PUT' && isRed) result = 'WIN';
                        if (trade.signal === 'PUT' && isGreen) result = 'LOSS';

                        await signalsRef.doc(trade.id).update({ 
                            status: result, 
                            closePrice: resolutionCandle.close,
                            closeTime: now // Timestamp of resolution
                        });
                        console.log(`✅ Resolved ${symbol} ${trade.signal} as ${result}`);
                    }
                } else if (now - trade.openTime > 15 * 60 * 1000) {
                    // Fallback: If 15 mins passed and we can't find it, mark expired
                    await signalsRef.doc(trade.id).update({ status: 'DRAW', closeTime: now });
                }
            }

            // --- SCAN FOR NEW NEXT-CANDLE SIGNALS ---
            // Only search if there isn't already a pending prediction for this exact candle
            const currentFormingCandleTime = data[data.length - 1].time;
            const hasPendingForThisCandle = symbolPending.some(t => t.targetCandleTime === currentFormingCandleTime);

            if (!hasPendingForThisCandle) {
                const analysis = analyzeNextCandle(data);
                
                if (analysis) {
                    const newPrediction = {
                        symbol: symbol,
                        signal: analysis.signal,
                        probability: analysis.probability,
                        status: 'PENDING',
                        entryPrice: data[data.length - 1].open, // The price the predicted candle opened at
                        targetCandleTime: currentFormingCandleTime, // The exact timestamp of the candle being predicted
                        timestamp: new Date().toISOString(),
                        openTime: now
                    };
                    await signalsRef.add(newPrediction);
                    console.log(`🎯 New Binary Signal: ${symbol} ${analysis.signal} (${analysis.probability}%)`);
                }
            }
            
            // Respect API limits
            await new Promise(r => setTimeout(r, 200)); 
            
        } catch (e) {
            console.error(`Error processing ${symbol}:`, e.message);
        }
    }
    
    console.log("💤 Binary Engine finished cycle.");
}

runBot();
