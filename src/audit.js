export const maxInputBytes = 16 * 1024 * 1024;
const maxEntries = 50_000;
const maxRoutes = 20_000;
const codingNames = ['gzip', 'br', 'deflate', 'zstd', 'compress', 'x-gzip', 'x-compress'];
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const tokenPattern = /^[!#$%&'*+.^_`|~0-9a-z-]+$/iu;

function headerValues(headers, name) {
  if (!Array.isArray(headers) || headers.length > 1024) return null;
  const values = [];
  for (const header of headers) {
    if (!header || typeof header.name !== 'string' || typeof header.value !== 'string') return null;
    if (header.name.toLowerCase() === name) {
      if (header.value.length > 8192) return null;
      values.push(header.value);
    }
  }
  return values;
}

function offeredCompression(headers) {
  const values = headerValues(headers, 'accept-encoding');
  if (!values?.length) return null;
  const weights = new Map();
  for (const part of values.join(',').split(',')) {
    if (!part.trim()) continue;
    const [coding, weight, ...extra] = part.trim().toLowerCase().split(';').map(s => s.trim());
    if (!tokenPattern.test(coding) || extra.length ||
        (weight !== undefined && !/^q\s*=\s*(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/u.test(weight))) return null;
    const score = weight === undefined ? 1 : Number(weight.split('=')[1]);
    if (weights.has(coding) && weights.get(coding) !== score) return null;
    weights.set(coding, score);
  }
  return codingNames.some(coding => (weights.get(coding) ?? weights.get('*') ?? 0) > 0);
}

function classify(entry) {
  const request = entry?.request;
  const response = entry?.response;
  const method = typeof request?.method === 'string' ? request.method.toUpperCase() : null;
  const status = response?.status;
  if (method === 'HEAD' || (Number.isInteger(status) && status >= 100 &&
      (status < 200 || status >= 300 || [204, 205, 206].includes(status)))) {
    return ['excluded', 'outside-full-success-response'];
  }
  const types = headerValues(response?.headers, 'content-type');
  const mime = (types?.length ? types : [response?.content?.mimeType])
    .map(type => typeof type === 'string' ? type.split(';')[0].trim().toLowerCase() : '');
  if (!mime[0]?.includes('/') || mime.some(type => type !== mime[0])) {
    return ['unknown', 'media-type-unavailable'];
  }
  if (!/^application\/(?:json|[\w.+-]+\+json)$/u.test(mime[0])) return ['excluded', 'non-json'];
  if (!method || !Number.isInteger(status) || status < 100) return ['unknown', 'response-incomplete'];
  if ([entry, response].some(item => item._fromCache === true || item._fromDiskCache === true ||
      item._fromMemoryCache === true || item._fromServiceWorker === true ||
      item._fetchedViaServiceWorker === true ||
      ['disk', 'memory', 'service-worker'].includes(item._fromCache) || item._transferSize === 0)) {
    return ['excluded', 'cached-or-local-response'];
  }
  if (entry._error || response._error) return ['unknown', 'response-incomplete'];

  const wire = bodyBytes(response.bodySize);
  const decoded = bodyBytes(response.content?.size);
  if (wire === 0 && decoded === 0) return ['excluded', 'empty-body'];
  if (wire === 0) return ['unknown', 'zero-body-transfer'];

  const values = headerValues(response.headers, 'content-encoding');
  if (values === null || response.headers.length === 0) return ['unknown', 'response-headers-unavailable'];
  const codings = values.flatMap(value => value.split(',')).map(value => value.trim().toLowerCase());
  if (codings.some(coding => !tokenPattern.test(coding)) ||
      (codings.includes('identity') && codings.length > 1)) return ['unknown', 'ambiguous-content-encoding'];
  if (codings.length && codings[0] !== 'identity') {
    if (!codings.every(coding => codingNames.includes(coding))) return ['unknown', 'unrecognized-content-encoding'];
    return ['compressed', 'content-encoding-observed', wire, [...new Set(codings)]];
  }
  if (wire !== null && decoded !== null && wire !== decoded) return ['unknown', 'identity-size-mismatch'];
  const offer = offeredCompression(request?.headers);
  if (offer === null) return ['unknown', 'compression-offer-unavailable'];
  if (!offer) return ['excluded', 'compression-not-offered'];
  if (wire === null && !(decoded > 0)) return ['unknown', 'body-size-unavailable'];
  return ['identity', 'compression-offered-identity-returned', wire];
}

function bodyBytes(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function sum(left, right) {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new Error('Capture byte totals exceed safe integer precision.');
  return result;
}

function routeKey(entry, index) {
  const method = typeof entry?.request?.method === 'string' ? entry.request.method.toUpperCase() : '';
  const safeMethod = methods.has(method) ? method : 'OTHER';
  const raw = entry?.request?.url;
  if (typeof raw === 'string' && raw.length <= 16384) {
    try {
      const url = new URL(raw);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        return { key: `${method} ${url.origin}${url.pathname}`, label: `${safeMethod} ${url.origin}${url.pathname}` };
      }
    } catch {
      // An unavailable URL is reported as its own route.
    }
  }
  return { key: index, label: `${safeMethod} · request ${index + 1}` };
}

function totals() {
  return { identity: 0, compressed: 0, unknown: 0, identityBytes: 0,
    compressedBytes: 0, identityUnmeasured: 0, compressedUnmeasured: 0 };
}

function add(bucket, state, wire) {
  bucket[state]++;
  if (state === 'unknown') return;
  if (wire === null) bucket[`${state}Unmeasured`]++;
  else bucket[`${state}Bytes`] = sum(bucket[`${state}Bytes`], wire);
}

export function auditHar(har, { showPaths = false } = {}) {
  const entries = har?.log?.entries;
  if (!Array.isArray(entries) || entries.length > maxEntries) {
    throw new Error('Expected a HAR log.entries array of up to 50,000 entries.');
  }
  const summary = { entries: entries.length, excluded: 0, ...totals() };
  const reasons = new Map();
  const routes = new Map();
  for (const [index, entry] of entries.entries()) {
    const [state, reason, wire, codings] = classify(entry);
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    if (state === 'excluded') {
      summary.excluded++;
      continue;
    }
    add(summary, state, wire);
    const { key, label } = routeKey(entry, index);
    if (!routes.has(key)) {
      if (routes.size === maxRoutes) throw new Error('Capture has more than 20,000 routes.');
      routes.set(key, {
        id: routes.size + 1, firstEntry: index + 1, ...totals(), codings: [],
        ...(showPaths ? { path: label } : {}),
      });
    }
    const route = routes.get(key);
    add(route, state, wire);
    for (const coding of codings ?? []) {
      if (!route.codings.includes(coding)) route.codings.push(coding);
    }
  }
  const rows = [...routes.values()].sort((a, b) => b.identityBytes - a.identityBytes ||
    b.identity - a.identity || b.unknown - a.unknown || a.id - b.id);
  return { version: 1, pathsIncluded: Boolean(showPaths), summary, reasons: Object.fromEntries(reasons), routes: rows };
}

export function checkBudget(summary, maxIdentityBytes) {
  if (!Number.isSafeInteger(maxIdentityBytes) || maxIdentityBytes < 0) throw new Error('Budget must be a nonnegative integer.');
  if (summary.identityBytes > maxIdentityBytes) return 'exceeded';
  if (summary.unknown || summary.identityUnmeasured || (!summary.compressed && !summary.identity)) return 'inconclusive';
  return 'within';
}

/** Compare captured totals. Route IDs are local to each capture and cannot be joined. */
export function compareHar(beforeHar, afterHar) {
  const before = auditHar(beforeHar).summary;
  const after = auditHar(afterHar).summary;
  const complete = summary =>
    summary.unknown === 0 && summary.identityUnmeasured === 0 &&
    summary.identity + summary.compressed > 0;
  return {
    version: 1,
    before,
    after,
    identityCoverage: complete(before) && complete(after) ? 'complete' : 'incomplete',
    recordedIdentityBytesChange: after.identityBytes - before.identityBytes,
  };
}

export function parseHar(bytes) {
  if (bytes.byteLength > maxInputBytes) throw new Error('HAR input exceeds 16 MiB.');
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('Expected valid UTF-8 HAR JSON.');
  }
}
