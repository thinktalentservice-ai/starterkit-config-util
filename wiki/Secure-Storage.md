# Secure Storage

`@devopsnext/starterkit-config-util/storage` — AES-encrypted browser storage (via `secure-ls`) plus the two JWT helpers (via `jose`).

## Basic use

```js
import ApiUtils from "@devopsnext/starterkit-config-util/storage";

ApiUtils.setCookie("accessToken", token);
ApiUtils.setLocalStorage("userInfo", { id: 1, name: "Ada" });

const token = ApiUtils.getCookie("accessToken");
const user  = ApiUtils.getLocalStorage("userInfo");
```

`getCookie`/`setCookie` and `getLocalStorage`/`setLocalStorage` are the same encrypted `localStorage` underneath. Both name pairs exist because both call-site vocabularies existed in the apps this came from; they were not going to be renamed across two codebases as part of an extraction.

## Return values, precisely

| Situation | Returns |
|---|---|
| key written earlier | the decrypted value |
| key never written | **`""`** (empty string) |
| decrypt failed | `null` |
| running on the server (no `window`) | `null` |

The empty string is preserved deliberately: it is what secure-ls returns, `?? null` does not catch it (`""` is not nullish), and **both consuming apps already depend on it being falsy** (`if (token)` in the fetch layer; a comment in `session-brand.js` noting that "an empty string has no `.client`"). Tightening it to `null` would be a silent behaviour change across two apps in exchange for tidiness.

Reads never throw — a decrypt failure is caught and becomes `null`.

## The secret

Read from `config[keys.storageSecret]` — by default `STORAGE_SECRET` — **at call time, never captured at module scope.**

If it is missing or empty, the first accessor call throws a named error:

```
STORAGE_SECRET is not set. Encrypted local storage and JWT signing cannot work without it.
Set it in the environment this build loads (commonly NEXT_PUBLIC_STORAGE_SECRET),
or in the env.json the deployment serves.
```

That throw is the entire point. Without it, secure-ls fails every decrypt, every accessor returns `null`, and the app presents to every user exactly as though they had been signed out — no error, no log, a green build. jose fails later and elsewhere with `DataError: HMAC key data must not be empty`, a message naming neither the variable nor the file.

It cannot be a module-scope throw: that would run during a static-export prerender and fail the build on a machine that legitimately has no secrets. So it is checked at **first use, in the browser**, where the value is actually needed.

Non-throwing check:

```js
import { hasStorageSecret } from "@devopsnext/starterkit-config-util/storage";
if (!hasStorageSecret()) console.warn("storage secret missing — accessors will throw on use");
```

## Server / prerender behaviour

Every accessor no-ops on the server. You can import `ApiUtils` from a module that is evaluated during prerender; you just cannot get a value out of it there.

Two mechanisms, and neither is redundant:

- **Lazy construction.** `new SecureLS(...)` touches `localStorage` *in its constructor*. At module scope that runs during prerender on a machine with no `localStorage`, so importing any controller from a prerendered route would crash the build.
- **The `window` guard.** A client component's module still evaluates on the server during prerender, and an accessor called from a component body would run there too. Returning `null` lets it no-op instead of throwing.

The instance is cached **keyed on the secret**, not unconditionally — so if an `env.json` overlay changes `STORAGE_SECRET` after first use, the next call rebuilds SecureLS with the new one. An unconditional cache would keep the old secret and make the lazy read purely decorative.

## `mirrorRaw` — plaintext copies

```js
setConfigSource(config, { mirrorRaw: true });
```

Every `setLocalStorage(name, value)` then also writes `localStorage["<name>_raw"] = JSON.stringify(value)` — **unencrypted**.

Off by default, because writing a decrypted copy of `userInfo` next to the encrypted one is the exact thing secure-ls exists to prevent. One app opts in because its dev debug tooling reads those mirrors. Turn it on knowing what lands in the browser's storage inspector.

Note the asymmetry: reads never consult `_raw`. It is a debug mirror, not a fallback.

## JWT helpers

```js
import { encodeJwtString, decodeJwtString } from "@devopsnext/starterkit-config-util/storage";

const jwt = await encodeJwtString({ sub: "1", role: "USER" });   // HS256, signed with the secret
const claims = decodeJwtString(jwt);                              // DECODE ONLY — no verification
```

- `encodeJwtString` is **async** and throws the same named error if the secret is unset.
- `decodeJwtString` does **not verify** the signature — same semantics as jose's `decodeJwt`. Never use it to make a trust decision; use it to read claims off a token the server already validated.

> Implementation note: the key is re-wrapped with `Uint8Array.from(new TextEncoder().encode(secret))`. jose checks its key with `instanceof Uint8Array`, which is per-**realm**. Under jsdom — where every consuming app runs its unit tests — the global `TextEncoder` belongs to the jsdom realm while jose resolves Node's `Uint8Array`, so a perfectly good key is rejected with "Received an instance of Uint8Array", a message that reads like a bug in jose. One short allocation makes it work in every consumer's test environment as well as in a browser.

## `queryString`

```js
ApiUtils.queryString({ page: 1, q: "ada lovelace" });   // "page=1&q=ada%20lovelace"
```

A **local** implementation, deliberately not `FetchUtils.queryString`. The two are probably equivalent — and "probably" is not a reason to change the behaviour of live call sites building search queries against Java services. Swapping it later needs a test proving the outputs match for spaces, `+`, `&`, unicode and nested values.

## Re-exports

`ApiUtils.checkResponse`, `ApiUtils.checkStatus` and `ApiUtils.classifyError` are passed straight through from `@devopsthink/react-security-util`, so existing call sites that reached for them through the old `ApiUtils` object keep working.

## Instances without the global

```js
import { createApiUtils } from "@devopsnext/starterkit-config-util/storage";

const ApiUtils = createApiUtils({
  getConfig: () => config,          // no registry needed
  keys: { storageSecret: "APP_SECRET" },
  mirrorRaw: false,
});
```

Each instance keeps its own lazily-built, secret-keyed SecureLS. Pass the instance to `createFetchHelpers({ apiUtils })` so the fetch layer reads the same storage.

## Rules

1. Never capture the secret — or any config value — at module scope.
2. Never treat `getLocalStorage(...)` as returning `null` for a missing key; it returns `""`.
3. Never call an accessor during render on the server and expect a value.
4. Never trust `decodeJwtString` output for authorization.
5. Leave `mirrorRaw` off unless a specific tool needs it.
