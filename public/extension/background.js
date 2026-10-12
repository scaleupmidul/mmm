// GEP-5 Background Worker
// Monitors EA signal stream and issues high-priority desktop notifications on confirmed BUY/SELL

const CHECK_INTERVAL_MINUTES = 1;
const DEPLOYED_DASHBOARD_URL = 'https://ais-dev-ypyaix5bdfvaptugued2lk-496547113348.asia-southeast1.run.app';
const ENDPOINTS = [
  `${DEPLOYED_DASHBOARD_URL}/api/connector/latest`,
  'http://localhost:3000/api/connector/latest',
  'http://127.0.0.1:8765/status'
];

let lastNotifiedBarTime = 0;

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('checkGep5Signal', { periodInMinutes: CHECK_INTERVAL_MINUTES });
  console.log('[GEP-5 Extension] Installed & Alarm scheduled.');
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'checkGep5Signal') {
    await checkSignalIntegrity();
  }
});

async function checkSignalIntegrity() {
  for (const url of ENDPOINTS) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2500);
      const resp = await fetch(url, { cache: 'no-store', signal: controller.signal });
      clearTimeout(timeoutId);

      if (!resp.ok) continue;
      const json = await resp.json();
      if ((json.status !== 'LIVE' && json.connected !== true) || !json.data) continue;

      const data = json.data;
      const strat = data.strategy;
      if (!strat || !strat.decision || (strat.decision !== 'BUY' && strat.decision !== 'SELL')) continue;

      // Fail-closed freshness check (age <= 20s)
      const nowSec = Math.floor(Date.now() / 1000);
      const barTime = strat.closed_bar_time || (data.tick ? data.tick.time : 0);
      if (data.tick && Math.abs(nowSec - data.tick.time) > 20) continue;

      // Fail-closed R:R invariant check (>= 1.99)
      const levels = strat.trade_levels;
      if (levels && levels.entry && levels.stop_loss && levels.take_profit) {
        const risk = Math.abs(levels.entry - levels.stop_loss);
        const reward = Math.abs(levels.take_profit - levels.entry);
        if (risk <= 0 || reward / risk < 1.99) continue;
      } else {
        continue;
      }

      if (barTime > lastNotifiedBarTime) {
        lastNotifiedBarTime = barTime;
        const title = `GEP-5 ${strat.decision} SIGNAL CONFIRMED`;
        const message = `Symbol: ${data.symbol || 'XAUUSDm'} @ $${levels.entry.toFixed(2)} | SL: $${levels.stop_loss.toFixed(2)} | TP: $${levels.take_profit.toFixed(2)} (R:R 1:2.0)`;

        chrome.notifications.create(`gep5-signal-${barTime}`, {
          type: 'basic',
          iconUrl: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23fbbf24"><path d="M12 2L2 22h20L12 2z"/></svg>',
          title,
          message,
          priority: 2,
        });
        return; // Successfully notified
      }
    } catch (e) {
      // Continue to next endpoint
    }
  }
}
