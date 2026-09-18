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

// Production mutation caught: read-only deployments still render mutation controls or lose calculator access.
test('read-only comparison page hides mutation affordances and keeps both calculators usable', async () => {
  process.env.DASHBOARD_TOKEN = 'ui-test-token';
  const app = express();
  app.use(express.json());
  app.use('/lead-control', createLeadControlRouter({ writesEnabled: false }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await puppeteer.launch({ headless: 'new', executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.setCookie({ name: 'audit_session', value: createSessionCookie('manager'), url: base });
  try {
    await page.goto(`${base}/lead-control`);
    assert.match(await page.$eval('#read-only-mode', el => el.textContent || ''), /read-only comparison mode/i);
    for (const selector of ['#new-campaign', '#edit-campaign', '#activate-campaign', '#spend-form', '#save-draft', '#save-approve']) {
      assert.equal(await page.$(selector), null, selector);
    }
    await page.click('#comparison-calculate');
    await page.waitForFunction(() => document.querySelector('#comparison-results')?.textContent?.includes('66.7'));
    assert.match(await page.$eval('#comparison-results', el => el.textContent || ''), /66\.7 messages/);
    await page.type('#comparison-target-net', '10');
    await page.click('#comparison-calculate');
    await page.waitForFunction(() => document.querySelector('#comparison-results')?.textContent?.includes('$150.00'));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
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
    assert.equal(await page.$eval('#property-project', el => (el as HTMLInputElement).value), '');
    assert.equal(await page.$eval('#campaign-objective', el => (el as HTMLInputElement).value), '');
    assert.equal(await page.$eval('#campaign-audience', el => (el as HTMLInputElement).value), '');
    assert.equal(await page.$eval('#setup-spend-mode', el => (el as HTMLSelectElement).value), 'daily');
    await page.type('#campaign-name', 'September leads');
    await page.type('#campaign-page', 'September page');
    await page.type('#property-project', 'September Heights');
    await page.type('#campaign-objective', 'Qualified visits');
    await page.type('#campaign-audience', 'First-time buyers');
    await page.select('#setup-spend-mode', 'monthly');
    await page.click('#wizard-next');
    await page.evaluate(() => {
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString();
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
        const response = await originalFetch(input, init);
        if (url.endsWith('/calculator/budget-to-results') && body?.budgetCents === 100000) await new Promise(resolve => window.setTimeout(resolve, 250));
        return response;
      };
    });
    await page.$eval('#monthly-budget', el => { (el as HTMLInputElement).value = '1000'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await new Promise(resolve => setTimeout(resolve, 120));
    await page.$eval('#monthly-budget', el => { (el as HTMLInputElement).value = '1500'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.click('#wizard-next');
    await page.waitForFunction(() => document.querySelector('#preview')?.textContent?.includes('1,500'));
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.doesNotMatch(await page.$eval('#preview', el => el.textContent || ''), /1,000/);
    await page.click('#wizard-next');
    assert.match(await page.$eval('#review', el => el.textContent || ''), /September leads/);
    await page.click('#save-approve');
    await page.waitForFunction(() => document.querySelector('#notice')?.textContent?.includes('approved'));
    await page.waitForFunction(() => (document.querySelector('#spend-mode') as HTMLSelectElement)?.value === 'monthly');
    const createdCampaign = fixture.repository.campaigns.find((campaign) => campaign.name === 'September leads');
    assert.ok(createdCampaign);
    const createdForecast = fixture.repository.revisions.find((forecast) => forecast.campaignId === createdCampaign.id);
    assert.equal(createdForecast?.monthlyBudgetCents, 150000);
    assert.equal(createdForecast?.messageToPhoneRate, 0.3);
    assert.equal(createdForecast?.status, 'approved');
    assert.deepEqual({
      propertyProject: createdCampaign.propertyProject,
      objective: createdCampaign.objective,
      audience: createdCampaign.audience,
      spendMode: createdCampaign.spendMode,
    }, { propertyProject: 'September Heights', objective: 'Qualified visits', audience: 'First-time buyers', spendMode: 'monthly' });
    assert.equal(await page.$eval('#spend-mode', el => (el as HTMLSelectElement).value), 'monthly');
    assert.equal(await page.$eval('#spend-date-label', el => (el as HTMLElement).hidden), true);
    await page.$eval('#spend-amount', el => { (el as HTMLInputElement).value = '400'; });
    await page.click('#spend-form button');
    await page.waitForFunction(() => document.querySelector('#notice')?.textContent?.includes('recorded'));
    assert.equal(fixture.repository.spends.find((spend) => spend.campaignId === createdCampaign.id)?.businessDate, null);
    assert.equal(fixture.repository.events.filter((event) => event.actor === 'manager').length, fixture.repository.events.length);
    await page.setViewport({ width: 390, height: 844 });
    await page.screenshot({ path: fixture.screenshot('narrow'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.click('#new-campaign');
    await page.screenshot({ path: fixture.screenshot('narrow-setup'), fullPage: true });
    assert.equal(await page.$eval('#preview', el => getComputedStyle(el).display !== 'none'), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await fixture.close(); }
});
