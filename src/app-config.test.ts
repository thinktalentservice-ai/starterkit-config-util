import { describe, expect, it } from "vitest";
import { createAppConfig } from "./app-config.js";

const base = { APP_TITLE: "base", SHARED: "base" };
const dev = { ENV: "dev", SHARED: "dev" };
const think = { ENV: "think", SHARED: "think" };

describe("createAppConfig", () => {
  it("spreads base, then the environment, then overrides", () => {
    const config = createAppConfig({
      base,
      envs: { dev, think },
      appEnv: "think",
      overrides: { SHARED: "env.json" },
    });
    expect(config.APP_TITLE).toBe("base");
    expect(config.ENV).toBe("think");
    // env.json goes LAST. An app that spreads it earlier has an override
    // mechanism that silently does nothing.
    expect(config.SHARED).toBe("env.json");
  });

  it("works with no overrides at all", () => {
    // nextv3-ai-interview-react resolves { ...base, ...env } and has no env.json
    // layer. The parameter is optional for that reason, not for tidiness.
    const config = createAppConfig({ base, envs: { dev }, appEnv: "dev" });
    expect(config.SHARED).toBe("dev");
  });

  it("hardcodes no environment names", () => {
    const config = createAppConfig({
      base,
      envs: { staging: { ENV: "staging" }, qa: { ENV: "qa" }, elus: { ENV: "elus" } },
      appEnv: "elus",
    });
    expect(config.ENV).toBe("elus");
  });

  it("throws on an unknown environment, naming the value AND the known set", () => {
    expect(() => createAppConfig({ base, envs: { dev, think }, appEnv: "prod" })).toThrow(
      /appEnv="prod".*Known environments: dev, think/s,
    );
  });

  // THE BUG THIS FUNCTION EXISTS FOR.
  //
  // `envs[appEnv]` consults the prototype chain, so an inherited Object member
  // is TRUTHY and the "unknown environment" guard never fires. The env config
  // binds to a function, every key reads undefined, and the build ships green
  // with empty service URLs — from one typo in a CI variable.
  it.each(["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "isPrototypeOf"])(
    "throws for the inherited Object member %s instead of resolving it",
    (name) => {
      expect(() => createAppConfig({ base, envs: { dev, think }, appEnv: name })).toThrow(
        /has no matching env config/,
      );
    },
  );

  it("proves the naive form really would have resolved those", () => {
    // Guards the test above against becoming vacuous: if a future JS engine
    // stopped exposing these, the cases would pass for the wrong reason.
    const envs: Record<string, unknown> = { dev };
    expect(envs["constructor"]).toBeTruthy();
    expect(Object.hasOwn(envs, "constructor")).toBe(false);
  });

  it("throws when appEnv is missing or empty rather than resolving undefined", () => {
    expect(() => createAppConfig({ base, envs: { dev }, appEnv: undefined })).toThrow(/appEnv is/);
    expect(() => createAppConfig({ base, envs: { dev }, appEnv: "" })).toThrow(
      /appEnv is an empty string/,
    );
  });

  it("returns a fresh object and does not mutate its inputs", () => {
    const b = { ...base };
    const e = { ...dev };
    const config = createAppConfig({ base: b, envs: { dev: e }, appEnv: "dev" });
    config.SHARED = "mutated";
    expect(b.SHARED).toBe("base");
    expect(e.SHARED).toBe("dev");
  });
});
