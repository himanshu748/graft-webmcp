# Security Policy

Graft fetches third-party pages, so security reports are taken seriously.

## Reporting a vulnerability

**Do not put vulnerability details in a public issue, pull request, or discussion.**

1. Open a [GitHub issue](https://github.com/himanshu748/graft-webmcp/issues/new?title=%5BSecurity%5D%20Contact%20request) titled `[Security] Contact request`. Include only that you have a security report and, optionally, the affected component (for example `api/fetch.ts`). No reproduction steps, impact, or exploit details.
2. A maintainer will open a private [draft security advisory](https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/creating-a-repository-security-advisory) and add you as a collaborator.
3. Share reproduction steps, impact, and affected versions privately in that advisory.

If the repository's **Security** tab shows a **Report a vulnerability** button, you may use it instead to report privately in one step.

We aim to respond to contact requests within 7 days.

## Scope
In scope: SSRF or private-address bypasses, robots.txt/sensitive-domain refusal bypasses, credential forwarding, sanitization bypasses, and exported-adapter flaws.

Known residual risks (documented): DNS rebinding, and serverless Chromium running with `--no-sandbox`.

## Supported versions
Only the latest `main` is supported.
