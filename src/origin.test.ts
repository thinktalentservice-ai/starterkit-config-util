import { describe, expect, it } from "vitest";
import { isLoopbackHostname, normalizeOrigin, resolveServiceOrigin } from "./origin.js";

const FB = "https://fallback.test";
const CONFIGURED = "https://gateway.test";

/** A `location` for a page served from `origin`. Only the two fields the resolver reads. */
const at = (origin: string) => ({ origin, hostname: new URL(origin).hostname });

describe("normalizeOrigin", () => {
  it("strips trailing slashes so composed paths cannot double up", () => {
    expect(normalizeOrigin("https://h/")).toBe("https://h");
    expect(normalizeOrigin("https://h///")).toBe("https://h");
    expect(normalizeOrigin("https://h")).toBe("https://h");
  });

  it("uses the fallback for undefined - the env var was never set", () => {
    expect(normalizeOrigin(undefined, FB)).toBe(FB);
  });

  it("uses the fallback for null rather than the string 'null'", () => {
    // The code this replaces did String(null) -> "null" and composed
    // "null/oauth-service". Folding null in with undefined is a fix, not parity.
    expect(normalizeOrigin(null, FB)).toBe(FB);
  });

  it("KEEPS the empty string - NEXT_PUBLIC_SERVICE_URL= means root-relative on purpose", () => {
    // The single most important case in this file. A `value || fallback` would
    // collapse it into the fallback and silently re-target every API call at the
    // build's default host, which is exactly what an operator setting it empty
    // was trying to avoid.
    expect(normalizeOrigin("", FB)).toBe("");
  });

  it("normalises the fallback too, so a sloppy default cannot leak a double slash", () => {
    expect(normalizeOrigin(undefined, "https://fallback.test/")).toBe(FB);
  });

  it("defaults the fallback to the empty string", () => {
    expect(normalizeOrigin(undefined)).toBe("");
  });
});

describe("isLoopbackHostname", () => {
  it.each(["localhost", "127.0.0.1", "[::1]", "app.localhost"])("%s is this machine", (hostname) => {
    expect(isLoopbackHostname(hostname)).toBe(true);
  });

  it.each(["323.thinktalent.info", "nextv3.thinktalent.info", "192.168.1.20", "localhost.example.com", "notlocalhost"])(
    "%s is a deployment",
    (hostname) => {
      expect(isLoopbackHostname(hostname)).toBe(false);
    },
  );
});

describe("resolveServiceOrigin", () => {
  it("follows the host that served the page - the configured origin does NOT win on a deployment", () => {
    // The defect this function exists for: one artefact built with
    // NEXT_PUBLIC_SERVICE_URL=https://nextv3... and served from 323... sent every
    // API call, and every task link, to nextv3.
    expect(resolveServiceOrigin(CONFIGURED, FB, at("https://323.thinktalent.info"))).toBe(
      "https://323.thinktalent.info",
    );
    expect(resolveServiceOrigin(undefined, FB, at("https://nextv3.elemetrik.net"))).toBe(
      "https://nextv3.elemetrik.net",
    );
  });

  it("keeps a non-default port, which is part of the origin", () => {
    expect(resolveServiceOrigin(CONFIGURED, FB, at("http://deployed.test:3005"))).toBe("http://deployed.test:3005");
  });

  it.each(["http://localhost:3005", "http://127.0.0.1:3005", "http://[::1]:3005", "http://app.localhost:3005"])(
    "uses the configured origin on %s - a dev machine has no gateway of its own",
    (origin) => {
      expect(resolveServiceOrigin(CONFIGURED, FB, at(origin))).toBe(CONFIGURED);
    },
  );

  it("on loopback, normalises exactly as normalizeOrigin does", () => {
    const local = at("http://localhost:3005");
    expect(resolveServiceOrigin("https://gateway.test///", FB, local)).toBe(CONFIGURED);
    expect(resolveServiceOrigin(undefined, FB, local)).toBe(FB);
    expect(resolveServiceOrigin(null, FB, local)).toBe(FB);
    // Set to empty on purpose: root-relative, e.g. behind a local reverse proxy.
    expect(resolveServiceOrigin("", FB, local)).toBe("");
  });

  it("names NO host when there is no location - a prerender must not bake one into the artefact", () => {
    expect(resolveServiceOrigin(CONFIGURED, FB, null)).toBe("");
  });

  it("falls back to the configured origin for an opaque origin rather than composing 'null/…'", () => {
    // file://, a sandboxed iframe and about:blank all report origin "null".
    expect(resolveServiceOrigin(CONFIGURED, FB, { origin: "null", hostname: "" })).toBe(CONFIGURED);
  });

  it("reads globalThis.location by default", () => {
    // vitest's jsdom serves the test page from localhost, so the default takes
    // the loopback branch. The assertion is on the hostname first so a changed
    // jsdom URL fails HERE, naming the cause, instead of in the line below.
    expect(isLoopbackHostname(globalThis.location.hostname)).toBe(true);
    expect(resolveServiceOrigin(CONFIGURED, FB)).toBe(CONFIGURED);
  });
});
