/**
 * Resolve `{ ...base, ...envs[appEnv], ...overrides }` — the composition every
 * consumer of this package writes, and gets wrong in the same two ways.
 *
 * ── DEFECT 1: A DYNAMIC require() DOES NOT FAIL LOUDLY ───────────────────────
 *
 * Both apps started with `require(`./env.${appEnv}`).default`, which looks like
 * it throws on a bad environment name and does not: a template-literal require
 * becomes a bundler CONTEXT MODULE, so the failure is a runtime
 * "Cannot find module './env.prod'" inside a client chunk — a white screen with
 * no server log, on whichever route first touches config. `.env.think` set
 * NEXT_PUBLIC_APP_ENV=prod for months while no env.prod.js existed and every
 * build was green.
 *
 * Taking `envs` as an object the caller built from STATIC imports moves that
 * failure to build time, because a static export prerenders every route and
 * every route imports the config module.
 *
 * ── DEFECT 2: A BARE INDEX WALKS THE PROTOTYPE CHAIN ─────────────────────────
 *
 * `envs[appEnv]` with appEnv="constructor" resolves to an inherited Object
 * member. It is TRUTHY, so the "unknown environment" guard never fires, and the
 * build proceeds with the env config bound to a FUNCTION. Every `config.*` read
 * is then undefined and the app ships with empty service URLs — a green build
 * whose every API call goes to the wrong place, from a single typo in a CI
 * variable. The same holds for `toString`, `valueOf`, `hasOwnProperty` and
 * `__proto__`.
 *
 * `Object.hasOwn` is the whole fix and it is why this function exists rather
 * than being three lines inlined in each app.
 *
 * ── ORDERING ─────────────────────────────────────────────────────────────────
 *
 * `overrides` goes LAST and is OPTIONAL. Last, because it is the runtime layer
 * (a decrypted env.json) and the entire point is that it wins — an app that
 * spreads it earlier has an override mechanism that silently does nothing.
 * Optional, because not every consumer has one: nextv3-ai-interview-react
 * resolves `{ ...baseEnv, ...envConfig }` and has no env.json at all.
 */
export interface CreateAppConfigOptions<
  TBase extends object,
  TEnv extends object,
  TOverrides extends object,
> {
  /** Keys present in every environment. Usually the app's env.base.js default export. */
  base: TBase;
  /**
   * Environment name -> that environment's config object. Build it from STATIC
   * imports and an object literal; the literal is also what lets a host gate
   * enumerate the registered environments without executing anything.
   */
  envs: Record<string, TEnv>;
  /** Typically `process.env.NEXT_PUBLIC_APP_ENV || "dev"`. */
  appEnv: string | undefined;
  /** Runtime layer, applied last. Omit it if the app has none. */
  overrides?: TOverrides | undefined;
}

export function createAppConfig<
  TBase extends object,
  TEnv extends object,
  TOverrides extends object = Record<string, never>,
>(options: CreateAppConfigOptions<TBase, TEnv, TOverrides>): TBase & TEnv & Partial<TOverrides> {
  const { base, envs, appEnv, overrides } = options;

  const known = Object.keys(envs);

  if (typeof appEnv !== "string" || appEnv === "") {
    throw new Error(
      `createAppConfig: appEnv is ${appEnv === "" ? "an empty string" : String(appEnv)}. ` +
        `Pass the environment name explicitly (e.g. process.env.NEXT_PUBLIC_APP_ENV || "dev"). ` +
        `Known environments: ${known.join(", ") || "none"}.`,
    );
  }

  // Object.hasOwn, NOT `envs[appEnv]` — see DEFECT 2 above. This line is the
  // reason this function is worth its own module.
  if (!Object.hasOwn(envs, appEnv)) {
    throw new Error(
      `createAppConfig: appEnv="${appEnv}" has no matching env config. ` +
        `Known environments: ${known.join(", ") || "none"}. ` +
        `Add the env module, import it statically, and register it in the map you pass as ` +
        `\`envs\` — or fix the environment variable this build loaded.`,
    );
  }

  const envConfig = envs[appEnv] as TEnv;

  return { ...base, ...envConfig, ...(overrides ?? {}) } as TBase & TEnv & Partial<TOverrides>;
}
