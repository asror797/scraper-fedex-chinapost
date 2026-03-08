/**
 * 17track.net carrier module
 *
 * How it works:
 * 1. Open Browserless session, load 17track page
 * 2. WASM generates browser fingerprint → `sign` field
 * 3. Server returns code:-14 → CAPTCHA required
 * 4. Solve CAPTCHA with Gemini vision (image grid: "find its kind")
 * 5. After CAPTCHA solved, session is "unlocked"
 * 6. Use WASM get_fingerprint() directly + captured Last-Event-Id
 *    to query any tracking number via direct API call (~0.5s each)
 *
 * Session pooling: one Browserless session can serve many requests
 * after CAPTCHA is solved once.
 */
const axios = require('axios');

const BL_KEY = process.env.BROWSERLESS_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const BL_URL = `https://production-sfo.browserless.io/function?token=${BL_KEY}&stealth`;

const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.ts >= CACHE_TTL) cache.delete(key);
  }
}, 10 * 60 * 1000);

function getCached(trackingNumber) {
  const entry = cache.get(trackingNumber);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  cache.delete(trackingNumber);
  return null;
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

function formatDate(isoStr) {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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

// Browserless function code — runs inside the browser
function buildBrowserCode() {
  return `
export default async ({ page, context }) => {
  const results = {};

  // Hook WASM to capture get_fingerprint + Last-Event-Id
  await page.evaluateOnNewDocument(() => {
    window.__wasmExports = null;
    window.__lastEventId = null;

    const origInstantiate = WebAssembly.instantiate;
    WebAssembly.instantiate = async function(source, imports) {
      const result = await origInstantiate.apply(this, arguments);
      const instance = result.instance || result;
      if (instance.exports?.get_fingerprint) {
        window.__wasmExports = instance.exports;
      }
      return result;
    };

    const origFetch = window.fetch;
    window.fetch = async function(url, opts) {
      if (typeof url === 'string' && url.includes('/track/restapi')) {
        try {
          const headers = opts?.headers || {};
          if (headers['Last-Event-Id']) {
            window.__lastEventId = headers['Last-Event-Id'];
          }
        } catch(e) {}
      }
      return origFetch.apply(this, arguments);
    };
  });

  let trackData = null;
  let apiCode = null;

  page.on('response', async resp => {
    if (resp.url().includes('/track/restapi')) {
      try {
        const json = await resp.json();
        apiCode = json.meta?.code;
        if (json.shipments?.length > 0 && json.shipments[0].shipment) trackData = json;
      } catch(e) {}
    }
  });

  // Load first number to trigger session + CAPTCHA
  await page.goto('https://t.17track.net/en#nums=' + context.numbers[0], {
    waitUntil: 'networkidle2',
    timeout: 45000,
  });

  for (let i = 0; i < 6; i++) { if (apiCode) break; await new Promise(r => setTimeout(r, 1000)); }

  // Solve CAPTCHA if needed
  if (!trackData && apiCode === -14) {
    await new Promise(r => setTimeout(r, 2500));

    const ci = await page.evaluate(() => {
      const modal = document.querySelector('.yq-captcha-modal-wrap');
      if (!modal) return null;
      const gridItems = [...modal.querySelectorAll('.yq-captcha-image-item')];
      const gridImgs = gridItems.map(item => item.querySelector('img')).filter(Boolean);
      const gridImgSet = new Set(gridImgs);
      const allImgs = [...modal.querySelectorAll('img')];
      const qImg = allImgs.find(img => !gridImgSet.has(img)) || allImgs[0];
      const toB64 = (img) => {
        try {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          c.getContext('2d').drawImage(img, 0, 0);
          return c.toDataURL('image/jpeg', 0.9).split(',')[1];
        } catch(e) { return null; }
      };
      return { q: toB64(qImg), a: gridImgs.map(img => toB64(img)) };
    });

    if (ci) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const answer = await page.evaluate(async (qB64, aArr, gKey) => {
          const parts = [
            { text: 'CAPTCHA: The first image is the QUESTION showing an animal/object type. The remaining ' + aArr.length + ' images are numbered 1-' + aArr.length + ' (grid, left to right, top to bottom). Which answer images show the SAME KIND of animal/object as the question? Reply with ONLY the numbers separated by commas. Example: 2,5,7' },
            { inline_data: { mime_type: 'image/jpeg', data: qB64 } },
          ];
          for (let i = 0; i < aArr.length; i++) {
            if (aArr[i]) {
              parts.push({ text: 'Image ' + (i + 1) + ':' });
              parts.push({ inline_data: { mime_type: 'image/jpeg', data: aArr[i] } });
            }
          }
          try {
            const resp = await fetch(
              'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + gKey,
              { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0 } }) }
            );
            const json = await resp.json();
            const allParts = json.candidates?.[0]?.content?.parts || [];
            const textParts = allParts.filter(p => p.text).map(p => p.text);
            return textParts[textParts.length - 1]?.trim() || '';
          } catch(e) { return ''; }
        }, ci.q, ci.a, context.geminiKey);

        const boxed = answer.match(/boxed\\{([\\d,\\s]+)\\}/);
        const nums = boxed ? boxed[1] : answer;
        const idxs = (nums.match(/\\d+/g) || []).map(Number).filter(n => n >= 1 && n <= 9);
        if (idxs.length === 0) continue;

        await page.evaluate((idxs) => {
          const items = document.querySelectorAll('.yq-captcha-modal-wrap .yq-captcha-image-item');
          for (const i of idxs) { if (items[i-1]) items[i-1].click(); }
        }, idxs);
        await new Promise(r => setTimeout(r, 500));
        await page.evaluate(() => document.querySelector('.yq-captcha-submit-btn')?.click());

        for (let i = 0; i < 10; i++) { if (trackData) break; await new Promise(r => setTimeout(r, 1000)); }
        if (trackData) break;

        // Refresh CAPTCHA for retry
        if (attempt < 1) {
          await page.evaluate(() => {
            const btn = document.querySelector('[class*=refresh]');
            if (btn) btn.click();
          });
          await new Promise(r => setTimeout(r, 2500));
          // Re-extract images
          const newCi = await page.evaluate(() => {
            const modal = document.querySelector('.yq-captcha-modal-wrap');
            if (!modal) return null;
            const gridItems = [...modal.querySelectorAll('.yq-captcha-image-item')];
            const gridImgs = gridItems.map(item => item.querySelector('img')).filter(Boolean);
            const gridImgSet = new Set(gridImgs);
            const allImgs = [...modal.querySelectorAll('img')];
            const qImg = allImgs.find(img => !gridImgSet.has(img)) || allImgs[0];
            const toB64 = (img) => {
              try {
                const c = document.createElement('canvas');
                c.width = img.naturalWidth; c.height = img.naturalHeight;
                c.getContext('2d').drawImage(img, 0, 0);
                return c.toDataURL('image/jpeg', 0.9).split(',')[1];
              } catch(e) { return null; }
            };
            return { q: toB64(qImg), a: gridImgs.map(img => toB64(img)) };
          });
          if (newCi) { ci.q = newCi.q; ci.a = newCi.a; }
        }
      }
    }
  }

  // Save first number result
  if (trackData) {
    results[context.numbers[0]] = trackData.shipments[0];
  }

  // Query remaining numbers via direct WASM API calls (~0.5s each)
  for (let n = 1; n < context.numbers.length; n++) {
    const num = context.numbers[n];
    const apiResult = await page.evaluate(async (tracking) => {
      try {
        let sign = null;
        if (window.__wasmExports?.get_fingerprint) {
          const exports = window.__wasmExports;
          const retptr = exports.__wbindgen_add_to_stack_pointer(-16);
          exports.get_fingerprint(retptr, 0);
          const view = new DataView(exports.memory.buffer);
          const ptr = view.getInt32(retptr, true);
          const len = view.getInt32(retptr + 4, true);
          if (ptr > 0 && len > 0 && len < 10000) {
            sign = new TextDecoder().decode(new Uint8Array(exports.memory.buffer, ptr, len));
          }
          exports.__wbindgen_add_to_stack_pointer(16);
        }
        if (!sign) return null;

        const headers = { 'Content-Type': 'application/json' };
        if (window.__lastEventId) headers['Last-Event-Id'] = window.__lastEventId;

        const resp = await fetch('/track/restapi', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            data: [{ num: tracking, fc: 0, sc: 0 }],
            guid: '',
            timeZoneOffset: new Date().getTimezoneOffset(),
            sign,
          }),
          credentials: 'include',
        });
        const json = await resp.json();
        if (json.meta?.code === 200 && json.shipments?.[0]?.shipment) {
          return json.shipments[0];
        }
        return null;
      } catch(e) { return null; }
    }, num);

    if (apiResult) results[num] = apiResult;
  }

  return { data: { results, captchaSolved: !!trackData }, type: 'application/json' };
};`;
}

async function fetchFrom17track(trackingNumbers) {
  if (!BL_KEY) throw new Error('BROWSERLESS_API_KEY not configured');
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY not configured');

  const numbers = Array.isArray(trackingNumbers) ? trackingNumbers : [trackingNumbers];

  const resp = await axios.post(BL_URL, {
    code: buildBrowserCode(),
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
  const cached = getCached(trackingNumber);
  if (cached) return cached;

  try {
    const results = await fetchFrom17track(trackingNumber);
    const result = results[trackingNumber];
    if (result && (result._data_storage.length > 0 || result.status !== 'notfound')) {
      cache.set(trackingNumber, { data: result, ts: Date.now() });
      return result;
    }
  } catch (e) {
    console.log(`[17track] Failed: ${e.message}`);
  }

  return buildNotFoundResponse(trackingNumber);
}

module.exports = { track17track, fetchFrom17track };
