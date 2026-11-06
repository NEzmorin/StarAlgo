import apiWorker from './_handler.js';

// Route all /api/* requests through the StarAlgo API on this Pages project.
export async function onRequest(context) {
  return apiWorker.fetch(context.request, context.env);
}
