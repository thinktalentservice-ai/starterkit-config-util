# API Reference

Every export, grouped by entry point. Types are TypeScript, but the package is usable from plain JS.

- [`.` — zero-peer entry](#entry--)
- [`./env-json`](#entry-env-json)
- [`./storage`](#entry-storage)
- [`./fetch`](#entry-fetch)
- [`./payload`](#entry-payload)

---

## Entry: `.`

`import { … } from "@devopsnext/starterkit-config-util"` — **pulls no peer dependency.**

### `createAppConfig(options)`

```ts
function createAppConfig<TBase, TEnv, TOverrides>(options: {
  base: TBase;
  envs: Record<string, TEnv>;
  appEnv: string | undefined;
  overrides?: TOverrides;
}): TBase & TEnv & Partial<TOverrides>;
```

Resolves `{ ...base, ...envs[appEnv], ...overrides }`.

| Param | Notes |
|---|---|
| `base` | keys present in every environment — usually `env.base.js`'s default export |
| `envs` | environment name → config object. **Build from static imports and an object literal.** |
| `appEnv` | typically `process.env.NEXT_PUBLIC_APP_ENV \|\| "dev"` |
| `overrides` | runtime layer (decoded `env.json`). Applied **last**. Optional. |

**Throws** when `appEnv` is not a non-empty string, or when `Object.hasOwn(envs, appEnv)` is false. Both errors name the known environments. It uses `Object.hasOwn` rather than `envs[appEnv]` — see [[Architecture#createappconfig-two-defects-it-exists-to-kill]].

```js
const config = createAppConfig({
  base: baseEnv,
  envs: { dev: devEnv, think: thinkEnv },
  appEnv: process.env.NEXT_PUBLIC_APP_ENV || "dev",
  overrides: envJsonSnapshot.overrides,
});
```

---

### `setConfigSource(config, options?)`

```ts
function setConfigSource(config: AppConfigLike, options?: ConfigSourceOptions): void;
```

Wire the package to your config **object**. Call once, at module scope, in the module that builds it.

`ConfigSourceOptions` — all optional, every default is `template-starterkit-nextjs`'s current behaviour:

| Option | Type | Default | Meaning |
|---|---|---|---|
| `keys` | `Partial<ConfigKeyMap>` | `DEFAULT_CONFIG_KEYS` | remap the config key names the package reads |
| `mirrorRaw` | `boolean` | `false` | also write a **plaintext** `"<key>_raw"` copy on every `setLocalStorage` |
| `decompressOverrideKey` | `string` | `keys.responseDecompress` | sessionStorage key that forces decompression on for one tab |
| `onUnauthorized` | `(config, keys) => void` | clear token + OAuth logout | what happens on a 401 |
| `payloadOnlyDecompress` | `boolean` | `true` | see [[Auth Fetch#the-one-live-fork]] |

**Unknown options throw.** A typo'd `mirrorRaw` would silently revert to a default — a plaintext copy that stops (or starts) being written with nothing to say so. The flat-vs-nested slip (`{ storageSecret }` instead of `{ keys: { storageSecret } }`) is named explicitly in the error.

Passing anything that is not an object also throws, with a message explaining that a snapshot of values would defeat the runtime overlay.

```js
setConfigSource(config, {
  keys: { storageSecret: "STORAGE_SECRET" },
  mirrorRaw: true,
  payloadOnlyDecompress: false,
  onUnauthorized: (cfg, keys) => { window.location.href = "/signed-out"; },
});
```

---

### `getConfig()`

```ts
function getConfig(): AppConfigLike;
```

Returns the **live** config object — the same reference you passed in, so a later `Object.assign(config, overrides)` is visible.

**Throws a named error when nothing has been wired.** Do not defeat it by capturing values at module scope.

### `hasConfigSource()`

```ts
function hasConfigSource(): boolean;
```

For a consumer that wants to degrade rather than throw.

### `clearConfigSource()`

```ts
function clearConfigSource(): void;
```

Test seam and teardown. **Not for application code.**

### `requiredConfigKeys()`

```ts
function requiredConfigKeys(): string[];
```

The **resolved** key names after any remap — `[storageSecret, oauthServiceUrl, responseDecompress]`. This is what a build-time env gate should assert your config declares.

### `resolvedOptions()`

```ts
function resolvedOptions(): Readonly<{
  keys: ConfigKeyMap;
  mirrorRaw: boolean;
  decompressOverrideKey: string;
  onUnauthorized: UnauthorizedHandler | null;
  payloadOnlyDecompress: boolean;
}>;
```

Internal seam used by `./storage` and `./fetch`. Useful for debugging what the registry actually resolved.

### `DEFAULT_CONFIG_KEYS`

```ts
const DEFAULT_CONFIG_KEYS: Readonly<{
  storageSecret: "STORAGE_SECRET";
  oauthServiceUrl: "OAUTH_SERVICE_URL";
  responseDecompress: "RESPONSE_DECOMPRESS";
}>;
```

Frozen.

### Types

`AppConfigLike` = `Record<string, unknown>` · `ConfigKeyMap` · `ConfigSourceOptions` · `UnauthorizedHandler` · `CreateAppConfigOptions`.

---

### `normalizeOrigin(value?, fallback?)`

```ts
function normalizeOrigin(value?: string | null, fallback = ""): string;
```

Strips trailing slashes from a service-gateway origin. Three cases, and the middle one is the point:

```js
normalizeOrigin(undefined, fb)   // → fb        env var not set at all
normalizeOrigin(null, fb)        // → fb        folded in with undefined
normalizeOrigin("", fb)          // → ""        env var set to empty ON PURPOSE
normalizeOrigin("https://h/")    // → "https://h"
normalizeOrigin("https://h///")  // → "https://h"
```

`NEXT_PUBLIC_SERVICE_URL=` in a `.env` file means "serve me root-relative URLs" — how a static export gets served from a second domain without hard-targeting the first. A naive `value || fallback` collapses that into the fallback and silently re-targets every API call at the build's default host. This mirrors a JavaScript default parameter, which also applies only to `undefined`.

---

### `parseBoolean(value)`

```ts
function parseBoolean(value: unknown): boolean;
```

Env vars arrive as **strings**, and `"false"` is a non-empty string — therefore truthy. `if (config.SOME_FLAG)` is `true` for a flag that was explicitly turned off. Every consumer hit that.

| Input | Result |
|---|---|
| `true` | `true` |
| `"true"`, `"1"`, `"yes"`, `"on"` (any case, trimmed) | `true` |
| `false`, `"false"`, `"0"`, `"no"`, `""`, `null`, `undefined`, anything else | `false` |

### `getEnvBoolean(buildValue, sessionValue)`

```ts
function getEnvBoolean(buildValue: unknown, sessionValue: unknown): boolean;
```

Build-time value plus a runtime override, where **only an explicit affirmative counts on either side**:

```js
getEnvBoolean(buildValue) || …   // conceptually: parseBoolean(session) || parseBoolean(build)
```

The override wins when affirmative and is otherwise ignored — so a `sessionStorage` key left over as `"false"` cannot turn **off** a flag the build turned on. That asymmetry is deliberate; do not "simplify" it to `sessionValue ?? buildValue`.

### `parseNumber(value, fallback?)`

```ts
function parseNumber(value: unknown, fallback = 0): number;
```

Uses `Number.isFinite`, not `!isNaN`: `Number("Infinity")` is `Infinity`, which is not a usable timeout. `"50"` → `50`; `"abc"` → `fallback`; `"Infinity"` → `fallback`.

---

## Entry: `./env-json`

`import { decodeEnvJson, unknownKeys } from "@devopsnext/starterkit-config-util/env-json"`
Peer: `@devopsthink/react-security-util`.

### `decodeEnvJson(text)`

```ts
function decodeEnvJson(text: string): { overrides: Record<string, unknown>; keys: string[] };
```

Raw `env.json` text → decoded overrides, **keys verbatim**. There is no camelCase mapping table and there never will be — a key in `env.json` *is* the config key.

Accepts either shape the pipeline serves:

| Field | Handling |
|---|---|
| `configEnv` (AES blob) | preferred — decrypted via `CryptoEncryption` |
| `envVariables` (plaintext object) | fallback, used only when `configEnv` is absent/empty |

`undefined` values are dropped (so "env.json set this key" stays true of every key that survives); `null` is kept — an operator can mean it.

**Throws** on: invalid JSON, a non-object, neither field present, a blob that does not decrypt, a blob that decrypts to non-JSON or to a non-object. A silent `{}` would be indistinguishable from "env.json legitimately overrides nothing". Callers decide: a build script should fail, a browser should log and keep the baked values.

> ⚠️ **The blob is obfuscated, not secret.** The encryption key ships inside `@devopsthink/react-security-util`, which ships to the browser. Anyone with the bundle can read `env.json`. Nothing confidential may go in it.

### `unknownKeys(overrides, declared)`

```ts
function unknownKeys(overrides: Record<string, unknown>, declared: Set<string>): string[];
```

Keys `env.json` sets that your config does not declare. **A warning, never an error.** The usual cause is a payload still written in a Vite app's dialect (`REACT_APP_idleTime` rather than `IDLE_TIME`): it applies cleanly and is read by nothing.

```js
const { overrides, keys } = decodeEnvJson(text);
const stray = unknownKeys(overrides, new Set(Object.keys(baseEnv)));
if (stray.length) console.warn("env.json sets undeclared keys:", stray);
```

---

## Entry: `./storage`

`import ApiUtils, { createApiUtils, encodeJwtString, decodeJwtString } from "@devopsnext/starterkit-config-util/storage"`
Peers: `jose`, `secure-ls`, `@devopsthink/react-security-util`.

### `ApiUtils` (default export)

A ready instance bound to the registry. Safe at module scope — `createApiUtils` does no work until an accessor is called.

| Member | Signature | Notes |
|---|---|---|
| `getLocalStorage(name)` | `(string) => unknown` | decrypted read; `null` on server or decrypt failure |
| `setLocalStorage(name, value)` | `(string, unknown) => void` | encrypted write (+ `<name>_raw` if `mirrorRaw`) |
| `getCookie(name)` | `(string) => unknown` | same storage as above, kept for call-site compatibility |
| `setCookie(name, value)` | `(string, unknown) => void` | same |
| `queryString(params)` | `(Record<string, unknown>) => string` | local implementation, deliberately not `FetchUtils.queryString` |
| `checkResponse` / `checkStatus` | re-exported from react-security-util | |
| `classifyError` | re-exported from react-security-util | |

**Return-value subtlety:** a key that was never written comes back as the **empty string**, because that is what secure-ls returns and `?? null` does not catch it (`""` is not nullish). Both consuming apps already depend on that falsy empty string. Do not "tighten" it.

All writes and reads no-op on the server (`typeof window === "undefined"`).

### `createApiUtils(options?)`

```ts
function createApiUtils(options?: {
  getConfig?: () => AppConfigLike;   // default: the registry
  keys?: Partial<ConfigKeyMap>;      // default: registry's, then DEFAULT_CONFIG_KEYS
  mirrorRaw?: boolean;               // default: registry's, then false
}): ApiUtilsInstance;
```

For a consumer that wants **no module state at all**:

```js
const ApiUtils = createApiUtils({ getConfig: () => config });
```

### `encodeJwtString(obj, options?)`

```ts
function encodeJwtString(obj: Record<string, unknown>, options?: CreateApiUtilsOptions): Promise<string>;
```

Signs with HS256 using the storage secret. Throws a named error if the secret is unset or empty.

> The implementation re-wraps the key with `Uint8Array.from(...)`. jose checks its key with `instanceof Uint8Array`, which is **per-realm**: under jsdom the global `TextEncoder` belongs to the jsdom realm while jose resolves Node's `Uint8Array`, so a perfectly good key is rejected with a message that reads like a bug in jose.

### `decodeJwtString(token)`

```ts
function decodeJwtString(token: string): JWTPayload;
```

Decodes **without verifying** — same semantics as jose's `decodeJwt`.

### `hasStorageSecret(options?)`

```ts
function hasStorageSecret(options?: CreateApiUtilsOptions): boolean;
```

Test seam: is a usable secret currently readable? Never throws.

---

## Entry: `./fetch`

`import { getJSON, postJSON, … } from "@devopsnext/starterkit-config-util/fetch"`
Peers: via `./storage`.

Every helper is exported both as a bound function (registry-backed) and via the `createFetchHelpers` factory. Full behavioural detail: [[Auth Fetch]].

| Function | Signature | 401 boundary |
|---|---|---|
| `authFetch(url, options?)` | `=> Promise<unknown>` | **yes** |
| `getJSON(url, options?)` | `=> Promise<unknown>` | yes |
| `postJSON(url, body?, options?)` | `=> Promise<unknown>` | yes |
| `putJSON(url, body = {}, options?)` | `=> Promise<unknown>` | yes |
| `deleteJSON(url, options?)` | `=> Promise<unknown>` | yes |
| `postFormData(url, formData, options?)` | `=> Promise<unknown>` | yes |
| `probeFetch(url, options?)` | `=> Promise<{ reached: true; status: number }>` | **no — by design** |
| `getBlob(url, options?)` | `=> Promise<Blob>` | **no — by design** |
| `postBinary(url, body?, options?)` | `=> Promise<ArrayBuffer>` | **no — by design** |
| `authHeaders(contentType = "application/json")` | `=> Headers` | n/a |
| `getToken()` | `=> unknown` | n/a |

### `RequestOptions`

```ts
interface RequestOptions extends Omit<RequestInit, "signal"> {
  timeout?: number;                    // milliseconds
  signal?: AbortSignal | null;
}
```

`timeout` is composed with your `signal` via `AbortSignal.any` — never assigned over it. That is how a caller's cancellation silently stops working when someone later adds a timeout.

### `createFetchHelpers(options?)`

```ts
function createFetchHelpers(options?: {
  getConfig?: () => AppConfigLike;
  keys?: Partial<ConfigKeyMap>;
  apiUtils?: ApiUtilsInstance;
  decompressOverrideKey?: string;
  onUnauthorized?: UnauthorizedHandler;
  payloadOnlyDecompress?: boolean;
}): FetchHelpers;
```

```js
const api = createFetchHelpers({ getConfig: () => config, apiUtils: ApiUtils });
```

---

## Entry: `./payload`

### `buildCompressedPayload(obj)`

```ts
function buildCompressedPayload(obj: unknown): string;
```

Returns an **already-stringified** request body: `{"payload":"<fflate base64>"}`. The double stringify is not redundant — the inner one produces the bytes that get compressed, the outer one produces the request body. The Java services expect exactly that shape.

```js
await postJSON(url, undefined, { body: buildCompressedPayload({ answers }) });
// or
await authFetch(url, { method: "POST", headers: authHeaders(), body: buildCompressedPayload(data) });
```

It returns a string rather than an object because that is what the call sites pass straight to `fetch`'s `body` — returning the object would let one of them forget to stringify.
