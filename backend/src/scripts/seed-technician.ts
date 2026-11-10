import { pathToFileURL } from 'node:url';
import { createAccount } from '../shared/accounts.js';
import { generatePassword, hashPassword } from '../shared/password.js';
import { isTeamId, type TeamId } from '../triage/policy.js';

/** Creates exactly one shared team login for a live staff workflow test. */
export function parseTechnicianArgs(argv: string[]): {
  email: string;
  teamId: TeamId;
} {
  if (argv.length !== 4) {
    throw new Error('Usage: seed-technician --email <email> --team <TEAM_ID>');
  }
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--email', '--team'].includes(argv[i]) || !argv[i + 1]) {
      throw new Error(
        'Usage: seed-technician --email <email> --team <TEAM_ID>',
      );
    }
    options.set(argv[i], argv[i + 1]);
  }
  const email = options.get('--email')?.trim().toLowerCase();
  const teamId = options.get('--team');
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) {
    throw new Error('--email must be a valid email address.');
  }
  if (!isTeamId(teamId)) {
    throw new Error('--team must be one of the five configured team IDs.');
  }
  return { email, teamId };
}

async function main(): Promise<void> {
  try {
    const { email, teamId } = parseTechnicianArgs(process.argv.slice(2));
    const password = generatePassword();
    const status = await createAccount({
      username: email,
      role: 'TECHNICIAN',
      teamId,
      displayName: `${teamId.toLowerCase().replaceAll('_', ' ')} team`,
      passwordHash: await hashPassword(password),
    });
    if (status === 'created') {
      process.stdout.write(
        `created  ${email}  TECHNICIAN  ${teamId}  password: ${password}\n` +
          'Copy the password privately now. It is not stored in plaintext or shown again.\n',
      );
    } else {
      process.stdout.write(
        `exists   ${email}  (skipped, password unchanged)\n`,
      );
    }
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
