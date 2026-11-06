// Standalone Worker entrypoint for the existing StarAlgo API.
// Keep the API implementation in one place so Pages and Workers stay in sync.
import apiWorker from './functions/api/_handler.js';

export default apiWorker;
