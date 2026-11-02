import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const tokens = () => JSON.parse(readFileSync('test-results/tokens.json', 'utf8'));
async function connect(page: Page, role: string) {
  await page.getByLabel('Access token', { exact: true }).fill(tokens()[role]);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('#status')).toContainText('demo-' + role);
}
async function capture(page: Page) {
  expect(
    await page
      .locator('[id]')
      .evaluateAll((nodes) => new Set(nodes.map((n) => n.id)).size === nodes.length),
  ).toBe(true);
  await page.getByLabel('Access token', { exact: true }).fill('');
  await page.screenshot({ path: 'test-results/dashboard-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('h1')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/dashboard-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.locator('#status')).toHaveText('Disconnected');
}
test('complete operational workflow and responsive evidence dashboard', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await connect(page, 'requester');
  await expect(page.locator('#people-count')).toHaveText('3');
  await page.locator('#employee').selectOption('worker-003');
  await page.getByRole('button', { name: 'Create reviewable plan', exact: true }).click();
  await expect(page.locator('#plans .record')).toHaveCount(1);
  const id = await page.locator('#plans .record').getAttribute('data-plan-id');
  const record = page.locator(`[data-plan-id="${id}"]`);
  await connect(page, 'reviewer');
  await record.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(record.locator('header .badge')).toHaveText('approved');
  await connect(page, 'operator');
  await page.getByRole('button', { name: 'Pause collaboration', exact: true }).click();
  await record.getByRole('button', { name: 'Execute', exact: true }).click();
  await expect(record.locator('header .badge')).toHaveText('blocked');
  await expect(record).toContainText('verified');
  await page.getByRole('button', { name: 'Restore collaboration', exact: true }).click();
  await record.getByRole('button', { name: 'Retry known blocked step', exact: true }).click();
  await expect(record.locator('header .badge')).toHaveText('completed');
  await expect(page.locator('#complete-count')).toHaveText('1');
  await record
    .getByRole('button', { name: 'Record review: Confirm data-retention decision', exact: true })
    .click();
  await expect(
    record.getByRole('button', {
      name: 'Record review: Confirm data-retention decision',
      exact: true,
    }),
  ).toHaveCount(0);
  await record
    .getByRole('button', { name: 'Record review: Confirm equipment-return decision', exact: true })
    .click();
  await expect(
    record.getByRole('button', {
      name: 'Record review: Confirm equipment-return decision',
      exact: true,
    }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Check account drift', exact: true }).click();
  await expect(page.locator('#drift-results')).toContainText('missing-managed-account');
  const download = page.waitForEvent('download');
  await record.getByRole('button', { name: 'Export evidence', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('plan-evidence.json');
  await capture(page);
  expect(errors).toEqual([]);
});
