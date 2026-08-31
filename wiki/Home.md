# @devopsnext/starterkit-config-util

App-config resolution, secure browser storage and an authenticated `fetch` layer — the mechanism that was byte-identical across the Think Talent frontends, extracted once so it can stop drifting.

> **Mechanism only.** Your app keeps its own `.env*` files, its own environment names, its own service-path map and its own `env.base.js`. This package owns none of your deployment data.

```bash
pnpm add @devopsnext/starterkit-config-util
```

ESM-only · Node >= 18 · all three peers (`jose`, `secure-ls`, `@devopsthink/react-security-util`) optional.

---

## Start here

| I want to… | Page |
|---|---|
| install it and wire it up in 5 minutes | **[[Getting Started]]** |
| know what every export does | **[[API Reference]]** |
| understand why it is built this way | **[[Architecture]]** |
| resolve config across base / env / env.json | **[[Configuration]]** |
| call an API with a bearer token | **[[Auth Fetch]]** |
| read/write encrypted localStorage, sign a JWT | **[[Secure Storage]]** |
| port an existing app onto the package | **[[Migration Guide]]** |
| fix an error I just hit | **[[Troubleshooting]]** |
| work on the package itself | **[[Contributing]]** |
| quick answers | **[[FAQ]]** |

---

## The 30-second version

```js
// src/config/index.js — ONCE, at module scope
import { createAppConfig, setConfigSource } from "@devopsnext/starterkit-config-util";
import baseEnv from "./env.base";
import devEnv  from "./env.dev";
import thinkEnv from "./env.think";

const config = createAppConfig({
  base: baseEnv,
  envs: { dev: devEnv, think: thinkEnv },   // STATIC imports, object literal
  appEnv: process.env.NEXT_PUBLIC_APP_ENV || "dev",
});

setConfigSource(config, { mirrorRaw: true });
export default config;
```

```js
// anywhere else
import { getJSON, postJSON } from "@devopsnext/starterkit-config-util/fetch";

const user = await getJSON(`${config.LANDING_USER_SERVICE_URL}/user/me`);
```

That is the whole integration. Everything else on this wiki is detail.

---

## The six entry points

| Import | What it gives you | Peers it pulls |
|---|---|---|
| `@devopsnext/starterkit-config-util` | config resolution, the registry, env parsing, `normalizeOrigin` | **none** |
| `…/env-json` | decrypt a deployed `env.json` into overrides | react-security-util |
| `…/storage` | `ApiUtils` — AES localStorage + JWT sign/decode | jose, secure-ls, react-security-util |
| `…/fetch` | `getJSON`, `postJSON`, … + the 401 boundary | (via `./storage`) |
| `…/payload` | `buildCompressedPayload` | react-security-util |
| `…/integrations` | run the `javascript_integration` table's third-party snippets | **none** |

The split is load-bearing: a server file or route that only wants `parseBoolean` must not drag `jose` and `secure-ls` into its bundle. `scripts/check-dist.mjs` asserts that over the *built* module graph, transitively — see [[Architecture]].

---

## Five rules that prevent every bug this package was built for

1. **Read config at call time.** Never `const secret = getConfig().STORAGE_SECRET` at module scope.
2. **Register environments from static imports.** Never `require(\`./env.${name}\`)`.
3. **`overrides` (env.json) goes last.** It is the runtime layer; it must win.
4. **Never route a health check / probe / avatar through `getJSON`.** Use `probeFetch` / `getBlob`.
5. **Wire once, before anything reads.** `getConfig()` throws by design if you don't.

Each rule has a production incident behind it. [[Architecture]] tells those stories.
