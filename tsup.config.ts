import { defineConfig, type Options } from "tsup";

// ESM ONLY, AND THAT IS A CORRECTNESS DECISION, NOT A PREFERENCE.
//
// The sibling packages this was scaffolded from ship dual ESM/CJS. Copying that
// here produces a build that is BROKEN IN TWO INDEPENDENT WAYS, both verified
// against the artefacts rather than reasoned about:
//
//  1. `jose` is ESM-only. Its package.json is `"type": "module"` and its
//     `exports["."]` offers only `types` and `default` -- there is no `require`
//     condition. A CJS `dist/storage.cjs` would emit `require("jose")`, which
//     throws ERR_REQUIRE_ESM on every Node below 22 and is a hard failure on the
//     `engines: node >=18` this package declares. The CJS entry would be dead on
//     arrival and nothing in a normal build would say so.
//
//  2. tsup does NOT code-split the CJS format. Each subpath entry therefore gets
//     its OWN inlined copy of every shared module -- confirmed by inspecting the
//     sibling package's dist/, where the ESM build shares a chunk and the CJS
//     build inlines the same source into two entries. This module graph has
//     MUTABLE MODULE STATE (the config registry), so duplicated copies mean the
//     host calls `setConfigSource` on one registry while `./storage` reads
//     another: getConfig() throws, or worse returns an empty config, in an app
//     whose build was green.
//
// (2) is separately defended against by the `Symbol.for` registry in
// src/config-source.ts, which survives duplicate instances by design. Belt and
// braces: the symbol handles a duplicate this build cannot see, and ESM-only
// stops this build from creating one.
//
// The cost of dropping CJS is nil for the verified consumers: Next 16 resolves
// the `import` condition for both its server and client graphs, and every build
// gate in the host is a `.mjs` run under Node. Node >=22 can `require()` an ESM
// package anyway.
const shared: Options = {
  format: ["esm"],
  dts: true,
  sourcemap: true,
  // ES2022, not ES2020: the ported code relies on Error `cause` and
  // Object.hasOwn, and the apps consuming it already ship AbortSignal.any
  // (Baseline 2024). Lowering the target would not make those APIs exist.
  target: "es2022",
  // NOT `treeshake: true`. That option post-processes the bundle through rollup,
  // which strips module-level directives. esbuild already tree-shakes when
  // bundling, so the option buys nothing and can only take something away.
  //
  // Every peer is external. The `/^jose\//` regex is defensive rather than
  // currently load-bearing -- this package imports bare "jose" today, but a
  // future `jose/errors` import would not be matched by the bare string and
  // esbuild would silently inline a second copy of the library.
  external: [
    "@devopsthink/react-security-util",
    "jose",
    /^jose\//,
    "secure-ls",
  ],
};

export default defineConfig([
  {
    ...shared,
    clean: true,
    entry: {
      index: "src/index.ts",
      "env-json": "src/env-json.ts",
      storage: "src/storage.ts",
      fetch: "src/fetch.ts",
      payload: "src/payload.ts",
    },
    // DELIBERATELY NO "use client" BANNER. Nothing here is a React component and
    // nothing calls a hook. A banner would put the whole module in the client
    // graph and stop a server file from importing `parseBoolean`.
    //
    // `splitting: true` is written out rather than left to the format default,
    // because turning it off would give every entry its own copy of the registry
    // -- the same fork the CJS format causes. scripts/check-dist.mjs asserts the
    // shared chunk actually exists, so this cannot regress quietly.
    splitting: true,
  },
]);
