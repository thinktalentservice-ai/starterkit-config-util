import { describe, expect, it } from "vitest";
import { normalizeOrigin } from "./origin.js";

const FB = "https://fallback.test";

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
