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

function loadBackground(environment, overrides = {}) {
  const storage = {};
  const runtimeListeners = [];
  const extensionApi = createExtensionApi(storage, runtimeListeners);
  const globals = {
    AbortController,
    clearTimeout,
    console,
    fetch: async () => { throw new Error('Unexpected network request'); },
    setTimeout,
    ...overrides,
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

  return { runtimeListeners, storage };
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
    assert.equal(response.mutedCount, 0);
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

  const autoMuteUpdate = await sendMessage(listener, {
    type: 'XHIDE_UPDATE_SETTINGS',
    action: 'setAutoMute',
    autoMute: true,
  });
  assert.equal(autoMuteUpdate.status, 'ok');
  assert.equal(autoMuteUpdate.settings.autoMute, true);
});

async function loadWithAutoMute(status) {
  const calls = [];
  const { runtimeListeners, storage } = loadBackground('chrome', {
    fetch: async (url) => {
      calls.push(url);
      return { ok: status >= 200 && status < 300, status };
    },
    // Skip the two-second mute pacing, so a missing pause would show up as an
    // extra request instead of hiding behind the delay.
    setTimeout: (callback) => setTimeout(callback, 0),
  });
  const listener = runtimeListeners[0];
  await sendMessage(listener, {
    type: 'XHIDE_UPDATE_SETTINGS',
    action: 'setAutoMute',
    autoMute: true,
  });

  return {
    calls,
    storage,
    mutedCount: async () =>
      (await sendMessage(listener, { type: 'XHIDE_GET_STATS' })).mutedCount,
    requestMute: async (handle, csrfToken = 'token') => {
      await sendMessage(listener, { type: 'XHIDE_MUTE_HANDLE', handle, csrfToken });
      // The queue keeps running after the reply.
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  };
}

test('auto-mute records accounts that X accepts and keeps going', async () => {
  const { calls, mutedCount, requestMute, storage } = await loadWithAutoMute(200);

  await requestMute('someone');
  await requestMute('another');

  assert.equal(calls.length, 2);
  assert.equal(await mutedCount(), 2);
  assert.deepEqual(
    JSON.parse(JSON.stringify(storage.xhide_muted_handles)),
    ['someone', 'another'],
  );
});

for (const status of [401, 403]) {
  test(`auto-mute does not record a ${status} and pauses further requests`, async () => {
    const { calls, mutedCount, requestMute, storage } = await loadWithAutoMute(status);

    await requestMute('someone');
    await requestMute('another');

    assert.equal(calls.length, 1);
    assert.equal(await mutedCount(), 0);
    assert.equal(storage.xhide_muted_handles, undefined);
  });
}

test('auto-mute sends nothing without a csrf token', async () => {
  const { calls, mutedCount, requestMute } = await loadWithAutoMute(200);

  await requestMute('someone', null);

  assert.equal(calls.length, 0);
  assert.equal(await mutedCount(), 0);
});
