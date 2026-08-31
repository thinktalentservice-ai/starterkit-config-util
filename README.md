# @devopsnext/starterkit-config-util

App-config resolution plus the secure-storage and authenticated-fetch utilities shared by the
Think Talent frontends.

**Mechanism only.** Every project keeps its own `.env*` files, its own environment names, its own
service-path map and its own base config. What this package owns is the handful of things that were
byte-identical in every copy — and had already drifted.

```bash
pnpm add @devopsnext/starterkit-config-util
```

ESM-only. Node >= 18. Peers (`jose`, `secure-ls`, `@devopsthink/react-security-util`) are all
optional — the `.` entry needs none of them.

---

## What is in, what is deliberately out

| Stays in YOUR app | Why |
|---|---|
| `env.base.js` | your keys. 13 names overlap between two apps; 5 expressions do. A package-owned default is un-greppable from the consumer, which is the one property this file exists to have. |
| `env.<name>.js` | your environments. One app has three, another has five (`dev`, `test`, `think`, `elus`, `lb`). |
| `derive.js` — the service-path map | one app derives `/landing-user-service`, another derives `/ai-interview-user-service` and a `LANDING_DOMAIN_URL` that is not a service at all. Only `normalizeOrigin()` moved. |
| the OAuth authorize/redirect URL builders | `redirect_uri` depends on your `BASE_PATH` and on reading `location.origin` at call time. The only OAuth URL this package owns is the **logout** default on a 401. |
| `.env*` | obviously |

Keeping `derive.js` in the app has a second, load-bearing effect for at least one consumer: its
`check-env-config.mjs` gate resolves the `...deriveServiceUrls(x)` spread by AST-parsing that file
for a returned object **literal** imported from `"./derive"`. Move the function into a package and
the gate can no longer name the keys — which is exactly the visibility whose absence once shipped
`window.location.replace("undefined/oauth/authorize?…")` to production.

---

## Entries

| Import | Exports | Peers pulled |
|---|---|---|
| `@devopsnext/starterkit-config-util` | `normalizeOrigin`, `createAppConfig`, `setConfigSource`, `getConfig`, `hasConfigSource`, `requiredConfigKeys`, `DEFAULT_CONFIG_KEYS`, `parseBoolean`, `getEnvBoolean`, `parseNumber` | **none** |
| `…/env-json` | `decodeEnvJson`, `unknownKeys`, `normalizeEnvJsonKeys`, `describeEnvJsonKeyChanges`, `ENV_JSON_KEY_PREFIX` | react-security-util |
| `…/storage` | `ApiUtils` (default), `createApiUtils`, `encodeJwtString`, `decodeJwtString` | jose, secure-ls, react-security-util |
| `…/fetch` | `authFetch`, `getJSON`, `postJSON`, `putJSON`, `deleteJSON`, `postFormData`, `postBinary`, `getBlob`, `probeFetch`, `authHeaders`, `getToken`, `createFetchHelpers` | (via `./storage`) |
| `…/payload` | `buildCompressedPayload` | react-security-util |

The split is the point: a route that only wants `parseBoolean` must not pull `jose` and `secure-ls`
into its bundle. `scripts/check-dist.mjs` asserts that transitively, over the built module graph —
a `grep dist/index.js` version of the same check passes trivially once code splitting is on.

---

## Wiring

Once, at module scope, in the module that builds your config:

```js
// src/config/index.js
import { createAppConfig, setConfigSource } from "@devopsnext/starterkit-config-util";
import baseEnv from "./env.base";
import devEnv from "./env.dev";
import thinkEnv from "./env.think";
import envJsonSnapshot from "@/generated/env-runtime.json";

const ENV_CONFIGS = { dev: devEnv, think: thinkEnv };

const config = createAppConfig({
  base: baseEnv,
  envs: ENV_CONFIGS,
  appEnv: process.env.NEXT_PUBLIC_APP_ENV || "dev",
  overrides: envJsonSnapshot.overrides,   // optional
});

setConfigSource(config, { mirrorRaw: true });
export default config;
```

### Options

All optional; every default is `template-starterkit-nextjs`'s current behaviour.

```js
setConfigSource(config, {
  keys: {                                  // remap the key names this package reads
    storageSecret: "STORAGE_SECRET",
    oauthServiceUrl: "OAUTH_SERVICE_URL",
    responseDecompress: "RESPONSE_DECOMPRESS",
  },
  mirrorRaw: false,                        // write a PLAINTEXT "<key>_raw" copy too
  decompressOverrideKey: "RESPONSE_DECOMPRESS",  // sessionStorage per-tab override
  payloadOnlyDecompress: true,             // see "The one live fork" below
  onUnauthorized: (config, keys) => {},    // default: clear token + OAuth logout
});
```

**Unknown options throw.** A typo'd `mirrorRaw` would silently revert to a default — a plaintext
copy that stops (or starts) being written with nothing to say so. That is the exact class of silent
misconfiguration this package exists to prevent, so it is not reproduced by the wiring call. The
flat-vs-nested slip (`{ storageSecret }` instead of `{ keys: { storageSecret } }`) is named
explicitly in the error.

### Without any global

Every factory takes an explicit `getConfig`, so a consumer that wants no module state can have none:

```js
const ApiUtils = createApiUtils({ getConfig: () => config });
const api = createFetchHelpers({ getConfig: () => config, apiUtils: ApiUtils });
```

---

## The contract: reads happen at CALL TIME

`setConfigSource` stores **the object, never a copy**. If your app re-applies a deployed `env.json`
in the browser by `Object.assign(config, overrides)`, that mutation reaches this package — because
nothing here captures a config value at module scope.

Do not write `const secret = getConfig().STORAGE_SECRET` at module scope in your own code either.
One consuming app does exactly that today (`const secret = appConfig.STORAGE_SECRET`), and it is
harmless there only because that app has no `env.json` layer.

`getConfig()` **throws a named error** when nothing has been wired. The alternative failure is
silence: an undefined encryption secret makes secure-ls fail every decrypt, so every accessor
returns null and the app looks to every user exactly as though they had been signed out — no error,
no log, a green build.

---

## The one live fork: `payloadOnlyDecompress`

The two apps this was extracted from disagree about one thing. When the decompression flag is on the
client sends `X-Decompress` and the service is supposed to answer uncompressed:

- **`true` (default)** — still decompress a response whose **only** key is `payload`.
- **`false`** — return the response untouched; the service already did the work.

They differ for exactly one input: a response carrying `payload` **alongside** other keys. Both
branches are pinned by tests.

This is a **live** fork, not dead code: one app's `.env.dev` sets
`NEXT_PUBLIC_RESPONSE_DECOMPRESS=true`, so every local dev build takes it. Its `.env` sets `false`
and neither `.env.test` nor `.env.think` overrides that, so the deployed builds do not. The other
app sets the variable nowhere.

---

## Three helpers deliberately bypass `authFetch`

`probeFetch`, `getBlob` and `postBinary` do **not** go through the 401 boundary, and that is the
whole reason they exist. `authFetch` clears the bearer token and redirects to the OAuth logout on a
401 — correct for a real API call by a signed-in user, catastrophic otherwise.

It shipped wrong once, exactly like this: a briefing page's connection check called
`/actuator/health` through `getJSON`, the gateway answered 401, and a candidate pressing Start on
their emailed link was signed out by a health check — on a route that deliberately requires no
sign-in at all.

`getBlob` has the same shape for a different reason: "no photo on file" is the normal case for most
accounts, and a picture is not worth a session.

---

## Why ESM-only

Two independently verified reasons, not a preference:

1. **`jose` is ESM-only.** Its `exports["."]` has no `require` condition, so a CJS `storage.cjs`
   would emit `require("jose")` and throw `ERR_REQUIRE_ESM` on the declared engines range. The CJS
   entry would be dead on arrival with nothing in a normal build to say so.
2. **tsup does not code-split CJS.** Each subpath entry inlines its own copy of every shared module.
   This graph has mutable module state (the config registry), so duplicated copies mean the host
   calls `setConfigSource` on one registry while `./storage` reads another — `getConfig()` throwing
   in an app whose build was green.

(2) is separately defended against: the registry is keyed on `Symbol.for(...)`, which is a
cross-realm registered symbol, so even two genuinely separate instances of the module share one
store. Belt and braces — the symbol handles a duplicate the build cannot see, ESM-only stops the
build from creating one, and `check-dist.mjs` asserts both.

Cost: nil for the verified consumers. Next 16 resolves the `import` condition for both its server
and client graphs, build gates are `.mjs` run under Node, and Node >= 22 can `require()` ESM anyway.

---

## Development

```bash
pnpm verify      # typecheck -> vitest -> tsup -> check-dist
pnpm test:watch
```

`scripts/check-dist.mjs` asserts things no unit test can: ESM-only, every declared export resolves,
the `.` entry's **transitive** closure imports nothing, the peer-using entries **do** reach their
peers (so the graph walk cannot silently go vacuous), and the registry lives in exactly one chunk.
It has been fault-injected — adding `import "jose"` to `src/index.ts` turns it red.
