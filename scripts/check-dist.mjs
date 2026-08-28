/**
 * Assertions about the BUILT ARTEFACT that no unit test can make.
 *
 * Three of these exist because the naive version of the check cannot fail:
 * "grep dist/index.js for jose" passes trivially the moment code splitting is
 * on, because the import moved into a chunk file. Every check here therefore
 * walks the module graph or reads package.json, never a single file.
 *
 * Run after `tsup` (see the `verify` script).
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");

const problems = [];
const fail = (m) => problems.push(m);

if (!existsSync(DIST)) {
  console.error("\n✖ dist/ does not exist. Run `pnpm build` first.\n");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

/* ── 1. ESM only ─────────────────────────────────────────────────────────────
   Two independent reasons, both verified rather than assumed:
     · `jose` is ESM-only (no `require` condition in its exports), so a CJS
       entry would throw ERR_REQUIRE_ESM on the engines range declared here.
     · tsup does not code-split CJS, so every subpath entry would inline its own
       copy of the config registry and setConfigSource/getConfig would land on
       different objects while the build stayed green.                        */

if (pkg.main) fail(`package.json still declares "main": ${pkg.main}. This package is ESM-only.`);

for (const [subpath, conditions] of Object.entries(pkg.exports ?? {})) {
  if (typeof conditions !== "object") continue;
  if (conditions.require) {
    fail(
      `exports["${subpath}"] declares a "require" condition. jose is ESM-only and tsup does not ` +
        `code-split CJS - a CJS build both fails at require() time and forks the config registry.`,
    );
  }
  if (!conditions.import) fail(`exports["${subpath}"] has no "import" condition.`);
  if (!conditions.types) fail(`exports["${subpath}"] has no "types" condition.`);
}

const cjs = readdirSync(DIST).filter((f) => f.endsWith(".cjs"));
if (cjs.length) fail(`dist/ contains ${cjs.length} .cjs file(s): ${cjs.slice(0, 4).join(", ")}`);

/* ── 2. every declared export actually exists ───────────────────────────── */

for (const [subpath, conditions] of Object.entries(pkg.exports ?? {})) {
  if (typeof conditions !== "object") continue;
  for (const [condition, file] of Object.entries(conditions)) {
    const abs = path.join(ROOT, file);
    if (!existsSync(abs)) {
      fail(`exports["${subpath}"].${condition} points at ${file}, which does not exist.`);
    }
  }
}

/* ── 3. the zero-dependency entry really is zero-dependency ──────────────────
   Walked TRANSITIVELY. `grep dist/index.js` is the version of this check that
   cannot fail: with splitting on, the peer import lives in a chunk. */

const BARE = /^\s*(?:import|export)[^'"]*?from\s*["']([^"'.][^"']*)["']/gm;
const RELATIVE = /^\s*(?:import|export)[^'"]*?from\s*["'](\.[^"']*)["']/gm;
const SIDE_EFFECT = /^\s*import\s*["']([^"']+)["']/gm;

function closureOf(entryFile) {
  const seen = new Set();
  const queue = [entryFile];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(RELATIVE)) {
      queue.push(path.resolve(path.dirname(file), m[1]));
    }
    for (const m of text.matchAll(SIDE_EFFECT)) {
      if (m[1].startsWith(".")) queue.push(path.resolve(path.dirname(file), m[1]));
    }
  }
  return seen;
}

function bareSpecifiersIn(files) {
  const out = new Set();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(BARE)) out.add(m[1]);
    for (const m of text.matchAll(SIDE_EFFECT)) {
      if (!m[1].startsWith(".")) out.add(m[1]);
    }
  }
  return out;
}

const indexClosure = closureOf(path.join(DIST, "index.js"));
const indexDeps = bareSpecifiersIn(indexClosure);
if (indexDeps.size) {
  fail(
    `the "." entry is meant to be zero-dependency, but its module closure imports ` +
      `${[...indexDeps].join(", ")}.\n` +
      `    Closure: ${[...indexClosure].map(rel).join(", ")}\n` +
      `    A route that only wants parseBoolean would pull those into its bundle.`,
  );
}

/* ── 4. the peer-using entries DO reach their peers ──────────────────────────
   Guards check 3 against becoming vacuous: if a rename silently emptied the
   graph walk, check 3 would pass for the wrong reason. */

const MUST_REACH = {
  "storage.js": ["jose", "secure-ls", "@devopsthink/react-security-util"],
  "fetch.js": ["@devopsthink/react-security-util"],
  "payload.js": ["@devopsthink/react-security-util"],
  "env-json.js": ["@devopsthink/react-security-util"],
};

for (const [entry, expected] of Object.entries(MUST_REACH)) {
  const deps = bareSpecifiersIn(closureOf(path.join(DIST, entry)));
  for (const dep of expected) {
    if (!deps.has(dep)) {
      fail(
        `dist/${entry} does not import ${dep} anywhere in its closure. Either the entry is ` +
          `broken, or this graph walk stopped working - which would also make check 3 vacuous.`,
      );
    }
  }
}

/* ── 5. the registry is shared, not duplicated ───────────────────────────────
   `splitting: false` would give every entry its own copy of config-source and
   therefore its own registry: the host wires one, ./storage reads another. The
   Symbol.for key in config-source.ts survives that, but this asserts the build
   does not create the situation in the first place. */

const registryMarker = "@devopsnext/starterkit-config-util/registry";
const carriers = readdirSync(DIST).filter(
  (f) => f.endsWith(".js") && readFileSync(path.join(DIST, f), "utf8").includes(registryMarker),
);
if (carriers.length !== 1) {
  fail(
    `the registry symbol appears in ${carriers.length} emitted file(s) (${carriers.join(", ")}), ` +
      `expected exactly 1 shared chunk. More than one means the registry is duplicated per entry ` +
      `(check tsup's \`splitting\`); zero means the marker was renamed and this check is dead.`,
  );
}

/* ── report ──────────────────────────────────────────────────────────────── */

if (problems.length) {
  console.error(`\n✖ dist: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  · ${p}\n`);
  process.exit(1);
}

console.log(
  `✓ dist: ESM-only, ${Object.keys(pkg.exports).length} entries resolve, "." closure is ` +
    `zero-dependency (${indexClosure.size} files), peer entries reach their peers, registry ` +
    `lives in exactly one chunk.`,
);
