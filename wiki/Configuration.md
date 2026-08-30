# Configuration

How a value gets from a `.env` file to `config.SOME_KEY`, and every knob along the way.

## The layer cake

```
env.base.js            keys present in every environment
        ▼  overridden by
env.<appEnv>.js        the environment this build is for
        ▼  overridden by
overrides              decoded env.json — the RUNTIME layer, wins over everything
        ▼
config object          ← setConfigSource() holds THIS REFERENCE
```

`createAppConfig` performs exactly `{ ...base, ...envs[appEnv], ...overrides }`. Nothing is merged deeply, nothing is renamed, nothing is validated against an allow-list.

## Choosing the environment

`appEnv` is a plain string you pass in. There is no magic env-var lookup inside the package — an app that names its variable `VITE_APP_ENV` or reads it from a CI-only source works unchanged.

```js
appEnv: process.env.NEXT_PUBLIC_APP_ENV || "dev"
```

Register environments from **static imports** in an object literal:

```js
import devEnv from "./env.dev";
import testEnv from "./env.test";
import thinkEnv from "./env.think";

const ENV_CONFIGS = { dev: devEnv, test: testEnv, think: thinkEnv };
```

Not `require("./env." + name)`. A template-literal require becomes a bundler context module: an unknown name is a **runtime** white screen in a client chunk, not a build failure. See [[Architecture#createappconfig-two-defects-it-exists-to-kill]].

Unknown names throw with the list of known ones:

```
createAppConfig: appEnv="prod" has no matching env config.
Known environments: dev, test, think.
Add the env module, import it statically, and register it in the map you pass as `envs`
— or fix the environment variable this build loaded.
```

## The keys this package reads

Only three, and each is a *name*, not a value:

| Logical name | Default config key | Used by |
|---|---|---|
| `storageSecret` | `STORAGE_SECRET` | `./storage` — AES localStorage, JWT signing |
| `oauthServiceUrl` | `OAUTH_SERVICE_URL` | `./fetch` — the default 401 logout redirect |
| `responseDecompress` | `RESPONSE_DECOMPRESS` | `./fetch` — whether to send `X-Decompress` |

Remap them if your app names them differently:

```js
setConfigSource(config, {
  keys: {
    storageSecret: "APP_STORAGE_SECRET",
    oauthServiceUrl: "AUTH_BASE_URL",
    responseDecompress: "COMPRESS_RESPONSES",
  },
});
```

`requiredConfigKeys()` then returns the **resolved** names — feed that to your build-time env gate so the gate and the package can never disagree.

## `setConfigSource` options in full

```js
setConfigSource(config, {
  keys: { … },                                  // above
  mirrorRaw: false,                             // plaintext "<key>_raw" copies
  decompressOverrideKey: "RESPONSE_DECOMPRESS", // sessionStorage per-tab override
  payloadOnlyDecompress: true,                  // see Auth Fetch
  onUnauthorized: (config, keys) => {},          // default: clear token + OAuth logout
});
```

### `mirrorRaw`

Writes a **plaintext** `"<name>_raw"` copy alongside every encrypted `setLocalStorage` value.

Off by default, because writing a decrypted copy of `userInfo` next to the encrypted one is the exact thing secure-ls exists to prevent. One app opts in because its debug tooling (`scripts/dev-debug/login.mjs`) reads those mirrors, and keeping behaviour byte-identical mattered more during extraction.

If you turn it on, know what lands in `localStorage`.

### `decompressOverrideKey`

A `sessionStorage` key that can force the decompression branch **on** for one browser tab. Defaults to whatever `keys.responseDecompress` resolved to. One app uses `"VITE_RESPONSE_DECOMPRESS"`, left over from its Vite build.

Only an affirmative value counts (`getEnvBoolean` semantics) — a stale `"false"` in sessionStorage cannot turn **off** a flag the build turned on.

### `onUnauthorized`

Runs when an authenticated request comes back 401.

```js
onUnauthorized: (config, keys) => {
  // config: the live config object · keys: the RESOLVED key map
}
```

Default (identical in both current consumers): clear the bearer token, then `location.replace(\`${config[keys.oauthServiceUrl]}/logout?USER_TYPE=USER\`)`.

Deliberately **not** a static `/error/401` page — that leaves the dead token in storage, so every subsequent navigation 401s again with no way out but clearing site data by hand.

### Unknown options throw

```js
setConfigSource(config, { mirorRaw: true });
// Error: setConfigSource: unknown option(s) mirorRaw. Known options: keys, mirrorRaw,
// decompressOverrideKey, onUnauthorized, payloadOnlyDecompress. Rejected rather than
// ignored, because a typo'd option silently reverts to a default.
```

Same for unknown entries inside `keys`, and that error names the flat-vs-nested slip explicitly:

```js
setConfigSource(config, { storageSecret: "X" });        // ❌ throws
setConfigSource(config, { keys: { storageSecret: "X" }}); // ✅
```

## The `env.json` runtime layer

`env.json` is what the DevOps pipeline serves for every app in this family:

```json
{ "configEnv": "<AES blob>" }
```

Decrypted, it is a flat object whose **keys are verbatim config keys**:

```
{"INTEGRATION_ALLOWED_DOMAINS": "a.example,b.example", "IDLE_TIME": 3600}
        │
        ▼
config.INTEGRATION_ALLOWED_DOMAINS
```

There is no camelCase → UPPER_SNAKE transform and no lookup table. An earlier decoder had both, and that translation layer fails in the direction nobody notices: a key with no row and no clean transform lands on the config object under a name nothing reads, so the override is "applied" and changes nothing. **Whoever writes `env.json` writes the key the code reads.**

### At build time

```js
// scripts/env-json-snapshot.mjs
import { decodeEnvJson, unknownKeys } from "@devopsnext/starterkit-config-util/env-json";
import { readFileSync, writeFileSync } from "node:fs";

const { overrides, keys } = decodeEnvJson(readFileSync("public/env.json", "utf8"));

const stray = unknownKeys(overrides, new Set(Object.keys(baseEnv)));
if (stray.length) console.warn("env.json sets keys nothing reads:", stray);

console.log("env.json set:", keys.join(", "));
writeFileSync("src/generated/env-runtime.json", JSON.stringify({ overrides }, null, 2));
```

A build script should let `decodeEnvJson` throw. A browser should catch, log, and keep the baked values.

### In the browser

Re-apply the deployed file onto the **same object**:

```js
const { overrides } = decodeEnvJson(await (await fetch("/env.json")).text());
Object.assign(config, overrides);   // reaches every consumer, including this package
```

This works only because nothing captures a config value at module scope — the rule the whole package is built around. See [[Architecture#the-registry-and-why-it-holds-a-reference]].

> ⚠️ **`env.json` is obfuscated, not secret.** The key lives inside `@devopsthink/react-security-util`, which ships to the browser. Anyone with the bundle can read it. Nothing confidential may go in it.

## Boolean and numeric flags

Env vars are strings, and `"false"` is truthy:

```js
import { parseBoolean, getEnvBoolean, parseNumber } from "@devopsnext/starterkit-config-util";

if (config.FEATURE_X) { }                      // ❌ true for "false"
if (parseBoolean(config.FEATURE_X)) { }        // ✅

const idle = parseNumber(config.IDLE_TIME, 3600);   // ✅ "3600" → 3600, "abc" → 3600

// build value + per-tab override, affirmative-only on both sides
const on = getEnvBoolean(config.FEATURE_X, sessionStorage.getItem("FEATURE_X"));
```

## Service URLs

`normalizeOrigin` is the only piece of URL derivation the package owns:

```js
import { normalizeOrigin } from "@devopsnext/starterkit-config-util";

const origin = normalizeOrigin(env.SERVICE_URL);            // "https://h/" → "https://h"
const origin = normalizeOrigin(env.SERVICE_URL, "https://fallback.example");
```

`""` is preserved, **not** replaced by the fallback: `NEXT_PUBLIC_SERVICE_URL=` means "serve me root-relative URLs", which is how a static export gets served from a second domain without hard-targeting the first.

Everything else — which services exist, what their paths are — stays in your `derive.js`. [[Architecture#what-deliberately-stayed-in-your-app]] explains why that is load-bearing and not laziness.

## Wiring without any global

Every factory takes an explicit `getConfig`, so an app that wants no module state can have none:

```js
import { createApiUtils } from "@devopsnext/starterkit-config-util/storage";
import { createFetchHelpers } from "@devopsnext/starterkit-config-util/fetch";

const ApiUtils = createApiUtils({ getConfig: () => config });
const api = createFetchHelpers({ getConfig: () => config, apiUtils: ApiUtils });

export const { getJSON, postJSON, probeFetch } = api;
```

Still pass a **function** that reads the object, not a captured value.
