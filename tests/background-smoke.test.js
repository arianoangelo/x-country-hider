const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

function createExtensionApi(storage, runtimeListeners) {
  return {
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
}

function runScript(context, filename) {
  const absolutePath = path.join(root, filename);
  vm.runInContext(fs.readFileSync(absolutePath, 'utf8'), context, {
    filename: absolutePath,
  });
}

function loadBackground(environment) {
  const storage = {};
  const runtimeListeners = [];
  const extensionApi = createExtensionApi(storage, runtimeListeners);
  const globals = {
    AbortController,
    clearTimeout,
    console,
    fetch: async () => { throw new Error('Unexpected network request'); },
    setTimeout,
  };
  globals[environment === 'firefox' ? 'browser' : 'chrome'] = extensionApi;
  const context = vm.createContext(globals);

  if (environment === 'firefox') {
    for (const filename of ['shared.js', 'background-logic.js', 'background.js']) {
      runScript(context, filename);
    }
  } else {
    context.importScripts = (...filenames) => {
      for (const filename of filenames) runScript(context, filename);
    };
    runScript(context, 'background.js');
  }

  return { runtimeListeners };
}

function sendMessage(listener, message) {
  return new Promise((resolve) => {
    const keepChannelOpen = listener(message, {}, resolve);
    assert.equal(keepChannelOpen, true);
  });
}

for (const environment of ['chrome', 'firefox']) {
  test(`${environment} background initializes and answers popup status requests`, async () => {
    const { runtimeListeners } = loadBackground(environment);

    assert.equal(runtimeListeners.length, 1);
    const response = await sendMessage(
      runtimeListeners[0],
      { type: 'XHIDE_GET_STATS' },
    );

    assert.equal(response.hiddenCount, 0);
    assert.equal(response.cacheSize, 0);
    assert.equal(response.lookupHealth.status, 'idle');
  });
}

test('settings updates remain serialized through the cross-browser API', async () => {
  const { runtimeListeners } = loadBackground('chrome');
  const listener = runtimeListeners[0];

  const [firstAdd, secondAdd] = await Promise.all([
    sendMessage(listener, {
      type: 'XHIDE_UPDATE_SETTINGS',
      action: 'addCountry',
      country: 'Turkey',
    }),
    sendMessage(listener, {
      type: 'XHIDE_UPDATE_SETTINGS',
      action: 'addCountry',
      country: 'Türkiye',
    }),
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
