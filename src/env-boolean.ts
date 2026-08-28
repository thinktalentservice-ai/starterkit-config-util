/**
 * Utilities to safely interpret environment flags.
 *
 * Env vars arrive as STRINGS. `"false"` is a non-empty string and therefore
 * truthy, so `if (config.SOME_FLAG)` is true for a flag that was explicitly
 * turned off. Every consumer of this package hit that, which is why all of them
 * carry a copy of this file.
 */

/** `"false"`, `""`, `null`, `undefined`, `"no"`, `"0"` -> false. Everything explicitly affirmative -> true. */
export function parseBoolean(value: unknown): boolean {
  if (value === true) return true;
  if (value === false) return false;

  if (value == null) return false;

  const s = String(value).trim().toLowerCase();
  if (!s) return false;

  return s === "true" || s === "1" || s === "yes" || s === "on";
}

/**
 * Build-time value plus a runtime override, where ONLY an explicit affirmative
 * counts on either side.
 *
 * The override wins when it is affirmative and is otherwise ignored — so a
 * sessionStorage key left over as `"false"` cannot turn OFF a flag the build
 * turned on. That asymmetry is deliberate and is what the parameter order
 * encodes; do not "simplify" it to `sessionValue ?? buildValue`.
 */
export function getEnvBoolean(buildValue: unknown, sessionValue: unknown): boolean {
  return parseBoolean(sessionValue) || parseBoolean(buildValue);
}

/**
 * Same idea for numeric flags: `"50"` from a .env file must not reach code that
 * expects a number, and a bad value must fall back rather than produce NaN.
 *
 * `Number.isFinite`, not `!isNaN`: `Number("")` is 0 and `Number(" ")` is 0,
 * but `Number("Infinity")` is Infinity, which is not a usable timeout.
 */
export function parseNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
