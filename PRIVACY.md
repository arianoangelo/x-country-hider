# Privacy policy

Last updated: November 6, 2026

X Country Hider processes only the information required to filter X posts by the country or region shown in X's About this Account data or by the language marker on rendered post text, and to mute matching accounts if the user turns on **Also mute on X**.

## Information processed

The extension processes:

- The enabled/disabled and **Also mute on X** settings, the user's selected country or region list, and the standard two-letter region code used to derive a country's language fallback.
- The language marker attached by X to rendered post text; it is evaluated locally and is not retained as post history.
- X account handles found in rendered posts. A handle is sent to X for a location lookup only when a country filter is active and the post is hovered or crosses the middle of the viewport. When **Also mute on X** is on, the extension also sends X the handle of each account whose location matches the user's list, in a mute request.
- The country, region, or unavailable result returned by X for those accounts.
- X's `ct0` CSRF cookie while making an authenticated request to X.
- Local operational information: cache timestamps, request pacing and cooldown state, lookup health, the number of posts hidden, and the handles of accounts the extension has muted.

## Network activity

The extension sends an account handle and the active X session credentials directly to an HTTPS endpoint on `x.com` to retrieve About this Account data.

**Also mute on X** is off by default. When the user turns it on, the extension sends the handle of each account whose location matches the user's list, with the active X session credentials, to X's mute endpoint on `x.com`. Muting changes the user's X account. The extension never unmutes an account, so these mutes remain after the option is turned off or the extension is removed, until the user undoes them on X.

Language fallback is performed entirely on the rendered page. It does not send the derived language or post text anywhere and does not trigger an account-location or mute request by itself.

The CSRF cookie is read only when a request is needed. It is passed transiently to the background service worker, is not written to extension storage, and is sent only back to X. The bearer value bundled in the source is an X web-client value, not a user's personal access token.

The extension has no developer-operated backend, analytics, telemetry, advertising, or transfer to unrelated third parties. X receives and processes the direct account-data and mute requests according to X's own terms and privacy practices.

## Local storage and retention

The following data is stored in the browser's extension-local storage on the user's device:

- Settings, until changed or the extension is removed.
- Resolved author locations, for up to 30 days.
- Unavailable author-location results, for up to 24 hours.
- A maximum of 5,000 cached author entries; older entries are removed first.
- Request pacing, lookup-health state, the hidden-post count, and the handles of accounts the extension has muted, until the extension is removed.

Chrome and Firefox clear this extension storage when the extension is uninstalled. The popup's **Clear cache** button removes all cached author locations without changing settings, the hidden-post count, or the muted handles.

## Sharing and human access

The developer does not receive, store, sell, or manually inspect extension data. Data is not used for advertising, profiling, or any purpose unrelated to the filtering and optional muting features.

## Security

All network requests use HTTPS and are restricted to `x.com`. Authentication cookies are neither logged nor persisted by the extension.

## Changes

Material changes to these practices will be documented in this file and in the project changelog before release.
