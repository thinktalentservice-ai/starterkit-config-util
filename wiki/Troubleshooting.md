# Troubleshooting

Error message → cause → fix. Errors from this package are deliberately verbose; the first line usually names the fix.

## Quick index

| What you see | Jump to |
|---|---|
| `no config source is set` | [#no-config-source-is-set](#no-config-source-is-set) |
| `appEnv="…" has no matching env config` | [#appenv-has-no-matching-env-config](#appenv-has-no-matching-env-config) |
| `unknown option(s) …` | [#setconfigsource-unknown-options](#setconfigsource-unknown-options) |
| `STORAGE_SECRET is not set` | [#storage_secret-is-not-set](#storage_secret-is-not-set) |
| everything reads as signed out, no errors | [#everything-looks-signed-out](#everything-looks-signed-out) |
| users signed out by a health check | [#a-probe-signs-users-out](#a-probe-signs-users-out) |
| `env.json` changes have no effect | [#envjson-changes-do-nothing](#envjson-changes-do-nothing) |
| `localStorage is not defined` during build | [#localstorage-is-not-defined-during-a-build](#localstorage-is-not-defined-during-a-build) |
| `ERR_REQUIRE_ESM` / `Cannot use import statement` | [#err_require_esm](#err_require_esm) |
| `Received an instance of Uint8Array` | [#received-an-instance-of-uint8array](#received-an-instance-of-uint8array) |
| double slashes in service URLs | [#double-slashes-in-urls](#double-slashes-in-urls) |
| a `"false"` flag behaves as on | [#a-false-flag-behaves-as-on](#a-false-flag-behaves-as-on) |
| uploads rejected server-side | [#uploads-rejected-server-side](#uploads-rejected-server-side) |

---

## `no config source is set`

```
@devopsnext/starterkit-config-util: no config source is set. Call setConfigSource(config)
once, at module scope, in the module that builds your app config …
```

**Cause.** Something read from the package before your config module was imported and evaluated.

**Fix.**
1. Confirm `setConfigSource(config)` runs at **module scope**, not inside a component or an effect.
2. Import your config module from an entry point every route reaches (in Next.js: the root layout).
3. In tests, call `setConfigSource` in a `beforeEach` and `clearConfigSource` in `afterEach`.

To degrade instead of throwing:

```js
import { hasConfigSource } from "@devopsnext/starterkit-config-util";
if (!hasConfigSource()) return null;
```

The throw is not a papercut to route around — see [[Architecture#why-getconfig-throws]].

---

## `appEnv="…" has no matching env config`

```
createAppConfig: appEnv="prod" has no matching env config.
Known environments: dev, test, think.
```

**Cause.** A build set an environment name you never registered. Under the old dynamic `require`, this was a runtime white screen instead — one app ran with `NEXT_PUBLIC_APP_ENV=prod` and no `env.prod.js` for months.

**Fix.** Either fix the variable, or create `env.prod.js`, import it **statically**, and add it to the `envs` literal.

Related: `createAppConfig: appEnv is undefined` / `is an empty string` — the variable never reached the build. In Next.js, only `NEXT_PUBLIC_*` variables reach client bundles.

---

## `setConfigSource: unknown option(s) …`

```
setConfigSource: unknown option(s) mirorRaw. Known options: keys, mirrorRaw,
decompressOverrideKey, onUnauthorized, payloadOnlyDecompress.
```

**Cause.** A typo, or the flat-vs-nested slip. Rejected rather than ignored, because a typo'd option silently reverts to a default.

```js
setConfigSource(config, { storageSecret: "X" });           // ❌
setConfigSource(config, { keys: { storageSecret: "X" } }); // ✅
```

Also: `setConfigSource: expected the app config OBJECT, received string` — you passed a value, not the object. The package must hold the reference so a runtime overlay reaches it.

---

## `STORAGE_SECRET is not set`

```
STORAGE_SECRET is not set. Encrypted local storage and JWT signing cannot work without it.
```

**Cause.** The key resolved to something that is not a non-empty string.

**Check, in order.**
1. Is the variable in the `.env` file this build actually loads?
2. Does it have the framework's public prefix (`NEXT_PUBLIC_`) so it reaches the browser?
3. Does `env.base.js` map it onto the config key? `console.log(getConfig().STORAGE_SECRET)`.
4. Did you remap the key name and forget to update the env gate? `requiredConfigKeys()` shows the resolved names.

---

## Everything looks signed out

No errors. Every storage read returns `null`. The user sees a signed-out app with a green build.

**Cause.** Almost always a missing or wrong `STORAGE_SECRET`: secure-ls fails every decrypt, every accessor catches and returns `null`.

**Confirm.**

```js
import { hasStorageSecret } from "@devopsnext/starterkit-config-util/storage";
console.log(hasStorageSecret());        // false → that is your bug
```

**Second cause: the secret changed.** Data encrypted with the old secret can no longer be decrypted. Clear site data for the origin and sign in again.

**Third cause: a duplicated module instance** — the host wired one registry, the storage entry read another. The `Symbol.for` registry and the ESM-only build both exist to prevent it; if you have forced a CJS build or disabled code splitting downstream, undo that.

---

## A probe signs users out

A health check, connectivity test or avatar request 401s and the user is redirected to OAuth logout.

**Cause.** The call went through `getJSON` / `authFetch`, whose 401 boundary clears the token and redirects. Correct for a real API call by a signed-in user, catastrophic for a probe.

**Fix.**

```js
// ❌
await getJSON(`${config.SERVICE_URL}/actuator/health`);
// ✅
const { reached, status } = await probeFetch(`${config.SERVICE_URL}/actuator/health`);
```

Also `getBlob` for images and `postBinary` for binary POST responses. Audit with:

```bash
grep -rn "getJSON(.*\(health\|actuator\|ping\|photo\|avatar\)" src/
```

[[Auth Fetch#the-three-deliberate-bypasses]].

---

## `env.json` changes do nothing

**Cause 1 — a value was captured at module scope.**

```js
const secret = getConfig().STORAGE_SECRET;   // ❌ frozen before the overlay applied
```

Read inside the function that needs it. Sweep with `grep -rn "^const .* = .*[Cc]onfig\." src/`.

**Cause 2 — a key nothing reads.** The decoder applies keys verbatim; there is no camelCase translation. `REACT_APP_idleTime` is applied and read by nothing.

```js
const stray = unknownKeys(overrides, new Set(Object.keys(baseEnv)));
```

**Cause 3 — `overrides` is not last.** `{ ...overrides, ...base }` gives you an override mechanism that silently does nothing.

**Cause 4 — the overlay replaced the object instead of mutating it.** `config = { ...config, ...overrides }` creates a *new* object; the registry still holds the old one. Use `Object.assign(config, overrides)`.

Related errors from `decodeEnvJson`:

| Message | Meaning |
|---|---|
| `env.json is not valid JSON` | the endpoint served HTML — usually a 404 page |
| `has no configEnv string and no envVariables object` | wrong file shape |
| `configEnv did not decrypt` | blob produced with a different key, or a react-security-util version bump |
| `configEnv decrypted to something that is not JSON` | truncated or double-encrypted blob |

---

## `localStorage is not defined` during a build

**Cause.** Something touched browser storage during a static-export prerender. This package constructs SecureLS lazily and guards `window` and `sessionStorage`, so it is almost certainly **your** code — a module-scope `new SecureLS(...)`, or a bare `sessionStorage.getItem(...)`.

**Fix.** Move it into the function that needs it, and guard:

```js
if (typeof window !== "undefined") { … }
```

If it really is in this package, that is a bug — see `storage.prerender.test.ts` and file an issue with the stack.

---

## `ERR_REQUIRE_ESM`

```
Error [ERR_REQUIRE_ESM]: require() of ES Module …
```

**Cause.** Something is `require()`-ing this package. It is **ESM-only**, deliberately — `jose` has no `require` condition, and tsup does not code-split CJS, which would fork the config registry.

**Fix.** Use `import`. In a CJS script on Node < 22, use dynamic import:

```js
const { parseBoolean } = await import("@devopsnext/starterkit-config-util");
```

Build scripts should be `.mjs`. Node >= 22 can `require()` ESM anyway. [[Architecture#why-esm-only]].

---

## `Received an instance of Uint8Array`

From jose, usually in tests. `instanceof Uint8Array` is per-realm, and jsdom's `TextEncoder` produces one from a different realm.

The package already re-wraps with `Uint8Array.from(...)`. If you see this, the call is going through **your** copy of the JWT code — finish the migration and delete it.

---

## Double slashes in URLs

`https://host//oauth-service` — most gateways answer it, some rewrite it, and it is invisible until one does not.

```js
const origin = normalizeOrigin(env.SERVICE_URL);   // strips ALL trailing slashes
```

**And the reverse:** if a URL suddenly became root-relative, an environment sets `SERVICE_URL=` on purpose (root-relative serving). `normalizeOrigin` preserves `""`; a `value || fallback` would not. That is intended.

---

## A `"false"` flag behaves as on

```js
if (config.FEATURE_X) { }               // ❌ "false" is a non-empty string
if (parseBoolean(config.FEATURE_X)) { } // ✅
```

**And the reverse:** a flag you turned *off* in `sessionStorage` stays on. `getEnvBoolean` is affirmative-only on both sides — a stale `"false"` cannot switch off a flag the build switched on. That asymmetry is deliberate.

---

## Uploads rejected server-side

A message about the body, not about headers.

**Cause.** `Content-Type: application/json` was sent with a `FormData` body, so the browser never set the multipart boundary.

**Fix.** Use `postFormData(url, formData)` — it deliberately sends no `Content-Type` while still attaching the bearer token.

---

## Still stuck

Collect this before opening an issue:

```js
import { hasConfigSource, requiredConfigKeys, resolvedOptions } from "@devopsnext/starterkit-config-util";
import { hasStorageSecret } from "@devopsnext/starterkit-config-util/storage";

console.log({
  wired: hasConfigSource(),
  requiredKeys: requiredConfigKeys(),
  options: resolvedOptions(),
  secret: hasStorageSecret(),
});
```

Plus your Node version, bundler + version, and whether the failure is at build time, prerender, or in the browser.
