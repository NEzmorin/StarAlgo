// StarAlgo API is hosted on the Cloudflare Worker.
// The Vercel frontend sends all /api/* requests to this Worker.
(() => {
  window.STARALGO_API_BASE = 'https://staralgo-api.nezmorin-official.workers.dev';
})();
