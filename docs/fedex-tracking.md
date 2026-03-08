# FedEx Tracking

FedEx uses Akamai Bot Manager to protect their tracking API. To bypass it I'm using Hyper Solutions SDK to generate valid Akamai sensor data, and impit as the HTTP client because it mimics Chrome's TLS fingerprint (JA3/JA4).

## How it works

1. Fetch the FedEx tracking page to get cookies (`_abck`, `bm_sz`)
2. Parse the Akamai bot script URL from the page HTML
3. Generate 3 rounds of sensor data using Hyper SDK and post them to the script endpoint
4. Once the `_abck` cookie is valid, get an OAuth token from `api.fedex.com/auth/oauth/v2/token`
5. Call `api.fedex.com/track/v2/shipments` with the token and cookies

The cookies and token are cached so subsequent requests skip the Akamai solving step. If the cookie expires (403 response), it automatically re-solves.

## Performance

- First request: ~6-8s (Akamai solving + API call)
- Cached requests: ~1-2s (API call only)

## Services & tools used

- **Hyper Solutions** (`hyper-sdk-js`) — Akamai sensor data generation, handles the bot detection bypass
- **impit** — HTTP client with real Chrome TLS/HTTP2 fingerprint so FedEx doesn't flag the connection
- No browser packages, no Browserless needed for this one — it's all direct HTTP
