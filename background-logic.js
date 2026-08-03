(function (global) {
  const CACHE_POSITIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const CACHE_NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;
  const CACHE_FUTURE_SKEW_MS = 5 * 60 * 1000;
  const MAX_CACHE_ENTRIES = 5000;

  function normalizeCacheEntry(value) {
    if (!value || typeof value !== 'object') return null;
    const ts = Number(value.ts);
    if (!Number.isFinite(ts) || ts <= 0) return null;
    return {
      country: typeof value.country === 'string' && value.country.trim()
        ? value.country.trim()
        : null,
      source: typeof value.source === 'string' ? value.source : null,
      ts,
    };
  }

  function cacheTtlMs(entry) {
    return entry?.country ? CACHE_POSITIVE_TTL_MS : CACHE_NEGATIVE_TTL_MS;
  }

  function isCacheEntryFresh(entry, now = Date.now()) {
    const normalized = normalizeCacheEntry(entry);
    if (!normalized || normalized.ts > now + CACHE_FUTURE_SKEW_MS) return false;
    return now - normalized.ts <= cacheTtlMs(normalized);
  }

  function parseAboutAccountResponse(json, now = Date.now()) {
    if (!json || typeof json !== 'object') {
      return { ok: false, reason: 'invalid_json' };
    }

    const errors = Array.isArray(json.errors) ? json.errors : [];
    const accountGone = errors.some(
      (bodyError) => bodyError?.code === 50 || bodyError?.code === 63,
    );
    if (accountGone) {
      return {
        ok: true,
        entry: { country: null, source: 'account_unavailable', ts: now },
      };
    }
    if (errors.length) return { ok: false, reason: 'graphql_error' };

    const result = json?.data?.user_result_by_screen_name?.result;
    if (!result || typeof result !== 'object') {
      return { ok: false, reason: 'missing_user_result' };
    }
    if (!Object.prototype.hasOwnProperty.call(result, 'about_profile')) {
      return { ok: false, reason: 'missing_about_profile' };
    }

    const profile = result.about_profile;
    if (profile !== null && typeof profile !== 'object') {
      return { ok: false, reason: 'invalid_about_profile' };
    }
    if (
      profile?.account_based_in != null &&
      typeof profile.account_based_in !== 'string'
    ) {
      return { ok: false, reason: 'invalid_country' };
    }

    return {
      ok: true,
      entry: {
        country: typeof profile?.account_based_in === 'string' && profile.account_based_in.trim()
          ? profile.account_based_in.trim()
          : null,
        source: typeof profile?.source === 'string' ? profile.source : null,
        ts: now,
      },
    };
  }

  global.XHideBackgroundLogic = Object.freeze({
    CACHE_NEGATIVE_TTL_MS,
    CACHE_POSITIVE_TTL_MS,
    MAX_CACHE_ENTRIES,
    isCacheEntryFresh,
    normalizeCacheEntry,
    parseAboutAccountResponse,
  });
})(globalThis);
