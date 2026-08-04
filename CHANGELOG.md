# Changelog

All notable changes to X Country Hider are documented here.

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
