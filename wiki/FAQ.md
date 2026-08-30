# FAQ

### Why doesn't the package own `env.base.js` / my service paths?

Because they are **deployment data**, not mechanism. One app derives `/landing-user-service`, another `/ai-interview-user-service` plus a `LANDING_DOMAIN_URL` that is not a service at all. A package-owned default is also un-greppable from the consumer, which is the one property those files exist to have.

There is a second, load-bearing reason for `derive.js`: at least one host's build gate AST-parses it for a returned object literal to enumerate config keys. Move the function into a package and the gate can no longer name them.

### Can I use this from CommonJS?

Not with `require()`. Use `import`, or a dynamic `await import(...)` from CJS. Build scripts should be `.mjs`. Node >= 22 can `require()` ESM anyway. [[Architecture#why-esm-only]].

### Do I have to install all three peers?

No. All are optional. The `.` entry needs none. Install `@devopsthink/react-security-util` for `./env-json` and `./payload`; add `jose` and `secure-ls` for `./storage` and `./fetch`.

### Will importing `parseBoolean` pull `jose` into my bundle?

No — that is the entire reason for the five-entry split, and `scripts/check-dist.mjs` asserts it over the built, transitive module graph.

### Why does `getConfig()` throw instead of returning `{}`?

Because the silent version is worse. An undefined encryption secret makes secure-ls fail every decrypt, every accessor returns `null`, and the app looks to every user exactly as though they had been signed out — no error, no log, a green build. One stack trace at first use is cheaper.

Use `hasConfigSource()` if you genuinely want to degrade.

### Can I call `setConfigSource` more than once?

Technically yes — the last call wins. Don't. Calling it from a component or an effect means module-scope consumers may already have thrown. Call it once, at module scope, in the module that builds the config.

### Why does `setConfigSource` throw on unknown options?

A typo'd `mirrorRaw` silently reverts to the default — a plaintext copy of your storage that starts or stops being written with nothing to say so. That is exactly the class of silent misconfiguration this package exists to prevent.

### My key names aren't `STORAGE_SECRET` / `OAUTH_SERVICE_URL` / `RESPONSE_DECOMPRESS`.

Remap them:

```js
setConfigSource(config, { keys: { storageSecret: "APP_STORAGE_SECRET" } });
```

Then feed `requiredConfigKeys()` to your build gate so it asserts the resolved names.

### Why does `getLocalStorage` return `""` for a missing key instead of `null`?

Because that is what secure-ls returns, `?? null` does not catch it (`""` is not nullish), and both consuming apps already depend on it being falsy. Tightening it would be a silent behaviour change across two apps in exchange for tidiness.

### Is `env.json` secure?

**No.** It is obfuscated. The encryption key lives inside `@devopsthink/react-security-util`, which ships to the browser — anyone with the bundle can read it. Nothing confidential may go in it.

### Why are the keys in `env.json` not translated to UPPER_SNAKE?

A translation layer fails in the direction nobody notices: a key with no mapping row and no clean transform lands on the config object under a name nothing reads, so the override is "applied" and changes nothing. Whoever writes `env.json` writes the key the code reads. `unknownKeys()` reports the strays.

### Why is `mirrorRaw` off by default?

Writing a decrypted copy of `userInfo` next to the encrypted one is the exact thing secure-ls exists to prevent. One app opts in because its debug tooling reads those mirrors.

### What is `payloadOnlyDecompress` and which value do I want?

The one place the two consuming apps genuinely disagree, and only for a response carrying `payload` **alongside** other keys. `true` (default) still decompresses a response whose *only* key is `payload`; `false` returns everything untouched. Match whichever app you are migrating. [[Auth Fetch#the-one-live-fork]].

### Why do `probeFetch`, `getBlob` and `postBinary` skip the 401 boundary?

Because the boundary clears the token and redirects to OAuth logout — correct for a real API call by a signed-in user, catastrophic for anything else. A health check once signed out candidates on a route that requires no sign-in at all. A picture is not worth a session.

### Does `timeout` replace my `AbortSignal`?

No. They are composed with `AbortSignal.any()`. Assigning one over the other is how a caller's cancellation silently stops working when someone later adds a timeout.

### Can I use this without the global registry?

Yes. Every factory takes an explicit `getConfig`:

```js
const ApiUtils = createApiUtils({ getConfig: () => config });
const api = createFetchHelpers({ getConfig: () => config, apiUtils: ApiUtils });
```

Pass a **function**, not a captured value.

### Does it work with SSR / static export?

Yes. Nothing touches browser APIs at module scope; SecureLS is constructed lazily and guarded, `sessionStorage` access is `typeof`-guarded and try/caught. Accessors no-op on the server and return `null`.

### Is it React-specific?

No. No React import, no hook, no `"use client"` banner — deliberately, so a server file can import `parseBoolean`. It works in Next.js, Vite, plain Node scripts and build gates.

### Why `globalThis` + `Symbol.for` for the registry?

Mutable module state that can be bundled twice means the host wires one copy and the code that matters reads another — with a green build. A registered symbol is cross-realm, so even two genuinely separate instances share one store. Belt and braces alongside the ESM-only build.

### How do I test code that uses this?

```js
import { setConfigSource, clearConfigSource } from "@devopsnext/starterkit-config-util";

beforeEach(() => setConfigSource({ STORAGE_SECRET: "test-secret", OAUTH_SERVICE_URL: "https://oauth.test" }));
afterEach(() => clearConfigSource());
```

Use jsdom, not node — secure-ls needs a real `Storage`.

### Where do I report a bug?

[github.com/thinktalentservice-ai/starterkit-config-util/issues](https://github.com/thinktalentservice-ai/starterkit-config-util/issues). Include the diagnostic block at the bottom of [[Troubleshooting]].
