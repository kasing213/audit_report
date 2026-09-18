import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { AddressInfo } from 'node:net';
import puppeteer from 'puppeteer';
import { createLeadControlRouter } from '../../src/api/lead-control-routes';
import { createSessionCookie } from '../../src/api/auth-middleware';
import { renderPage } from '../../src/api/template-helper';

test('Lead Control HTML and assets require dashboard authority; navigation hides for other roles', async () => {
  process.env.DASHBOARD_TOKEN = 'ui-test-token';
  const app = express();
  app.use('/lead-control', createLeadControlRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const role of ['developer', 'manager', 'agent']) {
      const response = await fetch(`${base}/lead-control`, { headers: { Cookie: `audit_session=${encodeURIComponent(createSessionCookie(role))}` } });
      assert.equal(response.status, role === 'agent' ? 403 : 200);
      if (role !== 'agent') {
        const html = await response.text();
        assert.match(html, /<main/);
        assert.match(html, /lead-control\/assets\/lead-control.js/);
      }
    }
    assert.equal((await fetch(`${base}/lead-control/assets/lead-control.js`)).status, 403);
    const hidden = await renderPage('crm/groups', { canLeadControl: false });
    const visible = await renderPage('crm/groups', { canLeadControl: true });
    assert.doesNotMatch(hidden, /href="\/lead-control"/);
    assert.match(visible, /href="\/lead-control"/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('browser setup creates a reviewed forecast with cents and percentage conversion; summary and editing remain usable on narrow screens', async () => {
  process.env.DASHBOARD_TOKEN = 'ui-test-token';
  const { startUiFixture } = await import('./ui-fixture');
  const fixture = await startUiFixture();
  const browser = await puppeteer.launch({ headless: 'new', executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.setCookie({ name: 'audit_session', value: createSessionCookie('manager'), url: fixture.url });
  try {
    await page.setViewport({ width: 1440, height: 1100 });
    await page.goto(`${fixture.url}/lead-control`);
    await page.type('#page-filter', 'north');
    await page.click('#load-campaigns');
    await page.waitForSelector('[data-open="c1"]');
    await page.click('[data-open="c1"]');
    await page.waitForSelector('#stage-ledger tr');
    assert.match(await page.$eval('#summary', el => el.textContent || ''), /provisional/i);
    await page.select('#cancellation-view', 'event');
    await page.waitForFunction(() => document.querySelector('#cancellations')?.textContent?.includes('sale-event'));
    await page.click('[data-attribute="sale-unmatched"]');
    await page.waitForFunction(() => document.querySelector('#unmatched')?.textContent?.includes('No unmatched'));
    await page.screenshot({ path: fixture.screenshot('desktop'), fullPage: true });
    await page.click('#edit-campaign');
    assert.equal(await page.$eval('#campaign-name', el => (el as HTMLInputElement).value), 'North · ផ្ទះ');
    await page.click('#wizard-next');
    assert.equal(await page.$eval('#monthly-budget', el => (el as HTMLInputElement).value), '1200');
    await page.click('#wizard-cancel');
    await page.click('#new-campaign');
    await page.type('#campaign-name', 'September leads');
    await page.click('#wizard-next');
    await page.$eval('#monthly-budget', el => { (el as HTMLInputElement).value = '1500'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.click('#wizard-next');
    await page.waitForFunction(() => document.querySelector('#preview')?.textContent?.includes('1,500'));
    await page.click('#wizard-next');
    assert.match(await page.$eval('#review', el => el.textContent || ''), /September leads/);
    await page.click('#save-approve');
    await page.waitForFunction(() => document.querySelector('#notice')?.textContent?.includes('approved'));
    assert.equal(fixture.writes.forecast.monthlyBudgetCents, 150000);
    assert.equal(fixture.writes.forecast.messageToPhoneRate, 0.3);
    assert.equal(fixture.writes.approved, true);
    assert.deepEqual({
      propertyProject: fixture.writes.campaign.propertyProject,
      objective: fixture.writes.campaign.objective,
      audience: fixture.writes.campaign.audience,
      spendMode: fixture.writes.campaign.spendMode,
    }, { propertyProject: 'North Residences', objective: 'Property visits', audience: 'Phnom Penh buyers', spendMode: 'daily' });
    await page.setViewport({ width: 390, height: 844 });
    await page.screenshot({ path: fixture.screenshot('narrow'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.click('#new-campaign');
    await page.screenshot({ path: fixture.screenshot('narrow-setup'), fullPage: true });
    assert.equal(await page.$eval('#preview', el => getComputedStyle(el).display !== 'none'), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await fixture.close(); }
});
