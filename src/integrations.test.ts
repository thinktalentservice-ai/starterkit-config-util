import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractIntegrationOrigins,
  extractIntegrationUrlHints,
  loadIntegrations,
  parseAllowedDomains,
  selectIntegrations,
} from "./integrations.js";
import type { IntegrationRecord } from "./integrations.js";

const rec = (over: Partial<IntegrationRecord> = {}): IntegrationRecord => ({
  INTEGRATION_ID: 1,
  INTEGRATION_LABEL: "TEST",
  INTEGRATION_TEXT: "<script>window.__x = 1;</script>",
  INTEGRATION_ORDER: 1,
  STATUS: "Y",
  ALLOWED_DOMAIN: "N",
  ...over,
});

const HOST = "a.test";
const at = (host = HOST, allowedDomains: string | readonly string[] = [HOST]) => ({
  host,
  allowedDomains,
});

describe("parseAllowedDomains", () => {
  it("splits, trims and drops empties", () => {
    expect(parseAllowedDomains(" a.test , ,b.test ")).toEqual(["a.test", "b.test"]);
  });

  it("returns [] for ANY '%', because an unsubstituted placeholder is not a hostname", () => {
    // The Vite app writes %VITE_allowedDomains% into index.html and relies on a
    // build-time substitution. When that does not happen the raw placeholder
    // arrives here; read as a hostname it would never match, but read as a LIST
    // it makes the empty-string entries look meaningful. Failing to [] means a
    // domain-gated widget loads nowhere rather than somewhere unvetted.
    expect(parseAllowedDomains("%VITE_allowedDomains%")).toEqual([]);
  });

  it("voids the WHOLE list on a mid-string '%', pinning the breadth of the guard", () => {
    // The original is `indexOf('%') === -1`, not a %VITE_ prefix test. Narrowing
    // it later would be a real behaviour change, so it is asserted rather than
    // left to a reading of the source.
    expect(parseAllowedDomains("a.test,%VITE_x%,b.test")).toEqual([]);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["an array", ["a.test"]],
  ])("returns [] for %s rather than throwing", (_label, value) => {
    // Callers read this straight off a config object, where a missing key is
    // undefined. A throw here would turn "nobody set the allow-list" into a
    // crash on every page load.
    expect(parseAllowedDomains(value)).toEqual([]);
  });
});

describe("selectIntegrations — the ALLOWED_DOMAIN gate", () => {
  it('includes ALLOWED_DOMAIN "N" on any host', () => {
    expect(selectIntegrations([rec({ ALLOWED_DOMAIN: "N" })], at("elsewhere.test"))).toHaveLength(1);
  });

  it('includes ALLOWED_DOMAIN "Y" when the host is allow-listed', () => {
    expect(selectIntegrations([rec({ ALLOWED_DOMAIN: "Y" })], at())).toHaveLength(1);
  });

  it('excludes ALLOWED_DOMAIN "Y" when the host is not allow-listed', () => {
    expect(selectIntegrations([rec({ ALLOWED_DOMAIN: "Y" })], at("other.test"))).toEqual([]);
  });

  it.each([
    ["lowercase y", "y"],
    ["empty string", ""],
    ["null", null],
    ["an unknown value", "MAYBE"],
  ])("FAILS CLOSED on %s", (_label, value) => {
    // The default branch is `exclude`. A `default: allow` would ship every
    // future value of this column to every host — the direction nobody notices,
    // because the symptom is a widget appearing where it should not.
    expect(selectIntegrations([rec({ ALLOWED_DOMAIN: value })], at())).toEqual([]);
  });

  it("matches the host EXACTLY, so a port must be in the allow-list", () => {
    // location.host is hostname[:port]. This is why domain-gated rows are
    // dormant under a dev server on :3000 and only come alive on the deployed
    // host — surprising, long-standing, and pinned here so it cannot drift.
    expect(selectIntegrations([rec({ ALLOWED_DOMAIN: "Y" })], at("a.test:3000"))).toEqual([]);
    expect(
      selectIntegrations([rec({ ALLOWED_DOMAIN: "Y" })], at("a.test:3000", ["a.test:3000"])),
    ).toHaveLength(1);
  });

  it("applies the '%' guard to a raw comma string, so a caller cannot skip the parser", () => {
    // Every Express interceptor reads this value out of process.env as a string.
    // If the options object accepted a pre-split array only, each of them would
    // re-derive the guard — which is the drift this package exists to remove.
    expect(selectIntegrations([rec({ ALLOWED_DOMAIN: "Y" })], at(HOST, "%VITE_x%"))).toEqual([]);
    expect(selectIntegrations([rec({ ALLOWED_DOMAIN: "Y" })], at(HOST, " a.test "))).toHaveLength(1);
  });
});

describe("selectIntegrations — everything else it rejects", () => {
  it('excludes STATUS !== "Y"', () => {
    expect(selectIntegrations([rec({ STATUS: "N" })], at())).toEqual([]);
  });

  it("excludes an empty or absent INTEGRATION_TEXT", () => {
    expect(selectIntegrations([rec({ INTEGRATION_TEXT: "" })], at())).toEqual([]);
    expect(selectIntegrations([rec({ INTEGRATION_TEXT: null })], at())).toEqual([]);
  });

  it("skips a null or non-object entry rather than throwing on it", () => {
    // The file is a SELECT * dump. One malformed row must not take out the five
    // good ones, which is what a `.map` over unvalidated entries would do.
    expect(selectIntegrations([null, "nope", 7, rec()], at())).toHaveLength(1);
  });

  it("THROWS on a non-array instead of returning []", () => {
    // An empty result is a real state — "no rows apply to this host". A silent
    // [] for "the file was not what we thought" is indistinguishable from it,
    // and that ambiguity is the thing this package keeps deleting.
    expect(() => selectIntegrations({ rows: [] }, at())).toThrow(/expected an array/);
    expect(() => selectIntegrations(null, at())).toThrow(/received null/);
  });
});

describe("selectIntegrations — ordering", () => {
  it("returns records in ascending INTEGRATION_ORDER regardless of file order", () => {
    // Not cosmetic: secure-ls must be defined before the row that calls
    // `new SecureLS`, and FreshworksWidget before the row that calls it.
    const out = selectIntegrations(
      [rec({ INTEGRATION_ID: 3, INTEGRATION_ORDER: 30 }), rec({ INTEGRATION_ID: 1, INTEGRATION_ORDER: 10 })],
      at(),
    );
    expect(out.map((r) => r.INTEGRATION_ID)).toEqual([1, 3]);
  });

  it("sorts a missing or falsy INTEGRATION_ORDER as 0, i.e. first", () => {
    // Replicates `(x || 0)` from every copy of the loader.
    const out = selectIntegrations(
      [rec({ INTEGRATION_ID: 2, INTEGRATION_ORDER: 5 }), rec({ INTEGRATION_ID: 1, INTEGRATION_ORDER: null })],
      at(),
    );
    expect(out.map((r) => r.INTEGRATION_ID)).toEqual([1, 2]);
  });

  it("treats a non-numeric order as 0 rather than letting NaN scramble the sort", () => {
    // A comparator returning NaN is silently read as "equal" by the sort spec,
    // so a garbage value would land the row in an arbitrary position instead of
    // an obvious one. This is the one addition to the ported behaviour.
    const out = selectIntegrations(
      [rec({ INTEGRATION_ID: 2, INTEGRATION_ORDER: 5 }), rec({ INTEGRATION_ID: 1, INTEGRATION_ORDER: "junk" })],
      at(),
    );
    expect(out.map((r) => r.INTEGRATION_ID)).toEqual([1, 2]);
  });

  it("keeps input order for equal INTEGRATION_ORDER", () => {
    // The column has no uniqueness constraint. Sort has been stable since
    // ES2019, so this is a guarantee rather than a hope.
    const out = selectIntegrations(
      [rec({ INTEGRATION_ID: "a", INTEGRATION_ORDER: 1 }), rec({ INTEGRATION_ID: "b", INTEGRATION_ORDER: 1 })],
      at(),
    );
    expect(out.map((r) => r.INTEGRATION_ID)).toEqual(["a", "b"]);
  });

  it("does NOT mutate the caller's array", () => {
    // `.sort()` mutates. A consumer holding its own cached copy of the file
    // would otherwise find it silently reordered under it.
    const input = [rec({ INTEGRATION_ID: 2, INTEGRATION_ORDER: 20 }), rec({ INTEGRATION_ID: 1, INTEGRATION_ORDER: 10 })];
    selectIntegrations(input, at());
    expect(input.map((r) => r.INTEGRATION_ID)).toEqual([2, 1]);
  });
});

/* ── loadIntegrations ───────────────────────────────────────────────────────
   jsdom never fetches an external <script>, so an appended node with a `src`
   would sit there and its promise would never settle — the suite would hang
   rather than fail. head.appendChild is therefore wrapped: it appends FOR REAL
   (so template parsing, attribute copying and node order are all exercised
   against real DOM) and then dispatches the load/error the browser would.

   Assertions are on DOM STATE — which nodes landed, with which attributes and
   text — never on the side effects of executing a script, so the suite does not
   depend on jsdom's runScripts setting. */

const EXTERNAL = "https://cdn.test/lib.js";

describe("loadIntegrations", () => {
  let appended: HTMLScriptElement[] = [];
  let failing = new Set<string>();

  beforeEach(() => {
    appended = [];
    failing = new Set();
    const realAppend = document.head.appendChild.bind(document.head);
    vi.spyOn(document.head, "appendChild").mockImplementation(((node: Node) => {
      const out = realAppend(node);
      if (node instanceof HTMLScriptElement) {
        appended.push(node);
        const src = node.getAttribute("src");
        if (src) {
          queueMicrotask(() => node.dispatchEvent(new Event(failing.has(src) ? "error" : "load")));
        }
      }
      return out;
    }) as typeof document.head.appendChild);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.head.innerHTML = "";
  });

  const respond = (body: unknown, init: { ok?: boolean; status?: number } = {}) =>
    vi.fn(async () => ({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => body,
    })) as unknown as typeof globalThis.fetch;

  const load = (body: unknown, over: Record<string, unknown> = {}) =>
    loadIntegrations({
      sourceUrl: "/base/javascript_integration.json",
      allowedDomains: [HOST],
      host: HOST,
      fetch: respond(body),
      ...over,
    });

  it("appends inline and external scripts in INTEGRATION_ORDER, copying attributes", () => {
    return load([
      rec({
        INTEGRATION_ID: 2,
        INTEGRATION_ORDER: 20,
        INTEGRATION_TEXT: "<script>window.__second = 1;</script>",
      }),
      rec({
        INTEGRATION_ID: 1,
        INTEGRATION_ORDER: 10,
        INTEGRATION_TEXT: `<script type="text/javascript" defer src="${EXTERNAL}"></script>`,
      }),
    ]).then((result) => {
      expect(appended).toHaveLength(2);
      expect(appended[0]?.getAttribute("src")).toBe(EXTERNAL);
      expect(appended[0]?.getAttribute("type")).toBe("text/javascript");
      expect(appended[0]?.hasAttribute("defer")).toBe(true);
      expect(appended[1]?.text).toBe("window.__second = 1;");
      expect(result.executed).toBe(2);
      expect(result.failures).toEqual([]);
      expect(result.selected.map((r) => r.INTEGRATION_ID)).toEqual([1, 2]);
    });
  });

  it("waits for an external script before appending the NEXT record", async () => {
    // The whole reason the chain is sequential: row 5 loads secure-ls and row 6
    // calls `new SecureLS`. Run them concurrently and it fails intermittently,
    // which is worse than failing.
    const order: string[] = [];
    const realAppend = document.head.appendChild.bind(document.head);
    vi.spyOn(document.head, "appendChild").mockImplementation(((node: Node) => {
      const out = realAppend(node);
      if (node instanceof HTMLScriptElement) {
        const src = node.getAttribute("src");
        order.push(src ?? "inline");
        if (src) {
          // Two ticks, so an implementation that did not await would slip in.
          queueMicrotask(() => queueMicrotask(() => node.dispatchEvent(new Event("load"))));
        }
      }
      return out;
    }) as typeof document.head.appendChild);

    await load([
      rec({ INTEGRATION_ORDER: 1, INTEGRATION_TEXT: `<script src="${EXTERNAL}"></script>` }),
      rec({ INTEGRATION_ORDER: 2, INTEGRATION_TEXT: "<script>1;</script>" }),
    ]);

    expect(order).toEqual([EXTERNAL, "inline"]);
  });

  it("runs multiple <script> nodes inside ONE INTEGRATION_TEXT in document order", async () => {
    // Two live rows do exactly this: an inline settings block followed by the
    // external widget it configures.
    await load([
      rec({
        INTEGRATION_TEXT:
          `<script>window.__cfg = 1;</script><script src="${EXTERNAL}"></script>`,
      }),
    ]);
    expect(appended.map((n) => n.getAttribute("src") ?? "inline")).toEqual(["inline", EXTERNAL]);
  });

  it("does not let a failed external script strand the entries after it", async () => {
    // A 404, an ad blocker and a CSP block all land on onerror. One unreachable
    // widget must not take the rest of the table with it.
    failing.add(EXTERNAL);
    const result = await load([
      rec({ INTEGRATION_ID: 7, INTEGRATION_ORDER: 1, INTEGRATION_TEXT: `<script src="${EXTERNAL}"></script>` }),
      rec({ INTEGRATION_ID: 8, INTEGRATION_ORDER: 2, INTEGRATION_TEXT: "<script>1;</script>" }),
    ]);
    expect(appended).toHaveLength(2);
    expect(result.executed).toBe(2);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.integrationId).toBe(7);
    expect(result.failures[0]?.src).toContain("cdn.test");
  });

  it("REJECTS on a non-array payload, and appends nothing", async () => {
    await expect(load({ rows: [] })).rejects.toThrow(/expected an array/);
    expect(appended).toEqual([]);
  });

  it("REJECTS on an HTTP error, naming the status and the URL", async () => {
    // The old loader swallowed this into a console.error, so a mis-set basePath
    // and an empty table were the same observable state: nothing happened.
    await expect(
      load([], { fetch: respond([], { ok: false, status: 500 }) }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("reports why each record was skipped", async () => {
    const result = await load([
      rec({ INTEGRATION_ID: 1, STATUS: "N" }),
      rec({ INTEGRATION_ID: 2, ALLOWED_DOMAIN: "Y" }, ),
      rec({ INTEGRATION_ID: 3, INTEGRATION_TEXT: "" }),
    ], { host: "other.test" });
    expect(result.skipped.map((s) => s.reason)).toEqual([
      "status-not-Y",
      "domain-not-allowed",
      "empty-text",
    ]);
  });

  it("defaults host to location.host", async () => {
    const result = await load([], { host: undefined });
    expect(result.host).toBe(globalThis.location.host);
  });

  it("passes sourceUrl and the signal through to fetch", async () => {
    const controller = new AbortController();
    const spy = respond([]);
    await loadIntegrations({
      sourceUrl: "/base/x.json",
      allowedDomains: "",
      host: HOST,
      fetch: spy,
      signal: controller.signal,
    });
    expect(spy).toHaveBeenCalledWith("/base/x.json", { signal: controller.signal });
  });

  it("returns immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const spy = respond([rec()]);
    const result = await loadIntegrations({
      sourceUrl: "/base/x.json",
      allowedDomains: "",
      host: HOST,
      fetch: spy,
      signal: controller.signal,
    });
    expect(result.aborted).toBe(true);
    expect(result.executed).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it("requires a sourceUrl, with a message that names the basePath trap", async () => {
    await expect(
      loadIntegrations({ sourceUrl: "", allowedDomains: "" }),
    ).rejects.toThrow(/sourceUrl` is required/);
  });
});

describe("extractIntegrationOrigins", () => {
  const from = (...texts: string[]) =>
    extractIntegrationOrigins(texts.map((t) => rec({ INTEGRATION_TEXT: t })));

  it("returns one distinct, sorted origin per <script src>, across records", () => {
    expect(
      from(
        '<script src="https://b.cdn/x.js"></script>',
        '<script src="https://a.cdn/y.js"></script><script src="https://b.cdn/z.js"></script>',
      ),
    ).toEqual(["https://a.cdn", "https://b.cdn"]);
  });

  it("parses single-quoted, double-quoted and unquoted src attributes", () => {
    // A live row uses single quotes. A scanner that handled only double quotes
    // would silently report zero origins for it — a green gate over a blocked
    // widget, which is the one outcome this must never produce.
    expect(
      from(
        "<script type='text/javascript' src='https://one.cdn/a.js'></script>",
        '<script src="https://two.cdn/b.js"></script>',
        "<script src=https://three.cdn/c.js></script>",
      ),
    ).toEqual(["https://one.cdn", "https://two.cdn", "https://three.cdn"].sort());
  });

  it("yields nothing for a relative src, which 'self' already covers", () => {
    expect(from('<script src="/local.js"></script>', '<script src="local.js"></script>')).toEqual([]);
  });

  it("resolves a protocol-relative src as https", () => {
    expect(from('<script src="//cdn.test/x.js"></script>')).toEqual(["https://cdn.test"]);
  });

  it("skips javascript: and data: srcs, which a host list does not govern", () => {
    expect(from('<script src="data:text/javascript,1"></script>')).toEqual([]);
    expect(from('<script src="javascript:void 0"></script>')).toEqual([]);
  });

  it('scans STATUS "N" and domain-gated rows too', () => {
    // Deliberately asymmetric with selectIntegrations. A CSP is ONE header for
    // every host and every future flip of STATUS; a scan limited to today's
    // active rows goes green, and then a DBA re-enables a row and blocks it in
    // production with no code change to point at.
    expect(
      extractIntegrationOrigins([
        rec({ STATUS: "N", INTEGRATION_TEXT: '<script src="https://off.cdn/x.js"></script>' }),
        rec({ ALLOWED_DOMAIN: "Y", INTEGRATION_TEXT: '<script src="https://gated.cdn/y.js"></script>' }),
      ]),
    ).toEqual(["https://gated.cdn", "https://off.cdn"]);
  });

  it("CANNOT see a src assigned by an inline script — the documented blind spot", () => {
    // Pinned so nobody later reads a green gate as full coverage. This exact
    // shape is live in production today.
    expect(from('<script>var r = document.createElement("script"); r.src = "https://sneaky.cdn/x.js";</script>'))
      .toEqual([]);
  });

  it("throws on a non-array, like every other entry point here", () => {
    expect(() => extractIntegrationOrigins("nope")).toThrow(/expected an array/);
  });
});

describe("extractIntegrationUrlHints", () => {
  it("finds the runtime-assigned origin that the attribute scan misses", () => {
    expect(
      extractIntegrationUrlHints([
        rec({ INTEGRATION_TEXT: '<script>r.src = "https://sneaky.cdn/x.js";</script>' }),
      ]),
    ).toEqual(["https://sneaky.cdn"]);
  });

  it("does not repeat an origin the attribute scan already reported", () => {
    // Otherwise every real finding would arrive twice: once as a failure and
    // once as a warning, which trains a reader to skim both.
    expect(
      extractIntegrationUrlHints([
        rec({ INTEGRATION_TEXT: '<script src="https://cdn.test/x.js"></script>' }),
      ]),
    ).toEqual([]);
  });
});
