const admin = require('firebase-admin');

// 1. Initialize Firebase Securely from GitHub Secrets
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// 2. Config & Indicators
const COINS = ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','AVAXUSDT','DOTUSDT','LINKUSDT'];
const MIN_STRENGTH = 60;
const TICK_SIZE = { 'BTCUSDT': 0.01, 'ETHUSDT': 0.01, 'SOLUSDT': 0.001, 'XRPUSDT': 0.0001, 'DOGEUSDT': 0.00001, 'ADAUSDT': 0.0001 };

function getTick(symbol) { return TICK_SIZE[symbol] || 0.01; }
function roundToTick(val, tick) { const f = 1/tick; return Math.round(val*f)/f; }

// --- Indicator Math Functions ---
function calcEMA(closes, period) {
    let ema = [], k = 2/(period+1), sum = 0;
    for (let i=0; i<closes.length; i++) {
        if(i < period-1) { sum += closes[i]; ema.push(null); }
        else if(i === period-1) { sum += closes[i]; ema.push(sum/period); }
        else ema.push(closes[i]*k + ema[i-1]*(1-k));
    }
    return ema;
}

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

function calcVWAP(highs, lows, closes, vols) {
    let vwap = [], cumPV = 0, cumVol = 0;
    for(let i=0; i<closes.length; i++) {
        cumPV += ((highs[i]+lows[i]+closes[i])/3)*vols[i]; cumVol += vols[i];
        vwap.push(cumVol===0?null:cumPV/cumVol);
    }
    return vwap;
}

// 3. Professional Signal Generation Logic (Balanced Mode)
function analyzeCoin(data, symbol) {
    const closes = data.map(d=>d.close), highs = data.map(d=>d.high), lows = data.map(d=>d.low), vols = data.map(d=>d.vol);
    const idx = closes.length - 1;
    const price = closes[idx];
    
    // Calculate full arrays to get current and previous values
    const ema5 = calcEMA(closes, 5);
    const ema20 = calcEMA(closes, 20);
    const vwap = calcVWAP(highs, lows, closes, vols);
    const rsi = calcRSI(closes, 14);

    const currE5 = ema5[idx], prevE5 = ema5[idx-1];
    const currE20 = ema20[idx], prevE20 = ema20[idx-1];
    const currVWAP = vwap[idx];
    const currRSI = rsi[idx-1]; // Use previous closed candle RSI to avoid repainting

    // 1. Detect Fresh Momentum Crosses
    const crossUp = prevE5 <= prevE20 && currE5 > currE20;
    const crossDown = prevE5 >= prevE20 && currE5 < currE20;

    // 2. Validate with VWAP and RSI
    if (crossUp && price > currVWAP && currRSI > 50 && currRSI < 75) {
        return { direction: 'LONG', strength: 85, price };
    }
    if (crossDown && price < currVWAP && currRSI < 50 && currRSI > 25) {
        return { direction: 'SHORT', strength: 85, price };
    }
    
    return null; // No perfect setup found, wait for the next cycle
}

// 4. MAIN CLOUD ENGINE LOOP
async function runBot() {
    console.log("🚀 Waking up GitHub Action Engine...");
    const now = Date.now();
    const signalsRef = db.collection('signals');
    
    // A. Read existing OPEN trades from database
    const openTradesSnap = await signalsRef.where('status', '==', 'OPEN').get();
    const openTrades = [];
    openTradesSnap.forEach(doc => openTrades.push({ id: doc.id, ...doc.data() }));
    console.log(`Tracking ${openTrades.length} open trades.`);

    // B. Fetch 120 candles (10 hours) for all coins to check targets AND find new setups
    for (const symbol of COINS) {
        try {
            // Fetch Binance Data using their public data-api to bypass US IP blocks
            const res = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=5m&limit=120`);
            
            if (!res.ok) throw new Error(`API HTTP Error: ${res.status}`);
            
            const raw = await res.json();
            
            // Safeguard to ensure Binance actually returned an array of data
            if (!Array.isArray(raw)) throw new Error(`API Blocked/Invalid: ${JSON.stringify(raw)}`);

            const data = raw.map(c => ({ 
                time: c[0], open: parseFloat(c[1]), high: parseFloat(c[2]), low: parseFloat(c[3]), close: parseFloat(c[4]), vol: parseFloat(c[5]) 
            }));
            const currentPrice = data[data.length-1].close;

            // --- RECONCILIATION LOOP: Check if open trades hit TP/SL while we were asleep ---
            const activeCoinTrades = openTrades.filter(t => t.symbol === symbol);
            for (const trade of activeCoinTrades) {
                // Filter candles that occurred AFTER the trade was opened
                const recentCandles = data.filter(c => c.time >= trade.openTime);
                let resolved = false;

                for (const candle of recentCandles) {
                    if (trade.direction === 'LONG') {
                        if (candle.high >= trade.tp) { await signalsRef.doc(trade.id).update({ status: 'PROFIT', closedPrice: trade.tp, closeTime: candle.time }); resolved = true; break; }
                        if (candle.low <= trade.sl) { await signalsRef.doc(trade.id).update({ status: 'LOSS', closedPrice: trade.sl, closeTime: candle.time }); resolved = true; break; }
                    } else {
                        if (candle.low <= trade.tp) { await signalsRef.doc(trade.id).update({ status: 'PROFIT', closedPrice: trade.tp, closeTime: candle.time }); resolved = true; break; }
                        if (candle.high >= trade.sl) { await signalsRef.doc(trade.id).update({ status: 'LOSS', closedPrice: trade.sl, closeTime: candle.time }); resolved = true; break; }
                    }
                }
                
                // Expiry Check (30 mins)
                if (!resolved && (now - trade.openTime) > (30 * 60 * 1000)) {
                    await signalsRef.doc(trade.id).update({ status: 'EXPIRED', closedPrice: currentPrice, closeTime: now });
                }
            }

            // --- SCAN FOR NEW SIGNALS ---
            // Only search if there isn't already an active trade for this coin
            if (activeCoinTrades.length === 0) {
                const analysis = analyzeCoin(data, symbol);
                if (analysis && analysis.strength >= MIN_STRENGTH) {
                    const tick = getTick(symbol);
                    const spread = roundToTick(currentPrice * 0.001, tick);
                    const tpMove = roundToTick(currentPrice * 0.006, tick);
                    const slMove = roundToTick(currentPrice * 0.005, tick);
                    
                    const newTrade = {
                        symbol: symbol, direction: analysis.direction, strength: analysis.strength,
                        entryMin: roundToTick(currentPrice - spread/2, tick),
                        entryMax: roundToTick(currentPrice + spread/2, tick),
                        tp: roundToTick(analysis.direction === 'LONG' ? currentPrice + tpMove : currentPrice - tpMove, tick),
                        sl: roundToTick(analysis.direction === 'LONG' ? currentPrice - slMove : currentPrice + slMove, tick),
                        status: 'OPEN', timestamp: new Date().toISOString(), openTime: now
                    };
                    await signalsRef.add(newTrade);
                    console.log(`✅ Opened NEW signal for ${symbol}`);
                }
            }
            
            // Respect API limits
            await new Promise(r => setTimeout(r, 200)); 
            
        } catch (e) {
            console.error(`Error processing ${symbol}:`, e.message);
        }
    }
    
    console.log("💤 Engine finished cycle. Going back to sleep.");
}

runBot();
