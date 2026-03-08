# Testing Guide

## Setup

```bash
npm install
cp .env.example .env
# fill in your API keys in .env
npm start
```

Server runs on `http://localhost:3000` by default (or whatever PORT is set in .env).

## Health check

```bash
curl http://localhost:3000/health
```

Expected:
```json
{"status":"ok","uptime":5.12}
```

## FedEx tracking

Direct API (Hyper + impit, ~6-8s first request):
```bash
curl "http://localhost:3000/track?number=399052979157&carrier=fedex"
```

Browserless method (~15-30s):
```bash
curl "http://localhost:3000/track?number=399052979157&carrier=fedex&method=browserless"
```

## China Post tracking

Via Ship24 (~1-2s):
```bash
curl "http://localhost:3000/track?number=CY032871848CN&carrier=chinapost"
```

## 17track tracking

Via Browserless + WASM (~15-20s first, ~0.5s cached):
```bash
curl "http://localhost:3000/track?number=CY032871848CN&carrier=17track"
```

## Other carriers (UPS, DHL, etc.)

Falls back to Ship24 → 17track automatically:
```bash
curl "http://localhost:3000/track?number=YOUR_TRACKING_NUMBER&carrier=dhl"
curl "http://localhost:3000/track?number=YOUR_TRACKING_NUMBER&carrier=ups"
```

## Default carrier

If no carrier specified, defaults to `fedex`:
```bash
curl "http://localhost:3000/track?number=399052979157"
```

## Error cases

Missing tracking number:
```bash
curl "http://localhost:3000/track"
# → 400: {"error":"Missing required parameter: number"}
```

Invalid tracking number (returns notfound, not an error):
```bash
curl "http://localhost:3000/track?number=INVALID123&carrier=chinapost"
# → 200: {"trackid":"INVALID123","status":"notfound",...}
```

## Fallback behavior

Each carrier has a chain of scrapers. If the primary fails, it tries the next:

| carrier= | Try 1 | Try 2 | Try 3 |
|-----------|-------|-------|-------|
| fedex | FedEx Direct | Ship24 | 17track |
| chinapost | Ship24 | 17track | — |
| anything else | Ship24 | 17track | — |

To verify fallback works, you can test a FedEx number through chinapost scraper:
```bash
curl "http://localhost:3000/track?number=399052979157&carrier=chinapost"
```
Ship24 should still return FedEx tracking data since it's a universal tracker.

## Response format

```json
{
  "trackid": "CY032871848CN",
  "status": "delivered",
  "original_country": "CN",
  "original_city_state": null,
  "destination_country": "UZ",
  "destination_city_state": null,
  "_data_storage": [
    {
      "date": "2025-01-15T10:30:00",
      "information": "Delivered",
      "actual_position_parcel": "Tashkent"
    }
  ]
}
```

## Status values

| Status | Meaning |
|--------|---------|
| delivered | Package delivered |
| transit | In transit |
| pretransit | Label created, not yet shipped |
| pickup | Picked up by carrier |
| exception | Delivery exception or delay |
| undelivered | Delivery attempted but failed |
| expired | Tracking expired |
| notfound | No tracking data found |

## Test tracking numbers

| Number | Carrier | Expected status |
|--------|---------|----------------|
| 399052979157 | fedex | delivered |
| CY032871848CN | chinapost | delivered |
| ZP09676933601 | chinapost | notfound (expired) |

## Environment variables

```
PORT=3000                   # Server port
HYPER_API_KEY=              # Hyper Solutions (FedEx Akamai bypass)
HYPER_JWT_KEY=              # Hyper Solutions JWT
BROWSERLESS_API_KEY=        # Browserless.io (17track browser)
GEMINI_API_KEY=             # Google Gemini (17track CAPTCHA solving)
BRIGHTDATA_PROXY=           # Bright Data proxy (Ship24 rate limiting)
```
