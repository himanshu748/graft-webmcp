# Security Policy

Graft fetches third-party pages, so security reports are taken seriously.

## Reporting a vulnerability

Open a [GitHub issue](https://github.com/himanshu748/graft-webmcp/issues/new/choose) using the bug report template and prefix the title with `[Security]`.
Avoid posting working exploits or secrets in the issue.
Include reproduction steps, impact, and affected versions. We aim to acknowledge reports within 7 days.

## Scope
In scope: SSRF or private-address bypasses, robots.txt/sensitive-domain refusal bypasses, credential forwarding, sanitization bypasses, and exported-adapter flaws.

Known residual risks (documented): DNS rebinding, and serverless Chromium running with `--no-sandbox`.

## Supported versions
Only the latest `main` is supported.
