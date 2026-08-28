import {
  classifyError,
  decompressFflate,
  FetchUtils,
  UnauthorizedError,
} from "@devopsthink/react-security-util";

import { getEnvBoolean } from "./env-boolean.js";
import {
  getConfig as registryGetConfig,
  resolvedOptions,
  type AppConfigLike,
  type ConfigKeyMap,
  type UnauthorizedHandler,
} from "./config-source.js";
import ApiUtils, { type ApiUtilsInstance } from "./storage.js";

/**
 * The authenticated fetch layer, as the union of the two apps it came from.
 *
 * Three helpers here DELIBERATELY BYPASS `authFetch`, and the reason is the same
 * each time: authFetch's 401 boundary clears the bearer token and replaces the
 * location with the OAuth logout endpoint. That is correct for a real API call by
 * a signed-in user, and catastrophic for anything else.
 *
 * It shipped wrong once, exactly like this: a briefing page's connection check
 * called /actuator/health through getJSON, the gateway answered 401, and a
 * candidate pressing Start on their emailed link was logged out by a health
 * check.
 */

export interface RequestOptions extends Omit<RequestInit, "signal"> {
  /** Milliseconds. Composed with `signal` via AbortSignal.any, never replacing it. */
  timeout?: number | undefined;
  signal?: AbortSignal | null | undefined;
}

export interface CreateFetchHelpersOptions {
  /** Where to read config from. Defaults to the registry set by `setConfigSource`. */
  getConfig?: (() => AppConfigLike) | undefined;
  /** Override the config key names. Falls back to the registry's, then the defaults. */
  keys?: Partial<ConfigKeyMap> | undefined;
  /** Storage accessor to use. Defaults to the package's registry-bound ApiUtils. */
  apiUtils?: ApiUtilsInstance | undefined;
  /** sessionStorage key that forces decompression on for one tab. */
  decompressOverrideKey?: string | undefined;
  /** What to do on a 401. Defaults to clear-token + redirect to OAuth logout. */
  onUnauthorized?: UnauthorizedHandler | undefined;
  /**
   * When the decompression flag is ON, still decompress a response whose ONLY
   * key is `payload`. Default true (template-starterkit-nextjs);
   * nextv3-ai-interview-react passes false. See ConfigSourceOptions for the
   * measured per-environment values that make this a live fork rather than the
   * dead code an earlier draft claimed.
   */
  payloadOnlyDecompress?: boolean | undefined;
}

export interface FetchHelpers {
  getToken: () => unknown;
  authHeaders: (contentType?: string | null) => Headers;
  authFetch: (url: string, options?: RequestOptions) => Promise<unknown>;
  probeFetch: (url: string, options?: RequestOptions) => Promise<{ reached: true; status: number }>;
  getJSON: (url: string, options?: RequestOptions) => Promise<unknown>;
  getBlob: (url: string, options?: RequestOptions) => Promise<Blob>;
  postJSON: (url: string, body?: unknown, options?: RequestOptions) => Promise<unknown>;
  putJSON: (url: string, body?: unknown, options?: RequestOptions) => Promise<unknown>;
  deleteJSON: (url: string, options?: RequestOptions) => Promise<unknown>;
  postFormData: (url: string, formData: FormData, options?: RequestOptions) => Promise<unknown>;
  postBinary: (url: string, body?: unknown, options?: RequestOptions) => Promise<ArrayBuffer>;
}

function resolveKeys(options: CreateFetchHelpersOptions): ConfigKeyMap {
  return { ...resolvedOptions().keys, ...(options.keys ?? {}) };
}

/**
 * The per-tab decompression escape hatch.
 *
 * The `typeof` guard is not decoration. template-starterkit-nextjs reads
 * `sessionStorage.getItem(...)` bare, which is a ReferenceError rather than a
 * falsy value anywhere the module is evaluated outside a browser. It is not
 * reached during that app's prerender today -- it is one import away from being.
 */
function decompressOverride(options: CreateFetchHelpersOptions): string | null {
  if (typeof sessionStorage === "undefined") return null;
  const key = options.decompressOverrideKey ?? resolvedOptions().decompressOverrideKey;
  try {
    return sessionStorage.getItem(key);
  } catch {
    /* Safari in private mode, and any browser with site data blocked, throws on
       access rather than returning null. A storage failure must not decide how
       responses are parsed. */
    return null;
  }
}

export function createFetchHelpers(options: CreateFetchHelpersOptions = {}): FetchHelpers {
  const storage = options.apiUtils ?? ApiUtils;
  const cfg = (): AppConfigLike => (options.getConfig ?? registryGetConfig)();

  const getToken = (): unknown => storage.getCookie("accessToken");
  const clearToken = (): void => storage.setCookie("accessToken", "");

  function shouldDecompress(): boolean {
    const keys = resolveKeys(options);
    return getEnvBoolean(cfg()[keys.responseDecompress], decompressOverride(options));
  }

  function handleUnauthorized(): void {
    const keys = resolveKeys(options);
    const config = cfg();
    const handler = options.onUnauthorized ?? resolvedOptions().onUnauthorized;
    if (handler) {
      handler(config, keys);
      return;
    }
    /* The default, identical in both apps today: clear the dead bearer token and
       bounce through oauth-service's logout.
       NOT a static /error/401 page -- that leaves the dead token in storage, so
       every subsequent navigation 401s again with no way out but clearing site
       data by hand. */
    clearToken();
    globalThis.location.replace(`${String(config[keys.oauthServiceUrl])}/logout?USER_TYPE=USER`);
  }

  const authHeaders = (contentType: string | null = "application/json"): Headers => {
    const headers: Record<string, string> = {};
    if (contentType) headers["Content-Type"] = contentType;
    const token = getToken();
    if (token) headers["Authorization"] = `Bearer ${String(token)}`;
    if (shouldDecompress()) headers["X-Decompress"] = "true";
    return new Headers(headers);
  };

  /*
   * AbortSignal.timeout() (Baseline 2024) rather than a manual AbortController +
   * setTimeout, and AbortSignal.any() to combine it with a caller-supplied
   * signal -- assigning one over the other is how a caller's cancellation
   * silently stops working when a timeout is added later.
   */
  const authFetch = async (url: string, init: RequestOptions = {}): Promise<unknown> => {
    const { timeout, signal, ...fetchOptions } = init;
    const signals = [signal, timeout ? AbortSignal.timeout(timeout) : null].filter(
      Boolean,
    ) as AbortSignal[];
    const requestInit: RequestInit = { ...fetchOptions };
    if (signals.length) {
      requestInit.signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
    }

    try {
      const response = await fetch(url, requestInit);
      const checked = (await FetchUtils.checkStatus(response)) as Record<string, unknown>;

      /*
       * THE ONE LIVE BEHAVIOURAL FORK BETWEEN THE TWO APPS.
       *
       * The branches differ for exactly one input: a response carrying `payload`
       * ALONGSIDE other keys. With payloadOnlyDecompress=true (this repo) such a
       * response is returned untouched and a LONE `payload` is still
       * decompressed; with false (ai-interview) the whole response is returned
       * untouched, on the reasoning that sending X-Decompress means the service
       * already did the work.
       *
       * NOT dead code, which an earlier draft of this asserted and was wrong
       * about: `.env.dev` sets NEXT_PUBLIC_RESPONSE_DECOMPRESS=true, so every
       * local `pnpm dev` and `pnpm build` runs this branch. `.env` sets false
       * and neither `.env.test` nor `.env.think` overrides it, so the deployed
       * builds do not; ai-interview sets the variable nowhere.
       */
      if (shouldDecompress()) {
        const payloadOnly = options.payloadOnlyDecompress ?? resolvedOptions().payloadOnlyDecompress;
        if (payloadOnly && Object.keys(checked).length === 1 && checked["payload"]) {
          return JSON.parse(decompressFflate(checked["payload"] as string) as string);
        }
        return checked;
      }
      if (checked && checked["payload"]) {
        return JSON.parse(decompressFflate(checked["payload"] as string) as string);
      }
      return checked;
    } catch (error) {
      const classified = classifyError(error);
      if (classified instanceof UnauthorizedError) handleUnauthorized();
      throw classified;
    }
  };

  /**
   * A REACHABILITY PROBE THAT CANNOT SIGN ANYONE OUT.
   *
   * Three deliberate differences from authFetch:
   *   - NO Authorization header. Sending a stale token is what turns a probe
   *     into a 401 in the first place.
   *   - NO classifyError, so no UnauthorizedError, so no logout. Ever.
   *   - ANY HTTP RESPONSE COUNTS AS REACHED, 401/403/404/500 included. The
   *     question is "did bytes come back from that host", not "is the endpoint
   *     healthy" -- a protected actuator is a reachable service.
   *
   * Rejects only on a genuine network failure (DNS, TLS, offline, timeout),
   * which is precisely the signal the caller is measuring.
   */
  const probeFetch = async (
    url: string,
    init: RequestOptions = {},
  ): Promise<{ reached: true; status: number }> => {
    const { timeout = 5000, signal: _ignored, ...fetchOptions } = init;
    const response = await fetch(url, {
      method: "GET",
      // A cached 200 measures the disk, not the network.
      cache: "no-store",
      signal: timeout ? AbortSignal.timeout(timeout) : null,
      ...fetchOptions,
    });
    return { reached: true, status: response.status };
  };

  const getJSON = async (url: string, init: RequestOptions = {}): Promise<unknown> =>
    authFetch(url, { method: "GET", headers: authHeaders(), ...init });

  const postJSON = async (
    url: string,
    body?: unknown,
    init: RequestOptions = {},
  ): Promise<unknown> =>
    authFetch(url, {
      method: "POST",
      headers: authHeaders(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      ...init,
    });

  const putJSON = async (
    url: string,
    body: unknown = {},
    init: RequestOptions = {},
  ): Promise<unknown> =>
    authFetch(url, { method: "PUT", headers: authHeaders(), body: JSON.stringify(body), ...init });

  const deleteJSON = async (url: string, init: RequestOptions = {}): Promise<unknown> =>
    authFetch(url, { method: "DELETE", headers: authHeaders(), ...init });

  /*
   * No Content-Type: the browser must set the multipart boundary itself. Passing
   * authHeaders() here would set application/json and the upload would fail
   * server-side with a message about the body, not about the header.
   */
  const postFormData = async (
    url: string,
    formData: FormData,
    init: RequestOptions = {},
  ): Promise<unknown> => {
    const token = getToken();
    const headers = new Headers(token ? { Authorization: `Bearer ${String(token)}` } : {});
    return authFetch(url, { method: "POST", headers, body: formData, ...init });
  };

  /* Binary RESPONSE to a POST (TTS audio). checkStatus parses JSON, so this goes
     straight to the raw response and returns the bytes. */
  const postBinary = async (
    url: string,
    body?: unknown,
    init: RequestOptions = {},
  ): Promise<ArrayBuffer> => {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: authHeaders(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        ...(init as RequestInit),
      });
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      return await response.arrayBuffer();
    } catch (error) {
      throw classifyError(error);
    }
  };

  /*
   * Binary RESPONSE to a GET (a profile photo). The reasoning is probeFetch's
   * rather than postBinary's: "no photo on file" is the normal case for most
   * accounts and the endpoint answers it with an error status. If that status is
   * ever a 401, routing it through authFetch signs the user out over a
   * decorative avatar. A picture is not worth a session.
   *
   * `authHeaders(null)` because there is no request body to describe -- and the
   * header builder still attaches the bearer token, which an <img src> could
   * never send. That is the whole reason this cannot be an <img src>.
   */
  const getBlob = async (url: string, init: RequestOptions = {}): Promise<Blob> => {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: authHeaders(null),
        ...(init as RequestInit),
      });
      return await (FetchUtils.checkResponse(response) as Response).blob();
    } catch (error) {
      throw classifyError(error);
    }
  };

  return {
    getToken,
    authHeaders,
    authFetch,
    probeFetch,
    getJSON,
    getBlob,
    postJSON,
    putJSON,
    deleteJSON,
    postFormData,
    postBinary,
  };
}

const helpers = createFetchHelpers();

export const getToken = helpers.getToken;
export const authHeaders = helpers.authHeaders;
export const authFetch = helpers.authFetch;
export const probeFetch = helpers.probeFetch;
export const getJSON = helpers.getJSON;
export const getBlob = helpers.getBlob;
export const postJSON = helpers.postJSON;
export const putJSON = helpers.putJSON;
export const deleteJSON = helpers.deleteJSON;
export const postFormData = helpers.postFormData;
export const postBinary = helpers.postBinary;
