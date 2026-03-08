require('dotenv').config();

const express = require('express');
const { trackFedEx } = require('./carriers/fedex');
const { trackFedExBrowserless } = require('./carriers/fedex-browserless');
const { trackChinaPost } = require('./carriers/chinapost');
const { track17track } = require('./carriers/17track');
const { buildNotFoundResponse } = require('./utils/response');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const CARRIER_CHAINS = {
  fedex: [trackFedEx, trackChinaPost, track17track],
  chinapost: [trackChinaPost, track17track],
  default: [trackChinaPost, track17track],
};

async function trackWithFallback(trackingNumber, chain) {
  for (const trackFn of chain) {
    try {
      const result = await trackFn(trackingNumber);
      if (result && result.status !== 'notfound') return result;
    } catch (err) {
      console.log(`[Fallback] ${trackFn.name} failed: ${err.message}`);
    }
  }
  return buildNotFoundResponse(trackingNumber);
}

app.get('/track', async (req, res) => {
  const { number, carrier } = req.query;

  if (!number) {
    return res.status(400).json({ error: 'Missing required parameter: number' });
  }

  const carrierName = (carrier || 'fedex').toLowerCase();
  const method = (req.query.method || '').toLowerCase();

  let chain;
  if (carrierName === 'fedex' && method === 'browserless') {
    chain = [trackFedExBrowserless, trackChinaPost, track17track];
  } else {
    chain = CARRIER_CHAINS[carrierName] || CARRIER_CHAINS.default;
  }

  const start = Date.now();

  try {
    const result = await trackWithFallback(number, chain);
    const elapsed = Date.now() - start;
    console.log(`[${carrierName}] ${number} → ${result.status} (${elapsed}ms)`);
    return res.json(result);
  } catch (err) {
    const elapsed = Date.now() - start;
    console.error(`[${carrierName}] ${number} → ERROR (${elapsed}ms):`, err.message);
    return res.status(500).json({
      ...buildNotFoundResponse(number),
      error: err.message,
    });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.listen(PORT, () => {
  console.log(`Tracking service running on http://localhost:${PORT}`);
});
