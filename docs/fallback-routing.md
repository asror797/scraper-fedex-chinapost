# Fallback Routing

The service has automatic fallback. If the primary scraper for a carrier fails or returns no data, it tries the next one in the chain.

## Chains

| Carrier | Primary | Fallback 1 | Fallback 2 |
|---------|---------|------------|------------|
| FedEx | FedEx Direct API | Ship24 | 17track |
| China Post | Ship24 | 17track | — |
| Any other (UPS, DHL, etc.) | Ship24 | 17track | — |

## How it works

Each carrier has an ordered list of scrapers. The service tries them one by one. If a scraper returns `notfound` or throws an error, it moves to the next one. First successful result wins.

## Why this matters

Anti-bot systems change frequently. If FedEx updates their Akamai config and the direct scraper breaks, the service automatically falls back to Ship24 or 17track instead of returning an error. No downtime, no manual intervention needed.

Ship24 and 17track are universal trackers — they support hundreds of carriers. So they work as backup for pretty much anything.

## All services used across the project

| Service | What it does | Used for |
|---------|-------------|----------|
| **Hyper Solutions** | Akamai bot detection bypass | FedEx direct scraper |
| **impit** | HTTP client with Chrome TLS fingerprint | FedEx direct scraper |
| **Bright Data** | Datacenter proxy | Ship24 (China Post) to avoid rate limits |
| **Browserless.io** | Cloud browser (stealth) | 17track — runs WASM in real browser |
| **Gemini 2.5 Flash** | Google AI vision API | 17track — solves image CAPTCHA |

## Environment variables

```
HYPER_API_KEY       — Hyper Solutions API key (FedEx)
HYPER_JWT_KEY       — Hyper Solutions JWT key (FedEx)
BROWSERLESS_API_KEY — Browserless.io token (17track)
GEMINI_API_KEY      — Google Gemini API key (17track CAPTCHA)
BRIGHTDATA_PROXY    — Bright Data proxy URL (Ship24)
```
