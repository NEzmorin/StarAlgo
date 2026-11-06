# StarAlgo: Vercel frontend + Cloudflare Worker API

This branch prepares a separate deployment. The existing `main` branch and current
Cloudflare Pages deployment are intentionally left unchanged.

## Architecture

- Vercel serves the existing static frontend (`index.html`, assets and fonts).
- Cloudflare Worker serves the API using the existing implementation in
  `functions/api/_handler.js`.
- The Worker uses the existing Cloudflare D1 database through the `DB` binding.
- The browser API base is configured in `assets/api-config.js`.

## Before deploying the Worker

1. Find the existing D1 database ID for the database named `staralgo-db`.
2. Replace `REPLACE_WITH_EXISTING_D1_DATABASE_ID` in `wrangler.jsonc`.
3. Deploy the Worker from this repository root with Wrangler:
   `npx wrangler deploy`.
4. Set the Worker variable `APP_ORIGIN` to the exact Vercel origin
   (for example, `https://staralgo.vercel.app`, without a trailing slash).
   It can be set in the Cloudflare Worker settings or in `wrangler.jsonc`
   before deployment.
5. Verify `https://<worker-name>.<account-subdomain>.workers.dev/api/health`
   and `/api/health/db`.

Do not create a new D1 database. The Worker must use the existing `staralgo-db`
database so existing accounts, sessions, projects, likes and comments remain intact.

## Vercel

Import this GitHub repository into Vercel and select the `vercel-migration` branch.
The project is static: no framework preset or build command is required; the
repository root is the output directory.

After the Worker URL is known, update `assets/api-config.js` so
`window.STARALGO_API_BASE` is set to that Worker origin (no trailing slash).
Then redeploy the Vercel project.

## Validation checklist

- Open the Vercel site without VPN.
- Check `/api/health` and `/api/health/db` on the Worker URL.
- Register a test account and sign in.
- Verify bootstrap, project publishing, likes, comments, follows and notifications.
- Confirm the existing Cloudflare Pages site still works independently.

Never put API tokens, passwords, or other secrets in this repository.

<!-- Deployment trigger check: this commit is intentionally on vercel-migration. -->


<!-- Cloudflare Worker Git connection trigger: 2026-11-06. -->
