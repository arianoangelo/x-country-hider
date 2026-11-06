# Changelog

All notable changes to X Country Hider are documented here.

## 0.11.0 — 2026-11-06

### Added

- Automatic per-post language fallback derived from each selected country.
- Language-match notices that identify the detected post language without claiming it proves the author's country.

### Changed

- Each country entry now shows the most likely language it also matches; broader X region buckets remain location-only.
- Language fallback reads X's rendered language marker locally and can hide a matching post before an account-location request is needed.
- "Also mute on X" acts only on a confirmed account location; a language match hides the post but never mutes the account.
- The README and privacy policy now describe "Also mute on X", including that its mutes stay on the X account until undone there.

### Fixed

- "Also mute on X" no longer counts an account as muted when X refuses the request with a 401 or 403. Muting now pauses for ten minutes after such a refusal, and no mute request is sent without a CSRF token.

## 0.10.0 — 2026-11-06

### Added

- Optional "Also mute on X" toggle to automatically mute accounts whose country matches your blocklist.
- Safe rate-pacing for mute requests directly inside the authenticated browser session.
- Muted accounts counter in the popup.

## 0.9.0 — 2026-08-04

### Added

- Firefox Desktop 140+ support from the same Manifest V3 package used by Chrome.
- Firefox signing metadata and built-in data-transmission consent declarations.
- Automated smoke coverage for both Chrome service-worker and Firefox event-page startup.

### Changed

- Extension API calls now select Firefox's `browser` namespace or Chrome's `chrome` namespace at runtime.
- Installation, privacy, security, and contribution documentation now covers both browsers.

## 0.8.0 — 2026-08-03

### Added

- Visible lookup-health states for X cooldowns, authentication failures, service outages, and incompatible API responses.
- A popup control for clearing cached author locations.
- Country-label normalization and common aliases.
- Extension icons, automated tests, and GitHub Actions verification.
- Privacy, security, installation, development, and contribution documentation.
- GNU General Public License v3.0-only licensing.

### Changed

- Resolved locations now expire after 30 days; unavailable results expire after 24 hours.
- The cache is capped at 5,000 entries and pruned automatically.
- Malformed or partial GraphQL responses are retried instead of being cached as unavailable locations.
- Popup settings changes are serialized to prevent lost updates.
- The extension no longer requests `unlimitedStorage`.

### Fixed

- Cache deletion now updates open X tabs immediately.
- Hidden-post count writes are serialized.
- X session-cookie parsing now tolerates cookie separators without a space.

## 0.7.0

- Previous development release.
