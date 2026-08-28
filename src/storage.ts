import { decodeJwt, SignJWT } from "jose";
import SecureLS from "secure-ls";
import { classifyError, FetchUtils } from "@devopsthink/react-security-util";

import {
  getConfig as registryGetConfig,
  resolvedOptions,
  type AppConfigLike,
  type ConfigKeyMap,
} from "./config-source.js";

/**
 * AES-encrypted browser storage plus the two JWT helpers, as the union of the
 * two apps this was extracted from. Each of them had half of it right.
 *
 * -- THE SECRET IS READ AT CALL TIME. NEVER CAPTURED AT MODULE SCOPE. --------
 *
 * template-starterkit-nextjs re-applies its deployed env.json in the browser by
 * mutating the config object. A `const secret = config.STORAGE_SECRET` at module
 * scope copies the value before that happens, so STORAGE_SECRET would be the one
 * key in the whole app that silently ignores env.json -- with no error and
 * nothing in the DOM to show it. That app's build gate sweeps its own src/ for
 * this shape; it cannot see in here, so the rule is kept by construction and by
 * test instead (see storage.test.ts).
 *
 * nextv3-ai-interview-react DOES capture it (src/api/ApiUtils.jsx:17). Harmless
 * there today only because that app has no env.json layer.
 *
 * -- SECURELS IS CONSTRUCTED LAZILY, AND KEYED ON THE SECRET -----------------
 *
 * `new SecureLS(...)` touches localStorage in its constructor. At module scope
 * that runs during a static-export prerender, on a build machine with no
 * localStorage, so importing ANY controller from a prerendered route would crash
 * the build. Deferring construction to first use moves it into the browser.
 *
 * The `window` guard is not redundant with the laziness: a client component's
 * module still evaluates on the server during prerender, and an accessor called
 * from a component body would run there too. Returning null lets every accessor
 * no-op on the server instead of throwing.
 *
 * Caching keyed on the secret rather than unconditionally is what makes the
 * lazy read above actually mean something: if the env.json overlay changes
 * STORAGE_SECRET after first use, an unconditionally-cached instance would keep
 * using the old one and the lazy read would be decorative.
 *
 * -- THE MISSING-SECRET FAILURE, NAMED --------------------------------------
 *
 * With the secret unset, secure-ls fails every decrypt and every accessor
 * returns null, which presents to every user as "I have been signed out" -- no
 * error, no log, a green build. jose fails later and elsewhere, as
 * `DataError: HMAC key data must not be empty`, a message naming neither the
 * variable nor the file.
 *
 * It cannot be a module-scope throw: that would run during the prerender and
 * fail the build on a machine that legitimately has no secrets. So it is checked
 * at FIRST USE, in the browser, where the value is actually needed.
 */

export interface ApiUtilsInstance {
  checkResponse: typeof FetchUtils.checkResponse;
  checkStatus: typeof FetchUtils.checkStatus;
  classifyError: typeof classifyError;
  queryString: (params: Record<string, unknown>) => string;
  getCookie: (name: string) => unknown;
  setCookie: (name: string, value: unknown) => void;
  getLocalStorage: (name: string) => unknown;
  setLocalStorage: (name: string, value: unknown) => void;
}

export interface CreateApiUtilsOptions {
  /**
   * Where to read config from. Defaults to the registry set by
   * `setConfigSource`. Pass one to get an instance with no global at all.
   */
  getConfig?: (() => AppConfigLike) | undefined;
  /** Override the config key names. Falls back to the registry's, then the defaults. */
  keys?: Partial<ConfigKeyMap> | undefined;
  /**
   * Also write a PLAINTEXT `<name>_raw` copy on setLocalStorage.
   * Falls back to the registry's setting, then to false.
   */
  mirrorRaw?: boolean | undefined;
}

const ALG = "HS256";

function readConfig(options: CreateApiUtilsOptions): AppConfigLike {
  return (options.getConfig ?? registryGetConfig)();
}

function secretKeyName(options: CreateApiUtilsOptions): string {
  return options.keys?.storageSecret ?? resolvedOptions().keys.storageSecret;
}

function readSecret(options: CreateApiUtilsOptions): unknown {
  return readConfig(options)[secretKeyName(options)];
}

function assertSecret(options: CreateApiUtilsOptions): string {
  const keyName = secretKeyName(options);
  const secret = readConfig(options)[keyName];
  if (typeof secret !== "string" || secret === "") {
    throw new Error(
      `${keyName} is not set. Encrypted local storage and JWT signing cannot work without it. ` +
        `Set it in the environment this build loads (commonly NEXT_PUBLIC_${keyName}), ` +
        `or in the env.json the deployment serves.`,
    );
  }
  return secret;
}

export function createApiUtils(options: CreateApiUtilsOptions = {}): ApiUtilsInstance {
  let cached: { secret: string; ls: SecureLS } | null = null;

  function secureStorage(): SecureLS | null {
    if (typeof window === "undefined") return null;
    const secret = assertSecret(options);
    if (!cached || cached.secret !== secret) {
      cached = { secret, ls: new SecureLS({ encodingType: "aes", encryptionSecret: secret }) };
    }
    return cached.ls;
  }

  function mirrorRaw(): boolean {
    return options.mirrorRaw ?? resolvedOptions().mirrorRaw;
  }

  return {
    checkResponse: FetchUtils.checkResponse,
    checkStatus: FetchUtils.checkStatus,
    classifyError,

    /*
     * Kept as a LOCAL implementation rather than FetchUtils.queryString.
     *
     * The two are probably equivalent. "Probably" is not a reason to change the
     * behaviour of live call sites that build search queries against Java
     * services -- swap it later behind a test that proves the outputs match for
     * spaces, `+`, `&`, unicode and nested values.
     */
    queryString(params: Record<string, unknown>): string {
      return Object.entries(params)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
        .join("&");
    },

    /*
     * Returns `null` only on the server or on a decrypt failure. A key that was
     * never written comes back as the EMPTY STRING, because that is what
     * secure-ls returns and `?? null` does not catch it -- `""` is not nullish.
     *
     * Preserved deliberately: both consuming apps already depend on the falsy
     * empty string (`if (token)` in the fetch layer, and a comment in
     * session-brand.js noting that "an empty string has no .client"). Tightening
     * it to null here would be a silent behaviour change across two apps in
     * exchange for tidiness.
     */
    getCookie(name: string): unknown {
      try {
        return secureStorage()?.get(name) ?? null;
      } catch {
        return null;
      }
    },

    setCookie(name: string, value: unknown): void {
      secureStorage()?.set(name, value);
    },

    getLocalStorage(name: string): unknown {
      try {
        return secureStorage()?.get(name) ?? null;
      } catch {
        return null;
      }
    },

    setLocalStorage(name: string, value: unknown): void {
      secureStorage()?.set(name, value);
      if (mirrorRaw() && typeof window !== "undefined") {
        window.localStorage.setItem(`${name}_raw`, JSON.stringify(value));
      }
    },
  };
}

/** Sign an object as a JWT with the app's storage secret. */
export async function encodeJwtString(
  jsonObject: Record<string, unknown>,
  options: CreateApiUtilsOptions = {},
): Promise<string> {
  const secret = assertSecret(options);
  /*
   * `Uint8Array.from(...)` around the encode, and it is not superstition.
   *
   * jose checks its key with `instanceof Uint8Array`, which is per-REALM. Under
   * jsdom -- the environment every consuming app runs its unit tests in -- the
   * global TextEncoder belongs to the jsdom realm while jose resolves the Node
   * realm's Uint8Array, so a perfectly good key is rejected with
   * "Received an instance of Uint8Array", a message that reads like a bug in
   * jose. Re-wrapping here allocates one short array and makes the function
   * work in every consumer's test environment as well as in a browser.
   */
  const key = Uint8Array.from(new TextEncoder().encode(secret));
  return await new SignJWT(jsonObject).setProtectedHeader({ alg: ALG }).sign(key);
}

/** Decode a JWT WITHOUT verifying it. Same semantics as jose's `decodeJwt`. */
export function decodeJwtString(token: string): ReturnType<typeof decodeJwt> {
  return decodeJwt(token);
}

/** Test seam: is a usable secret currently readable? Never throws. */
export function hasStorageSecret(options: CreateApiUtilsOptions = {}): boolean {
  try {
    const secret = readSecret(options);
    return typeof secret === "string" && secret !== "";
  } catch {
    return false;
  }
}

/**
 * The default instance, bound to the registry.
 *
 * Created at module scope, which is safe because `createApiUtils` does no work
 * until an accessor is called -- it reads config, the key map and `mirrorRaw`
 * lazily, so this being constructed before `setConfigSource` runs is fine.
 */
const ApiUtils: ApiUtilsInstance = createApiUtils();

export default ApiUtils;
