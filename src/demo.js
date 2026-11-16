const $ = id => document.getElementById(id);
const number = new Intl.NumberFormat('en-US');
const format = value => number.format(value);
const capture = $('capture');
const paths = $('paths');
let active = sampleHar;
let synthetic = true;
let generation = 0;

function element(tag, value, className) {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}

function render(report, isSample) {
  const { summary, routes, reasons } = report;
  const metrics = [
    ['Identity body bytes', format(summary.identityBytes) + ' B', format(summary.identity) + ' responses with compression offered'],
    ['Compressed responses', format(summary.compressed), format(summary.compressedBytes) + ' recorded body bytes'],
    ['Unknown entries', format(summary.unknown), 'Missing or ambiguous evidence'],
    ['Excluded entries', format(summary.excluded), 'Of ' + format(summary.entries) + ' captured entries'],
  ];
  $('metrics').replaceChildren(...metrics.map(([label, value, note]) => {
    const metric = element('div', '', 'metric');
    metric.append(element('dt', label), element('dd', value, 'value'), element('dd', note, 'note'));
    return metric;
  }));

  $('routes').replaceChildren(...routes.slice(0, 100).map(route => {
    const row = document.createElement('tr');
    const bytes = format(route.identityBytes) + ' B' +
      (route.identityUnmeasured ? ' + ' + format(route.identityUnmeasured) + ' unmeasured' : '');
    for (const value of [route.path ?? 'Route ' + route.id, format(route.firstEntry), format(route.identity),
      bytes, format(route.compressed), format(route.unknown)]) row.append(element('td', value));
    return row;
  }));
  $('route-count').textContent = routes.length > 100
    ? 'Showing 100 of ' + format(routes.length) + ' routes. The CLI can export every route.'
    : format(routes.length) + (routes.length === 1 ? ' route' : ' routes') + ' with compression evidence or a capture gap.';
  $('evidence').replaceChildren(...Object.entries(reasons).flatMap(([reason, count]) => [
    element('dt', reason.replaceAll('-', ' ')), element('dd', format(count)),
  ]));
  $('status').removeAttribute('data-error');
  $('status').textContent = isSample ? 'Synthetic HAR example' : 'Local HAR loaded';
}

function reset() {
  generation++;
  capture.value = '';
  paths.checked = false;
  active = sampleHar;
  synthetic = true;
  render(auditHar(active), synthetic);
}

capture.addEventListener('change', async () => {
  const file = capture.files[0];
  const request = ++generation;
  if (!file) return;
  try {
    if (file.size > maxInputBytes) throw new Error('HAR input exceeds 16 MiB.');
    const candidate = parseHar(await file.arrayBuffer());
    if (request !== generation) return;
    const report = auditHar(candidate);
    active = candidate;
    synthetic = false;
    paths.checked = false;
    render(report, synthetic);
  } catch (error) {
    if (request !== generation) return;
    capture.value = '';
    $('status').setAttribute('data-error', '');
    $('status').textContent = error.message + ' Previous report retained.';
  }
});
paths.addEventListener('change', () => render(auditHar(active, { showPaths: paths.checked }), synthetic));
$('sample').addEventListener('click', reset);
reset();
