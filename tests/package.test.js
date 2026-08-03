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

test('permissions remain narrowly scoped', () => {
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.deepEqual(manifest.host_permissions, ['https://x.com/*']);
  assert.equal(manifest.permissions.includes('unlimitedStorage'), false);
});
