const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('service worker initializes and answers popup status requests', async () => {
  const root = path.join(__dirname, '..');
  const storage = {};
  const runtimeListeners = [];
  let context;

  const chrome = {
    runtime: {
      onMessage: { addListener: (listener) => runtimeListeners.push(listener) },
    },
    storage: {
      local: {
        get: async () => ({ ...storage }),
        set: async (values) => Object.assign(storage, values),
        remove: async (keys) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
        },
      },
      onChanged: { addListener: () => {} },
    },
    tabs: { onRemoved: { addListener: () => {} } },
  };

  context = vm.createContext({
    AbortController,
    clearTimeout,
    chrome,
    console,
    fetch: async () => { throw new Error('Unexpected network request'); },
    setTimeout,
  });
  context.importScripts = (...filenames) => {
    for (const filename of filenames) {
      const absolutePath = path.join(root, filename);
      vm.runInContext(fs.readFileSync(absolutePath, 'utf8'), context, {
        filename: absolutePath,
      });
    }
  };

  const backgroundPath = path.join(root, 'background.js');
  vm.runInContext(fs.readFileSync(backgroundPath, 'utf8'), context, {
    filename: backgroundPath,
  });

  assert.equal(runtimeListeners.length, 1);
  const response = await new Promise((resolve) => {
    const keepChannelOpen = runtimeListeners[0](
      { type: 'XHIDE_GET_STATS' },
      {},
      resolve,
    );
    assert.equal(keepChannelOpen, true);
  });

  assert.equal(response.hiddenCount, 0);
  assert.equal(response.cacheSize, 0);
  assert.equal(response.lookupHealth.status, 'idle');

  const sendMessage = (message) => new Promise((resolve) => {
    const keepChannelOpen = runtimeListeners[0](message, {}, resolve);
    assert.equal(keepChannelOpen, true);
  });
  const [firstAdd, secondAdd] = await Promise.all([
    sendMessage({ type: 'XHIDE_UPDATE_SETTINGS', action: 'addCountry', country: 'Turkey' }),
    sendMessage({ type: 'XHIDE_UPDATE_SETTINGS', action: 'addCountry', country: 'Türkiye' }),
  ]);
  assert.equal(firstAdd.status, 'ok');
  assert.equal(secondAdd.status, 'ok');
  assert.equal(firstAdd.alreadyExists, false);
  assert.equal(secondAdd.alreadyExists, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(secondAdd.settings.blockedCountries)),
    ['Turkey'],
  );
});
