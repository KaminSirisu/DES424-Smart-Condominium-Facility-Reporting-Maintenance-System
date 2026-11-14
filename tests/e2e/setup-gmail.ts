import { mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { chromium } from '@playwright/test';

const email = (
  process.env.GMAIL_ACCOUNT_EMAIL ||
  process.env.STAFF_EMAIL ||
  ''
).trim();
if (!email) {
  console.error(
    'Set STAFF_EMAIL to the technician Gmail address before Gmail setup.',
  );
  process.exit(2);
}

const browser = await chromium.launch({ channel: 'chrome', headless: false });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('https://mail.google.com/mail/u/0/#inbox');

  console.log(
    `Sign in to ${email} in the Chrome window. No Gmail password is read by this script.`,
  );
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    await prompt.question('When that Gmail inbox is open, press Enter here: ');
  } finally {
    prompt.close();
  }

  const title = await page.title();
  if (!title.toLowerCase().includes(email.toLowerCase())) {
    throw new Error(
      `Gmail tab title does not show ${email}. Check the signed-in account and run setup again.`,
    );
  }

  await mkdir('playwright/.auth', { recursive: true });
  await context.storageState({
    path: 'playwright/.auth/gmail.json',
    indexedDB: true,
  });
  console.log(
    'Technician Gmail session saved locally in playwright/.auth/gmail.json.',
  );
} finally {
  await browser.close();
}
