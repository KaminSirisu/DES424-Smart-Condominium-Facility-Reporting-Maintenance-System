import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';

const execFileAsync = promisify(execFile);
const gmailUrl = 'https://mail.google.com/mail/u/0/#inbox';
const profileRoot = resolve('..', '.scfrms-demo');
const profileDir = join(profileRoot, 'gmail-chrome-profile');
const markerPath = join(profileRoot, 'gmail-setup.json');
const oldProfileDir = resolve('playwright/.auth/gmail-chrome-profile');

async function isProfileOpen(directory: string): Promise<boolean> {
  try {
    await lstat(join(directory, 'SingletonLock'));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function main(): Promise<void> {
  const email = (
    process.env.GMAIL_ACCOUNT_EMAIL ||
    process.env.STAFF_EMAIL ||
    ''
  ).trim();
  if (!email) {
    throw new Error(
      'Set STAFF_EMAIL to the technician Gmail address before Gmail setup.',
    );
  }
  if (process.platform !== 'darwin') {
    throw new Error(
      'This Gmail setup currently requires macOS and Google Chrome.',
    );
  }

  await mkdir(profileRoot, { recursive: true, mode: 0o700 });
  if (existsSync(oldProfileDir) && !existsSync(profileDir)) {
    if (await isProfileOpen(oldProfileDir)) {
      throw new Error(
        'Close the dedicated Chrome window opened by the earlier setup, then rerun this command. Its existing Gmail profile will be moved outside the repository.',
      );
    }
    await rename(oldProfileDir, profileDir);
  }
  await execFileAsync('open', [
    '-na',
    'Google Chrome',
    '--args',
    `--user-data-dir=${profileDir}`,
    gmailUrl,
  ]);

  console.log(
    `Sign in to ${email} in the new, normal Chrome window. The script does not read your Google password.`,
  );
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    for (;;) {
      await prompt.question(
        'When Gmail is open, press Cmd+Q in that dedicated Chrome window, then press Enter here: ',
      );
      if (!(await isProfileOpen(profileDir))) break;
      console.log(
        'That Chrome profile is still open. Close its window before continuing.',
      );
    }
  } finally {
    prompt.close();
  }

  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: false,
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(gmailUrl);
    const title = await page.title();
    if (!title.toLowerCase().includes(email.toLowerCase())) {
      throw new Error(
        `Gmail is not signed in as ${email} in the dedicated profile. Check the account and repeat setup.`,
      );
    }
    await writeFile(markerPath, JSON.stringify({ email }, null, 2), {
      mode: 0o600,
    });
  } finally {
    await context.close();
  }

  console.log(`Technician Gmail profile is ready at ${profileDir}.`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
