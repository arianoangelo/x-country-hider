// Watches rendered X posts and asks the extension-wide background service for
// each author's cached "Account based in" country. Hovered posts get first
// priority. Only the background service is allowed to contact X's API.
(function () {
  const { normalizeCountry, normalizeSettings } = XHideShared;
  const SETTINGS_KEY = 'xhide_settings';
  const CACHE_PREFIX = 'xhide_cache_entry:';
  const SCAN_DEBOUNCE_MS = 300;
  const HOVER_DWELL_MS = 300;

  let settings = { enabled: true, blockedCountries: [] };
  let resultCache = new Map();
  let inFlight = new Set();
  let scanScheduled = false;
  let nextLookupAt = 0;
  let retryTimer = null;
  let retryTimerAt = 0;
  let hoveredArticle = null;
  let pendingHoverArticle = null;
  let hoverDwellTimer = null;
  let cacheHydrationInFlight = false;
  const cacheCheckedHandles = new Set();

  const placeholders = new WeakMap();

  function hasActiveFilter() {
    return Boolean(settings.enabled && settings.blockedCountries.length);
  }

  function isBlocked(country) {
    if (!country) return false;
    const countryKey = normalizeCountry(country);
    return settings.blockedCountries.some(
      (blockedCountry) => normalizeCountry(blockedCountry) === countryKey,
    );
  }

  async function loadState() {
    const [stored, schedule] = await Promise.all([
      chrome.storage.local.get([SETTINGS_KEY]),
      chrome.runtime.sendMessage({ type: 'XHIDE_GET_SCHEDULE' }).catch(() => null),
    ]);
    settings = normalizeSettings(stored[SETTINGS_KEY]);
    const scheduledAt = Number(schedule?.nextLookupAt);
    if (Number.isFinite(scheduledAt) && scheduledAt > Date.now()) {
      nextLookupAt = scheduledAt;
    }
  }

  function ensureNoticeStyles() {
    if (document.getElementById('xhide-notice-styles')) return;
    const style = document.createElement('style');
    style.id = 'xhide-notice-styles';
    style.textContent = `
      .xhide-notice {
        --xh-accent: #1d9bf0;
        --xh-accent-soft: rgba(29, 155, 240, 0.10);
        --xh-bg: #ffffff;
        --xh-card: #f7f9f9;
        --xh-text: #0f1419;
        --xh-muted: #536471;
        --xh-border: #cfd9de;
        box-sizing: border-box;
        width: 100%;
        padding: 12px 16px;
        border-bottom: 1px solid var(--xh-border);
        background: var(--xh-bg);
        color: var(--xh-text);
        font-family: Arial, Helvetica, sans-serif;
      }
      .xhide-notice[data-xhide-theme="dark"] {
        --xh-accent-soft: rgba(29, 155, 240, 0.14);
        --xh-muted: #8b98a5;
      }
      .xhide-notice__card {
        display: flex;
        align-items: center;
        gap: 12px;
        box-sizing: border-box;
        min-height: 74px;
        padding: 13px 14px;
        border: 1px solid var(--xh-border);
        border-radius: 16px;
        background: linear-gradient(135deg, var(--xh-accent-soft), transparent 58%), var(--xh-card);
      }
      .xhide-notice__icon {
        display: grid;
        place-items: center;
        flex: 0 0 38px;
        width: 38px;
        height: 38px;
        border-radius: 50%;
        background: var(--xh-accent-soft);
        color: var(--xh-accent);
      }
      .xhide-notice__icon svg { width: 20px; height: 20px; }
      .xhide-notice__copy { flex: 1; min-width: 0; }
      .xhide-notice__title {
        margin: 0 0 3px;
        color: var(--xh-text);
        font-size: 14px;
        font-weight: 700;
        line-height: 18px;
      }
      .xhide-notice__detail {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px;
        margin: 0;
        color: var(--xh-muted);
        font-size: 13px;
        line-height: 17px;
      }
      .xhide-notice__country {
        display: inline-flex;
        align-items: center;
        max-width: 180px;
        padding: 1px 7px;
        overflow: hidden;
        border-radius: 999px;
        background: var(--xh-accent-soft);
        color: var(--xh-accent);
        font-size: 12px;
        font-weight: 700;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .xhide-notice__action {
        flex: 0 0 auto;
        min-height: 34px;
        padding: 0 14px;
        border: 1px solid var(--xh-border);
        border-radius: 999px;
        background: transparent;
        color: var(--xh-text);
        cursor: pointer;
        font: inherit;
        font-size: 13px;
        font-weight: 700;
        transition: background-color 120ms ease, border-color 120ms ease;
      }
      .xhide-notice__action:hover {
        border-color: var(--xh-muted);
        background: var(--xh-accent-soft);
      }
      .xhide-notice__action:focus-visible {
        outline: 2px solid var(--xh-accent);
        outline-offset: 2px;
      }
      .xhide-location-badge {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        min-width: 0;
        margin-left: 4px;
        color: inherit;
        font-family: Arial, Helvetica, sans-serif;
        font-size: 13px;
        font-weight: 400;
        line-height: 20px;
        opacity: 0.78;
        white-space: nowrap;
      }
      .xhide-location-badge::before {
        content: "·";
        margin-right: 1px;
      }
      .xhide-location-badge svg {
        flex: 0 0 auto;
        width: 12px;
        height: 12px;
      }
      .xhide-location-badge__text {
        max-width: 150px;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .xhide-location-badge[data-xhide-location-state="unavailable"] {
        opacity: 0.6;
      }
      @media (max-width: 460px) {
        .xhide-notice__card { align-items: flex-start; flex-wrap: wrap; }
        .xhide-notice__copy { min-width: calc(100% - 50px); }
        .xhide-notice__action { margin-left: 50px; }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function parseCssColor(value) {
    const channels = value?.match(/[\d.]+/g)?.map(Number);
    if (!channels || channels.length < 3) return null;
    const alpha = channels.length > 3 ? channels[3] : 1;
    if (!Number.isFinite(alpha) || alpha <= 0) return null;
    return { r: channels[0], g: channels[1], b: channels[2] };
  }

  function cssColor({ r, g, b }) {
    return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
  }

  function mixColor(base, overlay, amount) {
    return {
      r: base.r + (overlay.r - base.r) * amount,
      g: base.g + (overlay.g - base.g) * amount,
      b: base.b + (overlay.b - base.b) * amount,
    };
  }

  function relativeLuminance({ r, g, b }) {
    const channels = [r, g, b].map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  }

  function contrastRatio(first, second) {
    const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
    const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
    return (lighter + 0.05) / (darker + 0.05);
  }

  function nearestOpaqueBackground(element) {
    let current = element;
    while (current) {
      const background = parseCssColor(getComputedStyle(current).backgroundColor);
      if (background) return background;
      current = current.parentElement;
    }
    return matchMedia('(prefers-color-scheme: dark)').matches
      ? { r: 0, g: 0, b: 0 }
      : { r: 255, g: 255, b: 255 };
  }

  function xPalette(article) {
    const articleStyles = getComputedStyle(article);
    const background = nearestOpaqueBackground(article);
    const luminance = background.r * 0.2126 + background.g * 0.7152 + background.b * 0.0722;
    const dark = luminance < 128;
    const fallbackText = dark ? { r: 231, g: 233, b: 234 } : { r: 15, g: 20, b: 25 };
    const computedText = parseCssColor(articleStyles.color);
    const text = computedText && contrastRatio(computedText, background) >= 4.5
      ? computedText
      : fallbackText;

    return {
      theme: dark ? 'dark' : 'light',
      background: cssColor(background),
      card: cssColor(mixColor(background, text, dark ? 0.055 : 0.025)),
      text: cssColor(text),
      muted: cssColor(mixColor(background, text, dark ? 0.62 : 0.58)),
      border: cssColor(mixColor(background, text, dark ? 0.2 : 0.15)),
    };
  }

  function applyXPalette(element, article) {
    const palette = xPalette(article);
    element.dataset.xhideTheme = palette.theme;
    element.style.setProperty('--xh-bg', palette.background);
    element.style.setProperty('--xh-card', palette.card);
    element.style.setProperty('--xh-text', palette.text);
    element.style.setProperty('--xh-muted', palette.muted);
    element.style.setProperty('--xh-border', palette.border);
  }

  function refreshNoticePalettes() {
    document.querySelectorAll('article[data-testid="tweet"]').forEach((article) => {
      const placeholder = placeholders.get(article);
      if (placeholder?.isConnected) applyXPalette(placeholder, article);
    });
  }

  function getCt0() {
    const match = document.cookie.split(/;\s*/).find((cookie) => cookie.startsWith('ct0='));
    if (!match) return null;
    const token = match.slice(4);
    try {
      return decodeURIComponent(token);
    } catch (_) {
      return token;
    }
  }

  function extractHandleFromArticle(article) {
    const nameBlock = article.querySelector('[data-testid="User-Name"]');
    const scope = nameBlock || article;
    const links = scope.querySelectorAll('a[href^="/"]');
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const match = href.match(/^\/(\w{1,15})$/);
      if (match) return match[1];
    }
    return null;
  }

  function revealArticle(article) {
    article.style.display = '';
    article.dataset.xhideHidden = '0';
    const placeholder = placeholders.get(article);
    if (placeholder) placeholder.remove();
    placeholders.delete(article);
  }

  function removeLocationBadge(article) {
    article.querySelector('.xhide-location-badge')?.remove();
  }

  function resetArticlesForHandle(key) {
    document.querySelectorAll('article[data-testid="tweet"]').forEach((article) => {
      if (article.dataset.xhideHandleKey !== key) return;
      article.dataset.xhideSeen = '0';
    });
  }

  function evictCachedHandle(key) {
    resultCache.delete(key);
    cacheCheckedHandles.delete(key);
    document.querySelectorAll('article[data-testid="tweet"]').forEach((article) => {
      if (article.dataset.xhideHandleKey !== key) return;
      if (article.dataset.xhideHidden === '1') revealArticle(article);
      removeLocationBadge(article);
      article.dataset.xhideSeen = '0';
    });
    scheduleScan();
  }

  async function hydrateCachedHandles(handles) {
    const unchecked = [...new Set(handles)]
      .filter((handle) => handle && !cacheCheckedHandles.has(handle))
      .slice(0, 100);
    if (!unchecked.length || cacheHydrationInFlight) return;

    cacheHydrationInFlight = true;
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'XHIDE_GET_CACHED_BATCH',
        handles: unchecked,
      });
      for (const key of unchecked) cacheCheckedHandles.add(key);
      for (const [key, entry] of Object.entries(response?.entries || {})) {
        if (entry && typeof entry === 'object') resultCache.set(key, entry);
      }
    } catch (_) {
      // A reload can invalidate the message channel; leave these handles
      // unchecked so the next scan can ask again without making API calls.
    } finally {
      cacheHydrationInFlight = false;
      scheduleScan();
    }
  }

  function ensureLocationBadge(article) {
    const nameBlock = article.querySelector('[data-testid="User-Name"]');
    if (!nameBlock) return null;

    let badge = nameBlock.querySelector('.xhide-location-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'xhide-location-badge';
      badge.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10' +
        'c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg>';
      const text = document.createElement('span');
      text.className = 'xhide-location-badge__text';
      badge.appendChild(text);

      const timestampLink = nameBlock.querySelector('time')?.closest('a');
      if (timestampLink) timestampLink.insertAdjacentElement('afterend', badge);
      else nameBlock.appendChild(badge);
    }

    return badge;
  }

  function showLocationBadge(article, country) {
    if (!hasActiveFilter()) {
      removeLocationBadge(article);
      return;
    }

    const badge = ensureLocationBadge(article);
    if (!badge) return;

    if (!country) {
      badge.dataset.xhideLocationState = 'unavailable';
      badge.title = 'Account location unavailable';
      badge.setAttribute('aria-label', 'Account location unavailable');
      badge.querySelector('.xhide-location-badge__text').textContent = 'Location unavailable';
      return;
    }

    badge.dataset.xhideLocationState = 'resolved';
    badge.title = `Account based in ${country}`;
    badge.setAttribute('aria-label', `Account based in ${country}`);
    badge.querySelector('.xhide-location-badge__text').textContent = country;
  }

  function hideArticle(article, country) {
    if (article.dataset.xhideHidden === '1') return;
    article.dataset.xhideHidden = '1';

    const placeholder = document.createElement('div');
    placeholder.className = 'xhide-placeholder';
    placeholder.classList.add('xhide-notice');
    applyXPalette(placeholder, article);
    placeholder.setAttribute('role', 'status');
    placeholder.setAttribute(
      'aria-label',
      `X Country Hider hid a post from an account based in ${country}`,
    );

    const card = document.createElement('div');
    card.className = 'xhide-notice__card';

    const icon = document.createElement('div');
    icon.className = 'xhide-notice__icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7' +
      'c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></svg>';

    const copy = document.createElement('div');
    copy.className = 'xhide-notice__copy';

    const title = document.createElement('p');
    title.className = 'xhide-notice__title';
    title.textContent = 'X Country Hider hid this post';

    const detail = document.createElement('p');
    detail.className = 'xhide-notice__detail';
    const handle = article.dataset.xhideHandle || article.dataset.xhideHandleKey || 'This account';
    const account = document.createElement('span');
    account.textContent = handle === 'This account' ? handle : `@${handle}`;
    const explanation = document.createElement('span');
    explanation.textContent = 'is based in';
    const countryBadge = document.createElement('span');
    countryBadge.className = 'xhide-notice__country';
    countryBadge.textContent = country;
    detail.append(account, explanation, countryBadge);
    copy.append(title, detail);

    const showButton = document.createElement('button');
    showButton.className = 'xhide-notice__action';
    showButton.type = 'button';
    showButton.textContent = 'Show post';
    showButton.setAttribute('aria-label', `Show post from ${account.textContent}`);
    showButton.addEventListener('click', () => revealArticle(article));
    card.append(icon, copy, showButton);
    placeholder.appendChild(card);

    // Keep the notice inside X's virtualized timeline cell. Inserting it next
    // to cellInnerDiv makes X leave the notice behind at the top while the
    // actual feed cell is recycled during scrolling.
    article.insertAdjacentElement('beforebegin', placeholder);
    placeholders.set(article, placeholder);
    article.style.display = 'none';
    requestAnimationFrame(() => {
      if (placeholder.isConnected) applyXPalette(placeholder, article);
    });
    void chrome.runtime.sendMessage({ type: 'XHIDE_INCREMENT_HIDDEN' }).catch(() => {});
  }

  function applyToHandle(key) {
    const entry = resultCache.get(key);
    document.querySelectorAll('article[data-testid="tweet"]').forEach((article) => {
      if (article.dataset.xhideHandleKey !== key) return;
      if (entry) showLocationBadge(article, entry.country);
      if (entry && isBlocked(entry.country)) hideArticle(article, entry.country);
      else if (article.dataset.xhideHidden === '1') revealArticle(article);
    });
  }

  function reconcileVisibleArticles() {
    document.querySelectorAll('article[data-testid="tweet"]').forEach((article) => {
      const key = article.dataset.xhideHandleKey;
      const entry = key ? resultCache.get(key) : null;
      if (hasActiveFilter() && entry) showLocationBadge(article, entry.country);
      else removeLocationBadge(article);
      if (entry && isBlocked(entry.country)) hideArticle(article, entry.country);
      else if (article.dataset.xhideHidden === '1') revealArticle(article);
    });
  }

  function resetUncachedArticles() {
    document.querySelectorAll('article[data-testid="tweet"]').forEach((article) => {
      const key = article.dataset.xhideHandleKey;
      if (!key || !resultCache.has(key)) article.dataset.xhideSeen = '0';
    });
  }

  function refreshResolvedLocations() {
    document.querySelectorAll('article[data-testid="tweet"]').forEach((article) => {
      const key = article.dataset.xhideHandleKey;
      const entry = key ? resultCache.get(key) : null;
      if (entry) showLocationBadge(article, entry.country);
    });
  }

  function isCenteredArticle(article) {
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    if (!viewportHeight) return false;
    const rect = article.getBoundingClientRect();
    const center = viewportHeight / 2;
    return rect.top <= center && rect.bottom >= center;
  }

  function scheduleRetry(retryAt) {
    const now = Date.now();
    const suppliedRetryAt = Number(retryAt);
    // Preserve the background scheduler's absolute millisecond timestamp.
    // Only use a one-second fallback when no valid future time was supplied.
    const requestedAt = Number.isFinite(suppliedRetryAt) && suppliedRetryAt > now
      ? Math.ceil(suppliedRetryAt)
      : now + 1000;
    nextLookupAt = Math.max(nextLookupAt, requestedAt);

    if (retryTimer && retryTimerAt >= nextLookupAt) return;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimerAt = nextLookupAt;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      retryTimerAt = 0;
      nextLookupAt = 0;
      resetUncachedArticles();
      scan();
    }, Math.max(0, nextLookupAt - Date.now()));
  }

  function topLevelArticleFromTarget(target) {
    let article = target?.closest?.('article[data-testid="tweet"]') || null;
    let parentArticle = article?.parentElement?.closest('article[data-testid="tweet"]') || null;
    while (parentArticle) {
      article = parentArticle;
      parentArticle = article.parentElement?.closest('article[data-testid="tweet"]') || null;
    }
    return article;
  }

  function handleArticlePointerOver(event) {
    // Touch contact is not a hover intent and should not spend a lookup.
    if (event.pointerType === 'touch') return;
    const article = topLevelArticleFromTarget(event.target);
    if (!article || article === hoveredArticle || article === pendingHoverArticle) return;

    // A pointer merely crossing the timeline is not intent either. Require a
    // short dwell before a hover may claim the scarce network lookup slot.
    // Cache hydration and background pacing still guard the actual X request.
    pendingHoverArticle = article;
    clearTimeout(hoverDwellTimer);
    hoverDwellTimer = setTimeout(() => {
      hoverDwellTimer = null;
      pendingHoverArticle = null;
      if (!article.isConnected) return;
      hoveredArticle = article;
      scan();
    }, HOVER_DWELL_MS);
  }

  function handleArticlePointerOut(event) {
    const article = topLevelArticleFromTarget(event.target);
    if (!article) return;
    const enteredArticle = topLevelArticleFromTarget(event.relatedTarget);
    if (enteredArticle === article) return;

    if (article === pendingHoverArticle) {
      clearTimeout(hoverDwellTimer);
      hoverDwellTimer = null;
      pendingHoverArticle = null;
    }
    if (article !== hoveredArticle) return;

    hoveredArticle = null;
    scheduleScan();
  }

  async function requestCountry(handle, key) {
    inFlight.add(key);
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'XHIDE_LOOKUP',
        handle,
        csrfToken: getCt0() || '',
      });

      if (response?.status === 'ok' && response.entry) {
        resultCache.set(key, response.entry);
        applyToHandle(key);
        if (response.source === 'network' && response.nextLookupAt) {
          scheduleRetry(response.nextLookupAt);
        }
      } else {
        resetArticlesForHandle(key);
      }

      if (response?.status === 'cooldown' || response?.status === 'deferred') {
        scheduleRetry(response.retryAt);
      }
    } catch (_) {
      // Extension reloads invalidate pending message channels. A future DOM
      // mutation or page reload will scan these posts again.
      resetArticlesForHandle(key);
    } finally {
      inFlight.delete(key);
      scheduleScan();
    }
  }

  function processArticle(article, isHoveredPost = false) {
    const handle = extractHandleFromArticle(article);
    // X often mounts the article before its author block is complete. Do not
    // mark it as processed until a handle actually exists.
    if (!handle) {
      article.dataset.xhideSeen = '0';
      return null;
    }

    const key = handle.toLowerCase();
    const previousKey = article.dataset.xhideHandleKey;

    // X recycles timeline DOM nodes while scrolling. Reset extension state if
    // an existing article element now represents a different author.
    if (previousKey && previousKey !== key) {
      if (article.dataset.xhideHidden === '1') revealArticle(article);
      removeLocationBadge(article);
      article.dataset.xhideSeen = '0';
    }

    if (article.dataset.xhideSeen === '1' && previousKey === key) return null;
    article.dataset.xhideHandle = handle;
    article.dataset.xhideHandleKey = key;

    const entry = resultCache.get(key);
    if (entry) {
      article.dataset.xhideSeen = '1';
      showLocationBadge(article, entry.country);
      if (isBlocked(entry.country)) hideArticle(article, entry.country);
      return null;
    }

    // Confirm the persistent cache miss in one cheap batch before allowing
    // this author to compete for the single network lookup slot.
    if (!cacheCheckedHandles.has(key)) {
      article.dataset.xhideSeen = '0';
      return null;
    }

    article.dataset.xhideSeen = '0';

    // Network lookups have exactly two intent signals: pointer hover or the
    // post crossing the viewport's horizontal center line.
    if (!isHoveredPost && !isCenteredArticle(article)) {
      article.dataset.xhideSeen = '0';
      return null;
    }

    if (Date.now() < nextLookupAt) {
      article.dataset.xhideSeen = '0';
      scheduleRetry(nextLookupAt);
      return null;
    }
    return {
      article,
      handle,
      key,
      isHoveredPost,
      priority: isHoveredPost ? -1 : 0,
    };
  }

  function scan() {
    if (
      !hasActiveFilter() ||
      document.visibilityState !== 'visible' ||
      !document.hasFocus()
    ) {
      return;
    }
    refreshNoticePalettes();
    const articles = [...document.querySelectorAll('article[data-testid="tweet"]')].filter(
      (article) => !article.parentElement?.closest('article[data-testid="tweet"]'),
    );
    if (hoveredArticle && !articles.includes(hoveredArticle)) hoveredArticle = null;
    const hoveredHandle = hoveredArticle
      ? extractHandleFromArticle(hoveredArticle)?.toLowerCase()
      : null;
    const renderedHandles = [hoveredHandle, ...articles.map(extractHandleFromArticle)]
      .filter(Boolean)
      .map((handle) => handle.toLowerCase());
    if (!cacheHydrationInFlight) void hydrateCachedHandles(renderedHandles);
    const candidates = articles
      .map((article) => processArticle(article, article === hoveredArticle))
      .filter((candidate) => candidate && Number.isFinite(candidate.priority))
      .sort((first, second) => first.priority - second.priority);

    // Hover wins if both signals exist; otherwise there should normally be
    // only one timeline post crossing the center line.
    if (!inFlight.size && candidates.length) {
      const candidate = candidates[0];
      candidate.article.dataset.xhideSeen = '1';
      // Unknown accounts stay visually untouched while the background lookup
      // runs; only a resolved cached country is shown to the user.
      void requestCountry(candidate.handle, candidate.key);
    }
    refreshResolvedLocations();
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    setTimeout(() => {
      scanScheduled = false;
      scan();
    }, SCAN_DEBOUNCE_MS);
  }

  async function init() {
    await loadState();
    ensureNoticeStyles();
    scan();

    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('pointerover', handleArticlePointerOver, { passive: true });
    document.addEventListener('pointerout', handleArticlePointerOut, { passive: true });
    document.addEventListener('scroll', scheduleScan, { capture: true, passive: true });
    window.addEventListener('resize', scheduleScan, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') scheduleScan();
    });
    window.addEventListener('focus', scheduleScan);

    const themeObserver = new MutationObserver(refreshNoticePalettes);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
    themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;

      for (const [storageKey, change] of Object.entries(changes)) {
        if (!storageKey.startsWith(CACHE_PREFIX)) continue;
        const key = storageKey.slice(CACHE_PREFIX.length).toLowerCase();
        if (change.newValue && typeof change.newValue === 'object') {
          cacheCheckedHandles.add(key);
          resultCache.set(key, change.newValue);
          applyToHandle(key);
        } else {
          evictCachedHandle(key);
        }
      }

      if (changes[SETTINGS_KEY]) {
        settings = normalizeSettings(changes[SETTINGS_KEY].newValue);
        reconcileVisibleArticles();
        if (hasActiveFilter()) {
          resetUncachedArticles();
          scan();
        }
      }
    });
  }

  void init();
})();
