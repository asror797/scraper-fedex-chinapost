export default async ({ page, context }) => {
  const results = {};

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

  await page.goto('https://t.17track.net/en#nums=' + context.numbers[0], {
    waitUntil: 'networkidle2',
    timeout: 45000,
  });

  for (let i = 0; i < 6; i++) { if (apiCode) break; await new Promise(r => setTimeout(r, 1000)); }

  if (!trackData && apiCode === -14) {
    await new Promise(r => setTimeout(r, 2500));

    const extractCaptchaImages = () => {
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
    };

    const ci = await page.evaluate(extractCaptchaImages);

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

        const boxed = answer.match(/boxed\{([\d,\s]+)\}/);
        const nums = boxed ? boxed[1] : answer;
        const idxs = (nums.match(/\d+/g) || []).map(Number).filter(n => n >= 1 && n <= 9);
        if (idxs.length === 0) continue;

        await page.evaluate((idxs) => {
          const items = document.querySelectorAll('.yq-captcha-modal-wrap .yq-captcha-image-item');
          for (const i of idxs) { if (items[i-1]) items[i-1].click(); }
        }, idxs);
        await new Promise(r => setTimeout(r, 500));
        await page.evaluate(() => document.querySelector('.yq-captcha-submit-btn')?.click());

        for (let i = 0; i < 10; i++) { if (trackData) break; await new Promise(r => setTimeout(r, 1000)); }
        if (trackData) break;

        if (attempt < 1) {
          await page.evaluate(() => {
            const btn = document.querySelector('[class*=refresh]');
            if (btn) btn.click();
          });
          await new Promise(r => setTimeout(r, 2500));
          const newCi = await page.evaluate(extractCaptchaImages);
          if (newCi) { ci.q = newCi.q; ci.a = newCi.a; }
        }
      }
    }
  }

  if (trackData) {
    results[context.numbers[0]] = trackData.shipments[0];
  }

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
};
