// Standalone Worker entrypoint for the StarAlgo API.
// Keep the API implementation shared with Pages, but apply Worker-level
// rate limits before expensive API work.
import apiWorker from './functions/api/_handler.js';

const warnedLimiters = new Set();

function rateLimitResponse() {
  return new Response(JSON.stringify({
    error: 'Слишком много запросов. Подождите немного и попробуйте снова.'
  }), {
    status: 429,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'retry-after': '60',
      // Keep rate-limit responses readable for browser clients such as the
      // TurboWarp Scratch embed, which calls this Worker cross-origin.
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,HEAD,POST,PATCH,DELETE,OPTIONS',
      'access-control-allow-headers': 'Content-Type,Authorization'
    }
  });
}

async function withinRateLimit(bindingName, binding, key) {
  // Fail open if a binding is temporarily unavailable: availability is more
  // important than returning errors to every visitor. Log configuration
  // problems once per isolate so an outage cannot amplify log volume.
  if (!binding || typeof binding.limit !== 'function') {
    if (!warnedLimiters.has(bindingName)) {
      warnedLimiters.add(bindingName);
      console.error('[StarAlgo rate limit] Missing binding:', bindingName);
    }
    return true;
  }

  try {
    const result = await binding.limit({ key });
    return result?.success !== false;
  } catch (error) {
    if (!warnedLimiters.has(bindingName)) {
      warnedLimiters.add(bindingName);
      console.error('[StarAlgo rate limit] Binding unavailable:', bindingName, error?.message || error);
    }
    return true;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflights do not execute application/database work and should not
    // consume a visitor's request allowance.
    if (url.pathname.startsWith('/api/') && request.method !== 'OPTIONS') {
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

      // Broad safety net for all API routes exposed on the standalone Worker.
      if (!await withinRateLimit('API_EDGE_LIMITER', env.API_EDGE_LIMITER, ip)) {
        return rateLimitResponse();
      }

      // Password hashing is deliberately isolated behind a stricter limit.
      const isPasswordHeavyPost = request.method === 'POST' && (
        ['/api/auth/login', '/api/auth/register', '/api/auth/change-password'].includes(path) ||
        /^\/api\/(?:admin|singularity)\/users\/[^/]+\/password$/.test(path) ||
        /^\/api\/support\/guest\/[^/]+\/reset-password$/.test(path)
      );
      if (isPasswordHeavyPost &&
          !await withinRateLimit('AUTH_EDGE_LIMITER', env.AUTH_EDGE_LIMITER, ip)) {
        return rateLimitResponse();
      }

      // Google Drive proxy requests can trigger large upstream downloads.
      // Limit both GET and HEAD because HEAD still performs an upstream fetch.
      if (/^\/api\/scratch\/drive\/[A-Za-z0-9_-]{10,100}$/.test(path) &&
          ['GET', 'HEAD'].includes(request.method) &&
          !await withinRateLimit('SCRATCH_PROXY_LIMITER', env.SCRATCH_PROXY_LIMITER, ip)) {
        return rateLimitResponse();
      }
    }

    return apiWorker.fetch(request, env);
  }
};

// Run retention cleanup once daily instead of on every bootstrap request.
export async function scheduled(controller, env, ctx) {
  ctx.waitUntil(
    env.DB.prepare('DELETE FROM projects WHERE deleted_at IS NOT NULL AND deleted_at < ?')
      .bind(Date.now() - 180 * 86400000)
      .run()
  );
}
