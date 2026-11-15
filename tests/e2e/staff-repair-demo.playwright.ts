import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const DEFAULT_PORTAL_URL = 'https://d3hd1sqczt5st1.cloudfront.net';
const TICKET_ID = /^tkt_[0-9a-f]{26}$/;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

type DemoInputs = {
  ticketId: string;
  workOrderUrl: string;
  gmailAddress: string;
  photoPath: string;
  email: string;
  password: string;
};

async function demoInputs(): Promise<DemoInputs> {
  const ticketId = process.env.DEMO_TICKET_ID?.trim() ?? '';
  const photoPath = process.env.DEMO_PHOTO_PATH?.trim() ?? '';
  const email = process.env.STAFF_EMAIL?.trim() ?? '';
  const password = process.env.STAFF_PASSWORD ?? '';
  const gmailAddress = (process.env.GMAIL_ACCOUNT_EMAIL || email).trim();

  if (!TICKET_ID.test(ticketId)) {
    throw new Error(
      'Set DEMO_TICKET_ID to the full tkt_... ID from the new work order.',
    );
  }
  if (!photoPath || !email || !password) {
    throw new Error(
      'Set DEMO_PHOTO_PATH, STAFF_EMAIL, and STAFF_PASSWORD before running the live demo.',
    );
  }

  const photo = await readFile(resolve(photoPath));
  const jpeg =
    photo.length >= 3 &&
    photo.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  const png =
    photo.length >= 8 &&
    photo.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (photo.length === 0 || photo.length > MAX_PHOTO_BYTES || (!jpeg && !png)) {
    throw new Error(
      'DEMO_PHOTO_PATH must point to a JPEG or PNG image of at most 10 MiB.',
    );
  }

  const portal = new URL(process.env.DEMO_PORTAL_URL || DEFAULT_PORTAL_URL);
  if (portal.protocol !== 'https:')
    throw new Error('DEMO_PORTAL_URL must use HTTPS.');
  const workOrderUrl = new URL(`/tech/jobs/${ticketId}`, portal);

  return {
    ticketId,
    workOrderUrl: workOrderUrl.toString(),
    gmailAddress,
    photoPath: resolve(photoPath),
    email,
    password,
  };
}

async function findTechnicianGmailTab(
  contexts: BrowserContext[],
  email: string,
): Promise<{ context: BrowserContext; page: Page }> {
  for (const context of contexts) {
    for (const page of context.pages()) {
      if (!page.url().startsWith('https://mail.google.com/mail/')) continue;
      if ((await page.title()).toLowerCase().includes(email.toLowerCase())) {
        return { context, page };
      }
    }
  }
  throw new Error(
    `Open the ${email} Gmail inbox in your regular Chrome window, then run npm run test:demo:gmail:setup.`,
  );
}

test('technician completes the ticket created in LINE', async ({
  playwright,
}, testInfo) => {
  const input = await demoInputs();
  const shortId = `#${input.ticketId.slice(4, 12).toUpperCase()}`;
  const browser = await playwright.chromium.connectOverCDP('chrome', {
    noDefaults: true,
    timeout: 30_000,
  });
  const { context, page } = await findTechnicianGmailTab(
    browser.contexts(),
    input.gmailAddress,
  ).catch(async (error: unknown) => {
    await browser.close();
    throw error;
  });
  let portalPage = page;

  try {
    await test.step('Open the technician Gmail inbox', async () => {
      const inboxUrl = new URL(page.url());
      inboxUrl.hash = '#inbox';
      await page.goto(inboxUrl.toString(), { waitUntil: 'domcontentloaded' });
      await expect(page).toHaveTitle(
        new RegExp(
          input.gmailAddress.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          'i',
        ),
      );
      await expect(page.locator('tr.zA:visible').first()).toBeVisible();
    });

    await test.step('Open the newest inbox row and check its work order', async () => {
      const newestRow = page.locator('tr.zA:visible').first();
      await expect(newestRow).toContainText(/work order/i);
      await expect(newestRow).toContainText(
        new RegExp(input.ticketId.slice(4, 12), 'i'),
      );
      await newestRow.click();
      await expect(
        page.getByRole('link', { name: new RegExp(input.ticketId, 'i') }),
      ).toBeVisible();
    });

    await test.step('Follow the email link to the staff portal', async () => {
      const link = page.getByRole('link', {
        name: new RegExp(input.ticketId, 'i'),
      });
      const href = await link.getAttribute('href');
      if (!href)
        throw new Error('The work order email has no clickable ticket link.');
      const destination = new URL(href, page.url());
      if (destination.toString() !== input.workOrderUrl) {
        throw new Error(
          'The newest email link does not lead to this ticket on the staff portal.',
        );
      }

      const pagesBeforeClick = new Set(context.pages());
      const portalOrigin = new URL(input.workOrderUrl).origin;
      const openedForThisClick = (candidate: Page): boolean =>
        (candidate === page || !pagesBeforeClick.has(candidate)) &&
        candidate.url().startsWith(portalOrigin);
      await link.click();
      await expect
        .poll(() => context.pages().some(openedForThisClick))
        .toBe(true);
      const opened = context.pages().find(openedForThisClick);
      if (!opened)
        throw new Error('The work order link did not open the staff portal.');
      portalPage = opened;
      await portalPage.bringToFront();
      await expect(
        portalPage.getByRole('heading', { name: 'Welcome back' }),
      ).toBeVisible();
      await expect(portalPage).toHaveURL(/\/login(?:\?|$)/);
    });

    await test.step('Sign in as the assigned technician', async () => {
      await portalPage.getByPlaceholder('Enter your email').fill(input.email);
      await portalPage
        .getByPlaceholder('Enter your password')
        .fill(input.password);
      await portalPage.getByRole('button', { name: 'SIGN IN' }).click();
      await expect(portalPage).toHaveURL(input.workOrderUrl);
      await expect(
        portalPage.getByRole('heading', { name: shortId }),
      ).toBeVisible();
    });

    await test.step('Confirm the new ticket is assigned to this team', async () => {
      await expect(
        portalPage
          .locator('section')
          .first()
          .getByText('Assigned', { exact: true }),
      ).toBeVisible();
      await expect(
        portalPage.getByRole('button', { name: 'Start work' }),
      ).toBeEnabled();
    });

    await test.step('Start work and verify In progress', async () => {
      await portalPage.getByRole('button', { name: 'Start work' }).click();
      await expect(
        portalPage
          .locator('section')
          .first()
          .getByText('In progress', { exact: true }),
      ).toBeVisible();
      await expect(
        portalPage.getByText('Proof-of-repair photo (required)'),
      ).toBeVisible();
    });

    await test.step('Upload the repair photo', async () => {
      await portalPage
        .locator('input[type="file"]')
        .setInputFiles(input.photoPath);
      await expect(
        portalPage.getByRole('img', { name: 'Proof of repair' }),
      ).toBeVisible();
      await expect(
        portalPage.getByRole('button', { name: 'Mark as done' }),
      ).toBeEnabled();
    });

    await test.step('Mark the ticket Done', async () => {
      await portalPage.getByRole('button', { name: 'Mark as done' }).click();
      await expect(
        portalPage
          .locator('section')
          .first()
          .getByText('Done', { exact: true }),
      ).toBeVisible();
      await expect(
        portalPage.getByText('Job completed', { exact: false }),
      ).toBeVisible();
    });

    await test.step('Confirm the completed ticket shows its repair photo', async () => {
      const completedPhoto = portalPage.getByRole('img', {
        name: 'Proof of repair',
      });
      await expect(completedPhoto).toBeVisible();
      await expect(completedPhoto).toHaveAttribute('src', /^https:\/\//);
      await expect
        .poll(() =>
          completedPhoto.evaluate((image) =>
            Number(Reflect.get(image, 'naturalWidth')),
          ),
        )
        .toBeGreaterThan(0);
      await testInfo.attach('completed-ticket', {
        body: await portalPage.screenshot(),
        contentType: 'image/png',
      });
    });
  } finally {
    await browser.close();
  }
});
