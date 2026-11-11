import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { noStore } from '../auth/staff-session.js';
import { parseJsonObject } from '../auth/json-body.js';
import {
  createManagedAccount,
  listAccounts,
  resetMfa,
  resetPassword,
  setAccountActive,
  toManagedAccount,
  validateNewAccount,
} from '../shared/account-management.js';
import { normalizeUsername } from '../shared/accounts.js';
import { generatePassword, hashPassword } from '../shared/password.js';
import { requireStaff } from '../shared/staff-auth.js';
import { errorResponse, json } from '../tickets/staff-http.js';
import { ApiError } from '../tickets/types.js';

/**
 * Staff account management for managers (RR-13, SR-07):
 *
 *   GET   /staff-accounts                  list every account
 *   POST  /staff-accounts                  create a technician or manager account
 *   PATCH /staff-accounts/{accountId}      RESET_PASSWORD | SET_ACTIVE | RESET_MFA
 *
 * Manager only (a technician gets 403). Passwords are never chosen by anyone:
 * the system makes one (shared/password.ts), stores only its hash, and shows
 * it once in the answer as `temporaryPassword` for the manager to hand over in
 * person (SR-09). The rules and the audit trail live in
 * shared/account-management.ts. Nothing here is logged: not the password, not
 * a hash, not an MFA secret.
 *
 * `accountId` is the account's email. It may be sent as it is or percent
 * encoded; it is read case-insensitively like a login.
 */

const ACCOUNT_ID_MAX = 254;
const CREATE_FIELDS = ['email', 'role', 'teamId', 'displayName'];
const UPDATE_FIELDS = ['action', 'isActive'];

type Respond = (
  event: APIGatewayProxyEventV2,
  actorAccountId: string,
  now: Date,
) => Promise<APIGatewayProxyStructuredResultV2>;

function run(operation: string, respond: Respond) {
  return async (
    event: APIGatewayProxyEventV2,
  ): Promise<APIGatewayProxyStructuredResultV2> => {
    try {
      const staff = await requireStaff(event.headers?.authorization);
      if (staff.role !== 'MANAGER') {
        throw new ApiError(
          403,
          'FORBIDDEN',
          'Only a manager can manage staff accounts.',
        );
      }
      return noStore(await respond(event, staff.accountId, new Date()));
    } catch (err) {
      return errorResponse(
        err,
        event.requestContext?.requestId ?? 'unknown',
        operation,
      );
    }
  };
}

/** The {accountId} path parameter as an account key, or a 400. */
function accountIdFromPath(event: APIGatewayProxyEventV2): string {
  const raw = event.pathParameters?.accountId;
  if (!raw) {
    throw new ApiError(400, 'BAD_REQUEST', 'accountId is required.');
  }
  let decoded = raw;
  if (raw.includes('%')) {
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      throw new ApiError(400, 'BAD_REQUEST', 'accountId is not valid.');
    }
  }
  const id = normalizeUsername(decoded);
  if (id === '' || id.length > ACCOUNT_ID_MAX) {
    throw new ApiError(400, 'BAD_REQUEST', 'accountId is not valid.');
  }
  return id;
}

/** A new password and its hash; the password goes in the answer, once. */
async function newPassword(): Promise<{ password: string; hash: string }> {
  const password = generatePassword();
  return { password, hash: await hashPassword(password) };
}

export const listHandler = run('listStaffAccounts', async (_event, _a, now) =>
  json(200, {
    items: (await listAccounts()).map((a) => toManagedAccount(a, now)),
  }),
);

export const createHandler = run(
  'createStaffAccount',
  async (event, actor, now) => {
    const body = parseJsonObject(event, CREATE_FIELDS);
    validateNewAccount({
      email: body.email,
      role: body.role,
      teamId: body.teamId,
      displayName: body.displayName,
    });
    const { email, role, teamId, displayName } = body as {
      email: string;
      role: 'TECHNICIAN' | 'MANAGER';
      teamId?: string;
      displayName: string;
    };

    const { password, hash } = await newPassword();
    const account = await createManagedAccount(
      { email, role, teamId, displayName, passwordHash: hash },
      actor,
      now,
    );
    return json(201, {
      account: toManagedAccount(account, now),
      temporaryPassword: password,
    });
  },
);

export const updateHandler = run(
  'updateStaffAccount',
  async (event, actor, now) => {
    const accountId = accountIdFromPath(event);
    const body = parseJsonObject(event, UPDATE_FIELDS);
    const bad = (message: string) => new ApiError(400, 'BAD_REQUEST', message);

    switch (body.action) {
      case 'RESET_PASSWORD': {
        if (body.isActive !== undefined) {
          throw bad('isActive is only for SET_ACTIVE.');
        }
        const { password, hash } = await newPassword();
        const account = await resetPassword(accountId, hash, actor, now);
        return json(200, {
          account: toManagedAccount(account, now),
          temporaryPassword: password,
        });
      }
      case 'SET_ACTIVE': {
        if (typeof body.isActive !== 'boolean') {
          throw bad('isActive must be true or false for SET_ACTIVE.');
        }
        const account = await setAccountActive(
          accountId,
          body.isActive,
          actor,
          now,
        );
        return json(200, { account: toManagedAccount(account, now) });
      }
      case 'RESET_MFA': {
        if (body.isActive !== undefined) {
          throw bad('isActive is only for SET_ACTIVE.');
        }
        const account = await resetMfa(accountId, actor, now);
        return json(200, { account: toManagedAccount(account, now) });
      }
      default:
        throw bad('action must be RESET_PASSWORD, SET_ACTIVE or RESET_MFA.');
    }
  },
);
