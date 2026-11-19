#!/usr/bin/env node
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { auditHar, checkBudget, compareHar, maxInputBytes, parseHar } from '../src/audit.js';

const usage = 'Usage: har-compression-audit demo [--json]\n' +
  '       har-compression-audit check FILE [--json] [--show-paths] [--max-identity-bytes N]\n' +
  '       har-compression-audit compare BEFORE AFTER [--json] [--max-identity-increase N]';
const help = usage + '\n\nExit 1 when a byte budget is exceeded. Exit 2 on invalid input or an inconclusive budget.';

async function readCapture(path) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Expected a regular HAR file.');
    if (stat.size > maxInputBytes) throw new Error('HAR input exceeds 16 MiB.');
    const buffer = Buffer.allocUnsafe(Math.min(stat.size + 1, maxInputBytes + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error('HAR file changed size during reading. Try again once the export finishes.');
    return buffer.subarray(0, offset);
  } finally {
    await file.close();
  }
}

async function loadCapture(file) {
  const bytes = await readCapture(file).catch(error => {
    if (error.code) throw new Error('Cannot open or read the HAR file (' + error.code + ').');
    throw error;
  });
  return parseHar(bytes);
}

function parseBudget(value) {
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error('Budget must be a nonnegative safe integer.');
  }
  return Number(value);
}

async function printComparison(before, after, values) {
  const comparison = compareHar(await loadCapture(before), await loadCapture(after));
  const limit = values['max-identity-increase'];
  if (limit !== undefined) {
    const maximum = parseBudget(limit);
    const status = comparison.identityCoverage !== 'complete' ? 'inconclusive' :
      comparison.recordedIdentityBytesChange > maximum ? 'exceeded' : 'within';
    comparison.budget = { maxIdentityIncrease: maximum, status };
    process.exitCode = { within: 0, exceeded: 1, inconclusive: 2 }[status];
  }
  if (values.json) {
    console.log(JSON.stringify(comparison, null, 2));
    return;
  }
  for (const [label, summary] of [['Before', comparison.before], ['After', comparison.after]]) {
    console.log(label + '  ' + summary.entries + ' captured · ' + summary.identityBytes +
      ' recorded identity body bytes · ' + summary.identityUnmeasured +
      ' missing identity sizes · ' + summary.unknown + ' unknown');
  }
  console.log('Recorded identity byte change  ' + comparison.recordedIdentityBytesChange + ' B');
  console.log('Identity size coverage  ' + comparison.identityCoverage);
  console.log('Compare captures of the same workload to interpret this change.');
  if (comparison.budget) console.log('Increase budget  ' + comparison.budget.status);
}

function printSummary(report) {
  const { summary, routes, reasons, budget } = report;
  if (report.synthetic) console.log('Synthetic HAR example');
  console.log('Entries  ' + summary.entries + ' captured · ' + summary.excluded + ' excluded');
  console.log('Identity  ' + summary.identity + ' responses · ' + summary.identityBytes + ' recorded body bytes' +
    (summary.identityUnmeasured ? ' · ' + summary.identityUnmeasured + ' missing body sizes' : ''));
  console.log('Compressed  ' + summary.compressed + ' responses · ' + summary.compressedBytes + ' recorded body bytes' +
    (summary.compressedUnmeasured ? ' · ' + summary.compressedUnmeasured + ' missing body sizes' : ''));
  console.log('Unknown  ' + summary.unknown + ' entries lack conclusive evidence');
  if (routes.length) console.log('\nRoutes by identity body bytes');
  for (const route of routes.slice(0, 20)) {
    const label = route.path ? JSON.stringify(route.path) : 'Route ' + route.id;
    console.log('  ' + label + ' (HAR entry ' + route.firstEntry + ')  ' +
      route.identityBytes + ' B · ' + route.identity + ' identity · ' +
      route.compressed + ' compressed · ' + route.unknown + ' unknown');
  }
  if (routes.length > 20) console.log('  Use --json for all ' + routes.length + ' routes.');
  console.log('\nEvidence counts');
  for (const [reason, count] of Object.entries(reasons)) console.log('  ' + count + '  ' + reason);
  if (budget) console.log('\nIdentity body budget  ' + budget.status + ' (' + budget.maxIdentityBytes + ' B)');
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
      json: { type: 'boolean' },
      'show-paths': { type: 'boolean' },
      'max-identity-bytes': { type: 'string' },
      'max-identity-increase': { type: 'string' },
    },
  });
  if (values.help || process.argv.length === 2) {
    console.log(help);
    return;
  }
  if (values.version) {
    const info = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(info.version);
    return;
  }
  const [command, path] = positionals;
  const threshold = values['max-identity-bytes'];
  if (command === 'compare') {
    if (positionals.length !== 3 || threshold !== undefined || values['show-paths']) throw new Error(usage);
    await printComparison(path, positionals[2], values);
    return;
  }
  if (values['max-identity-increase'] !== undefined) throw new Error(usage);
  const synthetic = command === 'demo' && positionals.length === 1;
  if (!synthetic && !(command === 'check' && positionals.length === 2)) throw new Error(usage);
  if (synthetic && (threshold !== undefined || values['show-paths'])) throw new Error(usage);
  const maxIdentityBytes = threshold === undefined ? undefined : parseBudget(threshold);
  const har = synthetic
    ? parseHar(await readFile(new URL('../examples/synthetic.har.json', import.meta.url)))
    : await loadCapture(path);
  const report = { synthetic, ...auditHar(har, { showPaths: values['show-paths'] }) };
  if (threshold !== undefined) {
    const status = checkBudget(report.summary, maxIdentityBytes);
    report.budget = { maxIdentityBytes, status };
    process.exitCode = { within: 0, exceeded: 1, inconclusive: 2 }[status];
  }
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else printSummary(report);
}

main().catch(error => {
  console.error(error.code?.startsWith('ERR_PARSE_ARGS') ? usage : error.message);
  process.exitCode = 2;
});
