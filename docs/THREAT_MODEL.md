# Graft threat model

This document describes the security boundaries of the current Graft intake,
compiler, preview, and exported WebMCP adapter. It is a design and review aid,
not a penetration-test report or a claim that a deployment is secure against
every attacker. See [SECURITY.md](../SECURITY.md) for private disclosure.

## Assets and trust boundaries

Graft protects the serverless function and its network access, the user's
browser and workbench, and the integrity of tool contracts installed on a site
that the user owns. The main inputs crossing trust boundaries are:

1. **A caller-supplied URL:** an unauthenticated request to `api/fetch.ts`
   causes server-side DNS resolution and HTTP requests.
2. **A third-party page:** HTML, CSS, text, and optional JavaScript-rendered
   markup enter the snapshot compiler from an origin Graft does not control.
3. **A proposed tool contract:** data inferred from that snapshot can become
   metadata for an agent-facing WebMCP tool.
4. **An exported adapter:** reviewed contracts and the bundled runtime are
   installed by a separate site owner, inside that site's origin and DOM.

The URL's operator, page author, and any scripts or resources loaded by the
page are untrusted. A tool description or content returned from such a page is
also untrusted, even when its JSON Schema and selector are valid. Site owners
must review exported contracts and any custom mutating handlers they supply.

## Threats, current controls, and residual risk

| Threat | Existing control | Residual risk / deployment action |
| --- | --- | --- |
| SSRF via private or link-local destinations | `api/_net.ts` rejects private, link-local, loopback and selected sensitive hosts; `api/fetch.ts` validates redirect targets and stylesheet requests | DNS may change after validation but before connection. Do not treat DNS preflight as network isolation; restrict outbound network access at the host or network layer |
| DNS rebinding in Chromium | `api/_render.ts` intercepts requests and resolves their hosts through `isHostAllowedForEgress()` | Chromium resolves destinations independently of that check; its DNS answer can differ. Host-verdict caching can extend this gap. See #7 |
| Respect for target-site access policy | The intake checks `robots.txt` and blocks disallowed paths; an unavailable/5xx robots response fails closed | `robots.txt` is not authorization. Graft must not be pointed at authenticated, sensitive, or prohibited resources |
| Oversized responses or runaway fetches | `readCapped()` enforces streamed body-size limits; fetches and Chromium renders have timeouts and redirect bounds | Many small requests or concurrent requests can still exhaust a deployment. Per-caller rate limiting is tracked in #46 |
| Active content in imported HTML | `src/sanitize.ts` removes scripts, unsafe attributes, embedded execution surfaces and active network references before preview and analysis | Sanitizer/parser defects remain possible. Test adversarial HTML and deploy the workbench's production CSP; do not insert raw snapshot HTML directly into the application DOM |
| Prompt injection in page content | Derived tool results and contracts are treated as untrusted, and snapshot-derived tools carry `untrustedContentHint` | This is advisory metadata, not a model-enforced guarantee. Agents and owners must not execute instructions embedded in page text |
| Unsafe write tools or stale selectors | The compiler holds mutating or ambiguous candidates for review; approved read-only recipes use bounded schemas and deterministic target selection, and stale targets fail closed | An owner-supplied write handler is code that runs with the owner's site permissions. Review authorization, confirmation, parameter validation, and side effects independently |
| Confusion about the exported code's provenance | The adapter manifest records source/runtime/contract hashes and the compiler revision | Hashes identify artifacts, not the trustworthiness of the page or the owner's handler. Re-check the actual deployed WebMCP surface after integration |

## Browser rendering is a separate risk boundary

`api/_render.ts` can execute third-party JavaScript in headless Chromium to
resolve a client-rendered page. It disables downloads and nonessential
resource types, intercepts outgoing requests, dismisses dialogs, and imposes
timeouts. It does **not** use Chromium's process sandbox: the serverless
launch arguments include `--no-sandbox`. A browser-engine exploit therefore
has a more serious potential impact than parsing inert HTML, and request
interception does not substitute for an operating-system sandbox.

`GRAFT_RENDER=0` disables the JavaScript-rendering fallback in the fetch
endpoint. It does **not** guarantee that other browser-powered verification
features are disabled. Operators who do not need rendering should disable
that fallback and separately constrain any verification service's browser
execution and egress.

## Export and owner deployment responsibilities

- Treat generated artifacts as a starting point. Inspect tool names,
  descriptions, schemas, selectors, and annotations before installing them.
- Do not auto-promote held write tools. Bind each mutating handler only after
  checking authorization, user consent, and behavior on the owner's live site.
- Ensure the deployed site serves a restrictive Content Security Policy and
  other security headers. `vercel.json` covers Graft's hosted deployment, not
  an arbitrary self-host or exported owner site.
- Verify installed tools on the destination origin and repeat verification
  when the page or adapter changes. A valid manifest does not prove that
  current selectors still bind to the intended controls.
- Keep browser credentials and production secrets out of snapshots, fixtures,
  issue reports, and downloadable adapter artifacts.

## Evidence and review checklist

Existing security-focused tests include `src/intake.test.ts` (egress guards),
`src/robots.test.ts` (access policy), `src/sanitize.test.ts` (HTML isolation),
`src/lib/validation.fuzz.test.ts` (argument bounds), and
`src/security-headers.test.ts` (production response headers). These tests
are regression evidence for the cases they exercise, not a complete security
assessment.

Before changing an intake, rendering, sanitizer, or adapter boundary:

1. Identify the attacker-controlled input and the origin or privilege that
   would be crossed.
2. Add a positive and a negative regression, including redirects and resource
   limits when applicable; avoid tests that contact real third-party hosts.
3. Check that denial is enforced before a network request or side effect.
4. Re-run tests and the build, and verify relevant behavior at the deployed
   origin if headers or native WebMCP registration change.
5. Report a suspected vulnerability through [the private reporting process](../SECURITY.md),
   without publishing exploit details in a public issue.
