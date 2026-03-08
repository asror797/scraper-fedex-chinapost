require('dotenv').config();

const express = require('express');
const { trackFedEx } = require('./carriers/fedex');
const { trackFedExBrowserless } = require('./carriers/fedex-browserless');
const { trackChinaPost } = require('./carriers/chinapost');
const { track17track } = require('./carriers/17track');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const SUPPORTED_CARRIERS = {
  fedex: trackFedEx,
  chinapost: trackChinaPost,
  '17track': track17track,
};

app.get('/track', async (req, res) => {
  const { number, carrier } = req.query;

  if (!number) {
    return res.status(400).json({ error: 'Missing required parameter: number' });
  }

  const carrierName = (carrier || 'fedex').toLowerCase();
  const method = (req.query.method || '').toLowerCase();

  let trackFn;
  if (carrierName === 'fedex' && method === 'browserless') {
    trackFn = trackFedExBrowserless;
  } else {
    trackFn = SUPPORTED_CARRIERS[carrierName];
  }

  if (!trackFn) {
    return res.status(400).json({
      error: `Unsupported carrier: ${carrierName}. Supported: ${Object.keys(SUPPORTED_CARRIERS).join(', ')}`,
    });
  }

  const start = Date.now();

  try {
    const result = await trackFn(number);
    const elapsed = Date.now() - start;

    console.log(`[${carrierName}] ${number} → ${result.status} (${elapsed}ms)`);

    return res.json(result);
  } catch (err) {
    const elapsed = Date.now() - start;
    console.error(`[${carrierName}] ${number} → ERROR (${elapsed}ms):`, err.message);

    return res.status(500).json({
      trackid: number,
      status: 'notfound',
      original_country: null,
      original_city_state: null,
      destination_country: null,
      destination_city_state: null,
      _data_storage: [],
      error: err.message,
    });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.listen(PORT, () => {
  console.log(`Tracking service running on http://localhost:${PORT}`);
  console.log(`Example: http://localhost:${PORT}/track?number=399052979157&carrier=fedex`);
});
