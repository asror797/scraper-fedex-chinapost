const crypto = require('crypto');

const HMAC_SECRET = 'qxV6SOr2tqw9m36j0-R-ohPt1PAB2et0';
const SALT = '\u1780';

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

// MurmurHash3 x86 32-bit
function murmurhash3(bytes, seed = 0) {
  let h1 = seed >>> 0;
  const len = bytes.length;
  const nblocks = len >>> 2;
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;

  for (let i = 0; i < nblocks; i++) {
    let k1 = (bytes[i * 4] | (bytes[i * 4 + 1] << 8) | (bytes[i * 4 + 2] << 16) | (bytes[i * 4 + 3] << 24)) >>> 0;
    k1 = Math.imul(k1, c1) >>> 0;
    k1 = ((k1 << 15) | (k1 >>> 17)) >>> 0;
    k1 = Math.imul(k1, c2) >>> 0;
    h1 = (h1 ^ k1) >>> 0;
    h1 = ((h1 << 13) | (h1 >>> 19)) >>> 0;
    h1 = (Math.imul(h1, 5) + 0xe6546b64) >>> 0;
  }

  let k1 = 0;
  const tail = nblocks * 4;
  switch (len & 3) {
    case 3: k1 ^= bytes[tail + 2] << 16;
    case 2: k1 ^= bytes[tail + 1] << 8;
    case 1: k1 ^= bytes[tail];
      k1 = Math.imul(k1 >>> 0, c1) >>> 0;
      k1 = ((k1 << 15) | (k1 >>> 17)) >>> 0;
      k1 = Math.imul(k1, c2) >>> 0;
      h1 = (h1 ^ k1) >>> 0;
  }

  h1 = (h1 ^ len) >>> 0;
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85ebca6b) >>> 0;
  h1 ^= h1 >>> 13;
  h1 = Math.imul(h1, 0xc2b2ae35) >>> 0;
  h1 ^= h1 >>> 16;

  return h1 >>> 0;
}

function generateToken(trackingNumber) {
  const c = crypto.createHash('sha256').update('ship24-tracker').digest('hex');
  const b = Date.now();
  const input = trackingNumber + b + '64' + SALT;
  const bytes = Buffer.from(input, 'utf-8');
  const a = murmurhash3(bytes);

  const payload = Buffer.from(JSON.stringify({ a, b, c })).toString('base64');
  const signature = crypto.createHmac('sha256', HMAC_SECRET).update(payload).digest('hex');

  return `${payload}.${signature}`;
}

function mapShip24Status(dispatchCode) {
  if (!dispatchCode) return 'notfound';
  const code = dispatchCode.code || '';
  const desc = (dispatchCode.desc || '').toLowerCase();

  if (code === 'DC60' || desc.includes('delivered')) return 'delivered';
  if (code === 'DC40' || code === 'DC50' || desc.includes('transit') || desc.includes('customs')) return 'transit';
  if (code === 'DC20' || desc.includes('label') || desc.includes('created') || desc.includes('info received')) return 'pretransit';
  if (code === 'DC30' || desc.includes('pickup') || desc.includes('collected')) return 'pickup';
  if (desc.includes('exception') || desc.includes('failed') || desc.includes('return')) return 'exception';
  if (desc.includes('hold') || desc.includes('undelivered')) return 'undelivered';
  if (desc.includes('expired')) return 'expired';

  return 'transit';
}

function formatDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function parseLocation(event) {
  const parts = [event.location, event.courier?.slug].filter(Boolean);
  return parts[0] || null;
}

function convertShip24ToClient(trackingNumber, parcel) {
  const events = (parcel.events || []).map(e => ({
    date: formatDate(e.datetime),
    information: e.status || '',
    actual_position_parcel: parseLocation(e),
  }));

  const originCountry = parcel.origin_country_code || null;
  const destCountry = parcel.destination_country_code || null;

  return {
    trackid: trackingNumber,
    status: mapShip24Status(parcel.dispatch_code),
    original_country: originCountry,
    original_city_state: null,
    destination_country: destCountry,
    destination_city_state: null,
    _data_storage: events,
  };
}

async function fetchFromShip24(trackingNumber) {
  const token = generateToken(trackingNumber);

  const resp = await fetch(`https://api.ship24.com/api/parcels/${trackingNumber}?lang=en`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'https://www.ship24.com',
      'Referer': 'https://www.ship24.com/',
      'x-ship24-token': token,
    },
    body: JSON.stringify({
      userAgent: '',
      os: 'Mac',
      browser: 'Chrome',
      device: 'Macintosh',
      deviceType: 'desktop',
      orientation: 'landscape',
      uL: 'en',
    }),
  });

  if (resp.status === 404) return null;
  if (resp.status === 403) throw new Error('Ship24 token rejected (403)');
  if (!resp.ok) throw new Error(`Ship24 returned ${resp.status}`);

  const data = await resp.json();
  if (!data.data) return null;

  return convertShip24ToClient(trackingNumber, data.data);
}

async function trackChinaPost(trackingNumber) {
  const cached = getCached(trackingNumber);
  if (cached) return cached;

  try {
    const result = await fetchFromShip24(trackingNumber);
    if (result && (result._data_storage.length > 0 || result.status !== 'notfound')) {
      cache.set(trackingNumber, { data: result, ts: Date.now() });
      return result;
    }
  } catch (e) {
    console.log(`[ChinaPost] Ship24 failed: ${e.message}`);
  }

  return buildNotFoundResponse(trackingNumber);
}

module.exports = { trackChinaPost };
