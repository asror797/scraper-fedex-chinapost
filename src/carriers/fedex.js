const axios = require('axios');

let hyperSdk = null;

async function getHyperSdk() {
  if (hyperSdk) return hyperSdk;
  hyperSdk = await import('hyper-sdk-js');
  return hyperSdk;
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ACCEPT_LANGUAGE = 'en-US,en;q=0.9';

let impit = null;
let hyperSession = null;

async function getImpit() {
  if (impit) return impit;
  const { Impit } = await import('impit');
  impit = new Impit({ browser: 'chrome' });
  return impit;
}

async function getHyperSession() {
  if (hyperSession) return hyperSession;
  const { Session } = await getHyperSdk();
  const apiKey = process.env.HYPER_API_KEY;
  const jwtKey = process.env.HYPER_JWT_KEY;
  if (!apiKey) throw new Error('HYPER_API_KEY is required');
  hyperSession = new Session(apiKey, jwtKey || undefined);
  return hyperSession;
}

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

let cookies = {};
let sensorContext = '';
let cachedToken = null;
let cachedTokenExpiry = 0;
let cachedScriptUrl = null;
let cachedScriptBody = null;
let cachedScriptExpiry = 0;
let cachedIp = null;
let cachedIpExpiry = 0;

function parseCookiesFromHeaders(headers) {
  let raw;
  if (typeof headers.getSetCookie === 'function') {
    raw = headers.getSetCookie();
  } else {
    raw = headers.get('set-cookie');
    if (raw) raw = raw.split(/,(?=[^ ])/);
  }
  if (!raw) return;
  const parts = Array.isArray(raw) ? raw : [raw];
  for (const h of parts) {
    const [nameVal] = h.split(';');
    const eqIdx = nameVal.indexOf('=');
    if (eqIdx > 0) {
      cookies[nameVal.substring(0, eqIdx).trim()] = nameVal.substring(eqIdx + 1).trim();
    }
  }
}

function getCookieString() {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function getIp() {
  if (cachedIp && Date.now() < cachedIpExpiry) return cachedIp;
  try { cachedIp = (await axios.get('https://api.ipify.org', { timeout: 3000 })).data.trim(); }
  catch { cachedIp = (await axios.get('https://checkip.amazonaws.com', { timeout: 3000 })).data.trim(); }
  cachedIpExpiry = Date.now() + 600_000;
  return cachedIp;
}

async function getOAuthToken(client) {
  if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;
  const res = await client.fetch('https://api.fedex.com/auth/oauth/v2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': getCookieString(),
      'Origin': 'https://www.fedex.com',
      'Referer': 'https://www.fedex.com/',
      'User-Agent': USER_AGENT,
    },
    body: 'client_id=l7b8ada987a4544ff7a839c8e1f6548eea&grant_type=client_credentials&scope=oob',
  });
  parseCookiesFromHeaders(res.headers);
  const body = await res.text();
  const json = JSON.parse(body);
  cachedToken = json.access_token;
  cachedTokenExpiry = Date.now() + 50 * 60_000;
  return cachedToken;
}

async function solveFedExAkamai(client, trackNum) {
  const pageUrl = `https://www.fedex.com/fedextrack/?trknbr=${trackNum}`;

  const [pageRes, myIp] = await Promise.all([
    client.fetch(pageUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': ACCEPT_LANGUAGE,
        'Cookie': getCookieString(),
        'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
    }),
    getIp(),
  ]);
  parseCookiesFromHeaders(pageRes.headers);
  const pageBody = await pageRes.text();

  if (!pageBody || pageBody.length < 100 || pageBody.includes('System Down')) {
    throw new Error('WAF blocked page request');
  }

  const { parseAkamaiPath, SensorInput, generateSensorData, isAkamaiCookieValid: checkCookie } = await getHyperSdk();

  let scriptUrl = cachedScriptUrl;
  let scriptBody = cachedScriptBody;

  if (!scriptUrl || Date.now() > cachedScriptExpiry) {
    const scriptPath = parseAkamaiPath(pageBody);
    if (!scriptPath) throw new Error('No Akamai script found in page');
    scriptUrl = `https://www.fedex.com${scriptPath}`;
    cachedScriptUrl = scriptUrl;

    const scriptRes = await client.fetch(scriptUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': '*/*',
        'Accept-Language': ACCEPT_LANGUAGE,
        'Cookie': getCookieString(),
        'Referer': pageUrl,
        'Sec-Fetch-Dest': 'script',
        'Sec-Fetch-Mode': 'no-cors',
      },
    });
    parseCookiesFromHeaders(scriptRes.headers);
    scriptBody = await scriptRes.text();
    cachedScriptBody = scriptBody;
    cachedScriptExpiry = Date.now() + 3600_000;
  }

  const session = await getHyperSession();
  sensorContext = '';

  for (let i = 1; i <= 3; i++) {
    const input = new SensorInput(
      cookies._abck || '', cookies.bm_sz || '', '3', pageUrl,
      USER_AGENT, myIp, ACCEPT_LANGUAGE, sensorContext,
      i === 1 ? scriptBody : '', scriptUrl,
    );
    const result = await generateSensorData(session, input);
    sensorContext = result.context;

    const postRes = await client.fetch(scriptUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=UTF-8',
        'Cookie': getCookieString(),
        'Origin': 'https://www.fedex.com',
        'Referer': pageUrl,
        'User-Agent': USER_AGENT,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
      },
      body: JSON.stringify({ sensor_data: result.payload }),
    });
    parseCookiesFromHeaders(postRes.headers);

    if (cookies._abck && checkCookie(cookies._abck, i)) {
      return true;
    }
  }
  return false;
}

function mapFedexApiStatus(keyStatus) {
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

function convertFedexApiToClient(trackingNumber, pkg) {
  const shipper = pkg.shipperAddress || {};
  const recipient = pkg.recipientAddress || {};

  const originCityState = [shipper.city, shipper.stateCD].filter(Boolean).join(', ') || null;
  const destCityState = [recipient.city, recipient.stateCD].filter(Boolean).join(', ') || null;

  const events = (pkg.scanEventList || []).map(e => ({
    date: e.date || null,
    information: e.description || e.eventDescription || e.scanType || '',
    actual_position_parcel: e.scanLocation || null,
  }));

  return {
    trackid: trackingNumber,
    status: mapFedexApiStatus(pkg.keyStatus),
    original_country: shipper.countryCD || shipper.countryName || null,
    original_city_state: originCityState,
    destination_country: recipient.countryCD || recipient.countryName || null,
    destination_city_state: destCityState,
    _data_storage: events,
  };
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

async function trackViaHyper(trackingNumber) {
  const client = await getImpit();
  const start = Date.now();

  const { isAkamaiCookieValid } = await getHyperSdk();
  const needSensor = !cookies._abck || !isAkamaiCookieValid(cookies._abck, 3);

  if (needSensor) {
    console.log(`[FedEx/Hyper] Solving Akamai for ${trackingNumber}...`);
    const solved = await solveFedExAkamai(client, trackingNumber);
    if (!solved) throw new Error('Akamai not solved after 3 sensors');
    console.log(`[FedEx/Hyper] Akamai solved (${Date.now() - start}ms)`);
  }

  const token = await getOAuthToken(client);

  const trackRes = await client.fetch('https://api.fedex.com/track/v2/shipments', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Cookie': getCookieString(),
      'Origin': 'https://www.fedex.com',
      'Referer': 'https://www.fedex.com/',
      'User-Agent': USER_AGENT,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': ACCEPT_LANGUAGE,
      'X-clientid': 'WTRK',
      'X-locale': 'en_US',
      'X-version': '1.0.0',
      'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site',
    },
    body: JSON.stringify({
      appDeviceType: 'WTRK', appType: 'WTRK', supportHTML: true, supportCurrentLocation: true,
      trackingInfo: [{ trackNumberInfo: { trackingCarrier: '', trackingNumber, trackingQualifier: '' } }],
      uniqueKey: '', guestAuthenticationToken: '',
    }),
  });

  const body = await trackRes.text();

  if (trackRes.status === 403 && !needSensor) {
    console.log(`[FedEx/Hyper] Cookie expired, re-solving...`);
    cookies = {};
    sensorContext = '';
    return trackViaHyper(trackingNumber);
  }

  if (trackRes.status !== 200) {
    throw new Error(`Track API returned ${trackRes.status}`);
  }

  const json = JSON.parse(body);
  const pkg = json?.output?.packages?.[0];
  if (!pkg) return null;

  return convertFedexApiToClient(trackingNumber, pkg);
}

function mapShip24Status(milestone, statusCode) {
  if (!milestone && !statusCode) return 'notfound';
  const m = (milestone || '').toLowerCase();
  if (m === 'delivered') return 'delivered';
  if (m === 'in_transit' || m === 'out_for_delivery') return 'transit';
  if (m === 'info_received') return 'pretransit';
  if (m === 'failed_attempt' || m === 'exception') return 'exception';
  if (m === 'available_for_pickup') return 'pickup';
  if (m === 'expired') return 'expired';
  const sc = (statusCode || '').toLowerCase();
  if (sc.includes('deliver')) return 'delivered';
  if (sc.includes('transit') || sc.includes('shipping')) return 'transit';
  if (sc.includes('exception') || sc.includes('fail')) return 'exception';
  if (sc.includes('pickup')) return 'pickup';
  if (sc.includes('created') || sc.includes('info') || sc.includes('order')) return 'pretransit';
  return 'transit';
}

function parseShip24Location(loc) {
  if (!loc) return { country: null, cityState: null };
  const parts = loc.split(' ');
  const last = parts[parts.length - 1];
  if (last.length === 2 && last === last.toUpperCase() && parts.length >= 2) {
    return { country: last, cityState: parts.slice(0, -1).join(' ').replace(/,$/, '') };
  }
  return { country: null, cityState: loc };
}

function formatShip24Date(dt) {
  if (!dt) return null;
  const match = dt.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
  return match ? match[1] : null;
}

function convertShip24ToClient(trackingNumber, ship24Data) {
  const ship = ship24Data.shipment;
  const events = ship24Data.events || [];
  if (events.length === 0) return buildNotFoundResponse(trackingNumber);

  let originCityState = null;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].location) { originCityState = parseShip24Location(events[i].location).cityState; break; }
  }
  let destCityState = null;
  for (let i = 0; i < events.length; i++) {
    if (events[i].location) { destCityState = parseShip24Location(events[i].location).cityState; break; }
  }

  return {
    trackid: trackingNumber,
    status: mapShip24Status(ship.statusMilestone, ship.statusCode),
    original_country: ship.originCountryCode || null,
    original_city_state: originCityState,
    destination_country: ship.destinationCountryCode || null,
    destination_city_state: destCityState,
    _data_storage: events.map(e => ({
      date: formatShip24Date(e.occurrenceDatetime || e.datetime),
      information: e.status || '',
      actual_position_parcel: e.location || null,
    })),
  };
}

async function trackViaShip24(trackingNumber) {
  const SHIP24_KEY = process.env.SHIP24_API_KEY;
  if (!SHIP24_KEY) return null;

  const res = await axios.post('https://api.ship24.com/public/v1/tracking/search', {
    trackingNumber,
    courierCode: ['fedex'],
  }, {
    headers: { 'Authorization': `Bearer ${SHIP24_KEY}`, 'Content-Type': 'application/json' },
    timeout: 30000,
  });

  const tracking = res.data?.data?.trackings?.[0];
  if (!tracking || !tracking.events || tracking.events.length === 0) return null;
  return convertShip24ToClient(trackingNumber, tracking);
}

async function trackFedEx(trackingNumber) {
  const cached = getCached(trackingNumber);
  if (cached) return cached;

  if (process.env.HYPER_API_KEY) {
    try {
      const result = await trackViaHyper(trackingNumber);
      if (result && result.status !== 'notfound') {
        console.log(`[FedEx/Hyper] Success: ${result.status} (${result._data_storage.length} events)`);
        cache.set(trackingNumber, { data: result, ts: Date.now() });
        return result;
      }
    } catch (err) {
      console.log(`[FedEx/Hyper] Failed: ${err.message}`);
    }
  }

  try {
    console.log(`[FedEx] Trying Ship24 for ${trackingNumber}...`);
    const ship24Result = await trackViaShip24(trackingNumber);
    if (ship24Result && ship24Result.status !== 'notfound') {
      console.log(`[FedEx/Ship24] Success: ${ship24Result.status}`);
      cache.set(trackingNumber, { data: ship24Result, ts: Date.now() });
      return ship24Result;
    }
  } catch (err) {
    console.log(`[FedEx/Ship24] Failed: ${err.message}`);
  }

  return buildNotFoundResponse(trackingNumber);
}

module.exports = { trackFedEx };
