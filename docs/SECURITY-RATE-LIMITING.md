# StarAlgo rate limiting rollout

## Scope

This first code change protects requests that reach the standalone `staralgo-api` Worker. It does not yet protect the Cloudflare Pages Function entry point by itself.

The Worker uses Cloudflare Rate Limiting bindings before the shared API handler:
- `API_EDGE_LIMITER`: 1,200 requests / 60 seconds per source IP.
- `AUTH_EDGE_LIMITER`: 60 password-heavy POST requests / 60 seconds per source IP.
- `SCRATCH_PROXY_LIMITER`: 120 Google Drive proxy GET/HEAD requests / 60 seconds per source IP.

These are deliberately conservative starting thresholds. Cloudflare's Worker Rate Limiting API is approximate, eventually consistent, and local to each Cloudflare location; it is an additional mitigation layer, not a strict global quota. IP-based limits can affect people sharing a school, office, or mobile carrier NAT.

## Deployment requirements

1. Deploy the `staralgo-api` Worker with the updated `wrangler.jsonc` so the three rate-limit bindings are provisioned.
2. Verify the deployed Worker has all three bindings in its version configuration.
3. Run the safe checks below against a preview/test deployment before directing production traffic to it.
4. Do not change D1 schema or run D1 migrations for this feature.

If a rate-limit binding is missing or temporarily unavailable, this implementation logs the problem once per isolate and fails open to preserve site availability. Therefore, missing bindings must be treated as a failed deployment check, not as successful protection.

## Pages API is a separate entry point

`functions/api/[[path]].js` currently calls the shared API handler directly. It does not pass through the standalone Worker wrapper above, so these Worker bindings do not automatically rate-limit Pages requests.

Cloudflare Pages Functions currently document a limited set of supported bindings; the Worker Rate Limiting binding is not listed. Protect the Pages hostname separately at the Cloudflare zone/WAF edge if it is a proxied custom domain. First identify the exact production Pages hostname and check the existing traffic baseline. Start in logging/observe mode where available, then apply a conservative rate-limit rule scoped to `/api/*`. Do not apply a low global limit to all site traffic.

If Pages is accessed only through a `*.pages.dev` hostname, do not assume zone WAF rules cover it. Confirm the supported protection path before enabling a rule.

## Safe verification

- Normal API read request succeeds.
- Password/auth request below threshold succeeds.
- A test request after the configured threshold receives HTTP 429 with `Retry-After: 60`.
- Ordinary API reads are unaffected when only the auth limiter rejects.
- Scratch proxy is limited independently.
- OPTIONS preflight requests do not consume the quota.
- Missing binding produces a single diagnostic log and does not take the site offline.
- Check D1 errors and 5xx rate after preview deployment.

Do not run a high-volume stress test against production. The rate limiter is approximate, so a few extra requests may pass during synchronization.
