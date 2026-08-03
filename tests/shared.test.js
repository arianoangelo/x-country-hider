const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadShared() {
  const context = vm.createContext({});
  const filename = path.join(__dirname, '..', 'shared.js');
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return context.XHideShared;
}

const shared = loadShared();

test('country aliases resolve to a common key', () => {
  assert.equal(shared.normalizeCountry('Turkey'), shared.normalizeCountry('Türkiye'));
  assert.equal(shared.normalizeCountry('Côte d’Ivoire'), shared.normalizeCountry('Ivory Coast'));
  assert.equal(shared.normalizeCountry('Viet Nam'), shared.normalizeCountry('Vietnam'));
});

test('country normalization tolerates punctuation and spacing', () => {
  assert.equal(
    shared.normalizeCountry('  Europe   & Central Asia '),
    shared.normalizeCountry('Europe and Central Asia'),
  );
});

test('settings are validated and aliases are deduplicated', () => {
  const settings = shared.normalizeSettings({
    enabled: false,
    blockedCountries: [' Türkiye ', 'Turkey', '', null, 'Portugal'],
  });
  assert.equal(settings.enabled, false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(settings.blockedCountries)),
    ['Türkiye', 'Portugal'],
  );
});

test('missing settings use safe defaults', () => {
  const settings = shared.normalizeSettings(null);
  assert.equal(settings.enabled, true);
  assert.deepEqual(JSON.parse(JSON.stringify(settings.blockedCountries)), []);
});
