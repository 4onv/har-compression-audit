import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { auditHar, checkBudget, maxInputBytes, parseHar } from '../src/audit.js';

const header = (name, value) => ({ name, value });
const capture = (...entries) => ({ log: { entries } });
function entry({ offer = 'gzip, br', wire = 200, size = 200, status = 200,
  method = 'GET', encoding, type = 'application/json', headers, requestHeaders, flags } = {}) {
  return {
    request: { url: 'https://example.invalid/api', method,
      headers: requestHeaders ?? [header('Accept-Encoding', offer)] },
    response: { status, bodySize: wire, content: { size, mimeType: type },
      headers: headers ?? [header('Content-Type', type),
        ...(encoding === undefined ? [] : [header('Content-Encoding', encoding)])], ...flags },
  };
}

test('synthetic capture ranks grouped routes and accounts for every entry', async () => {
  const bytes = await readFile(new URL('../examples/synthetic.har.json', import.meta.url));
  const har = parseHar(bytes);
  const { summary, reasons, routes } = auditHar(har);
  assert.equal(summary.entries, 9);
  assert.equal(summary.excluded, 4);
  assert.equal(summary.identity, 3);
  assert.equal(summary.identityBytes, 75_538);
  assert.equal(summary.compressed, 1);
  assert.equal(summary.compressedBytes, 8_730);
  assert.equal(summary.unknown, 1);
  assert.equal(routes[0].identity, 2);
  assert.equal(routes[0].identityBytes, 74_252);
  assert.equal(routes[0].firstEntry, 1);
  assert.equal(Object.values(reasons).reduce((sum, count) => sum + count, 0), 9);
});

test('negotiation respects case, repeated field lines, empty fields and wildcard overrides', () => {
  const positive = entry({ requestHeaders: [
    header('accept-encoding', 'gzip;q=0, *;q=0.5'), header('ACCEPT-ENCODING', 'br;q=0'),
  ] });
  const report = auditHar(capture(positive, entry({ offer: '*;q=0, GZIP;q=1.000' }),
    entry({ offer: 'identity, gzip;q=0' }), entry({ offer: '' }),
    entry({ offer: 'gzip;q=abc' }), entry({ offer: 'br;q=0, br;q=1' }),
    entry({ requestHeaders: [] })));
  assert.equal(report.summary.identity, 2);
  assert.equal(report.reasons['compression-not-offered'], 2);
  assert.equal(report.reasons['compression-offer-unavailable'], 3);
});

test('encoded responses account for wire bytes and recognized stacked content codings', () => {
  const report = auditHar(capture(
    entry({ encoding: 'GZip, br', wire: 62, type: 'application/vnd.example+json' }),
    entry({ encoding: 'br', wire: -1, requestHeaders: [] }),
    entry({ encoding: 'identity' }),
    entry({ encoding: 'identity, gzip' }),
    entry({ encoding: 'reserved-extension' }),
  ));
  assert.equal(report.summary.compressed, 2);
  assert.equal(report.summary.compressedUnmeasured, 1);
  assert.equal(report.summary.compressedBytes, 62);
  assert.equal(report.summary.identity, 1);
  assert.equal(report.reasons['ambiguous-content-encoding'], 1);
  assert.equal(report.reasons['unrecognized-content-encoding'], 1);
  assert.deepEqual(report.routes[0].codings, ['gzip', 'br']);
});

test('Chrome cache and service worker markers, no-body responses and non-JSON do not count', () => {
  const cached = entry();
  cached._fromCache = 'memory';
  const report = auditHar(capture(cached, entry({ flags: { _fetchedViaServiceWorker: true } }),
    entry({ flags: { _transferSize: 0 } }), entry({ method: 'HEAD' }), entry({ status: 304 }),
    entry({ status: 206 }), entry({ status: 204 }), entry({ type: 'text/javascript' }),
    entry({ wire: 0, size: 0 })));
  assert.equal(report.summary.excluded, 9);
  assert.equal(report.reasons['cached-or-local-response'], 3);
  assert.equal(report.reasons['outside-full-success-response'], 4);
  assert.equal(report.reasons['non-json'], 1);
  assert.equal(report.reasons['empty-body'], 1);
});

test('incomplete captures stay unknown and missing sizes never borrow decoded counts', () => {
  const report = auditHar(capture(entry({ wire: 0 }), entry({ wire: 20 }),
    entry({ type: 'x-unknown' }), entry({ flags: { _error: 'aborted' } }),
    entry({ headers: [] }), entry({ wire: -1, size: -1 }), entry({ wire: -1, size: 9_000 })));
  assert.equal(report.summary.unknown, 6);
  for (const key of ['zero-body-transfer', 'identity-size-mismatch', 'media-type-unavailable',
    'response-incomplete', 'response-headers-unavailable', 'body-size-unavailable']) {
    assert.equal(report.reasons[key], 1);
  }
  assert.equal(report.summary.identity, 1);
  assert.equal(report.summary.identityUnmeasured, 1);
  assert.equal(report.summary.identityBytes, 0);
});

test('default output omits sensitive HAR data and opt-in paths still omit URL secrets', () => {
  const first = entry();
  first.request.url = 'https://user:password@private.invalid/accounts/42?token=secret#fragment';
  first.request.headers.push(header('Authorization', 'Bearer invisible'));
  first.response.content.text = 'sensitive payload';
  const second = structuredClone(first);
  second.request.url = 'https://private.invalid/accounts/42?token=other';
  const har = capture(first, second);
  assert.doesNotMatch(JSON.stringify(auditHar(har)), /private\.invalid|accounts|password|secret|invisible|payload|fragment/);
  const revealed = auditHar(har, { showPaths: true });
  assert.equal(revealed.routes.length, 1);
  assert.equal(revealed.routes[0].path, 'GET https://private.invalid/accounts/42');
  assert.doesNotMatch(JSON.stringify(revealed), /password|secret|invisible|payload|fragment/);
});

test('byte budget reports known failure, uncertainty and inclusive success', () => {
  const summary = auditHar(capture(entry())).summary;
  assert.equal(checkBudget(summary, 199), 'exceeded');
  assert.equal(checkBudget(summary, 200), 'within');
  assert.equal(checkBudget({ ...summary, unknown: 1 }, 200), 'inconclusive');
  assert.equal(checkBudget({ ...summary, unknown: 1 }, 199), 'exceeded');
  assert.equal(checkBudget({ ...summary, identityUnmeasured: 1 }, 200), 'inconclusive');
  assert.equal(checkBudget(auditHar(capture()).summary, 200), 'inconclusive');
  assert.throws(() => checkBudget(summary, -1), /nonnegative/);
});

test('UTF-8, shape and safe integer validation protect malformed inputs', () => {
  assert.throws(() => parseHar(new Uint8Array(maxInputBytes + 1)), /16 MiB/);
  assert.throws(() => parseHar(Uint8Array.of(0xc0)), /UTF-8/);
  assert.throws(() => parseHar(Buffer.from('{')), /HAR JSON/);
  assert.throws(() => auditHar({ log: { entries: {} } }), /log.entries/);
  assert.throws(() => auditHar(capture(...Array(50_001))), /50,000/);
  const large = entry({ wire: Number.MAX_SAFE_INTEGER, size: Number.MAX_SAFE_INTEGER });
  assert.throws(() => auditHar(capture(large, entry())), /safe integer/);
});
