# Migration Guide

Porting an existing Think Talent frontend onto the package. Roughly an hour for an app of the size these were, and it can be done incrementally — the package does not require you to move everything at once.

## Before you start

- [ ] Node >= 18, and your bundler resolves the `import` condition (Next 13+ / Vite do).
- [ ] You can install `jose`, `secure-ls` and `@devopsthink/react-security-util`.
- [ ] Note which environment names your app has. They stay yours.

```bash
pnpm add @devopsnext/starterkit-config-util jose secure-ls @devopsthink/react-security-util
```

---

## Step 1 — replace the dynamic `require` in your config module

**Before**

```js
// src/config/index.js
import baseEnv from "./env.base";

const appEnv = process.env.NEXT_PUBLIC_APP_ENV || "dev";
const envConfig = require(`./env.${appEnv}`).default;   // ❌ context module

export default { ...baseEnv, ...envConfig };
```

**After**

```js
import { createAppConfig } from "@devopsnext/starterkit-config-util";
import baseEnv from "./env.base";
import devEnv from "./env.dev";
import testEnv from "./env.test";
import thinkEnv from "./env.think";

const ENV_CONFIGS = { dev: devEnv, test: testEnv, think: thinkEnv };

export default createAppConfig({
  base: baseEnv,
  envs: ENV_CONFIGS,
  appEnv: process.env.NEXT_PUBLIC_APP_ENV || "dev",
});
```

**Expect this to fail the first time, and that is the win.** If your CI sets an environment name you never had a module for, the build now stops with `appEnv="prod" has no matching env config. Known environments: dev, test, think.` Previously that was a white screen in production.

Do not delete `env.base.js`, `env.<name>.js` or `derive.js`. They stay in your app on purpose — [[Architecture#what-deliberately-stayed-in-your-app]].

## Step 2 — wire the registry

Immediately after building the object, in the same module:

```js
import { setConfigSource } from "@devopsnext/starterkit-config-util";

const config = createAppConfig({ … });
setConfigSource(config, { mirrorRaw: true });   // mirrorRaw only if you had it
export default config;
```

Make sure this module is imported before anything reads from the package — in Next.js, from the root layout.

If your key names differ from `STORAGE_SECRET` / `OAUTH_SERVICE_URL` / `RESPONSE_DECOMPRESS`, remap rather than rename across your app:

```js
setConfigSource(config, { keys: { storageSecret: "APP_STORAGE_SECRET" } });
```

## Step 3 — swap `normalizeOrigin` into `derive.js`

**Before**

```js
const origin = String(env.SERVICE_URL || "").replace(/\/$/, "");
```

**After**

```js
import { normalizeOrigin } from "@devopsnext/starterkit-config-util";
const origin = normalizeOrigin(env.SERVICE_URL);
```

Behaviour changes in two directions, both intended: `""` is now preserved instead of collapsing to the fallback, and `null` no longer becomes the string `"null"`. If any environment legitimately sets an empty `SERVICE_URL` for root-relative URLs, this is the fix, not a regression.

Keep `deriveServiceUrls` returning an **object literal** — a host build gate may AST-parse it.

## Step 4 — delete your copy of `ApiUtils`

**Before** — `src/api/ApiUtils.jsx`, typically ~120 lines, usually including:

```js
const secret = appConfig.STORAGE_SECRET;                 // ❌ captured at module scope
const ls = new SecureLS({ encryptionSecret: secret });   // ❌ constructed at module scope
```

**After**

```js
// src/api/ApiUtils.js
export { default } from "@devopsnext/starterkit-config-util/storage";
```

A one-line re-export keeps every existing import path working, so this step touches one file rather than fifty.

Two behaviour differences to know:

| | Your old copy | The package |
|---|---|---|
| secret read | once, at module scope | at every call |
| SecureLS built | at module scope (crashes a prerender) | lazily, keyed on the secret |

If your app has no `env.json` layer, the first row was harmless — until someone added one. That is why the package does not preserve it.

## Step 5 — delete your copy of the fetch layer

```js
// src/api/fetchUtils.js
export * from "@devopsnext/starterkit-config-util/fetch";
```

Then audit call sites for the bypass helpers. **This is the highest-value step in the migration:**

```bash
# every place a probe/health check goes through the 401 boundary
grep -rn "getJSON(.*\(health\|actuator\|ping\|status\)" src/

# images fetched through the JSON helper
grep -rn "getJSON(.*\(photo\|avatar\|image\|logo\)" src/
```

| Found | Change to |
|---|---|
| `getJSON(".../actuator/health")` | `probeFetch(".../actuator/health")` |
| `getJSON(".../photo")` returning binary | `getBlob(...)` |
| `postJSON` expecting audio/binary back | `postBinary(...)` |

> A briefing page's connection check called `/actuator/health` through `getJSON`, the gateway answered 401, and a candidate pressing Start on their emailed link was signed out by a health check — on a route that deliberately requires no sign-in. Do this grep.

### Match your decompression behaviour

If your app was the one that returns a `payload`-carrying response untouched:

```js
setConfigSource(config, { payloadOnlyDecompress: false });
```

Check your `.env*` files for `RESPONSE_DECOMPRESS` before deciding — the two apps genuinely differ here, and only for a response carrying `payload` alongside other keys. [[Auth Fetch#the-one-live-fork]].

### Match your 401 behaviour

The default is clear-token + `${OAUTH_SERVICE_URL}/logout?USER_TYPE=USER`. If yours differs, pass `onUnauthorized`.

## Step 6 — env.json decoding

**Before** — a decoder with a camelCase → UPPER_SNAKE transform and a lookup table.

**After**

```js
import { decodeEnvJson, unknownKeys } from "@devopsnext/starterkit-config-util/env-json";

const { overrides, keys } = decodeEnvJson(text);
```

**Keys are now verbatim.** If your deployed `env.json` is still written in the old dialect (`REACT_APP_idleTime` rather than `IDLE_TIME`), those keys will now land unread. Catch it before deploying:

```js
const stray = unknownKeys(overrides, new Set(Object.keys(baseEnv)));
if (stray.length) console.warn("env.json sets keys nothing reads:", stray);
```

Fix the payload, not the code — the translation layer is exactly what was removed.

## Step 7 — replace ad-hoc flag parsing

```bash
grep -rn "=== 'true'\|== \"true\"\|Boolean(process.env" src/
```

```js
import { parseBoolean, parseNumber } from "@devopsnext/starterkit-config-util";

if (parseBoolean(config.FEATURE_X)) { }
const idle = parseNumber(config.IDLE_TIME, 3600);
```

## Step 8 — add a build-time gate

```js
import { requiredConfigKeys } from "@devopsnext/starterkit-config-util";
import config from "../src/config/index.js";

const missing = requiredConfigKeys().filter((k) => !config[k]);
if (missing.length) {
  console.error("Missing required config keys:", missing.join(", "));
  process.exit(1);
}
```

Using `requiredConfigKeys()` rather than a hardcoded list means the gate and the package can never disagree after a key remap.

## Step 9 — verify

```bash
pnpm typecheck && pnpm test && pnpm build
```

Then, in a browser:

- [ ] sign in — a token lands in encrypted storage
- [ ] an authenticated call returns data
- [ ] a deliberate 401 (expire the token) redirects to OAuth logout, and storage is cleared
- [ ] a health-check / probe screen does **not** sign you out
- [ ] an avatar 404 does **not** sign you out
- [ ] a static export / prerender build completes (no `localStorage is not defined`)
- [ ] if you use `env.json`: change a key in it, reload, see the new value take effect

## What you should have deleted

| File | Replaced by |
|---|---|
| `src/api/ApiUtils.jsx` (body) | `./storage` |
| `src/api/fetchUtils.js` (body) | `./fetch` |
| local `parseBoolean` / `getEnvBoolean` / `parseNumber` | `.` |
| local env.json decoder + mapping table | `./env-json` |
| local `buildCompressedPayload` | `./payload` |
| the trailing-slash regex in `derive.js` | `normalizeOrigin` |

## What you should still have

`env.base.js` · `env.<name>.js` · `derive.js` (the path map) · `.env*` · your OAuth authorize/redirect URL builders.

---

Hitting an error? [[Troubleshooting]].
