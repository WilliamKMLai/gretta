/**
 * Browser smoke (mock office mode): the shell renders, views switch, and the
 * chat surface exposes its core controls. Run locally with `pnpm e2e` — the
 * dev server serves /taskpane.html with the in-memory office mock.
 */
import { expect, test } from '@playwright/test';

test('shell renders and views switch', async ({ page }) => {
  // Stub the synchronous Office.js CDN script so browser-mode E2E stays offline/hermetic;
  // detectHostInfo maps missing global Office to { available: false }.
  await page.route('https://appsforoffice.microsoft.com/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
  });

  await page.goto('/taskpane.html');

  await expect(page.getByText('GRETTA')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate' })).toBeVisible();

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Ollama server URL')).toBeVisible();

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Generate' })).toBeVisible();

  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByText('No generations yet')).toBeVisible();

  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Generate' })).toBeVisible();

  await page.getByRole('button', { name: 'Knowledge base', exact: true }).click();
  await expect(page.getByText('Knowledge base is off')).toBeVisible();

  await page.getByRole('button', { name: 'Knowledge base', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Generate' })).toBeVisible();

  await page.getByRole('button', { name: 'Literature', exact: true }).click();
  await expect(page.getByText('Literature search is off')).toBeVisible();

  await page.getByRole('button', { name: 'Literature', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Generate' })).toBeVisible();
});
