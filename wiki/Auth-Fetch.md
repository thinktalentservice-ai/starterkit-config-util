# Auth Fetch

`@devopsnext/starterkit-config-util/fetch` — the authenticated request layer, as the union of the two apps it came from.

## What every authenticated call does

```
authHeaders()          Content-Type: application/json
                       Authorization: Bearer <token>       (if a token is in storage)
                       X-Decompress: true                  (if the decompression flag is on)
      ▼
fetch(url, init)       timeout composed with your signal via AbortSignal.any
      ▼
FetchUtils.checkStatus parses JSON, throws on non-OK
      ▼
decompression          see "Response decompression" below
      ▼
classifyError on throw → UnauthorizedError triggers the 401 boundary
```

## The helpers

```js
import {
  getJSON, postJSON, putJSON, deleteJSON, postFormData,   // 401 boundary ON
  probeFetch, getBlob, postBinary,                        // 401 boundary OFF
  authFetch, authHeaders, getToken,
} from "@devopsnext/starterkit-config-util/fetch";
```

```js
const me   = await getJSON(`${config.USER_SERVICE_URL}/me`);
const made = await postJSON(`${config.USER_SERVICE_URL}/user`, { name: "Ada" });
const upd  = await putJSON(`${config.USER_SERVICE_URL}/user/1`, { name: "Ada L." });
await deleteJSON(`${config.USER_SERVICE_URL}/user/1`);
```

### Timeouts and cancellation

```ts
interface RequestOptions extends Omit<RequestInit, "signal"> {
  timeout?: number;              // ms
  signal?: AbortSignal | null;
}
```

```js
const controller = new AbortController();
await getJSON(url, { timeout: 8000, signal: controller.signal });
```

Both are honoured: the timeout is built with `AbortSignal.timeout()` and **composed** with your signal via `AbortSignal.any()`, never assigned over it. Assigning one over the other is how a caller's cancellation silently stops working the day someone adds a timeout.

### Uploads

```js
const fd = new FormData();
fd.append("file", file);
await postFormData(url, fd);
```

`postFormData` deliberately does **not** send `Content-Type` — the browser must set the multipart boundary itself. Passing `authHeaders()` here would set `application/json` and the upload fails server-side with a message about the body, not about the header. It still attaches the bearer token.

## The 401 boundary

When `classifyError` produces an `UnauthorizedError`, `authFetch`:

1. clears the bearer token (`setCookie("accessToken", "")`), then
2. `location.replace(\`${config[keys.oauthServiceUrl]}/logout?USER_TYPE=USER\`)`

…unless you supplied `onUnauthorized` (per-call-site via `createFetchHelpers`, or globally via `setConfigSource`).

It is **not** a redirect to a static `/error/401` page: that leaves the dead token in storage, so every subsequent navigation 401s again with no way out but clearing site data by hand.

```js
setConfigSource(config, {
  onUnauthorized: (cfg, keys) => {
    ApiUtils.setCookie("accessToken", "");
    window.location.assign("/signed-out");
  },
});
```

The error is always re-thrown after the handler runs, so callers still see a rejected promise.

## The three deliberate bypasses

`probeFetch`, `getBlob` and `postBinary` do **not** go through the 401 boundary, and that is the whole reason they exist.

> It shipped wrong once, exactly like this: a briefing page's connection check called `/actuator/health` through `getJSON`, the gateway answered 401, and a candidate pressing Start on their emailed link was signed out by a health check — on a route that deliberately requires no sign-in at all.

### `probeFetch(url, options?)` — reachability, not health

```js
const { reached, status } = await probeFetch(`${config.SERVICE_URL}/actuator/health`);
```

Three deliberate differences from `authFetch`:

- **No `Authorization` header.** Sending a stale token is what turns a probe into a 401 in the first place.
- **No `classifyError`**, so no `UnauthorizedError`, so no logout. Ever.
- **Any HTTP response counts as reached** — 401/403/404/500 included. The question is "did bytes come back from that host", not "is this endpoint healthy". A protected actuator *is* a reachable service.

Defaults to a 5 s timeout and `cache: "no-store"` (a cached 200 measures the disk, not the network). Rejects only on a genuine network failure — DNS, TLS, offline, timeout — which is precisely the signal the caller is measuring.

### `getBlob(url, options?)` — binary GET

```js
const photo = await getBlob(`${config.USER_SERVICE_URL}/user/1/photo`);
const src = URL.createObjectURL(photo);
```

Same shape, different reason: "no photo on file" is the normal case for most accounts and the endpoint answers it with an error status. If that status is ever a 401, routing it through `authFetch` signs the user out over a decorative avatar. **A picture is not worth a session.**

Uses `authHeaders(null)` — no `Content-Type` (there is no request body to describe), but the bearer token *is* attached, which is exactly why this cannot just be an `<img src>`.

### `postBinary(url, body?, options?)` — binary POST response

```js
const audio = await postBinary(`${config.TTS_SERVICE_URL}/speak`, { text });
```

`checkStatus` parses JSON, so this goes straight to the raw response and returns the bytes. Throws `Request failed (<status>)` on a non-OK response, with `classifyError` applied but **no** logout.

## Response decompression

When the flag is on, the client sends `X-Decompress: true` and the service is supposed to answer uncompressed.

The flag is `getEnvBoolean(config[RESPONSE_DECOMPRESS], sessionStorage[decompressOverrideKey])` — build value **or** an affirmative per-tab override. A stale `"false"` in sessionStorage cannot turn it off.

```
flag OFF  →  if response has a `payload` key, decompress it; else return as-is
flag ON   →  payloadOnlyDecompress = true  (default)
                 response whose ONLY key is `payload`  → decompress
                 anything else                          → return untouched
             payloadOnlyDecompress = false
                 always return untouched
```

### The one live fork

The two apps this was extracted from disagree about exactly one input: **a response carrying `payload` alongside other keys.**

| | `true` (default) | `false` |
|---|---|---|
| `{ payload }` alone, flag on | decompressed | untouched |
| `{ payload, meta }`, flag on | untouched | untouched |
| Used by | `template-starterkit-nextjs` | `nextv3-ai-interview-react` |

This is **live**, not dead code: one app's `.env.dev` sets `NEXT_PUBLIC_RESPONSE_DECOMPRESS=true`, so every local dev build takes the branch. Its `.env` sets `false` and neither `.env.test` nor `.env.think` overrides it, so the deployed builds do not. The other app sets the variable nowhere.

It is an option rather than a hardcoded superset because a live divergence documented away in a comment is how the two copies drifted to begin with. Both branches are pinned by tests.

```js
setConfigSource(config, { payloadOnlyDecompress: false });
```

## Sending compressed request bodies

```js
import { buildCompressedPayload } from "@devopsnext/starterkit-config-util/payload";
import { authFetch, authHeaders } from "@devopsnext/starterkit-config-util/fetch";

await authFetch(url, {
  method: "POST",
  headers: authHeaders(),
  body: buildCompressedPayload({ answers }),   // already a string: {"payload":"<fflate b64>"}
});
```

## Per-instance helpers

To avoid the global registry, or to give one call site different behaviour:

```js
import { createFetchHelpers } from "@devopsnext/starterkit-config-util/fetch";
import { createApiUtils } from "@devopsnext/starterkit-config-util/storage";

const ApiUtils = createApiUtils({ getConfig: () => config });

const api = createFetchHelpers({
  getConfig: () => config,
  apiUtils: ApiUtils,
  payloadOnlyDecompress: false,
  onUnauthorized: () => window.location.assign("/signed-out"),
});

export const { getJSON, postJSON, probeFetch } = api;
```

## Choosing a helper

| Situation | Use | Never use |
|---|---|---|
| a real API call by a signed-in user | `getJSON` / `postJSON` / … | |
| health check, connectivity probe, "is the gateway up" | `probeFetch` | `getJSON` |
| avatar, any image behind auth | `getBlob` | `getJSON` |
| audio/binary response to a POST | `postBinary` | `postJSON` |
| file upload | `postFormData` | `postJSON` with a FormData body |
| anything on a route that does **not** require sign-in | `probeFetch` / plain `fetch` | anything with the 401 boundary |
