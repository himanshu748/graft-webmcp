# Graft Product Requirements

**Status:** Hackathon build contract  
**Event:** The WebMCP Challenge  
**Submission deadline:** September 3, 2026 at 1:00 pm PDT  
**Product line:** A governed tool layer for websites that never shipped one.

## 1. Product decision

Graft is a governed DOM-to-WebMCP compiler for owned page snapshots. It compiles a safe static snapshot into explainable tool candidates, lets a human review the contracts, registers the approved tools in the current page and exports the reviewed result as a starting point for owner-shipped integration.

The judged experience compiles any public URL, pasted markup or one of three original fixtures. Graft reads a page once on the server and never re-serves it under its own origin, never runs the target's scripts in your tab, never forwards credentials and does not claim universal website compatibility. See the README for the shipped surface, which is the authority when this document and the code disagree.

## 2. Problem

WebMCP gives a website a structured way to tell an agent what it can do. Existing sites still have to identify useful actions, design schemas, write descriptions, implement handlers and test the result. That migration work is slow even when the page already contains useful semantics in forms, tables and repeated content.

Graft shortens the first pass. It makes the proposed contract visible, editable and testable before an owner commits it to production code.

## 3. Users and jobs

| User | Job | Success signal |
| --- | --- | --- |
| Site owner or frontend engineer | Discover a credible first WebMCP contract from an existing page | Reviews and exports useful candidates without hand-authoring the first draft |
| Technical consultant | Explain migration choices and risks to a client | Can show why each candidate was created, scored or held |
| Challenge judge | Verify a non-trivial WebMCP implementation quickly | Sees a compiled tool registered and invoked within 60 seconds |

## 4. Core experience

1. The user opens Graft, which compiles a live page on load, and can point it at any public URL.
2. Graft creates a sanitized, inert snapshot and displays its source and trust status.
3. The compiler detects semantic patterns and proposes typed tools.
4. High-confidence tools are eligible for registration. Ambiguous tools are held with reasons.
5. The user inspects a candidate, edits safe metadata if needed and publishes it locally.
6. Graft registers eligible tools through WebMCP and shows registration state.
7. A judge or agent invokes a tool. The preview changes where appropriate and the timeline records its arguments and result.
8. The user exports the reviewed contract for owner-side integration.

The memorable beat is repair: a weak candidate is held, the user fixes its contract and the newly published tool becomes callable without changing the fixture source.

### 4.1 Epics and user stories

**Compile a trustworthy first draft**

- As a site owner, I want Graft to derive tools from semantic page structure so that I can start from a concrete contract instead of a blank file.
- Working means the owned fixtures produce stable candidates with schemas, provenance and confidence evidence (AC-01 to AC-03).

**Keep a human in the authoring loop**

- As a frontend engineer, I want uncertain tools held with specific reasons so that unsafe or vague contracts never publish silently.
- Working means I can repair, validate, publish and persist one candidate without injecting behavior (AC-04, AC-07 and AC-10).

**Prove the browser call**

- As a judge, I want to see an approved tool registered and invoked through WebMCP so that Graft is more than a contract mockup.
- Working means native registration, exact call evidence and a visible result succeed in an official judge browser (AC-05, AC-06 and AC-08).

**Carry the work into an owner codebase**

- As a site owner, I want to export the reviewed contract so that my team can replace preview recipes with production handlers and tests.
- Working means the export preserves approved descriptors and annotations without carrying imported executable content (AC-09).

## 5. Owned fixtures

| Fixture | Structures | Expected tools |
| --- | --- | --- |
| **Signal Cabinet** | Search and filter form, repeated products, product details, selected-item form and a local demo-cart output | `search_catalog`, `list_products`, `get_product`, `add_to_demo_cart` |
| **Mossbank Field Guide** | Search form, topic navigation, repeated entries, article sections and glossary details | `search_field_guide`, `list_entries`, `read_entry` |
| **Basin Ledger** | Filter form, semantic table, typed data, dates and notes | `filter_batches`, `list_batches`, `get_batch` |

All fixture names, copy, marks and styling are original. They have no external assets or target scripts.

## 6. P0 requirements

### 6.1 Snapshot safety

- The compiler accepts only the selected owned fixture in the judged path.
- Input is parsed as an inert document before analysis.
- Scripts, inline event handlers, embedded documents, active form destinations and network-capable URLs are removed or neutralized before preview.
- Imported content is treated as untrusted. It may supply bounded labels and visible data, never executable behavior.
- Graft exposes a truthful empty or blocked state if a snapshot cannot be sanitized.

### 6.2 Candidate derivation

- Derive candidates for search or filter forms, repeated records, semantic tables, detail reads and page summary data where relevant.
- Generate a JSON Schema input contract from semantic fields and bounded enums.
- Normalize unique tool names and produce concise descriptions.
- Score every candidate with human-readable evidence.
- Auto-register only high-confidence candidates. Hold ambiguous candidates for review and reject unsafe candidates.
- Never guess a selector at execution time. A missing or ambiguous target returns a stale-contract error.

### 6.3 Review and local repair

- Show the tool name, description, input schema, selector or recipe, safety annotation, status, confidence score and confidence reasons.
- Permit edits only to a tool's name and description. Schema, binding, annotations and executor type remain compiler-owned.
- Require a unique lowercase snake-case name that starts with a letter and stays within 30 characters. Require a description from 20 to 500 characters.
- Re-validate every edit before publication.
- **Save and register** publishes a valid edit, refreshes the current registration set and persists the override.
- Persist reviewed name, description and publication status in a versioned local envelope, then merge them over a fresh derivation for the same fixture.

### 6.4 WebMCP registration and execution

- Prefer `document.modelContext`; use `navigator.modelContext` only as a Chrome 149 compatibility fallback.
- Register only `auto` or `published` tools.
- Attach `readOnlyHint` and `untrustedContentHint` annotations directly to each descriptor.
- Pass an `AbortSignal` to registration and honor the execution callback's `{ signal }` argument.
- Return a plain JSON-serializable value from each execution callback.
- Show a clear browser-support diagnostic when the WebMCP surface is unavailable.
- Keep the exact tool name, arguments, status, duration and returned value visible in the local call timeline.

### 6.5 Controlled mutation

`add_to_demo_cart` is the only mutating P0 tool. It is available only on Signal Cabinet, accepts an allowlisted `product_id` and a quantity from 1 to 3, then changes only the fixture's in-memory demo-cart output.

- No checkout, network request, storage write or third-party state change is allowed.
- The UI must state that the action is a local simulation.
- A visible human confirmation must resolve before the mutation runs.
- Cancellation, timeout, invalid input or an aborted signal leaves state unchanged.

### 6.6 Export

- Export the reviewed tool manifest and owner-facing adapter code needed to reproduce the previewed registration.
- Include provenance, fixture identity, annotations and a generated-at timestamp.
- Await each native registration, report missing owner handlers or failures and roll back any partial registration set before returning a failed report.
- Exclude imported page content, executable imported code, credentials and browser storage.
- Label the export as a migration starting point that requires owner review and integration tests.

### 6.7 Edge behavior

- A search with no matches returns an empty result with the applied query, never a fabricated record.
- A selector that resolves to zero or multiple elements becomes stale and cannot execute.
- Corrupt or version-mismatched local overrides are ignored, leaving the fresh derivation intact.
- Reloading during a pending confirmation cancels the action and preserves empty demo-cart state.
- If the browser API is absent, derivation and review remain inspectable but registration is explicitly unavailable.
- If a fixture cannot produce its expected tools, the UI shows the mismatch and the demo does not proceed.

### 6.8 Experience design

- Present Graft as a premium dark systems tool with a Ruby Kernel palette: near-black foundations, warm-white reading surfaces and signal red reserved for governed action and state.
- Use IBM Plex Sans for editorial hierarchy and IBM Plex Mono for contracts, metrics and machine state. Avoid a generic AI chat layout.
- Make compilation state physically legible: snapshot, derive and register are distinct steps with text labels, not color alone.
- Keep the source preview and tool bench visible together on desktop. On mobile, provide explicit Preview and Tools tabs.
- Use motion only to explain compilation, connection or confirmation state and honor reduced-motion preferences.
- Keep every control keyboard-operable with visible focus. Confirmation must move focus into a real modal and return it safely.
- Use the original generated semantic-topology visual only as a brand metaphor. Keep the real compiler workbench as product proof.
- Use original fixtures and marks. No third-party product imagery enters the judged flow.

## 7. Non-goals

- Arbitrary URL proxying or claims that every site can be compiled
- Circumventing content security policy, bot controls, origin policy or site access rules
- Executing imported JavaScript or forwarding cookies, credentials or authenticated state
- Mutating third-party or production data
- A shared public registry, anonymous publishing or multi-user collaboration
- Automatic production deployment of generated tools
- Declaring WebMCP a final standard or promising support outside tested judge paths

### Next, after P0 is proven

- Pasted or uploaded static HTML with an explicit ownership or permission acknowledgement
- Permissioned URL intake that never forwards browser credentials and refuses unsupported targets
- An owner-site integration kit with handler templates, deployment checks and repository-specific tests

These extend the same source-agnostic compiler. They are roadmap items, not submission features or demo claims.

## 8. Acceptance criteria

| ID | Observable acceptance criterion |
| --- | --- |
| AC-01 | A fresh user can choose a fixture, compile it and reach the tool inspector without an account or setup step. |
| AC-02 | Sanitizer tests prove that scripts, inline handlers, embedded documents and active network destinations cannot execute in preview. |
| AC-03 | Each fixture produces the expected tools in section 5 with stable names, schemas and evidence-backed confidence states. |
| AC-04 | At least one candidate can be held, repaired, published, re-registered and recovered after reload from local persistence. |
| AC-05 | In a supported judge browser, the inspector confirms eligible tools were registered through `modelContext.registerTool()`. |
| AC-06 | A read-only tool call updates the timeline with exact arguments and a JSON-serializable result, while relevant fixture state visibly responds. |
| AC-07 | Every tool derived from snapshot content has `untrustedContentHint: true`; non-mutating tools have `readOnlyHint: true`. |
| AC-08 | `add_to_demo_cart` cannot change state before confirmation and cannot affect anything beyond Signal Cabinet's local demo cart. |
| AC-09 | Export reproduces the reviewed descriptors, schemas and annotations, includes an awaited `registerGraftTools(handlers)` path with rollback and cleanup and contains no imported executable content. |
| AC-10 | Missing WebMCP support, stale selectors, invalid edits and rejected snapshots each produce a specific recovery message. |
| AC-11 | The primary flow is keyboard-operable at 360px and 1440px, has visible focus, meets WCAG AA contrast and respects reduced motion. |
| AC-12 | The public submission includes an accessible live URL, a public repository with a visible OSS license, an English write-up and a public YouTube demo under three minutes with audio. |

## 9. Judging alignment

Stage One is pass or fail on viability, challenge fit and meaningful use of the required API. AC-01, AC-05, AC-06 and AC-12 provide that proof.

| Equal Stage Two criterion | Product evidence | Acceptance IDs |
| --- | --- | --- |
| **WebMCP Leverage** | Runtime contract generation, typed schemas, annotations, lifecycle cancellation, live registration and observable execution | AC-03, AC-05, AC-06, AC-07, AC-08 |
| **Execution** | Coherent first-run flow, deterministic fixtures, honest failures, accessible UI and submission readiness | AC-01, AC-02, AC-10, AC-11, AC-12 |
| **Potential Impact** | A credible owner-side migration workflow that turns page semantics into reviewable and exportable contracts | AC-04, AC-06, AC-09 |
| **Creativity & Ambition** | A compiler and repair bench for the pre-WebMCP web, demonstrated without unsafe third-party proxying | AC-02, AC-03, AC-04, AC-09 |

## 10. Risk triggers

| Trigger | Decision |
| --- | --- |
| Any sanitizer bypass executes content or reaches the network | Disable custom snapshot intake and ship only the three bundled fixtures until the bypass is fixed and regression-tested. |
| `document.modelContext` is unavailable in both official judge paths 48 hours before recording | Stop feature work, verify current ChatGPT desktop and Chrome flag setup, then record only after native registration is observed. |
| An expected fixture tool has an unstable name, schema or selector across three reloads | Freeze new recipes and fix determinism before UI polish. |
| The mutation can run without confirmation or survives a fixture recompile | Remove it from registration and demo until state isolation passes. |
| Exported code cannot register the same reviewed descriptors in the controlled export harness | Remove adapter download from the filmed path until registration and abort cleanup pass again. |
| The complete demo flow fails any of five consecutive rehearsals | Reduce the filmed path to one primary fixture plus one generality proof. |
| Any third-party mark, asset or unlicensed material appears in the recording | Replace it with owned material before capture. |

## 11. Success and scope guard

The build succeeds when a judge can see one owned page become a small, trustworthy WebMCP surface, repair a contract and execute it in under 60 seconds. Breadth is secondary. No feature is worth weakening deterministic execution, source safety or the truthfulness of the claim.

## 12. Official references

- [WebMCP Challenge overview](https://webmcp.devpost.com/)
- [WebMCP Challenge official rules](https://webmcp.devpost.com/rules)
- [WebMCP draft specification](https://webmachinelearning.github.io/webmcp/)
- [Chrome WebMCP documentation](https://developer.chrome.com/docs/ai/webmcp)
- [Chrome imperative API guide](https://developer.chrome.com/docs/ai/webmcp/imperative-api)
- [Chrome WebMCP tool security](https://developer.chrome.com/docs/ai/webmcp/secure-tools)
- [Chrome WebMCP eval guidance](https://developer.chrome.com/docs/ai/webmcp/evals)
