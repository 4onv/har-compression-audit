# HAR Compression Audit

Find the JSON API routes that account for the most uncompressed response bytes in a browser capture. HAR Compression Audit groups requests by route and shows where the client offered compression, where compression was used, and where the capture lacked the evidence to decide.

**Try it in your browser.** Download the standalone HTML, open it, and inspect the synthetic sample or choose a local HAR. The HTML makes no network requests. [Download the offline demo](https://github.com/4onv/har-compression-audit/releases/latest/download/har-compression-audit.html)

The synthetic sample contains three identity responses with **75,538 recorded body bytes**, of which **74,252** came from two requests to the same activity route. It also includes a Brotli response, a cached response, a 304, and one request with its compression offer missing.

## Audit a capture

In your browser’s Network panel, save a HAR while reproducing the affected request. A sanitized export is preferable where available. Start with an uncached load when you want to inspect the actual network response. Then open the HAR in the offline demo or check it with the CLI.

The CLI requires Node.js 22 or later. Download the package archive from the release. The resulting command has no runtime dependencies. [Download the package archive and checksums](https://github.com/4onv/har-compression-audit/releases/latest)

```sh
npm install --global ./4onv-har-compression-audit-0.1.0.tgz
har-compression-audit demo
har-compression-audit check session.har
har-compression-audit check session.har --json
```

By default, reports display numbered route aliases and the one-based index of the first matching HAR entry. Use `--show-paths` or the browser’s reveal checkbox to include request method, origin, and pathname. Paths can contain private values. URLs in reports omit userinfo, query strings, and fragments. Reports also omit request and response bodies, header values, and cookies. A raw HAR can contain all of them, so keep the capture local when it holds sensitive data.

## Use a byte budget in CI

```sh
har-compression-audit check session.har --max-identity-bytes 50000 --json
```

| Exit | With a budget |
| --- | --- |
| 0 | The recorded identity byte count is within budget and the capture has enough evidence. |
| 1 | The recorded identity byte count exceeds the budget. |
| 2 | Evidence is incomplete, no relevant responses were observed, or the input is invalid. |

Without a budget, a valid audit exits with 0 and exposes unknown entries in the report. In JSON, `summary.identityUnmeasured` counts identity responses whose recorded transfer size is unavailable. `reasons` breaks down exclusions and unknowns. `routes` contains all route groups. The terminal summary lists the top 20, and the HTML shows up to 100.

## What the audit measures

- **Identity** counts successful, nonempty JSON responses where the request offered a recognized compression coding and response headers indicate identity.
- **Compressed** counts successful JSON responses with observed gzip, Brotli, Deflate, Zstandard, Compress, or their supported legacy aliases.
- **Unknown** covers incomplete or contradictory evidence, including missing request offer headers on identity candidates, unavailable media types, and inconsistent body sizes.
- **Excluded** includes non-JSON traffic, requests with an explicit offer that rules out supported compression, recognized cache and service worker responses, HEAD, empty responses, partial content, and statuses outside 2xx.

The audit uses HAR `response.bodySize` for recorded bytes. Some exporters set it to `-1` even when another field has decoded size. Those transfers remain unmeasured. Reported bytes measure what the exporter recorded. They do not estimate the bytes a future compression configuration would save. HAR cannot establish why a server used identity, and cache detection depends on exporter metadata. Query variants are grouped by exact method, origin and path. Dynamic path segments remain distinct. Input is limited to 16 MiB, 50,000 entries, and 20,000 distinct routes. [HAR 1.2](https://github.com/ahmadnassri/har-spec/blob/master/versions/1.2.md) · [HTTP Accept-Encoding](https://www.rfc-editor.org/rfc/rfc9110.html#name-accept-encoding)

## Run from source

```sh
npm run build
node bin/har-compression-audit.js demo
npm test
npm ci --ignore-scripts
npx playwright install chromium firefox
npm run test:browser
```

Open `dist/har-compression-audit.html` for the built demo. Browser tests cover offline uploads plus real browser HAR recordings from a local server with gzip and identity responses.

[November 15 research and candidate comparison](docs/research-2026-11-15.md) · [MIT License](LICENSE)
