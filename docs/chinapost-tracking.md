# China Post Tracking

For China Post I'm using Ship24's internal API. It's fast and reliable, no browser needed.

## How it works

Ship24 protects their API with a custom token. I reverse-engineered how they generate it:

1. Compute SHA256 hash of the string `ship24-tracker`
2. Get current timestamp
3. Concatenate tracking number + timestamp + "64" + salt character
4. Run MurmurHash3 (x86 32-bit) on that string
5. Build a JSON payload with the hash, timestamp, and SHA256
6. Base64 encode it and sign with HMAC-SHA256 using their secret key

The token goes in the `x-ship24-token` header, then just POST to `api.ship24.com/api/parcels/{tracking}?lang=en`.

## Performance

- ~1-2s per request

## Services & tools used

- **Bright Data** — datacenter proxy to avoid Ship24 rate limiting. Configured via `BRIGHTDATA_PROXY` env variable
- **Ship24 API** — the actual data source. Aggregates tracking data from hundreds of postal services worldwide
- No browser, no Browserless, no CAPTCHA solving — just direct HTTP calls through the proxy

## Why Ship24

Ship24 aggregates data from multiple postal services so it works for China Post, EMS, and most international carriers. It's the primary scraper for non-FedEx tracking and also serves as fallback for FedEx.
