/**
 * Browser smoke (mock office mode): the shell renders, views switch, and the
 * chat surface exposes its core controls. Run locally with `pnpm e2e` — the
 * dev server serves /taskpane.html with the in-memory office mock.
 */
import { expect, test } from '@playwright/test';

test('shell renders and views switch', async ({ page }) => {
  await page.goto('/taskpane.html');

  await expect(page.getByText('GRETTA')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate' })).toBeVisible();

  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByLabel('Ollama server URL')).toBeVisible();

  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('button', { name: 'Generate' })).toBeVisible();

  await page.getByRole('button', { name: 'History' }).click();
  await expect(page.getByText('Conversations')).toBeVisible();
});
