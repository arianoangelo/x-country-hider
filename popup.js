const { normalizeCountry, normalizeSettings } = XHideShared;
const SETTINGS_KEY = 'xhide_settings';

const enabledEl = document.getElementById('enabled');
const statusCardEl = document.getElementById('statusCard');
const statusTitleEl = document.getElementById('statusTitle');
const statusDetailEl = document.getElementById('statusDetail');
const listEl = document.getElementById('list');
const emptyStateEl = document.getElementById('emptyState');
const countryCountEl = document.getElementById('countryCount');
const formEl = document.getElementById('countryForm');
const inputEl = document.getElementById('newCountry');
const addButtonEl = document.getElementById('add');
const formMessageEl = document.getElementById('formMessage');
const hiddenCountEl = document.getElementById('hiddenCount');
const cacheDetailEl = document.getElementById('cacheDetail');
const clearCacheEl = document.getElementById('clearCache');

let settingsMutation = Promise.resolve();
let renderSequence = 0;

// X can expose either a country or a privacy-preserving regional bucket.
// Country labels are generated in English because the API response consumed
// by this extension currently uses X's English location values.
const X_REGION_VALUES = [
  'East Asia & Pacific',
  'Europe & Central Asia',
  'Latin America & Caribbean',
  'Middle East & North Africa',
  'North America',
  'South Asia',
  'Sub-Saharan Africa',
  'Europe',
  'East Asia',
  'West Asia',
  'Eastern Europe',
  'Global / Worldwide',
  'Unknown',
];

const ISO_REGION_CODES = [
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW',
  'AX', 'AZ', 'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN',
  'BO', 'BQ', 'BR', 'BS', 'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CC', 'CD', 'CF', 'CG',
  'CH', 'CI', 'CK', 'CL', 'CM', 'CN', 'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ',
  'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE', 'EG', 'EH', 'ER', 'ES', 'ET', 'FI',
  'FJ', 'FK', 'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF', 'GG', 'GH', 'GI', 'GL',
  'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HM', 'HN', 'HR',
  'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT', 'JE', 'JM',
  'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ', 'LA',
  'LB', 'LC', 'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME',
  'MF', 'MG', 'MH', 'MK', 'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU',
  'MV', 'MW', 'MX', 'MY', 'MZ', 'NA', 'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP',
  'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG', 'PH', 'PK', 'PL', 'PM', 'PN', 'PR',
  'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW', 'SA', 'SB', 'SC', 'SD',
  'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS', 'ST', 'SV',
  'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO',
  'TR', 'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE',
  'VG', 'VI', 'VN', 'VU', 'WF', 'WS', 'YE', 'YT', 'ZA', 'ZM', 'ZW',
];

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

async function getSettings() {
  const stored = await chrome.storage.local.get([SETTINGS_KEY]);
  return normalizeSettings(stored[SETTINGS_KEY]);
}

function updateSettings(update) {
  const operation = settingsMutation.catch(() => {}).then(async () => {
    const response = await chrome.runtime.sendMessage({
      type: 'XHIDE_UPDATE_SETTINGS',
      ...update,
    });
    if (response?.status !== 'ok') throw new Error(response?.error || 'settings_write_failed');
    return response;
  });
  settingsMutation = operation.catch(() => {});
  return operation;
}

function formatCount(value) {
  return new Intl.NumberFormat().format(Number(value) || 0);
}

function flagForCode(code) {
  return [...code].map((letter) => String.fromCodePoint(127397 + letter.charCodeAt(0))).join('');
}

function populateCountrySelect(blockedCountries = []) {
  const selectedValues = new Set(blockedCountries.map(normalizeCountry));
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Select a country or region';

  const regions = document.createElement('optgroup');
  regions.label = 'X regions';
  for (const region of X_REGION_VALUES) {
    const option = document.createElement('option');
    option.value = region;
    option.textContent = `🌐  ${region}`;
    option.disabled = selectedValues.has(normalizeCountry(region));
    regions.appendChild(option);
  }

  const countries = document.createElement('optgroup');
  countries.label = 'Countries and territories';
  const countryOptions = ISO_REGION_CODES.map((code) => ({ code, name: regionNames.of(code) }))
    .filter(({ code, name }) => name && name !== code)
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  for (const { code, name } of countryOptions) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = `${flagForCode(code)}  ${name}`;
    option.disabled = selectedValues.has(normalizeCountry(name));
    countries.appendChild(option);
  }

  inputEl.replaceChildren(placeholder, regions, countries);
  inputEl.value = '';
  addButtonEl.disabled = true;
}

function makeCountryItem(country) {
  const item = document.createElement('li');
  item.className = 'country-item';

  const marker = document.createElement('span');
  marker.className = 'country-item__marker';
  marker.setAttribute('aria-hidden', 'true');
  marker.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 5-8 12-8 12S4 15 4 10' +
    'a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg>';

  const name = document.createElement('span');
  name.className = 'country-item__name';
  name.textContent = country;
  name.title = country;

  const removeButton = document.createElement('button');
  removeButton.className = 'country-item__remove';
  removeButton.type = 'button';
  removeButton.title = `Remove ${country}`;
  removeButton.setAttribute('aria-label', `Remove ${country} from hidden countries`);
  removeButton.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round"><path d="m7 7 10 10M17 7 7 17"/></svg>';
  removeButton.addEventListener('click', async () => {
    removeButton.disabled = true;
    try {
      await updateSettings({ action: 'removeCountry', country });
      await render();
    } catch (_) {
      formMessageEl.textContent = `Could not remove ${country}. Please try again.`;
      removeButton.disabled = false;
    }
  });

  item.append(marker, name, removeButton);
  return item;
}

function retryDescription(retryAt) {
  const seconds = Math.max(0, Math.ceil((Number(retryAt) - Date.now()) / 1000));
  if (seconds < 60) return 'in less than a minute';
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `in about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.ceil(minutes / 60);
  return `in about ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

function renderStatus(settings, stats) {
  const countryCount = settings.blockedCountries.length;
  const health = stats?.lookupHealth || { status: 'idle' };
  document.body.dataset.enabled = String(settings.enabled);
  enabledEl.checked = settings.enabled;
  statusCardEl.dataset.state = 'healthy';

  if (!settings.enabled) {
    statusCardEl.dataset.state = 'paused';
    statusTitleEl.textContent = 'Protection is paused';
    statusDetailEl.textContent = 'No posts are being checked or hidden.';
  } else if (!countryCount) {
    statusCardEl.dataset.state = 'ready';
    statusTitleEl.textContent = 'Ready for a country';
    statusDetailEl.textContent = 'Add one below to start filtering your timeline.';
  } else if (health.status === 'auth_error') {
    statusCardEl.dataset.state = 'degraded';
    statusTitleEl.textContent = 'X sign-in required';
    statusDetailEl.textContent = 'Cached matches stay hidden, but new accounts cannot be checked.';
  } else if (health.status === 'api_error') {
    statusCardEl.dataset.state = 'degraded';
    statusTitleEl.textContent = 'X lookup unavailable';
    statusDetailEl.textContent = 'Cached matches stay hidden. X may have changed its account data.';
  } else if (health.status === 'service_error') {
    statusCardEl.dataset.state = 'degraded';
    statusTitleEl.textContent = 'X is temporarily unavailable';
    statusDetailEl.textContent = 'Cached matches stay hidden while new checks wait.';
  } else if (health.status === 'cooldown' && Number(health.retryAt) > Date.now()) {
    statusCardEl.dataset.state = 'waiting';
    statusTitleEl.textContent = 'Waiting for X';
    statusDetailEl.textContent = `New account checks resume ${retryDescription(health.retryAt)}.`;
  } else {
    statusTitleEl.textContent = 'Protection is on';
    statusDetailEl.textContent = `${countryCount} ${countryCount === 1 ? 'country is' : 'countries are'} being filtered.`;
  }
}

async function render() {
  const requestId = ++renderSequence;
  const [settings, stats] = await Promise.all([
    getSettings().catch(() => normalizeSettings()),
    chrome.runtime.sendMessage({ type: 'XHIDE_GET_STATS' }).catch(() => ({
      hiddenCount: 0,
      cacheSize: 0,
      lookupHealth: { status: 'service_error', error: 'extension_unavailable' },
    })),
  ]);
  if (requestId !== renderSequence) return;

  renderStatus(settings, stats);
  populateCountrySelect(settings.blockedCountries);
  listEl.replaceChildren(...settings.blockedCountries.map(makeCountryItem));
  emptyStateEl.hidden = settings.blockedCountries.length > 0;
  countryCountEl.textContent = String(settings.blockedCountries.length);
  countryCountEl.setAttribute(
    'aria-label',
    `${settings.blockedCountries.length} hidden ${settings.blockedCountries.length === 1 ? 'country' : 'countries'}`,
  );
  hiddenCountEl.textContent = formatCount(stats?.hiddenCount);
  const cacheSize = Number(stats?.cacheSize) || 0;
  cacheDetailEl.textContent = cacheSize
    ? `${formatCount(cacheSize)} ${cacheSize === 1 ? 'author location' : 'author locations'} stored locally.`
    : 'No author locations are stored yet.';
  clearCacheEl.disabled = cacheSize === 0;
}

enabledEl.addEventListener('change', async () => {
  const enabled = enabledEl.checked;
  try {
    await updateSettings({ action: 'setEnabled', enabled });
    await render();
  } catch (_) {
    formMessageEl.textContent = 'Could not update protection. Please try again.';
    await render();
  }
});

inputEl.addEventListener('change', () => {
  addButtonEl.disabled = !inputEl.value;
  formMessageEl.textContent = '';
});

formEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  const country = inputEl.value;
  if (!country) return;

  addButtonEl.disabled = true;
  try {
    const response = await updateSettings({ action: 'addCountry', country });
    if (response.alreadyExists) {
      formMessageEl.textContent = `${country} is already on your list.`;
      inputEl.focus();
      return;
    }
    formMessageEl.textContent = '';
    await render();
    inputEl.focus();
  } catch (_) {
    formMessageEl.textContent = `Could not add ${country}. Please try again.`;
    addButtonEl.disabled = false;
  }
});

clearCacheEl.addEventListener('click', async () => {
  clearCacheEl.disabled = true;
  clearCacheEl.textContent = 'Clearing…';
  try {
    await chrome.runtime.sendMessage({ type: 'XHIDE_CLEAR_CACHE' });
    await render();
  } catch (_) {
    cacheDetailEl.textContent = 'Could not clear the cache. Please try again.';
    clearCacheEl.disabled = false;
  } finally {
    clearCacheEl.textContent = 'Clear cache';
  }
});

void render().catch(() => {});
