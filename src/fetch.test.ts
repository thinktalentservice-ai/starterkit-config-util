import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compressFflate } from "@devopsthink/react-security-util";
import { clearConfigSource, setConfigSource } from "./config-source.js";
import { createFetchHelpers } from "./fetch.js";
import type { ApiUtilsInstance } from "./storage.js";

/** A storage stand-in, so these tests exercise the fetch layer and not secure-ls. */
function fakeStorage(initial: Record<string, unknown> = {}): ApiUtilsInstance {
  const store: Record<string, unknown> = { ...initial };
  return {
    checkResponse: (r: unknown) => r,
    checkStatus: (r: unknown) => r,
    classifyError: (e: unknown) => e,
    queryString: () => "",
    getCookie: (n: string) => store[n] ?? null,
    setCookie: (n: string, v: unknown) => {
      store[n] = v;
    },
    getLocalStorage: (n: string) => store[n] ?? null,
    setLocalStorage: (n: string, v: unknown) => {
      store[n] = v;
    },
  } as unknown as ApiUtilsInstance;
}

/** The RequestInit of the nth fetch call, asserted to exist rather than cast past. */
function initOf(spy: { mock: { calls: unknown[][] } }, n = 0): RequestInit {
  const call = spy.mock.calls[n];
  expect(call, `expected fetch call #${n}`).toBeDefined();
  return call![1] as RequestInit;
}

let config: Record<string, unknown>;

beforeEach(() => {
  config = {
    STORAGE_SECRET: "s",
    OAUTH_SERVICE_URL: "https://gw.test/oauth-service",
    RESPONSE_DECOMPRESS: undefined,
  };
  setConfigSource(config);
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearConfigSource();
  sessionStorage.clear();
});

describe("authHeaders", () => {
  it("attaches the bearer token and the default content type", () => {
    const { authHeaders } = createFetchHelpers({ apiUtils: fakeStorage({ accessToken: "tok" }) });
    const h = authHeaders();
    expect(h.get("Authorization")).toBe("Bearer tok");
    expect(h.get("Content-Type")).toBe("application/json");
  });

  it("omits Content-Type when passed null - a GET has no body to describe", () => {
    const { authHeaders } = createFetchHelpers({ apiUtils: fakeStorage({ accessToken: "tok" }) });
    const h = authHeaders(null);
    expect(h.has("Content-Type")).toBe(false);
    expect(h.get("Authorization")).toBe("Bearer tok");
  });

  it("omits Authorization when there is no token", () => {
    const { authHeaders } = createFetchHelpers({ apiUtils: fakeStorage() });
    expect(authHeaders().has("Authorization")).toBe(false);
  });

  it("adds X-Decompress only when the flag resolves affirmative", () => {
    const helpers = createFetchHelpers({ apiUtils: fakeStorage() });
    expect(helpers.authHeaders().has("X-Decompress")).toBe(false);

    // The per-tab escape hatch.
    sessionStorage.setItem("RESPONSE_DECOMPRESS", "true");
    expect(helpers.authHeaders().get("X-Decompress")).toBe("true");
  });

  it('is unmoved by a stale "false" in sessionStorage when the build says true', () => {
    config["RESPONSE_DECOMPRESS"] = "true";
    sessionStorage.setItem("RESPONSE_DECOMPRESS", "false");
    const { authHeaders } = createFetchHelpers({ apiUtils: fakeStorage() });
    expect(authHeaders().get("X-Decompress")).toBe("true");
  });

  it("uses a remapped sessionStorage override key", () => {
    // ai-interview reads VITE_RESPONSE_DECOMPRESS, a leftover from its Vite build.
    const { authHeaders } = createFetchHelpers({
      apiUtils: fakeStorage(),
      decompressOverrideKey: "VITE_RESPONSE_DECOMPRESS",
    });
    sessionStorage.setItem("RESPONSE_DECOMPRESS", "true");
    expect(authHeaders().has("X-Decompress")).toBe(false);
    sessionStorage.setItem("VITE_RESPONSE_DECOMPRESS", "true");
    expect(authHeaders().get("X-Decompress")).toBe("true");
  });
});

describe("the 401 boundary", () => {
  it("calls onUnauthorized and rethrows, rather than swallowing the error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"message":"nope"}', { status: 401 })),
    );
    const onUnauthorized = vi.fn();
    const { getJSON } = createFetchHelpers({ apiUtils: fakeStorage({ accessToken: "t" }), onUnauthorized });

    await expect(getJSON("https://gw.test/rest/thing")).rejects.toBeTruthy();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    // The handler is given the live config and the RESOLVED key names, so a
    // consumer can build its own logout URL without re-deriving either.
    expect(onUnauthorized.mock.calls[0]?.[1]).toMatchObject({ oauthServiceUrl: "OAUTH_SERVICE_URL" });
  });

  it("leaves a non-401 error alone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"message":"boom"}', { status: 500 })),
    );
    const onUnauthorized = vi.fn();
    const { getJSON } = createFetchHelpers({ apiUtils: fakeStorage(), onUnauthorized });

    await expect(getJSON("https://gw.test/rest/thing")).rejects.toBeTruthy();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe("probeFetch", () => {
  /*
   * THE BUG THIS BLOCK EXISTS FOR (ported from nextv3-ai-interview-react).
   *
   * A briefing page's connection check called /actuator/health through getJSON,
   * i.e. through authFetch. The endpoint answered 401, authFetch did exactly
   * what it is written to do - cleared the bearer token and replaced the
   * location with the OAuth logout - and a candidate opening their emailed link
   * was signed out by a health check, on a route that deliberately requires no
   * sign-in at all.
   */
  it("resolves on a 401 instead of routing through the logout boundary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 401 })),
    );
    const onUnauthorized = vi.fn();
    const { probeFetch } = createFetchHelpers({ apiUtils: fakeStorage(), onUnauthorized });

    await expect(probeFetch("https://gw.test/actuator/health")).resolves.toEqual({
      reached: true,
      status: 401,
    });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("sends no Authorization header, so a stale token cannot provoke a 401", async () => {
    const spy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", spy);
    const { probeFetch } = createFetchHelpers({ apiUtils: fakeStorage({ accessToken: "stale" }) });

    await probeFetch("https://gw.test/actuator/health");

    const init = initOf(spy);
    expect(new Headers(init.headers ?? {}).has("Authorization")).toBe(false);
    // A cached 200 measures the disk, not the network.
    expect(init.cache).toBe("no-store");
  });

  it("treats any HTTP status as reached - a protected actuator is a live service", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 503 })),
    );
    const { probeFetch } = createFetchHelpers({ apiUtils: fakeStorage() });
    await expect(probeFetch("https://gw.test/actuator/health")).resolves.toMatchObject({
      reached: true,
    });
  });

  it("rejects only on a genuine network failure, which is the signal being measured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const { probeFetch } = createFetchHelpers({ apiUtils: fakeStorage() });
    await expect(probeFetch("https://gw.test/actuator/health")).rejects.toThrow();
  });
});

describe("getBlob", () => {
  it("does not route a 401 through the logout boundary - a picture is not worth a session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 401 })),
    );
    const onUnauthorized = vi.fn();
    const { getBlob } = createFetchHelpers({ apiUtils: fakeStorage({ accessToken: "t" }), onUnauthorized });

    await expect(getBlob("https://gw.test/rest/photo")).rejects.toBeTruthy();
    // "No photo on file" is the NORMAL case for most accounts.
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe("timeouts and caller signals", () => {
  it("composes a caller signal with the timeout instead of replacing it", async () => {
    const spy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", spy);
    const controller = new AbortController();
    const { authFetch } = createFetchHelpers({ apiUtils: fakeStorage() });

    await authFetch("https://gw.test/rest/thing", { timeout: 5000, signal: controller.signal });

    const init = initOf(spy);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // Assigning one over the other is how a caller's cancellation silently stops
    // working the day someone adds a timeout.
    expect(init.signal).not.toBe(controller.signal);
    controller.abort();
    expect(init.signal?.aborted).toBe(true);
  });

  it("passes the caller signal straight through when there is no timeout", async () => {
    const spy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", spy);
    const controller = new AbortController();
    const { authFetch } = createFetchHelpers({ apiUtils: fakeStorage() });

    await authFetch("https://gw.test/rest/thing", { signal: controller.signal });
    expect(initOf(spy).signal).toBe(controller.signal);
  });
});

describe("postFormData", () => {
  it("sets no Content-Type, so the browser can write the multipart boundary", async () => {
    const spy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", spy);
    const { postFormData } = createFetchHelpers({ apiUtils: fakeStorage({ accessToken: "t" }) });

    await postFormData("https://gw.test/rest/upload", new FormData());

    const headers = initOf(spy).headers as Headers;
    expect(headers.has("Content-Type")).toBe(false);
    expect(headers.get("Authorization")).toBe("Bearer t");
  });
});

describe("the decompression fork - the one live behavioural difference", () => {
  /*
   * NOT dead code, which an earlier draft of the extraction plan asserted.
   * `.env.dev:9` sets NEXT_PUBLIC_RESPONSE_DECOMPRESS=true, so every local
   * `pnpm dev` and `pnpm build` in template-starterkit-nextjs runs the
   * shouldDecompress() === true branch. `.env:47` sets false and neither
   * `.env.test` nor `.env.think` overrides it; ai-interview sets it nowhere.
   *
   * The two apps differ for exactly one input - a response carrying `payload`
   * ALONGSIDE other keys - which is why each case below is pinned.
   */
  const compressed = (obj: unknown): string => compressFflate(JSON.stringify(obj)) as string;

  function respondWith(body: Record<string, unknown>): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
  }

  beforeEach(() => {
    config["RESPONSE_DECOMPRESS"] = "true"; // the .env.dev value
  });

  it("payloadOnlyDecompress=true decompresses a LONE payload", async () => {
    respondWith({ payload: compressed({ hello: "world" }) });
    const { getJSON } = createFetchHelpers({ apiUtils: fakeStorage(), payloadOnlyDecompress: true });
    await expect(getJSON("https://gw.test/rest/x")).resolves.toEqual({ hello: "world" });
  });

  it("payloadOnlyDecompress=true leaves payload+other keys UNTOUCHED", async () => {
    const body = { payload: compressed({ hello: "world" }), total: 3 };
    respondWith(body);
    const { getJSON } = createFetchHelpers({ apiUtils: fakeStorage(), payloadOnlyDecompress: true });
    await expect(getJSON("https://gw.test/rest/x")).resolves.toEqual(body);
  });

  it("payloadOnlyDecompress=false leaves even a LONE payload untouched", async () => {
    // ai-interview's reading: sending X-Decompress means the service already
    // did the work, so the client must not do it again.
    const body = { payload: compressed({ hello: "world" }) };
    respondWith(body);
    const { getJSON } = createFetchHelpers({ apiUtils: fakeStorage(), payloadOnlyDecompress: false });
    await expect(getJSON("https://gw.test/rest/x")).resolves.toEqual(body);
  });

  it("with the flag OFF, both settings decompress a payload - the branch they agree on", async () => {
    config["RESPONSE_DECOMPRESS"] = "false";
    for (const payloadOnlyDecompress of [true, false]) {
      respondWith({ payload: compressed({ hello: "world" }) });
      const { getJSON } = createFetchHelpers({ apiUtils: fakeStorage(), payloadOnlyDecompress });
      await expect(getJSON("https://gw.test/rest/x")).resolves.toEqual({ hello: "world" });
    }
  });

  it("defaults to this repo's shape when nothing is passed", async () => {
    respondWith({ payload: compressed({ hello: "world" }), total: 3 });
    const { getJSON } = createFetchHelpers({ apiUtils: fakeStorage() });
    await expect(getJSON("https://gw.test/rest/x")).resolves.toMatchObject({ total: 3 });
  });
});
