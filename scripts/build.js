import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const read = relative => readFile(new URL(relative, import.meta.url), 'utf8').then(text => text.replaceAll('\r\n', '\n'));
const [core, page, css, app, sample] = await Promise.all([
  read('../src/audit.js'), read('../src/demo.html'), read('../src/demo.css'), read('../src/demo.js'),
  read('../examples/synthetic.har.json'),
]);
const data = JSON.stringify(JSON.parse(sample)).replaceAll('<', '\\u003c');
const script = "(() => {\n'use strict';\n" + core.replace(/^export /gm, '') +
  '\nconst sampleHar = ' + data + ';\n' + app + '\n})();';
const hash = source => createHash('sha256').update(source).digest('base64');
const csp = "default-src 'none'; script-src 'sha256-" + hash(script) + "'; style-src 'sha256-" +
  hash(css) + "'; base-uri 'none'; form-action 'none'";
const html = page.replace('__CSP__', () => csp).replace('__CSS__', () => css).replace('__JS__', () => script);
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
await writeFile(new URL('../dist/har-compression-audit.html', import.meta.url), html);
