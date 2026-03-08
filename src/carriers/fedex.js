const axios = require('axios');
const { createCache } = require('../utils/cache');
const { buildNotFoundResponse } = require('../utils/response');
const { convertFedexPackage } = require('../utils/fedex');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SEC_CH_UA = '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"';
const SEC_CH_UA_PLATFORM = '"Windows"';
const ACCEPT_LANGUAGE = 'en-US,en;q=0.9';

let hyperSdk = null;
let impit = null;
let hyperSession = null;

async function getHyperSdk() {
  if (hyperSdk) return hyperSdk;
  hyperSdk = await import('hyper-sdk-js');
  return hyperSdk;
}

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

const cache = createCache();

const state = {
  cookies: {},
  sensorContext: '',
  token: null,
  tokenExpiry: 0,
  scriptUrl: null,
  scriptBody: null,
  scriptExpiry: 0,
  ip: null,
  ipExpiry: 0,
  reset() {
    this.cookies = {};
    this.sensorContext = '';
    this.token = null;
    this.tokenExpiry = 0;
    this.scriptUrl = null;
    this.scriptBody = null;
    this.scriptExpiry = 0;
  },
};

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
      state.cookies[nameVal.substring(0, eqIdx).trim()] = nameVal.substring(eqIdx + 1).trim();
    }
  }
}

function getCookieString() {
  return Object.entries(state.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function getIp() {
  if (state.ip && Date.now() < state.ipExpiry) return state.ip;
  try {
    state.ip = (await axios.get('https://api.ipify.org', { timeout: 3000 })).data.trim();
  } catch {
    state.ip = (await axios.get('https://checkip.amazonaws.com', { timeout: 3000 })).data.trim();
  }
  state.ipExpiry = Date.now() + 600_000;
  return state.ip;
}

async function getOAuthToken(client) {
  if (state.token && Date.now() < state.tokenExpiry) return state.token;
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
  const json = JSON.parse(await res.text());
  state.token = json.access_token;
  state.tokenExpiry = Date.now() + 50 * 60_000;
  return state.token;
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
        'sec-ch-ua': SEC_CH_UA,
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': SEC_CH_UA_PLATFORM,
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

  let scriptUrl = state.scriptUrl;
  let scriptBody = state.scriptBody;

  if (!scriptUrl || Date.now() > state.scriptExpiry) {
    const scriptPath = parseAkamaiPath(pageBody);
    if (!scriptPath) throw new Error('No Akamai script found in page');
    scriptUrl = `https://www.fedex.com${scriptPath}`;
    state.scriptUrl = scriptUrl;

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
    state.scriptBody = scriptBody;
    state.scriptExpiry = Date.now() + 3600_000;
  }

  const session = await getHyperSession();
  state.sensorContext = '';

  for (let i = 1; i <= 3; i++) {
    const input = new SensorInput(
      state.cookies._abck || '', state.cookies.bm_sz || '', '3', pageUrl,
      USER_AGENT, myIp, ACCEPT_LANGUAGE, state.sensorContext,
      i === 1 ? scriptBody : '', scriptUrl,
    );
    const result = await generateSensorData(session, input);
    state.sensorContext = result.context;

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

    if (state.cookies._abck && checkCookie(state.cookies._abck, i)) {
      return true;
    }
  }
  return false;
}

async function trackViaHyper(trackingNumber) {
  const client = await getImpit();
  const start = Date.now();

  const { isAkamaiCookieValid } = await getHyperSdk();
  const needSensor = !state.cookies._abck || !isAkamaiCookieValid(state.cookies._abck, 3);

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
      'sec-ch-ua': SEC_CH_UA,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': SEC_CH_UA_PLATFORM,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site',
    },
    body: JSON.stringify({
      appDeviceType: 'WTRK',
      appType: 'WTRK',
      supportHTML: true,
      supportCurrentLocation: true,
      trackingInfo: [{ trackNumberInfo: { trackingCarrier: '', trackingNumber, trackingQualifier: '' } }],
      uniqueKey: '',
      guestAuthenticationToken: '',
    }),
  });

  const body = await trackRes.text();

  if (trackRes.status === 403 && !needSensor) {
    console.log(`[FedEx/Hyper] Cookie expired, re-solving...`);
    state.reset();
    return trackViaHyper(trackingNumber);
  }

  if (trackRes.status !== 200) {
    throw new Error(`Track API returned ${trackRes.status}`);
  }

  const json = JSON.parse(body);
  const pkg = json?.output?.packages?.[0];
  if (!pkg) return null;

  if (pkg.errorList && pkg.errorList.length > 0) {
    console.log(`[FedEx/Hyper] Error for ${trackingNumber}: ${pkg.errorList[0]?.message || JSON.stringify(pkg.errorList[0])}`);
    return null;
  }

  return convertFedexPackage(trackingNumber, pkg);
}

async function trackFedEx(trackingNumber) {
  const cached = cache.get(trackingNumber);
  if (cached) return cached;

  try {
    const result = await trackViaHyper(trackingNumber);
    if (result && result.status !== 'notfound') {
      console.log(`[FedEx] Success: ${result.status} (${result._data_storage.length} events)`);
      cache.set(trackingNumber, result);
      return result;
    }
  } catch (err) {
    console.log(`[FedEx] Failed: ${err.message}`);
  }

  return buildNotFoundResponse(trackingNumber);
}

module.exports = { trackFedEx };
