// Standalone Worker entrypoint for the existing StarAlgo API.
// Keep the API implementation in one place so Pages and Workers stay in sync.
import apiWorker from './functions/api/_handler.js';

export default apiWorker;

// Run retention cleanup once daily instead of on every bootstrap request.
export async function scheduled(controller, env, ctx) {
  ctx.waitUntil(
    env.DB.prepare('DELETE FROM projects WHERE deleted_at IS NOT NULL AND deleted_at < ?')
      .bind(Date.now() - 180 * 86400000)
      .run()
  );
}
