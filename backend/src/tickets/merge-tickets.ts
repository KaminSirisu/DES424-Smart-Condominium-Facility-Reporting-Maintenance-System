import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { requireStaff } from '../shared/staff-auth.js';
import { listReporterIds } from '../shared/ticket-reporters.js';
import {
  getTicket,
  MAX_TRANSACTION_ITEMS,
  mergeItemCount,
  mergeTickets,
  type MergeChange,
} from '../shared/ticket-repository.js';
import { computeDeadline, isTeamId, slaStartOf } from '../triage/policy.js';
import {
  errorResponse,
  isConditionalCheckFailure,
  json,
  ticketIdFromPath,
} from './staff-http.js';
import { toTicketView } from './ticket-view.js';
import { ApiError, Priority, TicketRecord } from './types.js';

/**
 * POST /tickets/{ticketId}/merge — merge duplicate tickets into this one
 * (SCFRMS-44).
 *
 * Contract: docs/api-specs/openapi.yaml (mergeTickets, MergeTickets). The path
 * ticket is the canonical ticket; `sourceTicketIds` are the duplicates. Only a
 * technician may merge, and only tickets of their own team (a manager and a
 * technician of another team get 403). The canonical ticket and every source
 * must be ASSIGNED or IN_PROGRESS. The technician decides that the tickets are
 * the same problem; matching location text is not checked.
 *
 * Each source becomes MERGED and points at the canonical ticket; all of its
 * reporters are linked to the canonical ticket, so they can see it and get its
 * updates. The canonical ticket takes the highest priority of the tickets and a
 * deadline counted from the earliest creation time (SLA-09); its own
 * `createdAt` does not change, because it is part of the index keys.
 *
 * At most MAX_SOURCES sources per request, and no more reporters than fit in
 * one DynamoDB transaction (see shared/ticket-repository.ts), else 422.
 *
 * Idempotency: the Idempotency-Key header is required (8 to 128 characters),
 * but no key is stored. A retry finds its sources already MERGED into this
 * ticket and gets 200 with the ticket as it is.
 */

export const MAX_SOURCES = 10;
const MERGEABLE = ['ASSIGNED', 'IN_PROGRESS'];
const KEY_MIN = 8;
const KEY_MAX = 128;
const ID_MAX = 128;
const PRIORITY_RANK: Record<Priority, number> = {
  CRITICAL: 3,
  MEDIUM: 2,
  LOW: 1,
};

function idempotencyKey(event: APIGatewayProxyEventV2): void {
  const key = event.headers?.['idempotency-key'];
  if (typeof key !== 'string' || key.length < KEY_MIN || key.length > KEY_MAX) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `Idempotency-Key header is required (${KEY_MIN} to ${KEY_MAX} characters).`,
    );
  }
}

function parseBody(event: APIGatewayProxyEventV2): string[] {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : event.body;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? '');
  } catch {
    throw new ApiError(400, 'BAD_REQUEST', 'Request body must be valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'Request body must be a JSON object.',
    );
  }
  const body = parsed as Record<string, unknown>;

  const unknownField = Object.keys(body).find((k) => k !== 'sourceTicketIds');
  if (unknownField) {
    throw new ApiError(400, 'BAD_REQUEST', `Unknown field: ${unknownField}.`);
  }

  const ids = body.sourceTicketIds;
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.some((id) => typeof id !== 'string' || id === '' || id.length > ID_MAX)
  ) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'sourceTicketIds must be a list of ticket ids.',
    );
  }
  if (new Set(ids).size !== ids.length) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'sourceTicketIds must not repeat a ticket.',
    );
  }
  if (ids.length > MAX_SOURCES) {
    throw new ApiError(
      422,
      'UNPROCESSABLE',
      `At most ${MAX_SOURCES} tickets can be merged at once.`,
    );
  }
  return ids as string[];
}

function isMergedInto(source: TicketRecord, canonicalId: string): boolean {
  return (
    source.status === 'MERGED' && source.mergedIntoTicketId === canonicalId
  );
}

/** The priority and deadline the canonical ticket gets, when they change (SLA-09). */
function priorityAndDeadline(
  canonical: TicketRecord,
  sources: TicketRecord[],
): Pick<MergeChange, 'priority' | 'deadlineAt' | 'slaStartAt'> {
  const all = [canonical, ...sources];
  const ranked = all
    .map((t) => t.priority)
    .filter((p): p is Priority => p !== undefined);
  if (ranked.length === 0 || !isTeamId(canonical.teamId)) return {};

  const highest = ranked.reduce((a, b) =>
    PRIORITY_RANK[b] > PRIORITY_RANK[a] ? b : a,
  );
  const earliest = all
    .map(slaStartOf)
    .reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));
  const deadlineAt = computeDeadline(earliest, canonical.teamId, highest);

  return {
    ...(highest !== canonical.priority ? { priority: highest } : {}),
    ...(deadlineAt !== canonical.deadlineAt ? { deadlineAt } : {}),
    // createdAt stays (it is part of index keys), so the earlier start is kept
    // apart for any later recount of the deadline, such as a priority change.
    ...(Date.parse(earliest) < Date.parse(slaStartOf(canonical))
      ? { slaStartAt: earliest }
      : {}),
  };
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const staff = await requireStaff(event.headers?.authorization);
    const canonicalId = ticketIdFromPath(event);
    idempotencyKey(event);
    const sourceIds = parseBody(event);

    if (staff.role !== 'TECHNICIAN' || !staff.teamId) {
      throw new ApiError(
        403,
        'FORBIDDEN',
        'Only a technician can merge tickets.',
      );
    }
    if (sourceIds.includes(canonicalId)) {
      throw new ApiError(
        422,
        'UNPROCESSABLE',
        'A ticket cannot be merged into itself.',
      );
    }

    const [canonical, ...found] = await Promise.all(
      [canonicalId, ...sourceIds].map((id) => getTicket(id)),
    );
    if (!canonical) throw new ApiError(404, 'NOT_FOUND', 'Ticket not found.');
    if (found.some((s) => s === null)) {
      throw new ApiError(
        422,
        'UNPROCESSABLE',
        'A source ticket does not exist.',
      );
    }
    const sources = found as TicketRecord[];

    for (const ticket of [canonical, ...sources]) {
      if (ticket.teamId !== staff.teamId) {
        throw new ApiError(
          403,
          'FORBIDDEN',
          'Every ticket must be assigned to your team.',
        );
      }
    }
    if (!MERGEABLE.includes(canonical.status)) {
      throw new ApiError(
        409,
        'INVALID_TRANSITION',
        `A ${canonical.status} ticket cannot take merged tickets.`,
      );
    }
    const pending = sources.filter((s) => !isMergedInto(s, canonicalId));
    const closed = pending.find((s) => !MERGEABLE.includes(s.status));
    if (closed) {
      throw new ApiError(
        409,
        'INVALID_TRANSITION',
        `A ${closed.status} ticket cannot be merged.`,
      );
    }
    if (pending.length === 0) {
      return json(200, toTicketView(canonical));
    }

    const known = new Set(await listReporterIds(canonical.id));
    const reporters: MergeChange['reporters'] = [];
    for (const source of pending) {
      for (const lineUserId of await listReporterIds(source.id)) {
        if (known.has(lineUserId)) continue;
        known.add(lineUserId);
        reporters.push({ lineUserId, sourceTicketId: source.id });
      }
    }
    if (
      mergeItemCount(pending.length, reporters.length) > MAX_TRANSACTION_ITEMS
    ) {
      throw new ApiError(
        422,
        'UNPROCESSABLE',
        'Too many reporters to merge at once. Merge fewer tickets.',
      );
    }

    const change: MergeChange = {
      accountId: staff.accountId,
      teamId: staff.teamId,
      now: new Date().toISOString(),
      reporters,
      ...priorityAndDeadline(canonical, pending),
    };
    try {
      await mergeTickets(canonical, pending, change);
    } catch (err) {
      if (!isConditionalCheckFailure(err)) throw err;
      // A ticket changed between our read and write; a retry may have won.
      const [current, ...now] = await Promise.all(
        [canonicalId, ...pending.map((s) => s.id)].map((id) => getTicket(id)),
      );
      if (current && now.every((s) => s && isMergedInto(s, canonicalId))) {
        return json(200, toTicketView(current));
      }
      throw new ApiError(
        409,
        'CONFLICT',
        'A ticket changed while merging. Reload it and try again.',
      );
    }

    const updated: TicketRecord = {
      ...canonical,
      updatedAt: change.now,
      version: canonical.version + 1,
      ...(change.priority ? { priority: change.priority } : {}),
      ...(change.deadlineAt ? { deadlineAt: change.deadlineAt } : {}),
      ...(change.slaStartAt ? { slaStartAt: change.slaStartAt } : {}),
    };
    return json(200, toTicketView(updated));
  } catch (err) {
    return errorResponse(
      err,
      event.requestContext?.requestId ?? 'unknown',
      'mergeTickets',
    );
  }
}
