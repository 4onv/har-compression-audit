import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import info from '../package.json' with { type: 'json' };

const archive = resolve(process.argv[2] ?? '4onv-har-compression-audit-' + info.version + '.tgz');
const npm = process.env.npm_execpath;
assert.ok(npm, 'Run through npm run check:package.');
const tmp = await mkdtemp(join(tmpdir(), 'har-audit-package-'));

function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: tmp, encoding: 'utf8', timeout: 45_000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error ?? ''));
  return result.stdout;
}

try {
  run([npm, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', archive]);
  const root = join(tmp, 'node_modules', '@4onv', 'har-compression-audit');
  const version = run([npm, 'exec', '--offline', '--', 'har-compression-audit', '--version']);
  assert.equal(version.trim(), info.version);
  const demo = run([npm, 'exec', '--offline', '--', 'har-compression-audit', 'demo', '--json']);
  assert.equal(JSON.parse(demo).summary.identityBytes, 75_538);
  const exportsCheck = "import { auditHar } from '@4onv/har-compression-audit';" +
    "if (auditHar({ log: { entries: [] } }).summary.entries !== 0) process.exit(1);";
  run(['--input-type=module', '--eval', exportsCheck]);
  const html = await readFile(join(root, 'dist', 'har-compression-audit.html'), 'utf8');
  assert.match(html, /Synthetic HAR example/);
  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /__CSP__|__CSS__|__JS__/);
  console.log('Installed the release archive offline and ran the CLI, module and HTML artifact checks.');
} finally {
  await rm(tmp, { recursive: true, force: true });
}
