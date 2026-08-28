import { describe, expect, it } from "vitest";
import { getEnvBoolean, parseBoolean, parseNumber } from "./env-boolean.js";

describe("parseBoolean", () => {
  it('treats the STRING "false" as false - the bug this file exists for', () => {
    // A non-empty string is truthy in JS, so `if (config.FLAG)` is true for a
    // flag an operator explicitly turned off.
    expect(parseBoolean("false")).toBe(false);
    expect(parseBoolean("FALSE")).toBe(false);
    expect(parseBoolean(" false ")).toBe(false);
  });

  it("accepts the affirmative spellings a .env file actually contains", () => {
    for (const v of ["true", "TRUE", " True ", "1", "yes", "on"]) {
      expect(parseBoolean(v)).toBe(true);
    }
  });

  it("is false for absent, empty and unrecognised values", () => {
    for (const v of [undefined, null, "", "   ", "0", "no", "off", "maybe", 0]) {
      expect(parseBoolean(v)).toBe(false);
    }
  });

  it("passes real booleans straight through", () => {
    expect(parseBoolean(true)).toBe(true);
    expect(parseBoolean(false)).toBe(false);
  });
});

describe("getEnvBoolean", () => {
  it("lets an affirmative session override turn a build flag ON", () => {
    expect(getEnvBoolean(undefined, "true")).toBe(true);
    expect(getEnvBoolean("false", "1")).toBe(true);
  });

  it('does NOT let a "false" session value turn a build flag OFF', () => {
    // Deliberately asymmetric. A stale sessionStorage key must not be able to
    // disable something the deployment enabled.
    expect(getEnvBoolean("true", "false")).toBe(true);
    expect(getEnvBoolean(true, null)).toBe(true);
  });

  it("is false when neither side is affirmative", () => {
    expect(getEnvBoolean(undefined, null)).toBe(false);
    expect(getEnvBoolean("false", "false")).toBe(false);
  });
});

describe("parseNumber", () => {
  it('turns "50" into 50 rather than handing a string to arithmetic', () => {
    expect(parseNumber("50")).toBe(50);
    expect(parseNumber(50)).toBe(50);
  });

  it("falls back rather than producing NaN", () => {
    expect(parseNumber("abc", 7)).toBe(7);
    expect(parseNumber(undefined, 7)).toBe(7);
    expect(parseNumber(null, 7)).toBe(0); // Number(null) === 0, and 0 is finite
  });

  it("rejects Infinity, which is finite-looking but never a usable timeout", () => {
    expect(parseNumber("Infinity", 7)).toBe(7);
    expect(parseNumber(-Infinity, 7)).toBe(7);
  });

  it("defaults the fallback to 0", () => {
    expect(parseNumber("nope")).toBe(0);
  });
});
