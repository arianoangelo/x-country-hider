# X Country Hider

<p align="center">
  <img src="icons/icon-128.png" width="96" height="96" alt="X Country Hider shield icon">
</p>

X Country Hider is a small Chrome extension that hides posts on [x.com](https://x.com) according to the country or region shown in X's **About this Account** data.

It runs entirely in the browser, has no analytics or developer-operated server, and only contacts X directly when it needs an account location.

> X Country Hider is an independent project and is not affiliated with, endorsed by, or sponsored by X Corp.

## Features

- Filter posts by country or by one of X's broader regional labels.
- Show the resolved account location beside a post before it is filtered.
- Replace a hidden post with an accessible notice and a **Show post** override.
- Share a rate-limited location cache across X tabs.
- Report cooldown, sign-in, service, and API compatibility problems in the popup.
- Clear all cached author locations from the popup at any time.
- Match common country aliases such as Turkey/Türkiye and Czech Republic/Czechia.

## Install from source

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select this repository's root folder.
5. Sign in to X, open the extension popup, and add at least one country or region.

The extension currently targets Chrome and other Chromium browsers that support Manifest V3 and Promise-based extension APIs.

## How it works

The content script observes rendered X posts. When a post is hovered or crosses the middle of the viewport, the background service worker checks the local cache and, if necessary, calls X's own `AboutAccountQuery` endpoint using the active X session.

Requests are deliberately serialized and adapt to X's rate-limit headers. Existing cached matches continue to work during a cooldown or temporary X outage.

Cache policy:

- Resolved locations expire after 30 days.
- Unavailable locations expire after 24 hours.
- At most 5,000 author locations are retained.
- Oldest and expired entries are removed automatically.
- **Clear cache** removes all retained author locations immediately.

## Permissions

| Permission | Why it is needed |
| --- | --- |
| `storage` | Saves settings, cached author locations, the hidden-post count, and request pacing state locally. |
| `https://x.com/*` | Reads rendered posts, obtains the transient X CSRF cookie, and makes direct requests to X's account-data endpoint. |

The extension does not request browsing-history, tabs, cookies, or access to any site other than `x.com`.

See [PRIVACY.md](PRIVACY.md) for the complete data-handling description.

## Known issue

Due to X's rate limits, the extension may take longer to hide some accounts or temporarily fail to hide them.

## Development

There is no build step and no runtime dependency installation.

```sh
npm run verify
```

This checks JavaScript syntax, parses the manifest, and runs the unit tests for cache expiry, API-response validation, settings normalization, and country aliases.

When changing behavior, update the version in both `manifest.json` and `package.json`, add an entry to [CHANGELOG.md](CHANGELOG.md), and manually test against a signed-in X account.

## Security

Please use the repository's private security-reporting feature for vulnerabilities and read [SECURITY.md](SECURITY.md) before submitting a report. Never place X cookies or session tokens in a public issue.

## License

Copyright © 2026 Ariano Ângelo.

X Country Hider is licensed under the [GNU General Public License, version 3 only](LICENSE).
