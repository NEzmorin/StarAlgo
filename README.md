# StarAlgo — Cloudflare Pages + Pages Functions + D1

This build uses the existing Cloudflare Pages project. **Do not create a separate Worker.**

- `index.html` and `assets/` are the website interface.
- `functions/api/[[path]].js` routes `/api/*` requests to the StarAlgo API.
- `functions/api/_handler.js` contains the API implementation.
- The API uses the Pages D1 binding named `DB`.
- `schema.sql` is a copy of the schema already applied to `staralgo-db`; do not run it again unless creating a brand-new empty database.

## Dashboard settings already completed

Pages project → Settings → Bindings:

- Type: D1 database
- Variable name: `DB`
- Database: `staralgo-db`

After new code is deployed, Cloudflare will apply the binding to the Pages Functions runtime.

## Publish to the existing Pages project

This project is Git-integrated. Cloudflare Pages deploys Pages Functions through Git integration (dashboard Direct Upload does not deploy a `functions/` directory).

1. Unzip this archive.
2. In the **repository connected to the existing `staralgo` Pages project**, place the contents of this folder in the repository's configured Pages root:
   - replace `index.html`;
   - replace/add the files in `assets/`;
   - add the `functions/` folder at the same level as `index.html`;
   - replace/add `click.mp3`, `OldRobloxFontRegular-0WYjo.ttf`, and `Undertale-Battle-Font.ttf` at the root.
3. Keep the Pages project's current build settings unchanged unless its output directory is not the repository root.
4. Commit/push to the production branch. Pages will create a new deployment.
5. Open `https://staralgo.pages.dev/api/health`. A successful response looks like `{"ok":true,"service":"StarAlgo API",...}`.

Do not paste the API code into the D1 Console. D1 Console is only for SQL. Do not deploy `functions/` by dashboard Direct Upload; use the Git-connected Pages deployment.

## Notes

- The old localStorage demo accounts are not migrated into D1.
- The first user account starts with the normal user role. The site owner role must be granted server-side in D1 after registering the owner's account.
- No local server is required for production. The site, API, and database all run on Cloudflare.
