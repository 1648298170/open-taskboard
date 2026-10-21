// Public API of @taskboard/server (package entrypoint).
export { buildApp } from './app.js';
export type { ServerOptions } from './app.js';
export { startServer, lanUrls } from './server.js';
export {
  startEmbeddedWake, resolveWakePollMs, wakeEmbeddedEnabled,
  WAKE_POLL_DEFAULT_MS, WAKE_POLL_MIN_MS
} from './wake-embedded.js';
export type { EmbeddedWake, EmbeddedWakeOptions, WakeEmbeddedOverrides } from './wake-embedded.js';
