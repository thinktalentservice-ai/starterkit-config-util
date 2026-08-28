/**
 * The config registry: one wiring call from the host, then every read in this
 * package happens THROUGH it, AT CALL TIME.
 *
 * -- WHY A REFERENCE AND NEVER A COPY ----------------------------------------
 *
 * template-starterkit-nextjs re-applies its deployed `env.json` in the browser by
 * doing `Object.assign(config, overrides)` on the SAME object every module
 * imported. That reaches all ~27 consumers with no provider and no rewrite --
 * but ONLY because nothing anywhere copies a config value at module scope. Its
 * build gate (scripts/env-json-snapshot.mjs) sweeps src/ for exactly that shape
 * and fails the build on it.
 *
 * That sweep cannot see into node_modules. So the rule is enforced here instead,
 * by construction and by test: `setConfigSource` stores the OBJECT, `getConfig`
 * returns it, and every consumer reads `getConfig().SOME_KEY` inside the function
 * that needs it. A captured `const secret = getConfig().STORAGE_SECRET` at module
 * scope would be the one value in the app that silently ignores env.json.
 *
 * nextv3-ai-interview-react has exactly that bug today
 * (`const secret = appConfig.STORAGE_SECRET`, src/api/ApiUtils.jsx:17). It is
 * harmless there only because that app has no env.json layer -- which is
 * precisely the kind of "safe until someone adds a feature" that a shared
 * package should not preserve.
 *
 * -- WHY globalThis AND NOT A MODULE-LEVEL let -------------------------------
 *
 * Any module holding MUTABLE STATE that can be bundled or resolved twice has a
 * duplicate-instance hazard: the host wires one copy, the code that matters
 * reads the other, `getConfig()` throws or returns an empty config, and the
 * build stays green. Three separate mechanisms can produce that duplicate --
 * a dual ESM/CJS build (tsup does not code-split CJS, so every subpath entry
 * inlines its own copy), `splitting: false`, and a consumer resolving both
 * conditions in different graphs.
 *
 * The build defends against all three (ESM-only, `splitting: true`, both
 * asserted by scripts/check-dist.mjs). This is the belt to that pair of braces:
 * `Symbol.for` is registered in a cross-realm global symbol registry, so even
 * two genuinely separate instances of this module resolve the same key and
 * share one object. It costs a property lookup and removes a whole class of
 * failure that no consumer could diagnose.
 */

export type AppConfigLike = Record<string, unknown>;

/**
 * Which config KEY holds each thing this package needs.
 *
 * Both current consumers use these exact names, so the map is future-proofing
 * rather than speculation -- but it is three lines, and the alternative is a
 * consumer having to rename a key across its whole app in order to adopt this.
 */
export interface ConfigKeyMap {
  storageSecret: string;
  oauthServiceUrl: string;
  responseDecompress: string;
}

export const DEFAULT_CONFIG_KEYS: ConfigKeyMap = Object.freeze({
  storageSecret: "STORAGE_SECRET",
  oauthServiceUrl: "OAUTH_SERVICE_URL",
  responseDecompress: "RESPONSE_DECOMPRESS",
});

export type UnauthorizedHandler = (config: AppConfigLike, keys: ConfigKeyMap) => void;

export interface ConfigSourceOptions {
  /** Remap the config key names this package reads. Defaults to DEFAULT_CONFIG_KEYS. */
  keys?: Partial<ConfigKeyMap> | undefined;
  /**
   * Also write a PLAINTEXT "<key>_raw" copy alongside every encrypted
   * setLocalStorage value. Default false.
   *
   * template-starterkit-nextjs does this and its debug tooling
   * (scripts/dev-debug/login.mjs) reads those mirrors, so it opts in to keep
   * behaviour byte-identical. It is off by default because writing a decrypted
   * copy of userInfo next to the encrypted one is the exact thing secure-ls
   * exists to prevent.
   */
  mirrorRaw?: boolean | undefined;
  /**
   * sessionStorage key that can force the response-decompression branch on for
   * one browser tab. Default "RESPONSE_DECOMPRESS"; nextv3-ai-interview-react
   * uses "VITE_RESPONSE_DECOMPRESS", left over from its Vite build.
   */
  decompressOverrideKey?: string | undefined;
  /**
   * What to do when an authenticated request comes back 401. Default: clear the
   * token and redirect to the OAuth logout endpoint, which is what both current
   * consumers do.
   */
  onUnauthorized?: UnauthorizedHandler | undefined;
  /**
   * The one place the two consuming apps genuinely DISAGREE about behaviour.
   *
   * When the decompression flag is on, the client sends `X-Decompress` and the
   * service is supposed to answer uncompressed -- so there should be nothing to
   * decompress. template-starterkit-nextjs nevertheless still decompresses a
   * response whose ONLY key is `payload`; nextv3-ai-interview-react returns it
   * untouched. They differ for exactly one input: a response carrying `payload`
   * ALONGSIDE other keys.
   *
   * `true` (default) is this repo's shape. It is a real fork and not, as an
   * earlier draft of this claimed, dead code on both sides: `.env.dev` sets
   * NEXT_PUBLIC_RESPONSE_DECOMPRESS=true, so every local `pnpm dev` and
   * `pnpm build` takes the branch. (`.env` sets false and neither `.env.test`
   * nor `.env.think` overrides it, so test and think are off; ai-interview sets
   * it nowhere.) An option, not a hardcoded superset, because a live divergence
   * documented away in a comment is how the two copies drifted to begin with.
   */
  payloadOnlyDecompress?: boolean | undefined;
}

/**
 * Every legal top-level option key.
 *
 * `setConfigSource` REJECTS anything else rather than ignoring it. A typo'd
 * `mirrorRaw` silently reverts to the default, which is a plaintext copy that
 * stops being written or starts being written with nothing to say so -- exactly
 * the class of silent misconfiguration this whole package exists to stop.
 */
const KNOWN_OPTIONS = [
  "keys",
  "mirrorRaw",
  "decompressOverrideKey",
  "onUnauthorized",
  "payloadOnlyDecompress",
] as const;

const KNOWN_KEY_NAMES = ["storageSecret", "oauthServiceUrl", "responseDecompress"] as const;

interface Registry {
  config: AppConfigLike | null;
  keys: ConfigKeyMap;
  mirrorRaw: boolean;
  decompressOverrideKey: string;
  onUnauthorized: UnauthorizedHandler | null;
  payloadOnlyDecompress: boolean;
}

const REGISTRY_KEY = Symbol.for("@devopsnext/starterkit-config-util/registry");

function registry(): Registry {
  const store = globalThis as unknown as Record<symbol, Registry | undefined>;
  let reg = store[REGISTRY_KEY];
  if (!reg) {
    reg = {
      config: null,
      keys: { ...DEFAULT_CONFIG_KEYS },
      mirrorRaw: false,
      decompressOverrideKey: DEFAULT_CONFIG_KEYS.responseDecompress,
      onUnauthorized: null,
      payloadOnlyDecompress: true,
    };
    store[REGISTRY_KEY] = reg;
  }
  return reg;
}

/**
 * Wire the package to the app's config object. Call this ONCE, at module scope
 * in the app's own config module, immediately after building the object.
 *
 * Pass the OBJECT, not a snapshot of its values.
 */
export function setConfigSource(config: AppConfigLike, options: ConfigSourceOptions = {}): void {
  if (config === null || typeof config !== "object") {
    throw new Error(
      "setConfigSource: expected the app config OBJECT, received " +
        (config === null ? "null" : typeof config) +
        ". This package holds the reference so that a runtime overlay (Object.assign on the " +
        "same object) reaches it; a snapshot of values would defeat that.",
    );
  }

  const unknown = Object.keys(options).filter(
    (k) => !(KNOWN_OPTIONS as readonly string[]).includes(k),
  );
  if (unknown.length) {
    throw new Error(
      `setConfigSource: unknown option(s) ${unknown.join(", ")}. ` +
        `Known options: ${KNOWN_OPTIONS.join(", ")}. ` +
        `Rejected rather than ignored, because a typo'd option silently reverts to a default.`,
    );
  }

  const unknownKeyNames = Object.keys(options.keys ?? {}).filter(
    (k) => !(KNOWN_KEY_NAMES as readonly string[]).includes(k),
  );
  if (unknownKeyNames.length) {
    throw new Error(
      `setConfigSource: unknown entry(ies) in \`keys\`: ${unknownKeyNames.join(", ")}. ` +
        `Known: ${KNOWN_KEY_NAMES.join(", ")}. ` +
        `Note the shape is setConfigSource(config, { keys: { storageSecret: "..." } }), ` +
        `not setConfigSource(config, { storageSecret: "..." }).`,
    );
  }

  const reg = registry();
  reg.config = config;
  reg.keys = { ...DEFAULT_CONFIG_KEYS, ...(options.keys ?? {}) };
  reg.mirrorRaw = options.mirrorRaw ?? false;
  reg.decompressOverrideKey = options.decompressOverrideKey ?? reg.keys.responseDecompress;
  reg.onUnauthorized = options.onUnauthorized ?? null;
  reg.payloadOnlyDecompress = options.payloadOnlyDecompress ?? true;
}

/** Test seam and teardown. Not for application code. */
export function clearConfigSource(): void {
  const reg = registry();
  reg.config = null;
  reg.keys = { ...DEFAULT_CONFIG_KEYS };
  reg.mirrorRaw = false;
  reg.decompressOverrideKey = DEFAULT_CONFIG_KEYS.responseDecompress;
  reg.onUnauthorized = null;
  reg.payloadOnlyDecompress = true;
}

/** Has the host wired the package yet? For a consumer that wants to degrade rather than throw. */
export function hasConfigSource(): boolean {
  return registry().config !== null;
}

/**
 * The live config object.
 *
 * THROWS, LOUDLY, WHEN UNSET -- and that is the entire design.
 *
 * The alternative failure is silence: an undefined encryption secret makes
 * secure-ls fail every decrypt, every accessor returns null, and the app looks
 * to every user exactly as though they were signed out. No error, no log, a
 * green build. A named throw at first use costs one stack trace and saves that.
 */
export function getConfig(): AppConfigLike {
  const reg = registry();
  if (!reg.config) {
    throw new Error(
      "@devopsnext/starterkit-config-util: no config source is set. Call " +
        "setConfigSource(config) once, at module scope, in the module that builds your app " +
        "config (e.g. src/config/index.js) -- and make sure that module is imported before " +
        "anything reads from this package.",
    );
  }
  return reg.config;
}

/** The RESOLVED key names, after any remap. What a host gate should assert its config declares. */
export function requiredConfigKeys(): string[] {
  const { keys } = registry();
  return [keys.storageSecret, keys.oauthServiceUrl, keys.responseDecompress];
}

/** Internal: the resolved options, for the storage and fetch entries. */
export function resolvedOptions(): Readonly<Omit<Registry, "config">> {
  const reg = registry();
  return {
    keys: reg.keys,
    mirrorRaw: reg.mirrorRaw,
    decompressOverrideKey: reg.decompressOverrideKey,
    onUnauthorized: reg.onUnauthorized,
    payloadOnlyDecompress: reg.payloadOnlyDecompress,
  };
}
