import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearConfigSource, setConfigSource } from "./config-source.js";
import { createApiUtils, encodeJwtString, decodeJwtString, hasStorageSecret } from "./storage.js";

const SECRET_A = "secret-alpha-0123456789";
const SECRET_B = "secret-bravo-9876543210";

let config: Record<string, unknown>;

beforeEach(() => {
  window.localStorage.clear();
  config = { STORAGE_SECRET: SECRET_A };
  setConfigSource(config);
});

afterEach(() => {
  clearConfigSource();
  window.localStorage.clear();
});

describe("createApiUtils - encrypted storage", () => {
  it("round-trips a value through secure-ls", () => {
    const api = createApiUtils();
    api.setLocalStorage("userInfo", { id: 7, name: "x" });
    expect(api.getLocalStorage("userInfo")).toEqual({ id: 7, name: "x" });
  });

  it("does not store the value in plaintext", () => {
    const api = createApiUtils();
    api.setLocalStorage("userInfo", { name: "plaintext-canary" });
    const dump = JSON.stringify(window.localStorage);
    expect(dump).not.toContain("plaintext-canary");
  });

  it("returns a FALSY empty string for a key that was never written, not a throw", () => {
    // secure-ls returns "" for a missing key, and `?? null` does not catch it
    // because "" is not nullish. Characterised rather than fixed: both consuming
    // apps already rely on the falsiness (`if (token)` in the fetch layer), and
    // tightening it to null would be a silent cross-app behaviour change.
    expect(createApiUtils().getCookie("accessToken")).toBe("");
    expect(createApiUtils().getCookie("accessToken")).toBeFalsy();
  });

  // THE CALL-TIME READ, PROVEN.
  //
  // A `const secret = config.STORAGE_SECRET` at module scope copies the value
  // before the browser applies the deployed env.json, so that one key would
  // silently ignore it. nextv3-ai-interview-react has exactly that capture.
  // This is the test that would fail if the port reintroduced it.
  it("re-reads the secret on every access, so an env.json overlay reaches it", () => {
    const api = createApiUtils();
    api.setLocalStorage("probe", { v: 1 });
    expect(api.getLocalStorage("probe")).toEqual({ v: 1 });

    // The overlay. Same object, mutated - exactly what runtime-config.js does.
    config["STORAGE_SECRET"] = SECRET_B;
    expect(api.getLocalStorage("probe")).not.toEqual({ v: 1 });

    config["STORAGE_SECRET"] = SECRET_A;
    expect(api.getLocalStorage("probe")).toEqual({ v: 1 });
  });

  it("names the missing secret instead of failing somewhere else later", () => {
    delete config["STORAGE_SECRET"];
    expect(hasStorageSecret()).toBe(false);
    // Without this the symptom is every decrypt returning null, i.e. "all users
    // are silently logged out", with no error anywhere.
    expect(() => createApiUtils().setCookie("accessToken", "x")).toThrow(/STORAGE_SECRET is not set/);
  });

  it("honours a remapped secret key name", () => {
    clearConfigSource();
    setConfigSource({ LS_SECRET: SECRET_A }, { keys: { storageSecret: "LS_SECRET" } });
    const api = createApiUtils();
    api.setCookie("accessToken", "tok");
    expect(api.getCookie("accessToken")).toBe("tok");
  });
});

describe("mirrorRaw", () => {
  it("writes NO plaintext mirror by default", () => {
    const api = createApiUtils();
    api.setLocalStorage("userInfo", { name: "x" });
    expect(window.localStorage.getItem("userInfo_raw")).toBeNull();
  });

  it("writes the plaintext mirror when the host opts in", () => {
    // template-starterkit-nextjs opts in: scripts/dev-debug/login.mjs reads these
    // mirrors. Byte-identical behaviour is the point, not an endorsement.
    const api = createApiUtils({ mirrorRaw: true });
    api.setLocalStorage("userInfo", { name: "x" });
    expect(window.localStorage.getItem("userInfo_raw")).toBe('{"name":"x"}');
  });

  it("inherits the registry setting when the instance does not specify one", () => {
    clearConfigSource();
    setConfigSource({ STORAGE_SECRET: SECRET_A }, { mirrorRaw: true });
    createApiUtils().setLocalStorage("k", 1);
    expect(window.localStorage.getItem("k_raw")).toBe("1");
  });
});

describe("queryString", () => {
  it("percent-encodes both halves of every pair", () => {
    expect(createApiUtils().queryString({ "a b": "c&d", page: 2 })).toBe("a%20b=c%26d&page=2");
  });
});

describe("jwt helpers", () => {
  it("signs and decodes with the app secret", async () => {
    const token = await encodeJwtString({ sub: "user-1" });
    expect(decodeJwtString(token)).toMatchObject({ sub: "user-1" });
  });

  it("names the missing secret rather than throwing jose's HMAC error", async () => {
    delete config["STORAGE_SECRET"];
    // jose's own failure is `DataError: HMAC key data must not be empty`, which
    // names neither the variable nor the file.
    await expect(encodeJwtString({ sub: "x" })).rejects.toThrow(/STORAGE_SECRET is not set/);
  });
});

describe("no global at all", () => {
  it("works from an explicit getConfig, never touching the registry", () => {
    clearConfigSource();
    const local = { STORAGE_SECRET: SECRET_A };
    const api = createApiUtils({ getConfig: () => local });
    api.setCookie("accessToken", "tok");
    expect(api.getCookie("accessToken")).toBe("tok");
  });
});
