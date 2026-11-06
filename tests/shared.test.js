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
    autoMute: true,
    blockedCountries: [' Türkiye ', 'Turkey', '', null, 'Portugal'],
    blockedCountryCodes: { turkiye: 'tr', portugal: 'PT', france: 'FR' },
  });
  assert.equal(settings.enabled, false);
  assert.equal(settings.autoMute, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(settings.blockedCountries)),
    ['Türkiye', 'Portugal'],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(settings.blockedCountryCodes)),
    { turkiye: 'TR', portugal: 'PT' },
  );
});

test('language normalization accepts BCP 47 tags and legacy aliases', () => {
  assert.equal(shared.normalizeLanguage('tr-TR'), 'tr');
  assert.equal(shared.normalizeLanguage('pt_BR'), 'pt');
  assert.equal(shared.normalizeLanguage('iw'), 'he');
  assert.equal(shared.normalizeLanguage('english'), '');
});

test('a region resolves to its most likely language', () => {
  assert.equal(shared.languageForRegion('TR'), 'tr');
  assert.equal(shared.languageForRegion('PT'), 'pt');
  assert.equal(shared.languageForRegion(''), '');
});

test('missing settings use safe defaults', () => {
  const settings = shared.normalizeSettings(null);
  assert.equal(settings.enabled, true);
  assert.equal(settings.autoMute, false);
  assert.deepEqual(JSON.parse(JSON.stringify(settings.blockedCountries)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(settings.blockedCountryCodes)), {});
});

test('isCountryBlocked matches canonical and aliased countries', () => {
  assert.equal(shared.isCountryBlocked('Turkey', ['Türkiye']), true);
  assert.equal(shared.isCountryBlocked('Portugal', ['Spain', 'France']), false);
  assert.equal(shared.isCountryBlocked(null, ['Spain']), false);
});
