import { pathToFileURL } from 'node:url';
import { createAccount } from '../shared/accounts.js';
import { generatePassword, hashPassword } from '../shared/password.js';
import { TEAM_IDS } from '../triage/policy.js';

/**
 * Creates the first staff accounts (SR-07): one personal MANAGER account and,
 * with --teams-domain, one shared TECHNICIAN account for each of the 5 teams.
 * The manager endpoints that should do this later are not built yet.
 *
 *   npm run seed:accounts -w @scfrms/backend -- \
 *     --manager-email manager@example.com --manager-name "Juristic manager" \
 *     --teams-domain example.com
 *
 * It needs ACCOUNTS_TABLE_NAME and AWS credentials (and DYNAMODB_ENDPOINT for
 * DynamoDB Local), read from the environment or the root .env file.
 *
 * Each password is generated here (SR-09), printed once and never stored: only
 * its bcrypt hash is. Hand each one over in person, not in a chat group. An
 * account that already exists is skipped and keeps its password, so running
 * the script again is safe and never resets anything.
 */

export interface SeedOptions {
  managerEmail: string;
  managerName: string;
  /** When set, also creates `<team>@<domain>` for every team. */
  teamsDomain?: string;
}

export interface SeedResult {
  username: string;
  role: 'MANAGER' | 'TECHNICIAN';
  teamId?: string;
  status: 'created' | 'exists';
  /** Only for a created account. */
  password?: string;
}

export interface SeedDeps {
  createAccount: typeof createAccount;
  generatePassword: () => string;
  hashPassword: (password: string) => Promise<string>;
}

const USAGE =
  'Usage: seed-accounts --manager-email <email> --manager-name <name> [--teams-domain <domain>]';

const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9-]+)+$/;

function teamUsername(teamId: string, domain: string): string {
  return `${teamId.toLowerCase().replaceAll('_', '-')}@${domain}`;
}

function teamDisplayName(teamId: string): string {
  const words = teamId
    .toLowerCase()
    .split('_')
    .map((w) => w[0].toUpperCase() + w.slice(1));
  return `${words.join(' ')} team`;
}

export function parseSeedArgs(argv: string[]): SeedOptions {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    const value = argv[i + 1];
    if (
      !['--manager-email', '--manager-name', '--teams-domain'].includes(name) ||
      value === undefined ||
      value.startsWith('--')
    ) {
      throw new Error(`Bad arguments. ${USAGE}`);
    }
    values.set(name, value);
  }

  const managerEmail = values.get('--manager-email')?.trim().toLowerCase();
  const managerName = values.get('--manager-name')?.trim();
  const teamsDomain = values.get('--teams-domain')?.trim().toLowerCase();
  if (!managerEmail || !managerName) {
    throw new Error(
      `--manager-email and --manager-name are required. ${USAGE}`,
    );
  }
  if (!/^[^@\s]+@[^@\s]+$/.test(managerEmail)) {
    throw new Error('--manager-email must be an email address.');
  }
  if (teamsDomain !== undefined && !DOMAIN_PATTERN.test(teamsDomain)) {
    throw new Error('--teams-domain must be a domain such as example.com.');
  }
  return { managerEmail, managerName, ...(teamsDomain ? { teamsDomain } : {}) };
}

export async function seedAccounts(
  options: SeedOptions,
  deps: SeedDeps = { createAccount, generatePassword, hashPassword },
): Promise<SeedResult[]> {
  const wanted: {
    username: string;
    role: 'MANAGER' | 'TECHNICIAN';
    teamId?: string;
    displayName: string;
  }[] = [
    {
      username: options.managerEmail,
      role: 'MANAGER',
      displayName: options.managerName,
    },
  ];
  if (options.teamsDomain) {
    for (const teamId of TEAM_IDS) {
      wanted.push({
        username: teamUsername(teamId, options.teamsDomain),
        role: 'TECHNICIAN',
        teamId,
        displayName: teamDisplayName(teamId),
      });
    }
  }

  const results: SeedResult[] = [];
  for (const account of wanted) {
    const password = deps.generatePassword();
    const status = await deps.createAccount({
      ...account,
      passwordHash: await deps.hashPassword(password),
    });
    results.push({
      username: account.username,
      role: account.role,
      ...(account.teamId ? { teamId: account.teamId } : {}),
      status,
      ...(status === 'created' ? { password } : {}),
    });
  }
  return results;
}

function report(results: SeedResult[]): string {
  const lines = results.map((r) =>
    r.status === 'created'
      ? `created  ${r.username}  ${r.role}${r.teamId ? ` ${r.teamId}` : ''}  password: ${r.password}`
      : `exists   ${r.username}  (skipped, password unchanged)`,
  );
  const shown = results.some((r) => r.status === 'created');
  return [
    ...lines,
    ...(shown
      ? [
          '',
          'Passwords are shown once and are not stored. Hand each one over in person (SR-09).',
        ]
      : []),
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  try {
    const results = await seedAccounts(parseSeedArgs(process.argv.slice(2)));
    process.stdout.write(report(results));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main();
}
