const axios = require('axios');

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

function mapStatus(cniStatus) {
  if (!cniStatus) return 'notfound';
  const s = cniStatus.toUpperCase();

  if (s.includes('SIGNIN') || s.includes('SIGN_IN') || s === 'SIGNED') return 'delivered';
  if (s.includes('DELIVERED') || s === 'SUCCESS') return 'delivered';
  if (s.includes('FAILED') || s.includes('EXCEPTION') || s.includes('RETURN')) return 'exception';
  if (s.includes('TRANSPORT') || s.includes('TRANSIT') || s.includes('SHIPPING') ||
      s.includes('ARRIVAL') || s.includes('DEPART') || s.includes('CUSTOMS') ||
      s.includes('DELIVERING') || s.includes('ON_THE_WAY')) return 'transit';
  if (s.includes('PICKUP') || s.includes('PICK_UP') || s.includes('COLLECTED')) return 'pickup';
  if (s.includes('ACCEPT') || s.includes('PREPARING') || s.includes('CREATED') ||
      s.includes('WAIT_SELLER') || s.includes('SELLER_PREPARING')) return 'pretransit';
  if (s.includes('UNDELIVERED') || s.includes('HOLD')) return 'undelivered';
  if (s.includes('EXPIRED') || s.includes('STALE')) return 'expired';
  if (s === 'NOTFOUND' || s.includes('NOT_FOUND')) return 'notfound';

  return 'transit';
}

function formatDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function fetchFromCainiao(trackingNumber) {
  const res = await axios.get('https://global.cainiao.com/global/detail.json', {
    params: {
      mailNos: trackingNumber,
      lang: 'en-US',
      language: 'en-US',
    },
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'application/json',
    },
    timeout: 15000,
  });

  if (!res.data?.success || !res.data?.module?.[0]) {
    return null;
  }

  const m = res.data.module[0];
  const events = (m.detailList || []).map((e) => ({
    date: formatDate(e.time || e.timeStr),
    information: e.standerdDesc || e.desc || e.statusDesc || '',
    actual_position_parcel: e.city || e.location || null,
  }));

  const status = mapStatus(m.status);

  return {
    trackid: trackingNumber,
    status: events.length === 0 && status === 'notfound' ? 'notfound' : status,
    original_country: m.originCountry || null,
    original_city_state: null,
    destination_country: m.destCountry || null,
    destination_city_state: null,
    _data_storage: events,
  };
}

async function trackChinaPost(trackingNumber) {
  const cached = getCached(trackingNumber);
  if (cached) return cached;

  try {
    const result = await fetchFromCainiao(trackingNumber);
    if (result && (result._data_storage.length > 0 || result.status !== 'notfound')) {
      cache.set(trackingNumber, { data: result, ts: Date.now() });
      return result;
    }
  } catch (e) {
    console.log(`[ChinaPost] Cainiao API failed: ${e.message}`);
  }

  return buildNotFoundResponse(trackingNumber);
}

module.exports = { trackChinaPost };
