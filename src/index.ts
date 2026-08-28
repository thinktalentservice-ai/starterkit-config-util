/**
 * The zero-dependency entry.
 *
 * Everything exported here is pure JavaScript with no peer dependency, so a
 * server file, a build script or a route that only wants `parseBoolean` can
 * import it without pulling `jose`, `secure-ls` or the crypto utilities into
 * that bundle. The four things that DO need a peer live behind their own
 * subpath: ./env-json, ./storage, ./fetch, ./payload.
 */

export { normalizeOrigin } from "./origin.js";

export { parseBoolean, getEnvBoolean, parseNumber } from "./env-boolean.js";

export { createAppConfig } from "./app-config.js";
export type { CreateAppConfigOptions } from "./app-config.js";

export {
  setConfigSource,
  clearConfigSource,
  hasConfigSource,
  getConfig,
  requiredConfigKeys,
  resolvedOptions,
  DEFAULT_CONFIG_KEYS,
} from "./config-source.js";
export type {
  AppConfigLike,
  ConfigKeyMap,
  ConfigSourceOptions,
  UnauthorizedHandler,
} from "./config-source.js";
