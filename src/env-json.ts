/**
 * env.json -> config overrides.
 *
 * `env.json` is `{"configEnv": "<AES blob>"}` -- the shape the DevOps pipeline
 * serves for every app in this family. Decrypting it yields a flat object that is
 * spread over the app config at build time and re-applied in the browser.
 *
 * -- KEYS ARE VERBATIM. THERE IS NO MAPPING TABLE. ---------------------------
 *
 * A key in env.json IS the config key:
 *
 *     {"INTEGRATION_ALLOWED_DOMAINS": "a.example,b.example", "IDLE_TIME": 3600}
 *                 |
 *                 v
 *     appConfig.INTEGRATION_ALLOWED_DOMAINS
 *
 * The first version of this decoder carried a camelCase -> UPPER_SNAKE transform
 * plus a lookup table, because it was decoding a Vite app's `REACT_APP_camelCase`
 * payload unchanged. That is a translation layer between DevOps and the code, and
 * it fails in the direction nobody notices: a key with no row and no clean
 * transform lands on the config object under a name nothing reads, so the
 * override is "applied" and changes nothing. Whoever writes env.json writes the
 * key the code reads, and that sentence is the whole contract.
 *
 * IMPORTED FROM BOTH SIDES -- a build script at build time and the app in the
 * browser. No React, no DOM, no framework imports for that reason: one decoder,
 * so the baked values and the fetched values cannot disagree about what the file
 * means.
 *
 * THE BLOB IS OBFUSCATED, NOT SECRET. CryptoEncryption's key lives inside
 * @devopsthink/react-security-util, which ships to the browser, so anyone with
 * the bundle can read env.json. Nothing confidential may go in it.
 */
import { CryptoEncryption } from "@devopsthink/react-security-util";

export interface EnvJsonResult {
  /** The decoded key/value pairs, keys verbatim. */
  overrides: Record<string, unknown>;
  /** The key names, in file order. Useful for logging what a deployment actually set. */
  keys: string[];
}

/**
 * Raw `env.json` text -> `{ overrides, keys }`, keys verbatim.
 *
 * THROWS on anything it cannot read. A silent `{}` is indistinguishable from
 * "env.json legitimately overrides nothing", which is the state this mechanism
 * exists to be able to observe. Callers decide what to do with it: a build script
 * should fail, a browser should log and keep the baked values.
 */
export function decodeEnvJson(text: string): EnvJsonResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`env.json is not valid JSON: ${(cause as Error).message}`, { cause });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("env.json must be a JSON object.");
  }

  const record = parsed as Record<string, unknown>;

  /* The docker/express variant of this endpoint returns BOTH `envVariables`
     (plaintext) and `configEnv` (the same thing, encrypted); the static file
     carries only `configEnv`. Preferring the encrypted field keeps one code
     path, and means a file carrying both cannot have them disagree. */
  const blob = record["configEnv"];
  if (typeof blob !== "string" || blob.trim() === "") {
    const plain = record["envVariables"];
    if (plain && typeof plain === "object" && !Array.isArray(plain)) {
      return toOverrides(plain as Record<string, unknown>);
    }
    throw new Error("env.json has no `configEnv` string and no `envVariables` object.");
  }

  let decrypted: string;
  try {
    decrypted = CryptoEncryption.decrypt(blob) as string;
  } catch (cause) {
    throw new Error(
      "env.json: configEnv did not decrypt. It is encrypted by " +
        "@devopsthink/react-security-util, so a version bump on that package and a blob " +
        `produced with a different key both land here: ${(cause as Error).message}`,
      { cause },
    );
  }

  let values: unknown;
  try {
    values = JSON.parse(decrypted);
  } catch (cause) {
    throw new Error("env.json: configEnv decrypted to something that is not JSON.", { cause });
  }

  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new Error("env.json: configEnv must decrypt to a JSON object.");
  }

  return toOverrides(values as Record<string, unknown>);
}

/**
 * `{ IDLE_TIME: 3600 }` -> `{ overrides: { IDLE_TIME: 3600 }, keys: ["IDLE_TIME"] }`.
 *
 * Every key survives, whether or not the app declares it -- the contract is
 * "env.json can override any value", and an allow-list here would quietly make
 * that false for a key DevOps sets before the code that reads it exists.
 * Undeclared keys are REPORTED instead; see `unknownKeys()`.
 */
function toOverrides(values: Record<string, unknown>): EnvJsonResult {
  const overrides: Record<string, unknown> = {};
  const keys: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    /* `undefined` overrides nothing while counting as a key, so it is dropped --
       "env.json set this" then stays true of every key that survives. `null` is
       kept: it is a value an operator can mean. */
    if (value === undefined) continue;
    keys.push(key);
    overrides[key] = value;
  }
  return { overrides, keys };
}

/**
 * Keys env.json sets that the given config does not declare.
 *
 * A warning, never an error. The usual cause is a payload still written in a
 * Vite app's dialect (`REACT_APP_idleTime` rather than `IDLE_TIME`), which
 * applies cleanly and is read by nothing -- the one failure this design can
 * still have, so it gets said out loud rather than discovered later.
 */
export function unknownKeys(
  overrides: Record<string, unknown>,
  declared: Set<string>,
): string[] {
  return Object.keys(overrides).filter((k) => !declared.has(k));
}
