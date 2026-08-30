# Architecture

Why the package is shaped the way it is. Every decision below has a production failure behind it — that is the reason the source carries such long comments, and the reason this page exists.

## Module map

```
src/
  index.ts           .          → zero-peer entry (re-exports the four below)
    origin.ts        .          normalizeOrigin
    env-boolean.ts   .          parseBoolean / getEnvBoolean / parseNumber
    app-config.ts    .          createAppConfig
    config-source.ts .          the registry: setConfigSource / getConfig / resolvedOptions

  env-json.ts        ./env-json → decodeEnvJson, unknownKeys        [react-security-util]
  storage.ts         ./storage  → ApiUtils, encode/decodeJwtString  [jose, secure-ls, rsu]
  fetch.ts           ./fetch    → authFetch + helpers               [→ storage]
  payload.ts         ./payload  → buildCompressedPayload            [react-security-util]
```

Dependency direction is one-way: `fetch → storage → config-source`, and `config-source` imports nothing. Nothing imports React or touches the DOM at module scope.

## The registry, and why it holds a reference

`setConfigSource(config)` stores **the object, never a copy**. `getConfig()` hands the same object back. Every read inside the package happens *inside the function that needs the value*.

That is what makes a runtime overlay work. One consuming app re-applies its deployed `env.json` in the browser with `Object.assign(config, overrides)` on the same object every module imported — reaching ~27 consumers with no provider and no rewrite, but **only** because nothing captured a value at module scope.

```js
// GOOD — reads at call time, sees the overlay
function secret() { return getConfig().STORAGE_SECRET; }

// BAD — captured at module scope; the one key in your app that ignores env.json
const secret = getConfig().STORAGE_SECRET;
```

The host app's own build gate sweeps its `src/` for that second shape. It cannot see into `node_modules`, so here the rule is kept **by construction and by test** instead.

### Why `globalThis` + `Symbol.for`, not a module-level `let`

Mutable module state that can be bundled or resolved twice has a duplicate-instance hazard: the host wires one copy, the code that matters reads the other, `getConfig()` throws — and the build stays green. Three separate mechanisms can produce that duplicate (a dual ESM/CJS build, `splitting: false`, a consumer resolving both conditions in different graphs).

`Symbol.for("@devopsnext/starterkit-config-util/registry")` is a **cross-realm registered symbol**, so even two genuinely separate instances of the module resolve the same key and share one store. Cost: one property lookup. Benefit: removes a class of failure no consumer could diagnose.

### Why `getConfig()` throws

The alternative failure is silence. With an undefined encryption secret, secure-ls fails every decrypt, every accessor returns `null`, and the app presents to every user exactly as though they had been signed out — no error, no log, a green build. A named throw at first use costs one stack trace and saves that.

## `createAppConfig`: two defects it exists to kill

**1 — a dynamic `require()` does not fail loudly.**
Both apps started with a template-literal `require("./env." + appEnv).default`. That becomes a bundler *context module*, so a bad name is a runtime `Cannot find module './env.prod'` inside a client chunk: a white screen, no server log, on whichever route first touches config. One app's `.env.think` set `NEXT_PUBLIC_APP_ENV=prod` for months while no `env.prod.js` existed — every build green.

Taking `envs` as an object built from **static imports** moves that failure to build time, because a static export prerenders every route and every route imports the config module.

**2 — a bare index walks the prototype chain.**
`envs["constructor"]` resolves to an inherited `Object` member. It is *truthy*, so an "unknown environment" guard never fires and the build proceeds with the env config bound to a **function**. Every `config.*` read is then `undefined` and the app ships with empty service URLs — from a single typo in a CI variable. Same for `toString`, `valueOf`, `hasOwnProperty`, `__proto__`.

`Object.hasOwn` is the whole fix, and it is why this is a function rather than three lines inlined in each app.

**Ordering:** `{ ...base, ...envs[appEnv], ...overrides }`. `overrides` last, because it is the runtime layer and the entire point is that it wins — an app that spreads it earlier has an override mechanism that silently does nothing. Optional, because not every app has one.

## What deliberately stayed in your app

| Stays in YOUR app | Why |
|---|---|
| `env.base.js` | your keys. A package-owned default is un-greppable from the consumer — the one property this file exists to have. |
| `env.<name>.js` | your environments. One app has three, another five (`dev`, `test`, `think`, `elus`, `lb`). |
| `derive.js` service-path map | one app derives `/landing-user-service`, another `/ai-interview-user-service` plus a `LANDING_DOMAIN_URL` that is not a service at all. Only `normalizeOrigin()` moved. |
| OAuth authorize/redirect URL builders | `redirect_uri` depends on your `BASE_PATH` and on reading `location.origin` at call time. The only OAuth URL this package owns is the **logout** default on a 401. |
| `.env*` | obviously |

Keeping `derive.js` in the app is load-bearing for at least one consumer: its `check-env-config.mjs` gate resolves the `...deriveServiceUrls(x)` spread by AST-parsing that file for a returned object **literal** imported from `"./derive"`. Move the function into a package and the gate can no longer name the keys — which is exactly the visibility whose absence once shipped `window.location.replace("undefined/oauth/authorize?…")` to production.

## Entry splitting

A route that only wants `parseBoolean` must not pull `jose` and `secure-ls` into its bundle. The five entries exist for that, and `scripts/check-dist.mjs` asserts it over the **built, transitive** module graph — a `grep dist/index.js` version of the check passes trivially the moment code splitting is on.

## Why ESM-only

Two independently verified reasons, not a preference:

1. **`jose` is ESM-only.** Its `exports["."]` has no `require` condition, so a CJS `storage.cjs` would emit `require("jose")` and throw `ERR_REQUIRE_ESM` on the declared `engines` range. The CJS entry would be dead on arrival with nothing in a normal build to say so.
2. **tsup does not code-split CJS.** Each subpath entry inlines its own copy of every shared module. This graph has mutable module state (the registry), so duplicated copies mean the host calls `setConfigSource` on one registry while `./storage` reads another — `getConfig()` throwing in an app whose build was green.

(2) is *separately* defended by the `Symbol.for` registry. Belt and braces: the symbol handles a duplicate the build cannot see, ESM-only stops the build from creating one, and `check-dist.mjs` asserts both.

Cost: nil for the verified consumers. Next 16 resolves the `import` condition for both its server and client graphs, every build gate is a `.mjs` run under Node, and Node >= 22 can `require()` ESM anyway.

## Build shape (`tsup.config.ts`)

| Setting | Reason |
|---|---|
| `format: ["esm"]` | above |
| `splitting: true` | written out explicitly — off would give every entry its own registry copy, the same fork CJS causes |
| `target: "es2022"` | the code relies on `Error.cause`, `Object.hasOwn`, `AbortSignal.any` |
| **no** `treeshake: true` | that option post-processes through rollup, which strips module-level directives; esbuild already tree-shakes when bundling |
| **no** `"use client"` banner | nothing here is a component and nothing calls a hook; a banner would put the whole module in the client graph and stop a server file importing `parseBoolean` |
| `external: ["jose", /^jose\//, "secure-ls", "@devopsthink/react-security-util"]` | the regex is defensive: a future `jose/errors` import would not match the bare string and esbuild would silently inline a second copy |

## SSR / prerender safety

A static export prerenders on a machine with no `localStorage`, no `sessionStorage`, no `window`.

- `new SecureLS(...)` touches `localStorage` **in its constructor**, so it is constructed lazily at first accessor call, never at module scope. Otherwise importing any controller from a prerendered route crashes the build.
- The `typeof window === "undefined"` guard is *not* redundant with the laziness: a client component's module still evaluates on the server during prerender, and an accessor called from a component body would run there too. Returning `null` lets accessors no-op there rather than throw.
- The SecureLS instance is cached **keyed on the secret**, not unconditionally — otherwise an `env.json` overlay that changes `STORAGE_SECRET` would be ignored and the lazy read would be decorative.
- `sessionStorage.getItem(...)` is `typeof`-guarded *and* try/caught (Safari private mode and blocked site data throw on access). A storage failure must not decide how responses are parsed.

## Testing strategy

`vitest` under **jsdom**, not node — the storage utilities are written against the real `Storage` interface and secure-ls touches `localStorage` in its constructor. Faking those in node would test the fake. `storage.prerender.test.ts` covers the no-window path specifically.

See [[Contributing]] for the verify pipeline and what `check-dist.mjs` proves.
