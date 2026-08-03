const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadBackgroundLogic() {
  const context = vm.createContext({});
  const filename = path.join(__dirname, '..', 'background-logic.js');
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return context.XHideBackgroundLogic;
}

const logic = loadBackgroundLogic();

test('positive cache entries expire after 30 days', () => {
  const now = Date.UTC(2026, 7, 3);
  const fresh = { country: 'Portugal', source: 'profile', ts: now - 29 * 24 * 60 * 60 * 1000 };
  const expired = { ...fresh, ts: now - 31 * 24 * 60 * 60 * 1000 };
  assert.equal(logic.isCacheEntryFresh(fresh, now), true);
  assert.equal(logic.isCacheEntryFresh(expired, now), false);
});

test('unavailable locations expire after 24 hours', () => {
  const now = Date.UTC(2026, 7, 3);
  const fresh = { country: null, source: null, ts: now - 23 * 60 * 60 * 1000 };
  const expired = { ...fresh, ts: now - 25 * 60 * 60 * 1000 };
  assert.equal(logic.isCacheEntryFresh(fresh, now), true);
  assert.equal(logic.isCacheEntryFresh(expired, now), false);
});

test('malformed cache timestamps are rejected', () => {
  assert.equal(logic.normalizeCacheEntry({ country: 'Portugal', ts: 'not-a-date' }), null);
  assert.equal(logic.isCacheEntryFresh({ country: 'Portugal' }), false);
});

test('valid About this Account data is parsed', () => {
  const now = Date.UTC(2026, 7, 3);
  const parsed = logic.parseAboutAccountResponse({
    data: {
      user_result_by_screen_name: {
        result: {
          about_profile: { account_based_in: 'Portugal', source: 'profile' },
        },
      },
    },
  }, now);
  assert.equal(parsed.ok, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(parsed.entry)),
    { country: 'Portugal', source: 'profile', ts: now },
  );
});

test('an explicit null profile is a short-lived unavailable result', () => {
  const parsed = logic.parseAboutAccountResponse({
    data: { user_result_by_screen_name: { result: { about_profile: null } } },
  }, 1234);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entry.country, null);
  assert.equal(parsed.entry.ts, 1234);
});

test('missing response fields are not cached as unavailable locations', () => {
  const missingProfile = logic.parseAboutAccountResponse({
    data: { user_result_by_screen_name: { result: {} } },
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(missingProfile)),
    { ok: false, reason: 'missing_about_profile' },
  );

  const partialError = logic.parseAboutAccountResponse({
    data: { user_result_by_screen_name: { result: {} } },
    errors: [{ code: 131, message: 'Internal error' }],
  });
  assert.equal(partialError.ok, false);
  assert.equal(partialError.reason, 'graphql_error');
});

test('known unavailable-account errors may be cached briefly', () => {
  const parsed = logic.parseAboutAccountResponse({ errors: [{ code: 50 }] }, 1234);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entry.country, null);
  assert.equal(parsed.entry.source, 'account_unavailable');
});
