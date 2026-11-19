import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/har-compression-audit.js', import.meta.url));
const sample = fileURLToPath(new URL('../examples/synthetic.har.json', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [cli, ...args], {
  encoding: 'utf8', timeout: 8000, windowsHide: true,
});

test('capture comparison preserves unknowns, avoids URL output, and gates measured increases', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'har-audit-compare-'));
  const before = join(dir, 'before.har');
  const after = join(dir, 'after.har');
  const capture = bodySize => JSON.stringify({ log: { entries: [{
    request: { method: 'GET', url: 'https://private.example.invalid/secret?token=private',
      headers: [{ name: 'Accept-Encoding', value: 'gzip' }] },
    response: { status: 200, bodySize, headers: [{ name: 'Content-Type', value: 'application/json' }],
      content: { mimeType: 'application/json', size: bodySize === -1 ? 50 : bodySize } },
  }] } });
  try {
    await writeFile(before, capture(50));
    await writeFile(after, capture(60));
    const fail = run('compare', before, after, '--json', '--max-identity-increase', '9');
    assert.equal(fail.status, 1, fail.stderr);
    assert.equal(JSON.parse(fail.stdout).recordedIdentityBytesChange, 10);
    assert.doesNotMatch(fail.stdout, /private|secret/u);
    assert.equal(run('compare', before, after, '--max-identity-increase', '10').status, 0);
    await writeFile(before, capture(-1));
    const unknown = run('compare', before, after, '--json', '--max-identity-increase', '100');
    assert.equal(unknown.status, 2, unknown.stderr);
    assert.equal(JSON.parse(unknown.stdout).budget.status, 'inconclusive');
    assert.equal(JSON.parse(unknown.stdout).before.identityUnmeasured, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('demo labels invented data and outputs complete private JSON', () => {
  const demo = run('demo');
  assert.equal(demo.status, 0, demo.stderr);
  assert.match(demo.stdout, /Synthetic HAR example/);
  const result = run('demo', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).synthetic, true);
  assert.doesNotMatch(result.stdout, /api\.example\.invalid/);
});

test('check supports path opt-in and machine-readable budget exit codes', () => {
  const failed = run('check', sample, '--json', '--max-identity-bytes', '75537');
  assert.equal(failed.status, 1, failed.stderr);
  assert.equal(JSON.parse(failed.stdout).budget.status, 'exceeded');
  const inconclusive = run('check', sample, '--json', '--show-paths', '--max-identity-bytes', '75538');
  assert.equal(inconclusive.status, 2, inconclusive.stderr);
  const report = JSON.parse(inconclusive.stdout);
  assert.equal(report.budget.status, 'inconclusive');
  assert.equal(report.routes[0].path, 'GET https://api.example.invalid/v1/activity');
});

test('invalid arguments and malformed capture give controlled failures', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'har-audit-invalid-'));
  try {
    const badFile = join(tmp, 'bad.har');
    await writeFile(badFile, '{"secret":"do not echo"');
    const invalid = run('check', badFile);
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /valid UTF-8 HAR JSON/);
    assert.doesNotMatch(invalid.stderr, /do not echo/);
    assert.equal(run('check', tmp).status, 2);
    assert.equal(run('check', sample, '--max-identity-bytes', '1e3').status, 2);
    assert.equal(run('check', sample, '--unknown').status, 2);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
