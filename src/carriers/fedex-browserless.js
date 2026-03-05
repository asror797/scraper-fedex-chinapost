const axios = require('axios');

const BROWSERLESS_KEY = process.env.BROWSERLESS_API_KEY || '';
const BASE = 'https://production-sfo.browserless.io';

function buildCode(num) {
  return `
    export default async function ({ page }) {
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(param) {
          if (param === 37445) return 'Intel Inc.';
          if (param === 37446) return 'Intel Iris OpenGL Engine';
          return getParameter.call(this, param);
        };
      });

      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
      });

      await page.evaluateOnNewDocument(() => {
        window.__fedexData = [];
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, url) {
          this._url = url;
          return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function() {
          const self = this;
          this.addEventListener('load', function() {
            if (self._url && self._url.indexOf('shipments') !== -1) {
              window.__fedexData.push(self.responseText);
            }
          });
          return origSend.apply(this, arguments);
        };
      });

      try {
        await page.goto('https://www.fedex.com/fedextrack/?trknbr=${num}', {
          waitUntil: 'networkidle2',
          timeout: 30000,
        });
      } catch (e) {}

      const url = page.url();
      if (url.includes('system-error')) {
        return { data: JSON.stringify({ error: 'system-error' }), type: 'application/json' };
      }

      const text = await page.evaluate(() => document.body?.innerText?.substring(0, 300) || '');
      if (text.includes('permission') || text.includes("can't process")) {
        return { data: JSON.stringify({ error: 'akamai-block' }), type: 'application/json' };
      }

      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const captured = await page.evaluate(() => window.__fedexData);
        if (captured && captured.length > 0) {
          return { data: captured[0], type: 'application/json' };
        }
      }

      return { data: JSON.stringify({ error: 'timeout' }), type: 'application/json' };
    }
  `;
}

function mapStatus(keyStatus) {
  if (!keyStatus) return 'notfound';
  const s = keyStatus.toLowerCase();
  if (s.includes('delivered')) return 'delivered';
  if (s.includes('transit') || s.includes('on its way') || s.includes('in transit')) return 'transit';
  if (s.includes('label') || s.includes('created') || s.includes('shipment information sent')) return 'pretransit';
  if (s.includes('exception') || s.includes('delay') || s.includes('clearance')) return 'exception';
  if (s.includes('pickup') || s.includes('picked up')) return 'pickup';
  if (s.includes('hold') || s.includes('undelivered')) return 'undelivered';
  if (s.includes('updated')) return 'transit';
  return 'transit';
}

function buildNotFoundResponse(trackingNumber) {
  return {
    trackid: trackingNumber,
    status: 'notfound',
    original_country: null,
    original_city_state: null,
    destination_country: null,
    destination_city_state: null,
    _data_storage: [],
  };
}

async function trackFedExBrowserless(trackingNumber) {
  if (!BROWSERLESS_KEY) throw new Error('BROWSERLESS_API_KEY is required');

  const res = await axios.post(
    `${BASE}/function?token=${BROWSERLESS_KEY}`,
    buildCode(trackingNumber),
    {
      headers: { 'Content-Type': 'application/javascript' },
      timeout: 90000,
    }
  );

  const raw = typeof res.data?.data === 'string' ? res.data.data : JSON.stringify(res.data);
  const json = JSON.parse(raw);

  if (json.error) return buildNotFoundResponse(trackingNumber);

  const pkg = json?.output?.packages?.[0];
  if (!pkg) return buildNotFoundResponse(trackingNumber);

  if (pkg.errorList && pkg.errorList.length > 0) return buildNotFoundResponse(trackingNumber);

  const shipper = pkg.shipperAddress || {};
  const recipient = pkg.recipientAddress || {};

  return {
    trackid: trackingNumber,
    status: mapStatus(pkg.keyStatus),
    original_country: shipper.countryCD || shipper.countryName || null,
    original_city_state: [shipper.city, shipper.stateCD].filter(Boolean).join(', ') || null,
    destination_country: recipient.countryCD || recipient.countryName || null,
    destination_city_state: [recipient.city, recipient.stateCD].filter(Boolean).join(', ') || null,
    _data_storage: (pkg.scanEventList || []).map(e => ({
      date: e.date || null,
      information: e.description || e.eventDescription || e.scanType || '',
      actual_position_parcel: e.scanLocation || null,
    })),
  };
}

module.exports = { trackFedExBrowserless };
