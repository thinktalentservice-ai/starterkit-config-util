/**
 * env.json -> config overrides.
 *
 * `env.json` is `{"configEnv": "<AES blob>"}` -- the shape the DevOps pipeline
 * serves for every app in this family. Decrypting it yields a flat object that is
 * spread over the app config at build time and re-applied in the browser.
 *
 * -- KEYS ARE VERBATIM, MINUS ONE PREFIX. THERE IS STILL NO MAPPING TABLE. ---
 *
 * A key in env.json IS the config key, with `NEXT_PUBLIC_` removed if present:
 *
 *     {"INTEGRATION_ALLOWED_DOMAINS": "a.example", "NEXT_PUBLIC_IDLE_TIME": 3600}
 *                 |                                            |
 *                 v                                            v
 *     appConfig.INTEGRATION_ALLOWED_DOMAINS          appConfig.IDLE_TIME
 *
 * The first version of this decoder carried a camelCase -> UPPER_SNAKE transform
 * plus a lookup table, because it was decoding a Vite app's `REACT_APP_camelCase`
 * payload unchanged. That is a translation layer between DevOps and the code, and
 * it fails in the direction nobody notices: a key with no row and no clean
 * transform lands on the config object under a name nothing reads, so the
 * override is "applied" and changes nothing. THAT REMAINS BANNED -- there is no
 * table here, and adding one is still the wrong answer.
 *
 * -- WHY THE ONE PREFIX IS DIFFERENT, AND WHY IT LIVES HERE -----------------
 *
 * The DevOps pipeline writes env.json's payload in `.env` dialect for every app
 * in this family: `NEXT_PUBLIC_IDLE_TIME`, not `IDLE_TIME`. Those files are not
 * the apps' to re-key. Left alone, the prefixed keys land on the config object as
 * brand-new properties nothing reads while the real ones keep their build-time
 * values -- applied, green, and silently ignored. In one app that shipped
 * `INTEGRATION_ALLOWED_DOMAINS = ""` (every domain-gated integration blocked) and
 * an idle timeout 3x longer than intended, at HTTP 200, on environments where
 * env.json was the only source for those keys.
 *
 * `NEXT_PUBLIC_` is not a name. It is the marker that tells the Next compiler to
 * inline a `process.env` read into the client bundle -- and env.json NEVER
 * touches process.env; it is decrypted and assigned onto the config object. So
 * on this side of the boundary the prefix carries no meaning at all, which is
 * exactly what makes stripping it a normalisation rather than a translation:
 * one rule, no table, no key that can fail to have a row. It stays REQUIRED in
 * `.env.*` files, where it does mean something.
 *
 * IT IS DONE HERE, NOT IN EACH APP, AND THAT IS THE POINT. Every consumer
 * decodes env.json twice -- once in a build script that bakes it, once in the
 * browser that re-applies the deployed copy. A strip implemented app-side has to
 * be wired into both, in every app, and an app that wires only one gets a build
 * whose baked values and deployed values disagree about what the file means.
 * That is the precise failure this shared decoder exists to prevent, so the
 * normalisation belongs inside it.
 *
 * A payload already written in config keys passes through untouched, so this is
 * safe to apply unconditionally and DevOps can fix the dialect later with no
 * matching code change on any consumer.
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

/**
 * The one prefix removed from an env.json key. There is no second rule and no
 * lookup table; see the header for why this one is a normalisation rather than a
 * translation.
 */
export const ENV_JSON_KEY_PREFIX = "NEXT_PUBLIC_";

export interface EnvJsonKeyCollision {
  /** The config key both spellings resolved to. */
  key: string;
  /** The env.json key whose value was kept — always the literal one. */
  kept: string;
  /** The env.json key whose value was discarded. */
  dropped: string;
}

export interface EnvJsonResult {
  /** The decoded key/value pairs, keyed by CONFIG key. */
  overrides: Record<string, unknown>;
  /** The config key names, in file order. What a deployment actually set. */
  keys: string[];
  /**
   * The key names as env.json literally spelled them, in file order. Kept so
   * "which env.json produced this" stays answerable after the prefix is gone —
   * a generated snapshot or a build log can record it without decrypting again.
   */
  sourceKeys: string[];
  /** Every key the prefix was stripped from. Empty when the payload was already written in config keys. */
  renamed: Array<{ from: string; to: string }>;
  /** Every config key that arrived under two spellings. See `normalizeEnvJsonKeys`. */
  collisions: EnvJsonKeyCollision[];
}

function isPrefixed(key: string): boolean {
  return key.startsWith(ENV_JSON_KEY_PREFIX) && key.length > ENV_JSON_KEY_PREFIX.length;
}

/**
 * `{ NEXT_PUBLIC_IDLE_TIME: 3600 }` -> `{ IDLE_TIME: 3600 }`.
 *
 * Exported because a consumer that obtains the decoded object by some other
 * route (a plaintext endpoint, a test fixture) must normalise it the SAME way
 * the decoder does — two implementations of one rule is the drift this package
 * exists to remove. `decodeEnvJson` applies it for you; you rarely need this.
 *
 * -- COLLISIONS RESOLVE THE SAME WAY REGARDLESS OF KEY ORDER ----------------
 *
 * A payload carrying BOTH `NEXT_PUBLIC_X` and `X` is the one case a naive strip
 * gets wrong: last-write-wins makes the effective config depend on JSON key
 * order, which is invisible in a diff and unstable across whatever wrote the
 * file. The LITERAL key wins here, always — it is the config key, spelled
 * exactly, with nothing inferred — and the loser is REPORTED in `collisions`
 * rather than dropped in silence.
 */
export function normalizeEnvJsonKeys(decoded: {
  overrides: Record<string, unknown>;
  keys: string[];
}): EnvJsonResult {
  const values = new Map<string, unknown>();
  /* Which env.json key supplied the value currently held, so a collision is
     resolved on WHAT IT IS rather than on which arrived first. */
  const suppliedBy = new Map<string, string>();
  const order: string[] = [];
  const renamed: Array<{ from: string; to: string }> = [];
  const collisions: EnvJsonKeyCollision[] = [];

  for (const key of decoded.keys) {
    const prefixed = isPrefixed(key);
    const target = prefixed ? key.slice(ENV_JSON_KEY_PREFIX.length) : key;
    if (prefixed) renamed.push({ from: key, to: target });

    const previous = suppliedBy.get(target);
    if (previous === undefined) {
      order.push(target);
      values.set(target, decoded.overrides[key]);
      suppliedBy.set(target, key);
      continue;
    }

    /* Reached only when one of the pair is prefixed and the other is not — JSON
       object keys are unique, so two identical spellings cannot both arrive. */
    const incomingWins = isPrefixed(previous) && !prefixed;
    collisions.push({
      key: target,
      kept: incomingWins ? key : previous,
      dropped: incomingWins ? previous : key,
    });
    if (incomingWins) {
      values.set(target, decoded.overrides[key]);
      suppliedBy.set(target, key);
    }
  }

  const overrides: Record<string, unknown> = {};
  for (const key of order) overrides[key] = values.get(key);

  return { overrides, keys: order, sourceKeys: [...decoded.keys], renamed, collisions };
}

/**
 * One human-readable line per rename and collision, or `[]` when the payload was
 * already written in config keys.
 *
 * Shared so a build log and a browser console say the SAME thing — the two
 * places this gets diagnosed from, and the two that must not disagree. The strip
 * is deliberately SAID OUT LOUD rather than done quietly: a normaliser nobody
 * can see in a log is indistinguishable from a payload that never needed it, and
 * those two states want opposite follow-up actions.
 */
export function describeEnvJsonKeyChanges(result: {
  renamed: Array<{ from: string; to: string }>;
  collisions: EnvJsonKeyCollision[];
}): string[] {
  const lines: string[] = [];
  for (const c of result.collisions) {
    lines.push(
      `${c.key}: env.json sets both "${c.kept}" and "${c.dropped}" — kept "${c.kept}" ` +
        "(the literal config key always wins, whatever the key order).",
    );
  }
  if (result.renamed.length) {
    lines.push(
      `stripped ${ENV_JSON_KEY_PREFIX} from ${result.renamed.length} key(s): ` +
        result.renamed.map((r) => `${r.from} -> ${r.to}`).join(", "),
    );
  }
  return lines;
}

/**
 * Raw `env.json` text -> `{ overrides, keys, … }`, keyed by config key.
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
 * `{ NEXT_PUBLIC_IDLE_TIME: 3600 }` -> `{ overrides: { IDLE_TIME: 3600 }, … }`.
 *
 * Every key survives, whether or not the app declares it -- the contract is
 * "env.json can override any value", and an allow-list here would quietly make
 * that false for a key DevOps sets before the code that reads it exists.
 * Undeclared keys are REPORTED instead; see `unknownKeys()`.
 *
 * The normalisation is applied HERE rather than in `decodeEnvJson`, so it covers
 * the plaintext `envVariables` path as well as the encrypted `configEnv` one.
 * Those two are the same file served by two deployment shapes; a strip that
 * reached only one of them would make the docker and static variants disagree
 * about what the payload means.
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
  return normalizeEnvJsonKeys({ overrides, keys });
}

/**
 * Keys env.json sets that the given config does not declare.
 *
 * A warning, never an error. `NEXT_PUBLIC_`-prefixed keys no longer reach here --
 * `normalizeEnvJsonKeys()` resolved them to the config key -- so what this
 * reports is a genuinely unrecognised name: a payload still written in a Vite
 * app's dialect (`REACT_APP_idleTime` rather than `IDLE_TIME`), which applies
 * cleanly and is read by nothing. That is the one failure this design can still
 * have, so it gets said out loud rather than discovered later.
 */
export function unknownKeys(
  overrides: Record<string, unknown>,
  declared: Set<string>,
): string[] {
  return Object.keys(overrides).filter((k) => !declared.has(k));
}
