const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function assertFileExists(relativePath) {
  assert.equal(
    fs.existsSync(path.join(root, relativePath)),
    true,
    `Missing packaged file: ${relativePath}`,
  );
}

test('manifest and package versions stay aligned', () => {
  assert.equal(manifest.version, packageJson.version);
});

test('package declares GPL-3.0-only licensing', () => {
  assert.equal(packageJson.license, 'GPL-3.0-only');
  assertFileExists('LICENSE');
});

test('every manifest resource exists', () => {
  assertFileExists(manifest.background.service_worker);
  for (const filename of manifest.background.scripts || []) assertFileExists(filename);
  assertFileExists(manifest.action.default_popup);
  for (const contentScript of manifest.content_scripts) {
    for (const filename of contentScript.js || []) assertFileExists(filename);
    for (const filename of contentScript.css || []) assertFileExists(filename);
  }
  for (const filename of Object.values(manifest.icons || {})) assertFileExists(filename);
  for (const filename of Object.values(manifest.action.default_icon || {})) {
    assertFileExists(filename);
  }
});

test('manifest declares Chrome and Firefox background entry points', () => {
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.deepEqual(
    manifest.background.scripts,
    ['shared.js', 'background-logic.js', 'background.js'],
  );
});

test('Firefox metadata is ready for Manifest V3 signing and consent', () => {
  const gecko = manifest.browser_specific_settings?.gecko;
  assert.match(gecko?.id || '', /^[^@]+@[^@]+$/);
  assert.equal(Number(gecko?.strict_min_version) >= 140, true);
  assert.deepEqual(
    [...(gecko?.data_collection_permissions?.required || [])].sort(),
    ['authenticationInfo', 'websiteContent'],
  );
  assert.equal(
    Number(manifest.browser_specific_settings?.gecko_android?.strict_min_version) >= 142,
    true,
  );
});

test('permissions remain narrowly scoped', () => {
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.deepEqual(manifest.host_permissions, ['https://x.com/*']);
  assert.equal(manifest.permissions.includes('unlimitedStorage'), false);
});
