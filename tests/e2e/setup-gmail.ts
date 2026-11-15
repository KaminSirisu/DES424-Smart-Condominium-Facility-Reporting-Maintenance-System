import { chromium, type Browser } from '@playwright/test';

async function main(): Promise<void> {
  const email = (
    process.env.GMAIL_ACCOUNT_EMAIL ||
    process.env.STAFF_EMAIL ||
    ''
  ).trim();
  if (!email) {
    throw new Error('Set STAFF_EMAIL to the technician Gmail address.');
  }

  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP('chrome', {
      noDefaults: true,
      timeout: 30_000,
    });
  } catch {
    throw new Error(
      'In your regular Chrome, open chrome://inspect/#remote-debugging and enable "Allow remote debugging for this browser instance", then rerun this command.',
    );
  }

  try {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (!page.url().startsWith('https://mail.google.com/mail/')) continue;
        if ((await page.title()).toLowerCase().includes(email.toLowerCase())) {
          console.log(`Gmail tab for ${email} is ready in regular Chrome.`);
          return;
        }
      }
    }
    throw new Error(
      `Open the ${email} Gmail inbox in regular Chrome and rerun this command.`,
    );
  } finally {
    await browser.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
