# Security policy

## Supported versions

Security fixes are provided for the latest version on the default branch. Older unpacked copies should be updated before a report is investigated.

## Reporting a vulnerability

Use GitHub's **Report a vulnerability** option in the repository's Security tab so the report remains private.

Include:

- The extension and Chrome versions.
- A clear description of the impact.
- Minimal reproduction steps.
- Relevant source locations or sanitized console output.

Do not include X cookies, CSRF values, authorization headers, private messages, or other account data. Do not open a public issue for a vulnerability that could expose user information or authenticated X requests.

You can expect an acknowledgement after the report is reviewed, followed by a decision on severity and remediation. Please allow a reasonable period for a fix before public disclosure.

## Scope notes

The extension intentionally reads X's `ct0` CSRF cookie transiently and sends it only to an HTTPS endpoint on `x.com`. Any path that exposes, persists, logs, or sends that value elsewhere is considered a security bug.

The fixed X web-client bearer string in `background.js` is not a user's personal credential. Reports should focus on unintended access to user-specific authentication or data.
