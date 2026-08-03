importScripts('shared.js', 'background-logic.js');

// Owns all X API access for the extension. Keeping the queue and cache here
// prevents separate x.com tabs from repeating the same account lookup.
const { normalizeCountry, normalizeSettings } = XHideShared;
const {
  MAX_CACHE_ENTRIES,
  isCacheEntryFresh,
  normalizeCacheEntry,
  parseAboutAccountResponse,
} = XHideBackgroundLogic;
const BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const QUERY_ID = 'XRqGa7EeokUU5kppkh13EA';

const SETTINGS_KEY = 'xhide_settings';
const LEGACY_CACHE_KEY = 'xhide_cache';
const CACHE_PREFIX = 'xhide_cache_entry:';
const HIDDEN_COUNT_KEY = 'xhide_hidden_count';
const RATE_LIMIT_UNTIL_KEY = 'xhide_rate_limit_until';
const LAST_REQUEST_AT_KEY = 'xhide_last_request_at';
const RATE_STATE_KEY = 'xhide_rate_state';
const QUERY_REVISION_KEY = 'xhide_query_revision';
const LOOKUP_HEALTH_KEY = 'xhide_lookup_health';
const QUERY_REVISION = 3;

// This endpoint is private and authenticated as the signed-in X user. Keep a
// small global gap and adapt to the rate-limit headers X actually returns.
const PACING_POLICY_VERSION = 7;
const DEFAULT_REQUEST_INTERVAL_MS = 60 * 1000;
const MIN_REQUEST_INTERVAL_MS = 30 * 1000;
const ADAPTIVE_MIN_INTERVAL_MS = 10 * 1000;
const MAX_PENDING_LOOKUPS = 1;
const MAX_CACHE_BATCH_HANDLES = 100;
const QUEUE_RETRY_MS = 10 * 1000;
const DEFAULT_RATE_LIMIT_MS = 60 * 1000;
const AUTH_FAILURE_COOLDOWN_MS = 10 * 60 * 1000;
const SERVER_FAILURE_COOLDOWN_MS = 2 * 60 * 1000;
const RATE_RESET_BUFFER_MS = 10 * 1000;
const RATE_RESERVE_MIN = 2;
const RATE_RESERVE_RATIO = 0.1;
const RATE_SPACING_BUFFER = 1.25;
const RATE_LIMIT_BACKOFF_BASE_MS = 60 * 1000;
const RATE_LIMIT_BACKOFF_MAX_MS = 15 * 60 * 1000;
// 429s separated by more than this are independent events, not one streak.
const RATE_LIMIT_STREAK_WINDOW_MS = 2 * RATE_LIMIT_BACKOFF_MAX_MS;
// X windows are 15 minutes; a cooldown or reset beyond these bounds means a
// corrupt input (bad header, wrong clock), not a real limit.
const MAX_COOLDOWN_MS = 60 * 60 * 1000;
const MAX_RESET_HORIZON_MS = 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_SERVICE_WORKER_WAIT_MS = 1000;
const MAX_QUEUED_JOB_AGE_MS = 45 * 1000;
const REQUEST_TIMEOUT_MS = 12 * 1000;

let settings = { enabled: true, blockedCountries: [] };
// A popup settings write can land while loadState's snapshot read is still in
// flight; the change event must win over the stale snapshot.
let settingsChangedWhileLoading = false;
let cache = new Map();
let hiddenCount = 0;
let rateLimitUntil = 0;
let lastRequestAt = 0;
let lookupHealth = {
  status: 'idle',
  lastSuccessAt: 0,
  lastFailureAt: 0,
  lastHttpStatus: null,
  retryAt: 0,
  error: null,
};
let rateState = {
  policyVersion: PACING_POLICY_VERSION,
  limit: null,
  remaining: null,
  resetAt: 0,
  intervalMs: DEFAULT_REQUEST_INTERVAL_MS,
  reserve: null,
  headersObservedAt: 0,
  lastResponseAt: 0,
  lastStatus: null,
  clockOffsetMs: 0,
  responseLatencyMs: null,
  consecutiveRateLimits: 0,
  lastRateLimitAt: 0,
};

let queue = [];
let pending = new Map();
let currentJob = null;
let currentAbortController = null;
let processing = false;
let hiddenCountWrite = Promise.resolve();
let settingsWrite = Promise.resolve();

const stateReady = loadState();

function cacheStorageKey(handleKey) {
  return `${CACHE_PREFIX}${handleKey}`;
}

function normalizeHandle(handle) {
  const value = String(handle || '').trim().toLowerCase();
  return /^\w{1,15}$/.test(value) ? value : null;
}

function getFreshCacheEntry(handleKey) {
  const entry = cache.get(handleKey);
  if (!entry) return null;
  if (isCacheEntryFresh(entry)) return entry;
  cache.delete(handleKey);
  void chrome.storage.local.remove(cacheStorageKey(handleKey)).catch(() => {});
  return null;
}

function pruneExpiredCacheEntries() {
  const expiredStorageKeys = [];
  for (const [handleKey, entry] of cache.entries()) {
    if (isCacheEntryFresh(entry)) continue;
    cache.delete(handleKey);
    expiredStorageKeys.push(cacheStorageKey(handleKey));
  }
  if (expiredStorageKeys.length) {
    void chrome.storage.local.remove(expiredStorageKeys).catch(() => {});
  }
}

function evictOldestCacheEntries() {
  if (cache.size <= MAX_CACHE_ENTRIES) return [];
  const overflow = cache.size - MAX_CACHE_ENTRIES;
  const oldestFirst = [...cache.entries()].sort(
    (first, second) => first[1].ts - second[1].ts,
  );
  const evictedStorageKeys = [];
  for (let index = 0; index < overflow; index += 1) {
    const handleKey = oldestFirst[index][0];
    cache.delete(handleKey);
    evictedStorageKeys.push(cacheStorageKey(handleKey));
  }
  return evictedStorageKeys;
}

async function storeCacheEntry(handleKey, entry) {
  cache.set(handleKey, entry);
  const evictedStorageKeys = evictOldestCacheEntries();
  await chrome.storage.local
    .set({ [cacheStorageKey(handleKey)]: entry })
    .catch(() => {});
  if (evictedStorageKeys.length) {
    await chrome.storage.local.remove(evictedStorageKeys).catch(() => {});
  }
}

async function clearLocationCache() {
  const storageKeys = [...cache.keys()].map(cacheStorageKey);
  cache.clear();
  if (storageKeys.length) await chrome.storage.local.remove(storageKeys);
}

function hasActiveFilter() {
  return Boolean(
    settings.enabled &&
      Array.isArray(settings.blockedCountries) &&
      settings.blockedCountries.some((country) => String(country).trim()),
  );
}

function nullableNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeLookupHealth(value) {
  const allowedStatuses = new Set([
    'idle',
    'ok',
    'cooldown',
    'auth_error',
    'service_error',
    'api_error',
  ]);
  const status = allowedStatuses.has(value?.status) ? value.status : 'idle';
  return {
    status,
    lastSuccessAt: Math.max(0, nullableNumber(value?.lastSuccessAt) || 0),
    lastFailureAt: Math.max(0, nullableNumber(value?.lastFailureAt) || 0),
    lastHttpStatus: nullableNumber(value?.lastHttpStatus),
    retryAt: Math.max(0, nullableNumber(value?.retryAt) || 0),
    error: typeof value?.error === 'string' ? value.error.slice(0, 120) : null,
  };
}

async function setLookupHealth(patch) {
  lookupHealth = normalizeLookupHealth({ ...lookupHealth, ...patch });
  try {
    await chrome.storage.local.set({ [LOOKUP_HEALTH_KEY]: lookupHealth });
  } catch (_) {
    // The in-memory value still lets the popup report this worker's state.
  }
}

async function recordLookupSuccess(pauseUntil = 0) {
  const retryAt = Number(pauseUntil) > Date.now() ? Number(pauseUntil) : 0;
  await setLookupHealth({
    status: retryAt ? 'cooldown' : 'ok',
    lastSuccessAt: Date.now(),
    lastHttpStatus: 200,
    retryAt,
    error: null,
  });
}

async function recordLookupFailure(result) {
  await setLookupHealth({
    status: result.healthStatus || 'service_error',
    lastFailureAt: Date.now(),
    lastHttpStatus: nullableNumber(result.httpStatus),
    retryAt: Math.max(0, nullableNumber(result.retryAt) || 0),
    error: typeof result.reason === 'string' ? result.reason : 'lookup_failed',
  });
}

function lookupHealthSnapshot() {
  if (
    lookupHealth.status === 'cooldown' &&
    lookupHealth.retryAt > 0 &&
    lookupHealth.retryAt <= Date.now()
  ) {
    return {
      ...lookupHealth,
      status: lookupHealth.lastSuccessAt ? 'ok' : 'idle',
      retryAt: 0,
    };
  }
  return { ...lookupHealth };
}

// The 30-second floor is for flying blind. Fresh headers with budget well
// clear of the reserve justify the shorter gap X's own numbers allow.
function minRequestIntervalMs(state = rateState) {
  const trustedBudget =
    state.resetAt > Date.now() &&
    state.headersObservedAt > 0 &&
    state.remaining != null &&
    state.reserve != null &&
    state.remaining - state.reserve >= RATE_RESERVE_MIN;
  return trustedBudget ? ADAPTIVE_MIN_INTERVAL_MS : MIN_REQUEST_INTERVAL_MS;
}

// A window rollover restores the full budget. Presume a fresh window at the
// last known limit instead of forgetting the learned pace.
function presumedFreshWindowIntervalMs() {
  if (rateState.limit == null) return DEFAULT_REQUEST_INTERVAL_MS;
  const reserve = Math.max(
    RATE_RESERVE_MIN,
    Math.ceil(rateState.limit * RATE_RESERVE_RATIO),
  );
  return Math.max(
    MIN_REQUEST_INTERVAL_MS,
    Math.ceil((RATE_WINDOW_MS / Math.max(1, rateState.limit - reserve)) * RATE_SPACING_BUFFER),
  );
}

function normalizeRateState(value) {
  if (!value || typeof value !== 'object') return rateState;
  const now = Date.now();
  const lastResponseAt = nullableNumber(value.lastResponseAt) || 0;
  const lastStatus = nullableNumber(value.lastStatus);
  const storedRateLimitHits = nullableNumber(value.consecutiveRateLimits);
  let resetAt = nullableNumber(value.resetAt) || 0;
  if (resetAt > now + MAX_RESET_HORIZON_MS) resetAt = 0;
  const normalized = {
    policyVersion: PACING_POLICY_VERSION,
    limit: nullableNumber(value.limit),
    remaining: nullableNumber(value.remaining),
    resetAt,
    intervalMs: Math.min(
      MAX_COOLDOWN_MS,
      Number(value.policyVersion) === PACING_POLICY_VERSION
        ? nullableNumber(value.intervalMs) || DEFAULT_REQUEST_INTERVAL_MS
        : DEFAULT_REQUEST_INTERVAL_MS,
    ),
    reserve: nullableNumber(value.reserve),
    headersObservedAt: nullableNumber(value.headersObservedAt) || 0,
    lastResponseAt,
    lastStatus,
    clockOffsetMs: nullableNumber(value.clockOffsetMs) || 0,
    responseLatencyMs: nullableNumber(value.responseLatencyMs),
    consecutiveRateLimits: Math.max(
      0,
      storedRateLimitHits == null ? (lastStatus === 429 ? 1 : 0) : storedRateLimitHits,
    ),
    lastRateLimitAt:
      nullableNumber(value.lastRateLimitAt) || (lastStatus === 429 ? lastResponseAt : 0),
  };
  normalized.intervalMs = Math.max(minRequestIntervalMs(normalized), normalized.intervalMs);
  return normalized;
}

function rateLimitBackoffMs(hitCount = rateState.consecutiveRateLimits) {
  const exponent = Math.max(0, Math.min(10, Number(hitCount) - 1));
  return Math.min(
    RATE_LIMIT_BACKOFF_MAX_MS,
    RATE_LIMIT_BACKOFF_BASE_MS * 2 ** exponent,
  );
}

async function loadState() {
  try {
    await loadStoredState();
  } catch (error) {
    // Running on the in-memory defaults is safe: no settings means no active
    // filter and no requests. Pace the first post-failure request as if one
    // had just been sent, since any persisted cooldown may have been lost.
    console.warn('xhide: failed to load persisted state', error);
    lastRequestAt = Date.now();
  }
}

async function loadPerAuthorCache(stored, queryRevisionChanged) {
  const invalidatedCacheKeys = [];
  const storedCacheEntries = [];
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(CACHE_PREFIX)) continue;
    const handleKey = normalizeHandle(key.slice(CACHE_PREFIX.length));
    const entry = normalizeCacheEntry(value);
    if (
      !handleKey ||
      !entry ||
      !isCacheEntryFresh(entry) ||
      (queryRevisionChanged && !entry.country)
    ) {
      invalidatedCacheKeys.push(key);
      continue;
    }
    storedCacheEntries.push({ key, handleKey, entry });
  }
  storedCacheEntries.sort((first, second) => second.entry.ts - first.entry.ts);
  const loadedHandles = new Set();
  for (const storedEntry of storedCacheEntries) {
    if (cache.size >= MAX_CACHE_ENTRIES || loadedHandles.has(storedEntry.handleKey)) {
      invalidatedCacheKeys.push(storedEntry.key);
      continue;
    }
    loadedHandles.add(storedEntry.handleKey);
    cache.set(storedEntry.handleKey, storedEntry.entry);
  }
  if (invalidatedCacheKeys.length) {
    await chrome.storage.local.remove(invalidatedCacheKeys);
  }
}

async function migrateLegacyCache(legacyCache) {
  if (!legacyCache || typeof legacyCache !== 'object') return;
  const migrated = {};
  for (const [handle, value] of Object.entries(legacyCache)) {
    const handleKey = normalizeHandle(handle);
    const entry = normalizeCacheEntry(value);
    if (
      !handleKey ||
      !entry ||
      !isCacheEntryFresh(entry) ||
      cache.has(handleKey) ||
      cache.size >= MAX_CACHE_ENTRIES
    ) continue;
    cache.set(handleKey, entry);
    migrated[cacheStorageKey(handleKey)] = entry;
  }
  // Remove the potentially large legacy object before writing replacements so
  // an upgrade from unlimitedStorage can recover under the normal quota.
  await chrome.storage.local.remove(LEGACY_CACHE_KEY);
  if (Object.keys(migrated).length) await chrome.storage.local.set(migrated);
}

async function loadStoredState() {
  const stored = await chrome.storage.local.get(null);
  const previousPolicyVersion = Number(stored[RATE_STATE_KEY]?.policyVersion) || 0;
  const previousQueryRevision = Number(stored[QUERY_REVISION_KEY]) || 0;
  const queryRevisionChanged = previousQueryRevision < QUERY_REVISION;
  if (!settingsChangedWhileLoading) settings = normalizeSettings(stored[SETTINGS_KEY]);
  hiddenCount = Number(stored[HIDDEN_COUNT_KEY]) || 0;
  rateLimitUntil = Number(stored[RATE_LIMIT_UNTIL_KEY]) || 0;
  lastRequestAt = Number(stored[LAST_REQUEST_AT_KEY]) || 0;
  rateState = normalizeRateState(stored[RATE_STATE_KEY]);
  lookupHealth = normalizeLookupHealth(stored[LOOKUP_HEALTH_KEY]);
  if (queryRevisionChanged) lookupHealth = normalizeLookupHealth({ status: 'idle' });
  // Prune first so upgrades from an unlimited cache fall below Chrome's normal
  // quota before any migration attempts to write new state.
  await loadPerAuthorCache(stored, queryRevisionChanged);
  await migrateLegacyCache(stored[LEGACY_CACHE_KEY]);
  // Self-heal: cooldowns only ratchet upward at runtime, so one absurd
  // persisted value would otherwise disable lookups forever.
  if (rateLimitUntil > Date.now() + MAX_COOLDOWN_MS) {
    rateLimitUntil = Date.now() + MAX_COOLDOWN_MS;
    await chrome.storage.local.set({ [RATE_LIMIT_UNTIL_KEY]: rateLimitUntil });
  }
  // A 429 streak that old says nothing about the current windows.
  if (
    rateState.consecutiveRateLimits &&
    rateState.lastRateLimitAt &&
    Date.now() - rateState.lastRateLimitAt > RATE_LIMIT_STREAK_WINDOW_MS
  ) {
    rateState = { ...rateState, consecutiveRateLimits: 0, lastRateLimitAt: 0 };
  }
  // A stale query ID can produce a generic 4xx cooldown. Clear that failure
  // when the endpoint changes, but retain a genuine rate-limit reset from X.
  if (queryRevisionChanged && rateState.lastStatus !== 429) {
    rateLimitUntil = 0;
    rateState = {
      ...rateState,
      consecutiveRateLimits: 0,
      lastRateLimitAt: 0,
    };
    await chrome.storage.local.set({
      [RATE_LIMIT_UNTIL_KEY]: rateLimitUntil,
      [RATE_STATE_KEY]: rateState,
      [LOOKUP_HEALTH_KEY]: lookupHealth,
    });
  }
  // Do not carry longer cooldowns from an older pacing policy into this one.
  // A still-future reset explicitly reported by X stays authoritative for any
  // last status once the safe budget was spent, not only for a 429.
  if (previousPolicyVersion > 0 && previousPolicyVersion < PACING_POLICY_VERSION) {
    const reportedResetAt = rateState.resetAt > Date.now()
      ? rateState.resetAt + RATE_RESET_BUFFER_MS
      : 0;
    const reserveExhausted =
      rateState.remaining != null &&
      rateState.reserve != null &&
      rateState.remaining - rateState.reserve <= 0;
    let migratedCooldownAt;
    if (rateState.lastStatus === 429) {
      migratedCooldownAt = Math.max(
        rateState.lastRateLimitAt + rateLimitBackoffMs(),
        reportedResetAt,
      );
    } else if (rateState.lastStatus >= 500) {
      migratedCooldownAt = rateState.lastResponseAt + SERVER_FAILURE_COOLDOWN_MS;
    } else if (rateState.lastResponseAt) {
      migratedCooldownAt = rateState.lastResponseAt + AUTH_FAILURE_COOLDOWN_MS;
    } else {
      migratedCooldownAt = Date.now() + SERVER_FAILURE_COOLDOWN_MS;
    }
    if (reserveExhausted) {
      migratedCooldownAt = Math.max(migratedCooldownAt, reportedResetAt);
    }
    rateLimitUntil = Math.min(
      rateLimitUntil,
      migratedCooldownAt,
    );
    await chrome.storage.local.set({ [RATE_LIMIT_UNTIL_KEY]: rateLimitUntil });
  }
  // Version 3 imposed a two-hour first-429 fallback. Migrate an active legacy
  // 429 cooldown to the new header-aware exponential schedule.
  if (
    previousPolicyVersion === 3 &&
    rateLimitUntil > Date.now() &&
    rateState.consecutiveRateLimits &&
    rateState.lastRateLimitAt
  ) {
    const migratedRetryAt = Math.max(
      rateState.lastRateLimitAt + rateLimitBackoffMs(),
      rateState.resetAt > Date.now() ? rateState.resetAt + RATE_RESET_BUFFER_MS : 0,
    );
    rateLimitUntil = Math.min(
      rateLimitUntil,
      migratedRetryAt,
    );
    await chrome.storage.local.set({ [RATE_LIMIT_UNTIL_KEY]: rateLimitUntil });
  }
  if (rateState.consecutiveRateLimits && rateState.lastRateLimitAt) {
    rateLimitUntil = Math.max(
      rateLimitUntil,
      rateState.lastRateLimitAt + rateLimitBackoffMs(),
    );
  }
  if (rateState.resetAt && rateState.resetAt <= Date.now()) {
    rateState = {
      ...rateState,
      remaining: null,
      resetAt: 0,
      intervalMs: presumedFreshWindowIntervalMs(),
      reserve: null,
      headersObservedAt: 0,
    };
  }

  if (queryRevisionChanged) {
    await chrome.storage.local.set({
      [QUERY_REVISION_KEY]: QUERY_REVISION,
      [LOOKUP_HEALTH_KEY]: lookupHealth,
    });
  }

}

function safeRespond(sendResponse, payload) {
  try {
    sendResponse(payload);
  } catch (_) {
    // The requesting tab may have navigated or closed while queued.
  }
}

function finishJob(job, payload) {
  if (!job || job.done) return;
  job.done = true;
  pending.delete(job.key);
  for (const waiter of job.waiters) safeRespond(waiter.sendResponse, payload);
}

function stopQueuedWork(payload) {
  const jobs = queue;
  queue = [];
  for (const job of jobs) finishJob(job, payload);

  if (currentJob) finishJob(currentJob, payload);
  // A disable only stops future work. An in-flight request has already spent
  // rate-limit budget, so let it finish and cache its result.
  if (currentAbortController && payload?.status !== 'disabled') {
    currentAbortController.abort();
  }
}

// HTTP-date and x-rate-limit-reset are server-clock times; translate them
// into the local frame the scheduler runs on. Returns null without headers.
function retryAtFromHeaders(headers, clockOffsetMs) {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return Date.now() + Math.max(0, seconds * 1000) + RATE_RESET_BUFFER_MS;
    }
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return date - clockOffsetMs + RATE_RESET_BUFFER_MS;
  }

  const resetSeconds = Number(headers.get('x-rate-limit-reset'));
  if (Number.isFinite(resetSeconds) && resetSeconds > 0) {
    return resetSeconds * 1000 - clockOffsetMs + RATE_RESET_BUFFER_MS;
  }
  return null;
}

async function setCooldown(until) {
  // Cap the ratchet: no runtime path lowers this value later, so one corrupt
  // input must not disable lookups beyond the next worker start.
  rateLimitUntil = Math.max(rateLimitUntil, Math.min(until, Date.now() + MAX_COOLDOWN_MS));
  try {
    await chrome.storage.local.set({ [RATE_LIMIT_UNTIL_KEY]: rateLimitUntil });
  } catch (_) {
    // The in-memory value still enforces the cooldown for this worker.
  }
}

function rateHeaderNumber(headers, name) {
  const raw = headers.get(name);
  if (raw == null || raw === '') return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

function currentRequestIntervalMs() {
  if (rateState.resetAt && rateState.resetAt <= Date.now()) {
    return presumedFreshWindowIntervalMs();
  }
  return Math.max(
    minRequestIntervalMs(),
    Number(rateState.intervalMs) || DEFAULT_REQUEST_INTERVAL_MS,
  );
}

function nextAllowedRequestAt() {
  return Math.max(rateLimitUntil, lastRequestAt + currentRequestIntervalMs());
}

async function recordRateHeaders(headers, status, requestStartedAt) {
  const now = Date.now();
  const priorResetAt = rateState.resetAt;
  const limit = rateHeaderNumber(headers, 'x-rate-limit-limit');
  const remaining = rateHeaderNumber(headers, 'x-rate-limit-remaining');
  const resetSeconds = rateHeaderNumber(headers, 'x-rate-limit-reset');
  const serverDate = Date.parse(headers.get('date') || '');
  const responseLatencyMs = Number.isFinite(requestStartedAt)
    ? Math.max(0, now - requestStartedAt)
    : null;
  const responseMidpoint = responseLatencyMs == null
    ? now
    : requestStartedAt + responseLatencyMs / 2;
  const clockOffsetMs = Number.isFinite(serverDate)
    ? serverDate - responseMidpoint
    : rateState.clockOffsetMs;
  // X reports reset as server epoch seconds. Correcting for observed server
  // clock skew gives the local scheduler an absolute millisecond timestamp.
  // A corrected reset outside plausible bounds is a corrupt input, not data.
  let resetAt = resetSeconds && resetSeconds > 0
    ? resetSeconds * 1000 - clockOffsetMs
    : null;
  if (
    resetAt != null &&
    (resetAt < now - DEFAULT_RATE_LIMIT_MS || resetAt > now + MAX_RESET_HORIZON_MS)
  ) {
    resetAt = null;
  }
  const hasRateHeaders = limit != null || remaining != null || resetAt != null;
  const hitRateLimit = status === 429;
  const successfulResponse = status >= 200 && status < 300;
  // A 429 in a window the pacer already waited out, or long after the last
  // one, is a fresh probe (often the user's own About clicks draining the
  // shared budget), not an escalating pacing failure. The probe reset needs
  // a reset header as evidence of the new window; a header-less 429 must
  // keep escalating or it would retry at the backoff base forever.
  const rateLimitStreakContinues =
    rateState.consecutiveRateLimits > 0 &&
    now - rateState.lastRateLimitAt <= RATE_LIMIT_STREAK_WINDOW_MS &&
    !(resetAt != null && priorResetAt > 0 && now >= priorResetAt);
  const consecutiveRateLimits = hitRateLimit
    ? (rateLimitStreakContinues ? rateState.consecutiveRateLimits + 1 : 1)
    : successfulResponse
      ? 0
      : rateState.consecutiveRateLimits;
  const lastRateLimitAt = hitRateLimit ? now : rateState.lastRateLimitAt;

  let intervalMs = currentRequestIntervalMs();
  let reserve = rateState.reserve;
  let pauseUntil = 0;

  if (remaining != null && resetAt != null && resetAt > now) {
    reserve = Math.max(
      RATE_RESERVE_MIN,
      limit != null ? Math.ceil(limit * RATE_RESERVE_RATIO) : RATE_RESERVE_MIN,
    );
    const safeRequestsLeft = remaining - reserve;
    if (safeRequestsLeft <= 0) {
      pauseUntil = resetAt + RATE_RESET_BUFFER_MS;
      intervalMs = pauseUntil - now;
    } else {
      const floorMs = safeRequestsLeft >= RATE_RESERVE_MIN
        ? ADAPTIVE_MIN_INTERVAL_MS
        : MIN_REQUEST_INTERVAL_MS;
      intervalMs = Math.max(
        floorMs,
        Math.ceil(((resetAt - now) / safeRequestsLeft) * RATE_SPACING_BUFFER),
      );
    }
  }
  intervalMs = Math.min(intervalMs, MAX_COOLDOWN_MS);

  rateState = {
    policyVersion: PACING_POLICY_VERSION,
    limit: hasRateHeaders && limit != null ? limit : rateState.limit,
    remaining: hasRateHeaders && remaining != null ? remaining : rateState.remaining,
    resetAt: hasRateHeaders && resetAt != null ? resetAt : rateState.resetAt,
    intervalMs,
    reserve,
    headersObservedAt: hasRateHeaders ? now : rateState.headersObservedAt,
    lastResponseAt: now,
    lastStatus: status,
    clockOffsetMs,
    responseLatencyMs,
    consecutiveRateLimits,
    lastRateLimitAt,
  };
  try {
    await chrome.storage.local.set({ [RATE_STATE_KEY]: rateState });
  } catch (_) {
    // The in-memory rateState is authoritative for this worker lifetime; a
    // failed write must not turn a successful response into a cooldown.
  }
  return { pauseUntil };
}

async function fetchCountry(handle, csrfToken, signal) {
  const url =
    `https://x.com/i/api/graphql/${QUERY_ID}/AboutAccountQuery?variables=` +
    encodeURIComponent(JSON.stringify({ screenName: handle }));
  const headers = {
    accept: '*/*',
    authorization: `Bearer ${BEARER}`,
    'content-type': 'application/json',
    'x-twitter-active-user': 'yes',
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-client-language': 'en',
  };
  if (csrfToken) headers['x-csrf-token'] = csrfToken;

  try {
    const requestStartedAt = Date.now();
    const response = await fetch(url, {
      headers,
      credentials: 'include',
      signal,
    });
    const pacing = await recordRateHeaders(
      response.headers,
      response.status,
      requestStartedAt,
    );

    if (response.status === 429) {
      // X's own reset is authoritative. The exponential backoff term only
      // outgrows it after repeated 429s inside one window, where the headers
      // themselves proved insufficient; fresh probes carry a streak of one.
      const headerRetryAt = Math.max(
        pacing.pauseUntil,
        retryAtFromHeaders(response.headers, rateState.clockOffsetMs) || 0,
      );
      return {
        status: 'cooldown',
        retryAt: Math.max(headerRetryAt, Date.now() + rateLimitBackoffMs()),
        healthStatus: 'cooldown',
        httpStatus: response.status,
        reason: 'rate_limited',
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        status: 'cooldown',
        retryAt: Date.now() + AUTH_FAILURE_COOLDOWN_MS,
        healthStatus: 'auth_error',
        httpStatus: response.status,
        reason: 'authentication_failed',
      };
    }
    if (response.status >= 500) {
      return {
        status: 'cooldown',
        retryAt: Date.now() + SERVER_FAILURE_COOLDOWN_MS,
        healthStatus: 'service_error',
        httpStatus: response.status,
        reason: 'x_service_error',
      };
    }
    if (!response.ok) {
      return {
        status: 'cooldown',
        retryAt: Date.now() + AUTH_FAILURE_COOLDOWN_MS,
        healthStatus: 'api_error',
        httpStatus: response.status,
        reason: 'x_api_changed',
      };
    }

    let json;
    try {
      json = await response.json();
    } catch (_) {
      return {
        status: 'cooldown',
        retryAt: Date.now() + SERVER_FAILURE_COOLDOWN_MS,
        healthStatus: 'api_error',
        httpStatus: response.status,
        reason: 'invalid_json',
      };
    }

    const parsed = parseAboutAccountResponse(json);
    if (!parsed.ok) {
      return {
        status: 'cooldown',
        retryAt: Date.now() + SERVER_FAILURE_COOLDOWN_MS,
        healthStatus: 'api_error',
        httpStatus: response.status,
        reason: parsed.reason,
      };
    }
    return {
      status: 'ok',
      pauseUntil: pacing.pauseUntil,
      httpStatus: response.status,
      entry: parsed.entry,
    };
  } catch (error) {
    if (error?.name === 'AbortError') return { status: 'aborted' };
    return {
      status: 'cooldown',
      retryAt: Date.now() + SERVER_FAILURE_COOLDOWN_MS,
      healthStatus: 'service_error',
      httpStatus: null,
      reason: 'network_error',
    };
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processQueue() {
  if (processing) return;
  processing = true;

  try {
    while (queue.length) {
      if (!hasActiveFilter()) {
        stopQueuedWork({ status: 'disabled' });
        break;
      }
      if (Date.now() < rateLimitUntil) {
        stopQueuedWork({ status: 'cooldown', retryAt: rateLimitUntil });
        break;
      }

      const requestAt = nextAllowedRequestAt();
      const waitMs = Math.max(0, requestAt - Date.now());
      if (waitMs > MAX_SERVICE_WORKER_WAIT_MS) {
        stopQueuedWork({ status: 'deferred', retryAt: requestAt });
        break;
      }
      if (waitMs) await delay(waitMs);
      if (!hasActiveFilter()) continue;
      if (Date.now() < rateLimitUntil) continue;

      const job = queue.shift();
      if (!job || job.done) continue;
      if (Date.now() - job.createdAt > MAX_QUEUED_JOB_AGE_MS) {
        finishJob(job, { status: 'deferred', retryAt: Date.now() + 1000 });
        continue;
      }
      // Without a csrf token the request is a guaranteed auth failure. Defer
      // until a tab can read the ct0 cookie instead of burning a request and
      // earning a ten-minute cooldown.
      if (!job.csrfToken) {
        const result = {
          status: 'deferred',
          retryAt: Date.now() + QUEUE_RETRY_MS,
          healthStatus: 'auth_error',
          httpStatus: null,
          reason: 'missing_x_session',
        };
        await recordLookupFailure(result);
        finishJob(job, result);
        continue;
      }
      currentJob = job;
      currentAbortController = new AbortController();
      let requestTimedOut = false;
      const requestController = currentAbortController;
      const requestTimeout = setTimeout(() => {
        requestTimedOut = true;
        requestController.abort();
      }, REQUEST_TIMEOUT_MS);
      lastRequestAt = Date.now();

      try {
        await chrome.storage.local
          .set({ [LAST_REQUEST_AT_KEY]: lastRequestAt })
          .catch(() => {});

        let result = await fetchCountry(
          job.handle,
          job.csrfToken,
          requestController.signal,
        );

        if (result.status === 'aborted' && requestTimedOut) {
          result = {
            status: 'deferred',
            retryAt: Math.max(nextAllowedRequestAt(), Date.now() + 1000),
            healthStatus: 'service_error',
            httpStatus: null,
            reason: 'request_timeout',
          };
        }

        if (result.status === 'ok') {
          let effectivePauseUntil = 0;
          if (result.pauseUntil > Date.now()) {
            await setCooldown(result.pauseUntil);
            effectivePauseUntil = rateLimitUntil;
          }
          await storeCacheEntry(job.key, result.entry);
          await recordLookupSuccess(effectivePauseUntil);
          finishJob(job, {
            status: 'ok',
            entry: result.entry,
            source: 'network',
            nextLookupAt: Math.max(nextAllowedRequestAt(), effectivePauseUntil),
          });
          if (effectivePauseUntil > Date.now()) {
            stopQueuedWork({ status: 'cooldown', retryAt: effectivePauseUntil });
          }
        } else if (result.status === 'cooldown') {
          await setCooldown(result.retryAt);
          const boundedResult = { ...result, retryAt: rateLimitUntil };
          await recordLookupFailure(boundedResult);
          finishJob(job, boundedResult);
          stopQueuedWork(boundedResult);
        } else if (result.status === 'deferred') {
          if (result.healthStatus) await recordLookupFailure(result);
          finishJob(job, result);
        } else {
          finishJob(job, { status: 'disabled' });
        }
      } catch (error) {
        console.warn('xhide: lookup failed', error);
        await recordLookupFailure({
          healthStatus: 'service_error',
          httpStatus: null,
          retryAt: Date.now() + QUEUE_RETRY_MS,
          reason: 'internal_error',
        });
      } finally {
        clearTimeout(requestTimeout);
        // Waiters must always get an answer: a job left in the pending map
        // holds the single lookup slot for the rest of the worker lifetime.
        if (!job.done) {
          finishJob(job, {
            status: 'deferred',
            retryAt: Math.max(nextAllowedRequestAt(), Date.now() + QUEUE_RETRY_MS),
          });
        }
        currentJob = null;
        currentAbortController = null;
      }
    }
  } finally {
    currentJob = null;
    currentAbortController = null;
    processing = false;
  }
}

async function handleLookup(message, sender, sendResponse) {
  await stateReady;

  const key = normalizeHandle(message.handle);
  if (!key) {
    safeRespond(sendResponse, { status: 'invalid' });
    return;
  }
  if (!hasActiveFilter()) {
    safeRespond(sendResponse, { status: 'disabled' });
    return;
  }

  const cached = getFreshCacheEntry(key);
  if (cached) {
    safeRespond(sendResponse, { status: 'ok', entry: cached, source: 'cache' });
    return;
  }
  if (Date.now() < rateLimitUntil) {
    if (rateState.lastStatus === 429 && lookupHealth.status !== 'cooldown') {
      await setLookupHealth({
        status: 'cooldown',
        lastFailureAt: rateState.lastResponseAt || Date.now(),
        lastHttpStatus: 429,
        retryAt: rateLimitUntil,
        error: 'rate_limited',
      });
    }
    safeRespond(sendResponse, { status: 'cooldown', retryAt: rateLimitUntil });
    return;
  }

  const existing = pending.get(key);
  const waiter = { sendResponse, tabId: sender.tab?.id };
  if (existing) {
    existing.waiters.push(waiter);
    if (message.csrfToken) existing.csrfToken = message.csrfToken;
    return;
  }

  if (pending.size >= MAX_PENDING_LOOKUPS) {
    // nextAllowedRequestAt() is the honest earliest start for the next
    // request; a flat padding here would recreate a hidden pacing floor.
    safeRespond(sendResponse, {
      status: 'deferred',
      retryAt: Math.max(nextAllowedRequestAt(), Date.now() + 1000),
    });
    return;
  }

  const job = {
    key,
    handle: message.handle,
    csrfToken: message.csrfToken || '',
    waiters: [waiter],
    createdAt: Date.now(),
    done: false,
  };
  pending.set(key, job);
  queue.push(job);
  void processQueue();
}

async function updateSettingsFromMessage(message) {
  await stateReady;
  const previous = settings;
  let next = {
    ...settings,
    blockedCountries: [...settings.blockedCountries],
  };
  let alreadyExists = false;

  if (message.action === 'setEnabled') {
    next.enabled = Boolean(message.enabled);
  } else if (message.action === 'addCountry') {
    const country = String(message.country || '').trim();
    const countryKey = normalizeCountry(country);
    if (!countryKey) throw new Error('invalid_country');
    alreadyExists = next.blockedCountries.some(
      (value) => normalizeCountry(value) === countryKey,
    );
    if (!alreadyExists) next.blockedCountries.push(country);
  } else if (message.action === 'removeCountry') {
    const countryKey = normalizeCountry(message.country);
    if (!countryKey) throw new Error('invalid_country');
    next.blockedCountries = next.blockedCountries.filter(
      (value) => normalizeCountry(value) !== countryKey,
    );
  } else {
    throw new Error('invalid_settings_action');
  }

  next = normalizeSettings(next);
  settings = next;
  try {
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  } catch (error) {
    settings = previous;
    throw error;
  }
  return { settings: next, alreadyExists };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'XHIDE_GET_CACHED_BATCH') {
    void stateReady.then(() => {
      const entries = {};
      const handles = Array.isArray(message.handles)
        ? message.handles.slice(0, MAX_CACHE_BATCH_HANDLES)
        : [];
      for (const handle of handles) {
        const key = normalizeHandle(handle);
        const entry = key ? getFreshCacheEntry(key) : null;
        if (key && entry) entries[key] = entry;
      }
      safeRespond(sendResponse, { entries });
    });
    return true;
  }

  if (message?.type === 'XHIDE_GET_SCHEDULE') {
    void stateReady.then(() => {
      safeRespond(sendResponse, { nextLookupAt: nextAllowedRequestAt() });
    });
    return true;
  }

  if (message?.type === 'XHIDE_LOOKUP') {
    void handleLookup(message, sender, sendResponse);
    return true;
  }

  if (message?.type === 'XHIDE_UPDATE_SETTINGS') {
    const operation = settingsWrite.then(() => updateSettingsFromMessage(message));
    settingsWrite = operation.catch(() => {});
    void operation
      .then((result) => safeRespond(sendResponse, { status: 'ok', ...result }))
      .catch((error) => safeRespond(sendResponse, {
        status: 'error',
        error: typeof error?.message === 'string' ? error.message : 'settings_write_failed',
      }));
    return true;
  }

  if (message?.type === 'XHIDE_GET_STATS') {
    void stateReady.then(() => {
      pruneExpiredCacheEntries();
      safeRespond(sendResponse, {
        hiddenCount,
        cacheSize: cache.size,
        lookupHealth: lookupHealthSnapshot(),
      });
    });
    return true;
  }

  if (message?.type === 'XHIDE_CLEAR_CACHE') {
    void stateReady.then(async () => {
      stopQueuedWork({ status: 'deferred', retryAt: Date.now() + 1000 });
      await clearLocationCache();
      safeRespond(sendResponse, { cacheSize: 0 });
    });
    return true;
  }

  if (message?.type === 'XHIDE_INCREMENT_HIDDEN') {
    void stateReady.then(() => {
      const operation = hiddenCountWrite.then(async () => {
        hiddenCount += 1;
        await chrome.storage.local
          .set({ [HIDDEN_COUNT_KEY]: hiddenCount })
          .catch(() => {});
        safeRespond(sendResponse, { hiddenCount });
      });
      hiddenCountWrite = operation.catch(() => {});
    });
    return true;
  }

  return false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[SETTINGS_KEY]) return;
  settingsChangedWhileLoading = true;
  settings = normalizeSettings(changes[SETTINGS_KEY].newValue);
  if (!hasActiveFilter()) stopQueuedWork({ status: 'disabled' });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const job of pending.values()) {
    job.waiters = job.waiters.filter((waiter) => waiter.tabId !== tabId);
    if (job !== currentJob && job.waiters.length === 0) {
      queue = queue.filter((queuedJob) => queuedJob !== job);
      pending.delete(job.key);
      job.done = true;
    }
  }
});
