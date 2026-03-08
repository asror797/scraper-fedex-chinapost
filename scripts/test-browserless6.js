require('dotenv').config();
const axios = require('axios');

const BROWSERLESS_KEY = process.env.BROWSERLESS_API_KEY || '';
const trackNum = process.argv[2] || '399052979157';
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

      return { data: JSON.stringify({ error: 'timeout', text: text.substring(0, 200) }), type: 'application/json' };
    }
  `;
}

async function attempt(num, idx) {
  const start = Date.now();
  try {
    const res = await axios.post(
      `${BASE}/function?token=${BROWSERLESS_KEY}`,
      buildCode(num),
      {
        headers: { 'Content-Type': 'application/javascript' },
        timeout: 90000,
      }
    );

    const elapsed = Date.now() - start;
    const raw = typeof res.data?.data === 'string' ? res.data.data : JSON.stringify(res.data);
    const json = JSON.parse(raw);

    if (json.error) {
      return { idx, elapsed, success: false, error: json.error };
    }

    const pkg = json?.output?.packages?.[0];
    if (pkg) {
      return {
        idx, elapsed, success: true,
        status: pkg.keyStatus,
        events: pkg.scanEventList?.length || 0,
        from: pkg.shipperAddress,
        to: pkg.recipientAddress,
      };
    }

    return { idx, elapsed, success: false, error: 'no-package' };
  } catch (e) {
    return { idx, elapsed: Date.now() - start, success: false, error: e.message.substring(0, 100) };
  }
}

async function run() {
  console.log(`Browserless.io reliability test for: ${trackNum}`);
  console.log(`Running 3 attempts...\n`);

  for (let i = 1; i <= 3; i++) {
    process.stdout.write(`  Attempt ${i}: `);
    const r = await attempt(trackNum, i);
    if (r.success) {
      const from = r.from ? `${r.from.city}, ${r.from.countryCD}` : '—';
      const to = r.to ? `${r.to.city}, ${r.to.countryCD}` : '—';
      console.log(`${r.elapsed}ms | SUCCESS | ${r.status} | ${from} -> ${to} | ${r.events} events`);
    } else {
      console.log(`${r.elapsed}ms | FAILED (${r.error})`);
    }
  }
}

run().catch(e => console.log('ERR:', e.message));
