import type { OpenPosition, OpenStatus } from '../shared/ticket-repository.js';
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

/** The statuses of a team's open queue (TeamOpenIndex). */
export const OPEN_STATUSES: OpenStatus[] = ['ASSIGNED', 'IN_PROGRESS'];

/** The position in a team's open queue that a cursor holds, per open status. */
export function openCursor(cursor: unknown): OpenPosition {
  if (cursor === undefined) return {};
  const value = (cursor as Record<string, unknown> | null)?.o;
  if (typeof value !== 'object' || value === null) {
    throw badRequest('cursor is not valid.');
  }
  const position: OpenPosition = {};
  for (const status of OPEN_STATUSES) {
    const key = (value as Record<string, unknown>)[status];
    if (key === undefined) continue;
    if (!isKeyString(key)) throw badRequest('cursor is not valid.');
    position[status] = key;
  }
  return position;
}

/** A YYYY-MM-DD string that is a real calendar date, else a 400. */
export function parseDate(name: string, value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw badRequest(`${name} must be a date as YYYY-MM-DD.`);
  }
  return date;
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
