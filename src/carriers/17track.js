const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { createCache } = require('../utils/cache');
const { buildNotFoundResponse, formatDate } = require('../utils/response');

const BL_KEY = process.env.BROWSERLESS_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const BL_URL = `https://production-sfo.browserless.io/function?token=${BL_KEY}&stealth`;
const BROWSER_CODE = fs.readFileSync(path.join(__dirname, '17track-browser.js'), 'utf-8');

const cache = createCache();

function map17trackStatus(statusText) {
  if (!statusText) return 'notfound';
  const s = statusText.toLowerCase();
  if (s.includes('deliver')) return 'delivered';
  if (s.includes('transit') || s.includes('shipping') || s.includes('customs') || s.includes('dispatching')) return 'transit';
  if (s.includes('pickup') || s.includes('collected')) return 'pickup';
  if (s.includes('info received') || s.includes('label') || s.includes('created') || s.includes('pre-shipment')) return 'pretransit';
  if (s.includes('exception') || s.includes('failed') || s.includes('return')) return 'exception';
  if (s.includes('undelivered') || s.includes('hold') || s.includes('unsuccessful')) return 'undelivered';
  if (s.includes('expired')) return 'expired';
  return 'transit';
}

function convert17trackToClient(trackingNumber, shipment) {
  const status = shipment.latest_status?.status || '';
  const events = shipment.tracking?.providers?.[0]?.events || [];
  const shippingInfo = shipment.shipping_info || {};

  const dataStorage = events.map(e => ({
    date: formatDate(e.time_iso),
    information: e.description || '',
    actual_position_parcel: e.location || null,
  }));

  return {
    trackid: trackingNumber,
    status: map17trackStatus(status),
    original_country: shippingInfo.shipper_address?.country || null,
    original_city_state: shippingInfo.shipper_address?.city || null,
    destination_country: shippingInfo.recipient_address?.country || null,
    destination_city_state: shippingInfo.recipient_address?.city || null,
    _data_storage: dataStorage,
  };
}

async function fetchFrom17track(trackingNumbers) {
  if (!BL_KEY) throw new Error('BROWSERLESS_API_KEY not configured');
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY not configured');

  const numbers = Array.isArray(trackingNumbers) ? trackingNumbers : [trackingNumbers];

  const resp = await axios.post(BL_URL, {
    code: BROWSER_CODE,
    context: { numbers, geminiKey: GEMINI_KEY },
  }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 120000,
  });

  let d = resp.data;
  if (d.data) d = d.data;

  const output = {};
  for (const num of numbers) {
    const shipmentData = d.results?.[num];
    if (shipmentData?.shipment) {
      output[num] = convert17trackToClient(num, shipmentData.shipment);
    } else {
      output[num] = buildNotFoundResponse(num);
    }
  }

  return output;
}

async function track17track(trackingNumber) {
  const cached = cache.get(trackingNumber);
  if (cached) return cached;

  try {
    const results = await fetchFrom17track(trackingNumber);
    const result = results[trackingNumber];
    if (result && (result._data_storage.length > 0 || result.status !== 'notfound')) {
      cache.set(trackingNumber, result);
      return result;
    }
  } catch (e) {
    console.log(`[17track] Failed: ${e.message}`);
  }

  return buildNotFoundResponse(trackingNumber);
}

module.exports = { track17track, fetchFrom17track };
