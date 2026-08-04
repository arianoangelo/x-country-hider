# Contributing

Thanks for considering a contribution to X Country Hider.

## Before opening a change

- Search existing issues first.
- Keep the extension's single purpose and `x.com`-only host access intact.
- Do not add analytics, telemetry, remote code, or developer-operated data collection.
- Never include X cookies, session tokens, or private account data in an issue, fixture, commit, or screenshot.

## Development workflow

1. Make a focused change.
2. Add or update tests for pure logic.
3. Run `npm run verify`.
4. Load the repository with Chrome's **Load unpacked** option.
5. Load `manifest.json` with Firefox's **Load Temporary Add-on** option.
6. Manually test the popup and filtering behavior in light and dark modes in both browsers.
7. Update `CHANGELOG.md` for user-visible behavior.

Changes to the private X query, session handling, permissions, retention, or privacy policy require especially careful review.

## Pull requests

Describe the problem, the chosen solution, and the manual test performed. Keep unrelated formatting or refactoring out of the same pull request.

By submitting a contribution, you agree that it may be distributed under the project's GPL-3.0-only license.
