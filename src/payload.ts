import { compressFflate } from "@devopsthink/react-security-util";

/**
 * Compress and wrap a payload for an API call.
 *
 * Returns a STRING, already `JSON.stringify`d, because that is what the call
 * sites pass straight to `fetch`'s `body`. Returning the object and letting each
 * caller stringify would be tidier and would also let one of them forget.
 *
 * The double stringify is not redundant: the inner one produces the bytes that
 * get compressed, the outer one produces the request body. The Java services on
 * the other end expect exactly `{"payload": "<fflate base64>"}`.
 */
export function buildCompressedPayload(obj: unknown): string {
  return JSON.stringify({ payload: compressFflate(JSON.stringify(obj)) });
}
