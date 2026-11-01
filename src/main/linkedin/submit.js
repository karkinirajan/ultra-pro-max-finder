import { fillFirstName } from '../templates.js';
import { log } from '../log.js';
import { shouldDecline } from './projects.js';

const CHEVRON = 'li-icon[type="chevron-down"]';
const SAMESITE = { no_restriction: 'None', lax: 'Lax', strict: 'Strict', unspecified: 'Lax' };

/**
 * Electron cookie objects -> the shape Playwright accepts. The old code spread the Electron objects
 * (with fields Playwright does not know) and forced sameSite to "None" on every cookie.
 */
export function toPlaywrightCookies(cookies) {
  return cookies.map((cookie) => {
    const sameSite = SAMESITE[cookie.sameSite] ?? 'Lax';
    return {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || '/',
      expires: cookie.session || !cookie.expirationDate ? -1 : cookie.expirationDate,
      httpOnly: Boolean(cookie.httpOnly),
      secure: sameSite === 'None' ? true : Boolean(cookie.secure), // browsers refuse SameSite=None without Secure
      sameSite,
    };
  });
}

/**
 * Answers (or declines) the requests in a visible browser, using the LinkedIn session of the account.
 * ``chromium`` is Playwright's browser type; it is injected so the flow can be tested with a fake page.
 * Each request is handled on its own: one that fails no longer stops the ones after it.
 */
export function createSubmitter({ chromium, templates, settleMs = 10000, viewport = null }) {
  async function decline(page) {
    await page.locator(CHEVRON).click();
    await page.getByRole('button', { name: 'No thanks' }).click();
    await page.getByRole('button', { name: 'Decline' }).click();
  }

  async function propose(page, item, proposalText) {
    // The expand arrow is not always there.
    try {
      await page.locator(CHEVRON).click({ timeout: 5000 });
    } catch {
      /* already expanded */
    }
    await page.getByRole('button', { name: 'Submit proposal' }).click();

    const textArea = page.locator('textarea');
    await textArea.waitFor({ state: 'attached' });
    await textArea.fill(fillFirstName(proposalText, item.clientName));

    const submit = page.locator('button[data-test-proposal-submission-modal__submit-button]');
    await submit.waitFor();
    await submit.click();

    // The follow-up message is only sent when one is saved (the old code clicked Send on an empty box).
    const message = await templates.message();
    if (message) {
      await page.getByRole('button', { name: 'Message' }).click();
      const box = page.locator('.msg-form__contenteditable');
      await box.waitFor({ state: 'attached' });
      await box.fill(fillFirstName(message, item.clientName));
      const send = page.getByRole('button', { name: 'Send', exact: true });
      await send.scrollIntoViewIfNeeded();
      await send.click();
    }
  }

  async function handle(context, item) {
    // Checked first: the old code opened the proposal form and only then found there was no template.
    const proposalText = await templates.proposalFor(item.jobType);
    if (!shouldDecline(item) && !proposalText) {
      return {
        id: item.id,
        outcome: 'skipped',
        reason: `no template for "${item.jobType}" and no "default"`,
      };
    }
    const page = await context.newPage();
    try {
      if (viewport) await page.setViewportSize(viewport);
      await page.goto(item.url, { timeout: 10000 });
      await page.waitForTimeout(settleMs);
      if (shouldDecline(item)) {
        await decline(page);
        return { id: item.id, outcome: 'declined' };
      }
      await propose(page, item, proposalText);
      return { id: item.id, outcome: 'submitted' };
    } catch (error) {
      log.error(`Request ${item.id} failed:`, error.message);
      return { id: item.id, outcome: 'failed', reason: error.message };
    } finally {
      await page.close().catch(() => {});
    }
  }

  async function submitAll(items, cookies) {
    if (items.length === 0) return [];
    const browser = await chromium.launch({ headless: false });
    try {
      const context = await browser.newContext();
      await context.addCookies(toPlaywrightCookies(cookies));
      const results = [];
      for (const item of items) results.push(await handle(context, item));
      return results;
    } finally {
      await browser.close().catch(() => {});
    }
  }

  return { submitAll };
}
