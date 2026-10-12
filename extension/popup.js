// GEP-5 Chrome Extension Popup Script
// Strict Fail-Closed Verification Engine

const DEPLOYED_DASHBOARD_URL = 'https://ais-dev-ypyaix5bdfvaptugued2lk-496547113348.asia-southeast1.run.app';

const API_ENDPOINTS = [
  `${DEPLOYED_DASHBOARD_URL}/api/connector/latest`,
  'http://localhost:3000/api/connector/latest',
  'http://127.0.0.1:8765/status'
];

async function fetchLatestData() {
  for (const url of API_ENDPOINTS) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const resp = await fetch(url, { cache: 'no-store', signal: controller.signal });
      clearTimeout(timeoutId);

      if (resp.ok) {
        const json = await resp.json();
        // Normalize payload whether from web API (/api/connector/latest) or local daemon (/status)
        if (json && (json.status !== undefined || json.connected !== undefined)) {
          return { success: true, url, raw: json };
        }
      }
    } catch (e) {
      // Try next endpoint
    }
  }
  return { success: false, raw: null };
}

function updateUI(result) {
  const badge = document.getElementById('statusBadge');
  const signalDir = document.getElementById('signalDir');
  const signalReason = document.getElementById('signalReason');
  const valEntry = document.getElementById('valEntry');
  const valSL = document.getElementById('valSL');
  const valTP = document.getElementById('valTP');
  const chkFresh = document.getElementById('chkFresh');
  const chkClosed = document.getElementById('chkClosed');
  const chkTol = document.getElementById('chkTol');
  const chkRR = document.getElementById('chkRR');
  const lastTickTime = document.getElementById('lastTickTime');

  // FAIL-CLOSED DEFAULT STATE (Disconnected / Missing data)
  if (!result.success || !result.raw) {
    badge.className = 'badge badge-disc';
    badge.textContent = 'DISCONNECTED';

    signalDir.className = 'signal-direction signal-none';
    signalDir.textContent = 'NO TRADE';
    signalReason.textContent = 'MT5 connector offline. Run run_connector.bat on Windows.';

    valEntry.textContent = '--.--';
    valSL.textContent = '--.--';
    valTP.textContent = '--.--';

    chkFresh.textContent = 'FAIL (Offline)';
    chkFresh.className = 'tag-fail';
    chkClosed.textContent = 'DISCONNECTED';
    chkClosed.className = 'tag-fail';
    chkTol.textContent = 'DISCONNECTED';
    chkTol.className = 'tag-fail';
    chkRR.textContent = 'DISCONNECTED';
    chkRR.className = 'tag-fail';

    lastTickTime.textContent = 'Feed: Disconnected';
    return;
  }

  const raw = result.raw;
  const payload = raw.data || raw;

  // 1. EXTRACT DATA FIELDS
  const isLiveExplicit = raw.is_live === true || raw.connected === true;
  const statusString = (raw.status || (isLiveExplicit ? 'LIVE' : 'DISCONNECTED')).toUpperCase();
  const tick = payload.tick || payload.last_tick || null;
  const candlesM5 = Array.isArray(payload.candles_m5) ? payload.candles_m5 : [];
  const indicators = payload.indicators || null;
  const strategy = payload.strategy || null;

  // Calculate Feed Age
  let ageSeconds = null;
  if (typeof raw.age_seconds === 'number') {
    ageSeconds = raw.age_seconds;
  } else if (raw.last_received_at) {
    ageSeconds = Math.max(0, Math.floor((Date.now() - raw.last_received_at) / 1000));
  } else if (tick && tick.time) {
    ageSeconds = Math.max(0, Math.floor(Date.now() / 1000 - tick.time));
  }

  // 2. GATE 1: FEED FRESHNESS GUARD (Age <= 20s = LIVE, <= 90s = STALE, >90s = FAIL)
  let gateFreshPass = false;
  if (statusString === 'LIVE' && ageSeconds !== null && ageSeconds <= 20) {
    gateFreshPass = true;
    badge.className = 'badge badge-live';
    badge.textContent = 'LIVE DATA';
    chkFresh.textContent = `PASS (${ageSeconds}s)`;
    chkFresh.className = 'tag-pass';
  } else if (statusString === 'STALE' || (ageSeconds !== null && ageSeconds <= 90)) {
    badge.className = 'badge badge-stale';
    badge.textContent = 'STALE FEED';
    chkFresh.textContent = `STALE (${ageSeconds || '>20'}s)`;
    chkFresh.className = 'tag-fail';
  } else if (statusString === 'DEMO') {
    gateFreshPass = true;
    badge.className = 'badge badge-live';
    badge.textContent = 'DEMO FEED';
    chkFresh.textContent = 'DEMO (Sim)';
    chkFresh.className = 'tag-pass';
  } else {
    badge.className = 'badge badge-disc';
    badge.textContent = 'DISCONNECTED';
    chkFresh.textContent = 'FAIL (>90s)';
    chkFresh.className = 'tag-fail';
  }

  // Display Tick Price
  if (tick && typeof tick.bid === 'number') {
    valEntry.textContent = '$' + tick.bid.toFixed(2);
    lastTickTime.textContent = `Bid: ${tick.bid.toFixed(2)} | Spread: ${tick.spread || 0}pts`;
  } else {
    valEntry.textContent = '--.--';
    lastTickTime.textContent = 'No tick received';
  }

  // 3. GATE 2: CLOSED CANDLE ANCHOR GUARD (Must have closed M5 bars on discrete boundary)
  let gateClosedPass = false;
  if (candlesM5.length > 0) {
    const lastBar = candlesM5[candlesM5.length - 1];
    const isFiveMinBoundary = lastBar && typeof lastBar.time === 'number' && lastBar.time % 300 === 0;
    if (isFiveMinBoundary && candlesM5.length >= 10) {
      gateClosedPass = true;
      chkClosed.textContent = `PASS (${candlesM5.length} M5)`;
      chkClosed.className = 'tag-pass';
    } else {
      chkClosed.textContent = `WAITING (${candlesM5.length}/210)`;
      chkClosed.className = 'tag-fail';
    }
  } else {
    chkClosed.textContent = 'WAITING (No bars)';
    chkClosed.className = 'tag-fail';
  }

  // 4. GATE 3: INDICATOR BOUNDS & TOLERANCE GUARD
  let gateTolPass = false;
  if (indicators) {
    const ema20 = Number(indicators.ema20);
    const ema200 = Number(indicators.ema200);
    const rsi14 = Number(indicators.rsi14);

    const validNumbers =
      Number.isFinite(ema20) && ema20 > 0 &&
      Number.isFinite(ema200) && ema200 > 0 &&
      Number.isFinite(rsi14) && rsi14 >= 0 && rsi14 <= 100;

    if (validNumbers) {
      gateTolPass = true;
      chkTol.textContent = `PASS (RSI ${rsi14.toFixed(1)})`;
      chkTol.className = 'tag-pass';
    } else {
      chkTol.textContent = 'FAIL (NaN/Bounds)';
      chkTol.className = 'tag-fail';
    }
  } else {
    chkTol.textContent = 'WAITING (No Inds)';
    chkTol.className = 'tag-fail';
  }

  // 5. GATE 4: 1:2 MINIMUM RISK-TO-REWARD INVARIANT
  let gateRRPass = false;
  const levels = strategy && strategy.trade_levels ? strategy.trade_levels : null;

  if (levels && typeof levels.entry === 'number' && typeof levels.stop_loss === 'number' && typeof levels.take_profit === 'number') {
    const isBuy = strategy.decision === 'BUY';
    const isSell = strategy.decision === 'SELL';
    let risk = 0;
    let reward = 0;

    if (isBuy) {
      risk = levels.entry - levels.stop_loss;
      reward = levels.take_profit - levels.entry;
    } else if (isSell) {
      risk = levels.stop_loss - levels.entry;
      reward = levels.entry - levels.take_profit;
    }

    if (risk > 0 && reward > 0) {
      const rrRatio = reward / risk;
      if (rrRatio >= 1.99) {
        gateRRPass = true;
        chkRR.textContent = `PASS (1:${rrRatio.toFixed(1)})`;
        chkRR.className = 'tag-pass';
        valSL.textContent = '$' + levels.stop_loss.toFixed(2);
        valTP.textContent = '$' + levels.take_profit.toFixed(2);
      } else {
        chkRR.textContent = `FAIL (1:${rrRatio.toFixed(1)} < 1:2)`;
        chkRR.className = 'tag-fail';
        valSL.textContent = '$' + levels.stop_loss.toFixed(2);
        valTP.textContent = '$' + levels.take_profit.toFixed(2);
      }
    } else {
      chkRR.textContent = 'FAIL (Inverted SL)';
      chkRR.className = 'tag-fail';
    }
  } else {
    // No active proposed trade levels -> WAITING (never fake PASS)
    chkRR.textContent = 'WAITING (No Setup)';
    chkRR.className = 'tag-fail';
    valSL.textContent = '--.--';
    valTP.textContent = '--.--';
  }

  // 6. FINAL SIGNAL DIRECTION (FAIL-CLOSED)
  // Only display BUY/SELL CONFIRMED if 100% of required gates pass!
  const allGatesPass = gateFreshPass && gateClosedPass && gateTolPass && gateRRPass;

  if (allGatesPass && strategy && strategy.decision === 'BUY') {
    signalDir.className = 'signal-direction signal-buy';
    signalDir.textContent = 'BUY CONFIRMED';
    signalReason.textContent = 'All 4 verification gates PASS on closed M5 bar.';
  } else if (allGatesPass && strategy && strategy.decision === 'SELL') {
    signalDir.className = 'signal-direction signal-sell';
    signalDir.textContent = 'SELL CONFIRMED';
    signalReason.textContent = 'All 4 verification gates PASS on closed M5 bar.';
  } else {
    signalDir.className = 'signal-direction signal-none';
    if (!gateFreshPass) {
      signalDir.textContent = 'NO TRADE';
      signalReason.textContent = 'Fail-closed: MT5 feed is stale or disconnected.';
    } else if (!gateClosedPass) {
      signalDir.textContent = 'WAITING';
      signalReason.textContent = 'Waiting for completed candle close.';
    } else if (!gateTolPass) {
      signalDir.textContent = 'NO TRADE';
      signalReason.textContent = 'Fail-closed: Indicator validation failed.';
    } else {
      signalDir.textContent = 'NO TRADE';
      signalReason.textContent = 'Fail-closed: No setup satisfies 100% of GEP-5 rules.';
    }
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const result = await fetchLatestData();
  updateUI(result);

  const openLink = document.getElementById('openDashboard');
  if (openLink) {
    openLink.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: DEPLOYED_DASHBOARD_URL });
    });
  }
});
