# Contributing

Working on the package itself.

## Setup

```bash
git clone git@github.com:thinktalentservice-ai/starterkit-config-util.git
cd starterkit-config-util
pnpm install
```

`pnpm-workspace.yaml` approves esbuild's postinstall (it ships a platform-specific binary) — pnpm reads build-script approvals from there, no longer from `package.json`.

## Scripts

| Command | What it does |
|---|---|
| `pnpm verify` | **the gate**: `typecheck → test → build → lint:dist` |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | `vitest run` |
| `pnpm test:watch` | `vitest` |
| `pnpm build` | `tsc --noEmit && tsup` |
| `pnpm dev` | `tsup --watch` |
| `pnpm lint:dist` | `node scripts/check-dist.mjs` |

Run `pnpm verify` before opening a PR. It is the same sequence CI runs.

## Repo layout

```
src/
  index.ts  origin.ts  env-boolean.ts  app-config.ts  config-source.ts   ← the `.` entry
  env-json.ts  storage.ts  fetch.ts  payload.ts                          ← peer-using entries
  *.test.ts                                                              ← colocated tests
scripts/check-dist.mjs   ← artefact assertions
tsup.config.ts           ← build shape, heavily commented
vitest.config.ts         ← jsdom, not node
```

## TypeScript settings that will bite you

`tsconfig.json` is strict on purpose:

- `strict`
- `noUncheckedIndexedAccess` — `arr[0]` is `T | undefined`; that is why you see `signals[0]!`
- `noUnusedLocals` / `noUnusedParameters` — prefix intentionally-unused params with `_`
- `verbatimModuleSyntax` — use `import type { … }` for type-only imports
- `isolatedModules`
- ES2022 target — `Error.cause`, `Object.hasOwn`, `AbortSignal.any` are all in play

Relative imports inside `src/` carry the **`.js` extension** (`./config-source.js`), matching `moduleResolution: "Bundler"` + ESM output. Do not strip them.

## Tests

`vitest` under **jsdom**, not node: the storage utilities are written against the real `Storage` interface and secure-ls touches `localStorage` in its constructor. Faking those in node would test the fake.

| File | Covers |
|---|---|
| `app-config.test.ts` | env resolution, prototype-chain guard, ordering |
| `config-source.test.ts` | registry identity, option validation, throw-when-unset |
| `env-boolean.test.ts` | every truthy/falsy string, the override asymmetry |
| `env-json.test.ts` | both file shapes, verbatim keys, every throw |
| `origin.test.ts` | the three cases including the deliberate `""` |
| `storage.test.ts` | lazy + secret-keyed SecureLS, mirrorRaw, `""` vs `null` |
| `storage.prerender.test.ts` | the no-`window` path |
| `fetch.test.ts` | headers, 401 boundary, the bypasses, **both** decompression branches |
| `payload.test.ts` | the double stringify |

Registry state is global, so reset it:

```js
import { setConfigSource, clearConfigSource } from "../src/config-source.js";

beforeEach(() => setConfigSource({ STORAGE_SECRET: "test-secret", OAUTH_SERVICE_URL: "https://oauth.test" }));
afterEach(() => clearConfigSource());
```

### What a new test must pin

If you touch behaviour that differs between the two consuming apps — decompression, `mirrorRaw`, the 401 default — **pin both branches**. A live divergence documented away in a comment is how the two copies drifted to begin with.

## `scripts/check-dist.mjs`

Assertions about the built artefact that no unit test can make. It walks the module graph or reads `package.json` — never greps a single file, because `grep dist/index.js for jose` passes trivially the moment code splitting is on.

It asserts:

1. **ESM only** — no `main`, no `require` condition in any export, no `.cjs` in `dist/`.
2. **Every declared export exists** — each `types`/`import` path resolves on disk.
3. **The `.` entry is genuinely zero-dependency** — walked **transitively** over the built graph.
4. **The peer-using entries do reach their peers** — so the graph walk cannot silently go vacuous and pass for the wrong reason.
5. **The registry lives in exactly one chunk** — a second copy means `setConfigSource` and `getConfig` land on different objects.

It has been fault-injected: adding `import "jose"` to `src/index.ts` turns it red. If you change the build, re-do that injection and confirm it still fails.

## Rules for changes

1. **No module-scope config reads.** Every value is read inside the function that needs it.
2. **No module-scope browser API access.** No `localStorage`, `sessionStorage`, `window` or `document` at import time. Guard with `typeof`, and try/catch storage access (Safari private mode throws).
3. **Nothing app-specific.** Service paths, environment names and key values belong to the consumer. If it varies per app, it is deployment data.
4. **New options are validated.** Add the name to `KNOWN_OPTIONS`; an unvalidated option silently reverts to a default.
5. **Errors name the fix.** Every throw in this package says what to do next. Match that.
6. **Comments explain *why*.** The density here is deliberate — each block records a failure that actually shipped. Do not trim them for tidiness.
7. **No new runtime dependencies.** Peers only, and declared optional.

## Adding an export

To an existing entry: export it from the module and re-export from `src/index.ts` if it belongs to the zero-peer entry (**and only if it pulls no peer**).

A whole new entry:

1. create `src/<name>.ts`
2. add it to `entry` in `tsup.config.ts`
3. add an `exports["./<name>"]` block with `types` + `import` (never `require`)
4. `pnpm verify` — `check-dist.mjs` will confirm the export resolves and that the dependency split held

## Releasing

```bash
pnpm verify
npm version <patch|minor|major>
pnpm pack          # inspect the tarball: dist/ + README.md only
npm publish        # publishConfig.access is already "public"
git push --follow-tags
```

`files: ["dist", "README.md"]` — source and tests are not published.

## Documentation

- `README.md` — the package's front page, oriented to *why*.
- This wiki — the developer-facing detail.

Behaviour changes need both. If you change a default, say so in [[Configuration]] and [[API Reference]]; if you add a failure mode, add its message to [[Troubleshooting]].
