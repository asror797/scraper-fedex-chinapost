const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { buildNotFoundResponse } = require('../utils/response');
const { convertFedexPackage } = require('../utils/fedex');

const BROWSERLESS_KEY = process.env.BROWSERLESS_API_KEY || '';
const BASE = 'https://production-sfo.browserless.io';
const BROWSER_CODE = fs.readFileSync(path.join(__dirname, 'fedex-browserless-browser.js'), 'utf-8');

async function trackFedExBrowserless(trackingNumber) {
  if (!BROWSERLESS_KEY) throw new Error('BROWSERLESS_API_KEY is required');

  const start = Date.now();

  try {
    const res = await axios.post(
      `${BASE}/function?token=${BROWSERLESS_KEY}`,
      {
        code: BROWSER_CODE,
        context: { trackingUrl: `https://www.fedex.com/fedextrack/?trknbr=${trackingNumber}` },
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 90000,
      }
    );

    const raw = typeof res.data?.data === 'string' ? res.data.data : JSON.stringify(res.data);
    const json = JSON.parse(raw);
    const elapsed = Date.now() - start;

    if (json.error) {
      console.log(`[FedEx/Browserless] ${trackingNumber} → ${json.error} (${elapsed}ms)`);
      return buildNotFoundResponse(trackingNumber);
    }

    const pkg = json?.output?.packages?.[0];
    if (!pkg) {
      console.log(`[FedEx/Browserless] ${trackingNumber} → no package data (${elapsed}ms)`);
      return buildNotFoundResponse(trackingNumber);
    }

    if (pkg.errorList && pkg.errorList.length > 0) {
      console.log(`[FedEx/Browserless] ${trackingNumber} → ${pkg.errorList[0]?.message || 'error'} (${elapsed}ms)`);
      return buildNotFoundResponse(trackingNumber);
    }

    console.log(`[FedEx/Browserless] ${trackingNumber} → ${pkg.keyStatus} (${elapsed}ms, ${(pkg.scanEventList || []).length} events)`);

    return convertFedexPackage(trackingNumber, pkg);
  } catch (err) {
    const elapsed = Date.now() - start;
    console.log(`[FedEx/Browserless] ${trackingNumber} → FAILED: ${err.message} (${elapsed}ms)`);
    return buildNotFoundResponse(trackingNumber);
  }
}

module.exports = { trackFedExBrowserless };
