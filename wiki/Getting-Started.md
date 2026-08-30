# Getting Started

Five minutes from `pnpm add` to a working authenticated API call.

## 1. Requirements

| | |
|---|---|
| Node | `>= 18` |
| Module format | **ESM only** — no `require()` entry ships ([why](Architecture#why-esm-only)) |
| Package manager | pnpm (npm/yarn work; the repo itself uses pnpm) |

## 2. Install

```bash
pnpm add @devopsnext/starterkit-config-util
```

Then add only the peers you actually use:

```bash
# needed by ./storage and ./fetch
pnpm add jose secure-ls @devopsthink/react-security-util

# needed by ./env-json and ./payload
pnpm add @devopsthink/react-security-util
```

All three peers are declared **optional**. The `.` entry needs none of them — if your app only wants `parseBoolean` / `createAppConfig`, install nothing extra.

## 3. Lay out your config files

The package does not own these. You do.

```
src/config/
  env.base.js      # keys present in every environment
  env.dev.js       # per-environment overrides
  env.think.js
  derive.js        # your service-path map (stays in your app — see below)
  index.js         # builds the config + wires the package
```

`env.base.js`:

```js
export default {
  STORAGE_SECRET: process.env.NEXT_PUBLIC_STORAGE_SECRET,
  OAUTH_SERVICE_URL: process.env.NEXT_PUBLIC_OAUTH_SERVICE_URL,
  RESPONSE_DECOMPRESS: process.env.NEXT_PUBLIC_RESPONSE_DECOMPRESS,
  IDLE_TIME: process.env.NEXT_PUBLIC_IDLE_TIME,
};
```

`derive.js` — **stays in your app**, deliberately. Every app derives different service paths, and at least one app's build gate AST-parses this file for a returned object *literal* to enumerate the keys it must declare. Only the trailing-slash normalisation moved into the package:

```js
import { normalizeOrigin } from "@devopsnext/starterkit-config-util";

export function deriveServiceUrls(env) {
  const origin = normalizeOrigin(env.SERVICE_URL);   // strips trailing "/"
  return {
    OAUTH_SERVICE_URL: `${origin}/oauth-service`,
    NEXT_SERVICE_URL: `${origin}/next-service`,
    LANDING_USER_SERVICE_URL: `${origin}/landing-user-service`,
  };
}
```

## 4. Build the config and wire the package

```js
// src/config/index.js
import { createAppConfig, setConfigSource } from "@devopsnext/starterkit-config-util";
import baseEnv from "./env.base";
import devEnv from "./env.dev";
import thinkEnv from "./env.think";
import { deriveServiceUrls } from "./derive";

const ENV_CONFIGS = { dev: devEnv, think: thinkEnv };   // static imports only

const resolved = createAppConfig({
  base: baseEnv,
  envs: ENV_CONFIGS,
  appEnv: process.env.NEXT_PUBLIC_APP_ENV || "dev",
});

const config = { ...resolved, ...deriveServiceUrls(resolved) };

setConfigSource(config, { mirrorRaw: true });

export default config;
```

**Import this module before anything reads from the package.** In Next.js that usually means importing it from your root layout (or from the module that every API wrapper already imports).

## 5. Use it

```js
import ApiUtils from "@devopsnext/starterkit-config-util/storage";
import { getJSON, postJSON, postFormData } from "@devopsnext/starterkit-config-util/fetch";
import config from "@/config";

// encrypted localStorage
ApiUtils.setCookie("accessToken", token);
const token = ApiUtils.getCookie("accessToken");

// authenticated calls — bearer header + 401 boundary are automatic
const me      = await getJSON(`${config.LANDING_USER_SERVICE_URL}/user/me`);
const created = await postJSON(`${config.LANDING_USER_SERVICE_URL}/user`, { name: "Ada" });

// uploads: no Content-Type, the browser sets the multipart boundary
const fd = new FormData();
fd.append("file", file);
await postFormData(`${config.NEXT_SERVICE_URL}/upload`, fd);
```

## 6. Verify the wiring

```js
import { hasConfigSource, requiredConfigKeys } from "@devopsnext/starterkit-config-util";

console.log(hasConfigSource());     // true
console.log(requiredConfigKeys());  // ["STORAGE_SECRET","OAUTH_SERVICE_URL","RESPONSE_DECOMPRESS"]
```

`requiredConfigKeys()` returns the **resolved** names (after any remap), which is exactly what a build-time env gate should assert your config declares.

## Optional: a deployed `env.json` layer

If DevOps serves a runtime `env.json`, decode it and pass it as `overrides` — last, so it wins:

```js
import { decodeEnvJson } from "@devopsnext/starterkit-config-util/env-json";

const { overrides } = decodeEnvJson(await (await fetch("/env.json")).text());

const config = createAppConfig({ base, envs, appEnv, overrides });
```

Full details, including re-applying it in the browser: [[Configuration#the-envjson-runtime-layer]].

---

## Common first-run failures

| Symptom | Cause | Fix |
|---|---|---|
| `no config source is set` | nothing imported your config module yet | import `src/config/index.js` from the root layout |
| `appEnv="prod" has no matching env config` | env var names an environment you never registered | add the module + register it in `envs` |
| every storage read returns `null` | `STORAGE_SECRET` unset | set it; see [[Troubleshooting#everything-looks-signed-out]] |
| a health check signs users out | probe went through `getJSON` | use `probeFetch` — [[Auth Fetch#the-three-deliberate-bypasses]] |

More: [[Troubleshooting]].
