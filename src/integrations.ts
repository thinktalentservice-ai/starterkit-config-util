/**
 * The `javascript_integration` table, applied.
 *
 * A DevOps pipeline dumps a MySQL table to a static JSON array — one row per
 * third-party snippet, each carrying raw HTML in `INTEGRATION_TEXT`. Every
 * frontend in this family then does the same four things with it: filter on
 * `STATUS` and `ALLOWED_DOMAIN`, sort on `INTEGRATION_ORDER`, re-create each
 * `<script>` node, and run them in order.
 *
 * ── WHY THIS IS A PACKAGE AND NOT A FILE IN public/ ─────────────────────────
 *
 * That rule was written EIGHT TIMES before this module existed: once as a
 * browser loader in `public/javascript_integration.js` in two apps, and six
 * times as a cheerio `interceptor` block in `docker/server.js` (landing2,
 * ai-interview-client, csi, dmi and two dialogue apps) plus the Ansible master
 * they were all pasted from. The copies had already drifted — `const` vs `var`,
 * one extra argument on a `console.error`, a truthiness guard present in one and
 * absent in the other — and the allow-list arrives under THREE different env
 * names (`REACT_APP_allowedDomains`, `%VITE_allowedDomains%`,
 * `NEXT_PUBLIC_INTEGRATION_ALLOWED_DOMAINS`). None of that drift is visible from
 * inside any one repo, and none of it produces an error: a wrong filter is a
 * widget that silently does not load, at HTTP 200.
 *
 * The module is split so the Express consumers can take the half they need.
 * `selectIntegrations` is PURE — no DOM, no fetch — and is the entire rule those
 * six interceptors implement. `loadIntegrations` is the browser half on top of
 * it. Importing this entry in Node costs nothing: rule 2 of this package (no
 * module-scope browser API access) is what makes that true, and it is enforced
 * here by there being no module-scope statements at all beyond two regexes.
 *
 * ── THIS EXECUTES DATABASE-AUTHORED JAVASCRIPT ──────────────────────────────
 *
 * Whoever can write a row in the `javascript_integration` table can run script
 * on every page of every app that calls `loadIntegrations`. That is the trust
 * boundary the source data has, and packaging the mechanism does not narrow it —
 * it widens the blast radius by making adoption easy. It must never be fed
 * anything an end user can set, and the JSON must never be served from an origin
 * a third party can write.
 *
 * A consequence worth stating because it is invisible: `INTEGRATION_TEXT` is
 * secret-bearing in practice. Real rows in production today embed an AES key as
 * a string literal. NOTHING in this module may log, echo or return
 * `INTEGRATION_TEXT` — which is why the extractors below return origins, and why
 * the result object returns records the caller already handed in, never excerpts.
 *
 * ── MECHANISM ONLY ──────────────────────────────────────────────────────────
 *
 * The source URL, the allow-list value, the basePath and the enable flag are all
 * deployment data and arrive as ARGUMENTS. There is no config-registry read here
 * and no `DEFAULT_CONFIG_KEYS` entry — one consumer has no integrations at all,
 * and a required key would make its `check-env-config` gate demand a value it has
 * no reason to define.
 */

/**
 * One row of the `javascript_integration` table, verbatim.
 *
 * The index signature is load-bearing rather than lazy: `GEN_DATE` and
 * `GNE_DATE` (the typo is the DBA's — do not "fix" it and do not read either)
 * already exist, the dump is `SELECT *`, and a column added tomorrow must not
 * turn a green build red in six repos at once.
 */
export interface IntegrationRecord {
  INTEGRATION_ID?: number | string | undefined;
  INTEGRATION_LABEL?: string | null | undefined;
  /** Raw HTML containing `<script>` tags. SECRET-BEARING — never log it. */
  INTEGRATION_TEXT?: string | null | undefined;
  INTEGRATION_ORDER?: number | string | null | undefined;
  STATUS?: string | null | undefined;
  ALLOWED_DOMAIN?: string | null | undefined;
  [column: string]: unknown;
}

/** Why a record did not run. Reported rather than dropped in silence. */
export type IntegrationSkipReason =
  | "not-an-object"
  | "status-not-Y"
  | "empty-text"
  | "domain-not-allowed"
  | "unknown-allowed-domain";

export interface IntegrationSkip {
  record: unknown;
  reason: IntegrationSkipReason;
}

export interface SelectIntegrationsOptions {
  /**
   * `location.host` — hostname[:port]. Compared with `===`, so a port must be in
   * the allow-list to match. That is today's behaviour in every copy, and it is
   * why domain-gated rows are dormant under a local dev server on :3000.
   */
  host: string;
  /**
   * A comma-separated string or an array. A STRING is put through
   * `parseAllowedDomains`, so a consumer cannot accidentally skip the `%` guard.
   * An array is taken as already-parsed and only trimmed — it is programmatic,
   * so an unsubstituted build placeholder cannot be in it.
   */
  allowedDomains: string | readonly string[];
}

export interface IntegrationScriptFailure {
  integrationId: number | string | undefined;
  /** The `src` that did not load. A CSP block lands here too. */
  src: string;
}

export interface LoadIntegrationsResult {
  sourceUrl: string;
  host: string;
  allowedDomains: string[];
  selected: IntegrationRecord[];
  skipped: IntegrationSkip[];
  /** `<script>` nodes actually appended to `<head>`. */
  executed: number;
  failures: IntegrationScriptFailure[];
  aborted: boolean;
}

export interface LoadIntegrationsOptions {
  /**
   * Absolute or root-relative URL of the integration JSON. REQUIRED, with no
   * default: the `document.currentScript.src` fallback the browser loaders used
   * only existed because there was a `<script>` tag to read it from, and there
   * is not one any more.
   */
  sourceUrl: string;
  allowedDomains: string | readonly string[];
  /** Defaults to `location.host`, or `""` — which matches nothing, the safe direction. */
  host?: string | undefined;
  /** Test seam. Defaults to `globalThis.document`. */
  document?: Document | undefined;
  /** Test seam. Defaults to `globalThis.fetch`, BOUND — an unbound reference throws `Illegal invocation`. */
  fetch?: typeof globalThis.fetch | undefined;
  /**
   * Checked between records and between script nodes. It cannot un-run a script
   * that already executed; aborting mid-chain leaves the earlier ones live.
   */
  signal?: AbortSignal | undefined;
}

/* ── the allow-list ───────────────────────────────────────────────────────── */

/**
 * `"a.example, b.example"` -> `["a.example", "b.example"]`.
 *
 * ANY `%` ANYWHERE VOIDS THE ENTIRE LIST, and that breadth is deliberate. The
 * Vite app spells this value `%VITE_allowedDomains%` in `index.html` and relies
 * on a build-time substitution; when the substitution does not happen — a
 * copy-pasted tag, a different bundler, a mis-set env — the raw placeholder
 * reaches this function and would otherwise be read as a hostname. Failing to an
 * EMPTY list is the safe direction: a domain-gated integration then loads
 * nowhere, rather than on a host nobody cleared it for.
 *
 * Exported separately because the six Express interceptors read the same comma
 * string out of `process.env` and must apply the same rule. The
 * `window.env.REACT_APP_allowedDomains` fallback the browser loaders carried is
 * deliberately NOT here: that is one specific app's global, i.e. deployment
 * data, and it belongs to whichever app still sets it.
 */
export function parseAllowedDomains(value: unknown): string[] {
  if (typeof value !== "string") return [];
  if (value.includes("%")) return [];
  return value
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
}

function resolveAllowedDomains(value: string | readonly string[]): string[] {
  if (typeof value === "string") return parseAllowedDomains(value);
  if (!value) return [];
  return Array.from(value, (d) => String(d).trim()).filter(Boolean);
}

/* ── selection: the pure half ─────────────────────────────────────────────── */

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

function assertRecordArray(list: unknown, fn: string): readonly unknown[] {
  if (!Array.isArray(list)) {
    throw new TypeError(
      `${fn}: expected an array of integration records, received ${describe(list)}. ` +
        `The DevOps pipeline writes this file with pandas .to_json(orient="records"), so it is ` +
        `a JSON ARRAY at the top level. Pass the parsed file itself, not a wrapper object.`,
    );
  }
  return list;
}

/**
 * `INTEGRATION_ORDER` as a number, replicating `(x || 0)` exactly: every falsy
 * value — `0`, `""`, `null`, absent — sorts as 0, i.e. first.
 *
 * The `Number.isFinite` guard is the one addition. It is a DB column with no
 * constraint this code can see; a non-numeric value would make the comparator
 * return `NaN`, which the sort spec silently treats as "equal", so a garbage
 * order would land the row in an arbitrary position instead of an obvious one.
 */
function orderOf(record: IntegrationRecord): number {
  const value = Number(record.INTEGRATION_ORDER || 0);
  return Number.isFinite(value) ? value : 0;
}

function partitionIntegrations(
  list: unknown,
  options: SelectIntegrationsOptions,
  fn: string,
): { selected: IntegrationRecord[]; skipped: IntegrationSkip[] } {
  const entries = assertRecordArray(list, fn);
  const allowed = resolveAllowedDomains(options.allowedDomains);
  const host = options.host;

  const selected: IntegrationRecord[] = [];
  const skipped: IntegrationSkip[] = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      skipped.push({ record: entry, reason: "not-an-object" });
      continue;
    }
    const record = entry as IntegrationRecord;

    if (record.STATUS !== "Y") {
      skipped.push({ record, reason: "status-not-Y" });
      continue;
    }
    if (!record.INTEGRATION_TEXT) {
      skipped.push({ record, reason: "empty-text" });
      continue;
    }

    /* `"N"` loads everywhere; `"Y"` loads only on an allow-listed host; ANYTHING
       ELSE — `"y"`, `""`, `null`, a value added next year — is EXCLUDED. Failing
       closed is the whole point: a `default: allow` would ship every future
       column value to every host, which is the direction nobody notices. */
    if (record.ALLOWED_DOMAIN === "N") {
      selected.push(record);
      continue;
    }
    if (record.ALLOWED_DOMAIN === "Y") {
      if (allowed.includes(host)) selected.push(record);
      else skipped.push({ record, reason: "domain-not-allowed" });
      continue;
    }
    skipped.push({ record, reason: "unknown-allowed-domain" });
  }

  /* Sorted in place on a FRESH array, never on the caller's input. `.sort()`
     mutates, and a consumer that passed its own cached copy of the file would
     otherwise find it reordered. Stable since ES2019, so equal orders keep their
     file order — `INTEGRATION_ORDER` has no uniqueness constraint. */
  selected.sort((a, b) => orderOf(a) - orderOf(b));

  return { selected, skipped };
}

/**
 * The records that should run, in the order they should run.
 *
 * PURE: no DOM, no fetch, no clock. This is the entire rule the six
 * `docker/server.js` cheerio interceptors implement by hand, so they can adopt
 * this function without taking on anything browser-shaped.
 *
 * THROWS on a non-array rather than returning `[]`. An empty result is a real
 * and meaningful state — "the table has no rows for this host" — and a silent
 * `[]` for "the file was not what we thought" is indistinguishable from it.
 */
export function selectIntegrations(
  list: unknown,
  options: SelectIntegrationsOptions,
): IntegrationRecord[] {
  return partitionIntegrations(list, options, "selectIntegrations").selected;
}

/* ── origin extraction: for a Content-Security-Policy gate ────────────────── */

/*
 * Both extractors scan EVERY record and ignore `STATUS` and `ALLOWED_DOMAIN`
 * entirely — deliberately asymmetric with `selectIntegrations`. A CSP is ONE
 * static header serving every host and every future flip of that column; a gate
 * that looked only at today's active rows would go green, and then a DBA setting
 * `STATUS = 'Y'` would CSP-block a widget in production with no code change to
 * point at.
 *
 * A REGEX IS THE ONLY PARSER AVAILABLE HERE, and that has to be said out loud
 * rather than discovered. A CSP gate runs in plain Node, this package declares
 * `engines: node >= 18`, `jsdom` is a devDependency that is never shipped, and
 * rule 7 forbids a new runtime dependency. So this is best-effort by
 * construction, and the limits are enumerated on each function.
 */

const SCRIPT_SRC = /<script\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
const URL_LITERAL = /\bhttps?:\/\/[^\s"'`<>()\\]+/gi;

function originOf(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  /* Not fetches of a resource the `script-src` host list governs. */
  if (/^(?:javascript|data|blob):/i.test(value)) return null;
  const candidate = value.startsWith("//") ? `https:${value}` : value;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    /* Relative — same origin, already covered by `'self'`. Not a finding. */
    return null;
  }
}

function textsOf(list: unknown, fn: string): string[] {
  const out: string[] = [];
  for (const entry of assertRecordArray(list, fn)) {
    if (!entry || typeof entry !== "object") continue;
    const text = (entry as IntegrationRecord).INTEGRATION_TEXT;
    if (typeof text === "string" && text) out.push(text);
  }
  return out;
}

/**
 * Every distinct cross-origin `<script src>` origin in the table, sorted.
 *
 * AUTHORITATIVE, and incomplete — the two are not in tension, they are the
 * contract. This reads the `src` ATTRIBUTE of a `<script>` tag and nothing else.
 * What it provably cannot see, and what a caller must not assume it covers:
 *
 *   · a `src` ASSIGNED BY AN INLINE SCRIPT at runtime (`r.src = "https://…"`).
 *     This is not hypothetical — it is how a live row in production loads its
 *     widget today, which is the entire reason `extractIntegrationUrlHints`
 *     exists below.
 *   · `import()`, `fetch()`, `new Worker()`, `<link rel=preload as=script>`
 *   · anything a loaded third party then loads for itself
 *   · a `<script src>` inside an HTML comment or a JS string literal, which it
 *     reports as a false positive
 *
 * Relative srcs yield nothing: same origin, `'self'` covers them.
 * Protocol-relative `//host/x.js` is resolved as `https:`.
 */
export function extractIntegrationOrigins(list: unknown): string[] {
  const origins = new Set<string>();
  for (const text of textsOf(list, "extractIntegrationOrigins")) {
    for (const match of text.matchAll(SCRIPT_SRC)) {
      const raw = match[1] ?? match[2] ?? match[3];
      if (!raw) continue;
      const origin = originOf(raw);
      if (origin) origins.add(origin);
    }
  }
  return [...origins].sort();
}

/**
 * Every http(s) origin appearing ANYWHERE in the table's text, minus everything
 * `extractIntegrationOrigins` already found.
 *
 * ADVISORY ONLY — never fail a build on this. It is noisy by construction: an
 * API endpoint, a documentation link and a real script host are
 * indistinguishable to it, and it cannot tell which of them ever becomes a
 * script load.
 *
 * It exists because without it a CSP gate is GREEN ON THE ONE INTEGRATION THAT
 * IS ACTUALLY BROKEN. A row that builds its own `<script>` and assigns
 * `r.src = "https://…"` is invisible to every attribute scan, so adding the
 * attribute origins to a policy would flip such a gate green while that widget
 * stayed blocked — a gate that certifies the exact case it cannot see.
 */
export function extractIntegrationUrlHints(list: unknown): string[] {
  const known = new Set(extractIntegrationOrigins(list));
  const hints = new Set<string>();
  for (const text of textsOf(list, "extractIntegrationUrlHints")) {
    for (const match of text.matchAll(URL_LITERAL)) {
      const origin = originOf(match[0]);
      if (origin && !known.has(origin)) hints.add(origin);
    }
  }
  return [...hints].sort();
}

/* ── loading: the browser half ────────────────────────────────────────────── */

/**
 * Re-create one `<script>` node so the browser executes it, and wait for it.
 *
 * WHY RE-CREATE: a `<script>` inserted via `innerHTML` does NOT execute. The
 * node parsed out of `INTEGRATION_TEXT` is a template only; every attribute is
 * copied onto a fresh element, which is what makes it run.
 *
 * Resolves `true` when an EXTERNAL script failed. Both `load` and `error`
 * resolve, deliberately: one unreachable widget — a 404, an ad blocker, or a CSP
 * block, which lands on `onerror` alongside a browser-generated violation — must
 * not strand every later entry in the chain.
 */
function runScript(doc: Document, templateScript: HTMLScriptElement): Promise<boolean> {
  return new Promise((resolve) => {
    const script = doc.createElement("script");
    for (const attr of Array.from(templateScript.attributes)) {
      script.setAttribute(attr.name, attr.value);
    }

    /* `.src` is the IDL property, not `getAttribute("src")`, and the difference
       is behavioural: for `src=""` the IDL resolves against the base URL and is
       therefore truthy, taking the external branch. That is what every copy of
       this loader has always done; switching to `hasAttribute` would silently
       change which branch runs. */
    if (templateScript.src) {
      script.onload = () => resolve(false);
      script.onerror = () => {
        console.error("[integration] failed to load", templateScript.src);
        resolve(true);
      };
      doc.head.appendChild(script);
    } else {
      script.text = templateScript.textContent ?? "";
      doc.head.appendChild(script);
      resolve(false);
    }
  });
}

/**
 * Fetch the integration JSON and run what applies to this host.
 *
 * Records run one after another, and the `<script>` nodes within one record run
 * one after another, with external loads AWAITED. That sequencing is the whole
 * contract of `INTEGRATION_ORDER` and it is not decorative: the row that does
 * `new SecureLS(...)` is a different row from the one that loads secure-ls, and
 * the row calling `FreshworksWidget("identify")` is a different row from the one
 * that defines it. Run them concurrently and they fail intermittently, which is
 * worse than failing.
 *
 * ── IT REJECTS. THE CALLER MUST CATCH. ──────────────────────────────────────
 *
 * A missing file, an HTTP error, unparseable JSON or a non-array payload all
 * REJECT, where the `public/javascript_integration.js` this replaces swallowed
 * every one of them into a `console.error`. Same reasoning as `decodeEnvJson`:
 * the library reports, the caller decides. A browser should log and carry on; a
 * build script should fail. WITHOUT A `.catch()` THIS BECOMES AN UNHANDLED
 * REJECTION rather than a logged one.
 *
 * The result object exists because "did anything run?" was previously
 * unanswerable: an empty table, an allow-list that excluded everything, and a
 * CSP that blocked every external script are three different problems that all
 * looked identical — silent.
 */
export async function loadIntegrations(
  options: LoadIntegrationsOptions,
): Promise<LoadIntegrationsResult> {
  const sourceUrl = options.sourceUrl;
  if (typeof sourceUrl !== "string" || sourceUrl.trim() === "") {
    throw new TypeError(
      "loadIntegrations: `sourceUrl` is required. Pass the URL of the integration JSON, " +
        "including your basePath if you have one — a basePath is not applied for you.",
    );
  }

  const doc = options.document ?? globalThis.document;
  if (!doc) {
    throw new TypeError(
      "loadIntegrations: no `document`. This half of the module is browser-only — call it from " +
        "an effect, not at module scope or during prerender. For the filtering rule with no DOM, " +
        "use `selectIntegrations`.",
    );
  }

  /* Bound, always. `const f = options.fetch ?? globalThis.fetch; f(url)` throws
     `TypeError: Illegal invocation` in a browser, because `fetch` requires its
     `this` to be the global object. */
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new TypeError("loadIntegrations: no `fetch` available. Pass one via `options.fetch`.");
  }

  const host = options.host ?? globalThis.location?.host ?? "";
  const allowedDomains = resolveAllowedDomains(options.allowedDomains);
  const signal = options.signal;

  const result: LoadIntegrationsResult = {
    sourceUrl,
    host,
    allowedDomains,
    selected: [],
    skipped: [],
    executed: 0,
    failures: [],
    aborted: false,
  };

  if (signal?.aborted) {
    result.aborted = true;
    return result;
  }

  const response = await fetchImpl.call(globalThis, sourceUrl, signal ? { signal } : {});
  if (!response.ok) {
    throw new Error(
      `loadIntegrations: ${sourceUrl} answered HTTP ${response.status}. Check that the file is ` +
        `deployed at that path — a basePath is not applied for you.`,
    );
  }

  const payload: unknown = await response.json();
  const { selected, skipped } = partitionIntegrations(
    payload,
    { host, allowedDomains },
    "loadIntegrations",
  );
  result.selected = selected;
  result.skipped = skipped;

  for (const record of selected) {
    if (signal?.aborted) {
      result.aborted = true;
      break;
    }

    const template = doc.createElement("template");
    template.innerHTML = String(record.INTEGRATION_TEXT ?? "");

    for (const node of Array.from(template.content.querySelectorAll("script"))) {
      if (signal?.aborted) {
        result.aborted = true;
        break;
      }
      const failed = await runScript(doc, node);
      result.executed += 1;
      if (failed) {
        result.failures.push({ integrationId: record.INTEGRATION_ID, src: node.src });
      }
    }

    if (result.aborted) break;
  }

  return result;
}
