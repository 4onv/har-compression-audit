import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { auditHar, parseHar } from '../../src/audit.js';

const pageURL = new URL('../../dist/har-compression-audit.html', import.meta.url).href;

test('standalone sample renders offline and fits a narrow viewport', async ({ page, context }) => {
  await context.setOffline(true);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const network = [];
  page.on('request', request => {
    if (/^https?:/u.test(request.url())) network.push(request.url());
  });
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(pageURL);
  await expect(page.getByRole('status')).toHaveText('Synthetic HAR example');
  await expect(page.locator('#metrics')).toContainText('75,538 B');
  await expect(page.locator('#routes tr')).toHaveCount(4);
  await expect(page.locator('#routes')).not.toContainText('example.invalid');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(network).toEqual([]);
  expect(errors).toEqual([]);
});

test('local capture uploads offline, redacts paths by default and rejects invalid input', async ({ page, context }) => {
  await context.setOffline(true);
  await page.goto(pageURL);
  const har = {
    log: { entries: [{
      request: { method: 'GET', url: 'https://private.invalid/path?token=hidden',
        headers: [{ name: 'accept-encoding', value: 'gzip' }] },
      response: { status: 200, bodySize: 200, content: { size: 200 },
        headers: [{ name: 'content-type', value: 'application/json' }] },
    }] },
  };
  const capture = page.getByLabel('Open a HAR file');
  await capture.setInputFiles({ name: 'private.har', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(har)) });
  await expect(page.getByRole('status')).toHaveText('Local HAR loaded');
  await expect(page.locator('#metrics')).toContainText('200 B');
  await expect(page.locator('#routes')).not.toContainText('private.invalid');
  await page.getByLabel('Reveal origins and paths').check();
  await expect(page.locator('#routes')).toContainText('https://private.invalid/path');
  await expect(page.locator('#routes')).not.toContainText('token=hidden');
  await capture.setInputFiles({ name: 'broken.har', mimeType: 'application/json', buffer: Buffer.from('{') });
  await expect(page.getByRole('status')).toContainText('Previous report retained');
  await expect(page.locator('#metrics')).toContainText('200 B');
  await page.getByRole('button', { name: 'Load synthetic example' }).click();
  await expect(page.getByRole('status')).toHaveText('Synthetic HAR example');
  await expect(page.getByLabel('Reveal origins and paths')).not.toBeChecked();
});

test('real browser HAR distinguishes gzip from identity over loopback HTTP', async ({ browser }) => {
  const tmp = await mkdtemp(join(tmpdir(), 'har-audit-browser-'));
  const harPath = join(tmp, 'network.har');
  const body = Buffer.from(JSON.stringify({ data: 'synthetic data '.repeat(128) }));
  const compressed = gzipSync(body);
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.headers['accept-encoding'] ?? '');
    const gzip = request.url === '/gzip';
    const payload = gzip ? compressed : body;
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': payload.length,
      'Cache-Control': 'no-store', ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) });
    response.end(payload);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  let context;
  try {
    context = await browser.newContext({ recordHar: { path: harPath, content: 'omit' } });
    const page = await context.newPage();
    const root = 'http://127.0.0.1:' + server.address().port;
    const first = await page.goto(root + '/identity');
    expect(await first.body()).toEqual(body);
    const second = await page.goto(root + '/gzip');
    expect(await second.body()).toEqual(body);
    await context.close();
    context = null;
    expect(requests[0]).toMatch(/gzip/);
    const har = parseHar(await readFile(harPath));
    har.log.entries = har.log.entries.filter(entry => ['/identity', '/gzip'].includes(new URL(entry.request.url).pathname));
    const { summary } = auditHar(har);
    expect(summary.identity).toBe(1);
    expect(summary.compressed).toBe(1);
    expect(summary.unknown).toBe(0);
    expect(summary.identityBytes).toBe(body.length);
    expect(summary.compressedBytes).toBe(compressed.length);
  } finally {
    await context?.close();
    await new Promise(resolve => server.close(resolve));
    await rm(tmp, { recursive: true, force: true });
  }
});
