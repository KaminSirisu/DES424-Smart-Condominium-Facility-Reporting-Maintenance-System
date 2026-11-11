import { ApiError } from './types.js';

/**
 * What the list endpoints share: the `limit` and `cursor` query parameters
 * (openapi.yaml, Limit and Cursor). A cursor is opaque to the caller (base64
 * of a small JSON object holding a key position, never an item) and is
 * checked on the way back in; a position only narrows a query that is already
 * limited to what the caller may see, so a forged cursor can reach nothing
 * new.
 */

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
const CURSOR_MAX_LENGTH = 1000;

export function badRequest(message: string): ApiError {
  return new ApiError(400, 'BAD_REQUEST', message);
}

export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decodeCursor(raw: string): unknown {
  if (raw.length > CURSOR_MAX_LENGTH) throw badRequest('cursor is not valid.');
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw badRequest('cursor is not valid.');
  }
}

/** A key position inside a cursor: a non-empty string of sane length. */
export function isKeyString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value !== '' &&
    value.length <= CURSOR_MAX_LENGTH
  );
}

/** The one string a cursor holds under `field`, undefined for no cursor. */
export function stringCursor(
  cursor: unknown,
  field: string,
): string | undefined {
  if (cursor === undefined) return undefined;
  const value = (cursor as Record<string, unknown> | null)?.[field];
  if (!isKeyString(value)) throw badRequest('cursor is not valid.');
  return value;
}

/** A query parameter that may be given once, or a 400. */
export function scalarParam(
  params: URLSearchParams,
  name: string,
): string | undefined {
  const values = params.getAll(name);
  if (values.length > 1) throw badRequest(`${name} may be given once.`);
  return values[0];
}

/** `limit`: a whole number from 1 to MAX_LIMIT, DEFAULT_LIMIT when absent. */
export function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const limit = Number(raw);
  if (!/^\d+$/.test(raw) || limit < 1 || limit > MAX_LIMIT) {
    throw badRequest(`limit must be a whole number from 1 to ${MAX_LIMIT}.`);
  }
  return limit;
}
