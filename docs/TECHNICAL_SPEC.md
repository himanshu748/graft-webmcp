# Graft Technical Specification

## 1. Scope and invariants

Graft is a React, TypeScript and Vite application with serverless intake and verification endpoints. Its core compiler accepts a `Document`-shaped root without depending on a fixture ID, and three intake paths feed it the same way: live URL, pasted markup and bundled fixture.

Shipped since this document was first written, and authoritative in the README:

- `api/fetch.ts` reads a public page server-side with host, robots and size guards, and renders JavaScript-built pages in a headless browser when the server returns a shell.
- `api/verify.ts` opens a deployed site and reports the WebMCP surface it actually registers, including drift against an exported contract.
- A control plane registers Graft's own operations as WebMCP tools under a `graft_` prefix.
- `examples/owner-site` is a deployed integration proving exported contracts work off Graft's origin.

The implementation must preserve five invariants:

1. Snapshot content is inert and untrusted.
2. Derived text can label a contract but cannot define executable behavior.
3. Only `auto` and locally `published` tools reach WebMCP registration.
4. Read-only execution is the default. The sole mutation is a bounded local demo-cart action.
5. Every registration, execution, edit and failure is inspectable in the product UI.

## 2. System shape

```text
public URL, pasted HTML or owned fixture
      |
      v
guarded intake -> inert parse -> sanitize -> normalized snapshot
                              |
                              v
                    semantic recipe compiler
                              |
                 candidate tools + evidence
                              |
               local review and override merge
                              |
        auto/published gate -> WebMCP registry
                  |                    |
                  v                    v
           preview executor       call timeline
                  |
                  v
          reviewed manifest/export
```

The server surface is deliberately narrow: `/api/fetch` performs guarded public-page intake and `/api/verify` reads a deployed page's registered WebMCP surface. There is no remote registry, credential bridge or third-party write path. The server stores no target content and forwards no browser credentials.

## 3. Runtime modules

| Responsibility | Contract |
| --- | --- |
| Intake | Load a live URL, pasted markup or an owned fixture, and produce a sanitized, inert `Document`. |
| Snapshot sanitizer | Remove active content and return sanitized DOM plus a report of removed features. |
| Deriver | Detect supported semantic patterns and emit deterministic candidates. |
| Confidence gate | Attach a score, reasons and `auto`, `held` or `rejected` status. |
| Local override store | Persist reviewed fields by fixture and candidate identity, then merge them over fresh derivation. |
| Registration lifecycle | `start`, `refresh` and `stop` registration for only `auto` or `published` candidates. |
| Recipe executor | Resolve the candidate target, validate input, execute an allowlisted behavior and return serializable data. |
| Timeline | Record registration and tool-call events without logging secrets or raw imported markup. |
| Exporter | Generate a reviewed manifest and owner-facing adapter from validated candidates. |

The compiler and lifecycle entry point lives at `src/lib/index.ts`. UI code consumes its public types and events rather than reaching into recipe internals.

### 3.1 PRD traceability

| PRD requirement | Owning component | Primary verification |
| --- | --- | --- |
| 6.1 Snapshot safety | Fixture intake and snapshot sanitizer | Sanitizer regression suite plus trust report |
| 6.2 Candidate derivation | Deriver and confidence gate | Fixture-to-contract snapshots |
| 6.3 Local repair | Override store and inspector | Edit, reload and merge test |
| 6.4 Registration | WebMCP lifecycle and timeline | Native browser registration and call check |
| 6.5 Controlled mutation | Confirmation UI and local-cart recipe | Cancellation, bounds and isolation tests |
| 6.6 Export | Exporter | Manifest validation and adapter harness |

### 3.2 File structure

```text
graft/
  api/                         guarded intake, rendering and deployment verification
  public/fixtures/             owned standalone fixture pages
  examples/owner-site/         separate-origin adapter integration proof
  scripts/                     export, owner-site and native browser smoke checks
  src/
    data/
      fixtureHtml/             fixture source imported as inert text
      fixtures.ts              IDs, expected tools and controlled-action bounds
    lib/
      types.ts                 serializable contracts and WebMCP adapter types
      dom-utils.ts             names, selectors, text bounds and safe DOM helpers
      snapshot.ts              semantic DOM snapshot
      confidence.ts            evidence weights and publication bands
      derive.ts                recipes and deterministic compilation
      execute.ts               allowlisted recipe execution and cancellation
      webmcp.ts                registration lifecycle and tool-change events
      index.ts                 public compiler API
    App.tsx                    workbench UI, product state and fixture workflow
    main.tsx                   React entry
    styles.css                 responsive Ruby Kernel landing and workbench system
  docs/                        PRD, technical spec and demo runbook
  package.json                 scripts and dependency contract
```

### 3.3 External APIs and dependencies

| Dependency | Use | Boundary |
| --- | --- | --- |
| [React 19](https://react.dev/) | Workbench UI and local state | No server rendering or React-specific tool runtime |
| [TypeScript 5](https://www.typescriptlang.org/docs/) | Contract validation at build time | Runtime inputs still require explicit validation |
| [Vite 7](https://vite.dev/) | Local development and static production bundle | Dev mounts the same intake and verify handlers used in production |
| [Vitest](https://vitest.dev/) and [jsdom](https://github.com/jsdom/jsdom) | Deterministic compiler and sanitizer tests | Native WebMCP still needs a headed browser check |
| [Puppeteer Core](https://pptr.dev/) and serverless Chromium | Render shell pages and read deployed WebMCP registrations | Requests are host-checked, credential-free and sanitized before reaching the client |
| [WebMCP imperative API](https://developer.chrome.com/docs/ai/webmcp/imperative-api) | Register and execute approved page tools | Experimental browser surface, feature-detected |
| `localStorage` | Versioned reviewed overrides | No raw snapshot, call history or demo-cart persistence |

### 3.4 AI usage

Graft has no model API, prompt endpoint or server-side AI dependency. The compiler is deterministic. A browser agent chooses and invokes the registered WebMCP tools during the judged flow. This separation makes contract generation testable without a model, while agent-selection rehearsals cover the probabilistic layer.

## 4. Data contracts

The public engine types cover this shape:

```ts
type GraftRecipe = 'R1' | 'R3' | 'R4' | 'R7' | 'R9'
type GraftAction = 'fill_submit' | 'local_mutation' | 'read' | 'summarize'
type GraftToolStatus = 'auto' | 'held' | 'rejected' | 'published'

type PageSnapshot = {
  title: string
  url: string
  headings: HeadingSnapshot[]
  collections: CollectionSnapshot[]
  tables: TableSnapshot[]
  searchForms: SearchFormSnapshot[]
  localActions: LocalActionSnapshot[]
}

type GraftTool = {
  id: string
  recipe: GraftRecipe
  name: string
  description: string
  inputSchema: Record<string, unknown>
  selector: string
  action: GraftAction
  readOnly: boolean
  destructive: boolean
  confidence: number
  confidenceReasons: string[]
  status: GraftToolStatus
  origin: 'derived' | 'human'
  binding: ToolBinding
}

type CallEvent = {
  id: string
  toolName: string
  startedAt: string
  durationMs?: number
  input: Record<string, unknown>
  status: 'pending' | 'confirmed' | 'succeeded' | 'cancelled' | 'failed'
  output?: unknown
  errorCode?: string
}
```

Candidate IDs must be deterministic for the same fixture structure. Local overrides are keyed by fixture ID and candidate ID. A saved binding that no longer resolves exactly once fails with a stale-contract error and never falls through to a guessed element.

## 5. Snapshot pipeline

### 5.1 Parse

- Fixture HTML is parsed in an inert context with `DOMParser` or an equivalent detached document.
- Compilation never runs source scripts and never adopts unreviewed active nodes into the application document.
- Fixture identity and source type are assigned by application code, not page content.

### 5.2 Sanitize

At minimum, remove or neutralize:

- `script`, `iframe`, `frame`, `object`, `embed`, `portal` and active SVG or MathML scripting surfaces
- Inline event attributes such as `onclick` and `onload`
- `javascript:`, `data:` and external network URLs where they can trigger loading or navigation
- Form `action` and `formaction` destinations
- Meta refresh, `<base>`, preloads, module preloads and external stylesheets
- Elements or attributes outside the fixture sanitizer allowlist

Keep semantic HTML needed for analysis, including headings, labels, forms, inputs, buttons, tables, `data`, `time`, lists, articles and details. Return a removal report for the trust panel.

### 5.3 Normalize

- Collapse whitespace and bound all lifted text.
- Prefer accessible names, labels, headings and explicit data attributes over classes or position.
- Resolve relative identity only inside the detached fixture. Do not resolve it to a live network origin.
- Mark every output based on snapshot content as untrusted.

### 5.4 Preview and registration boundary

- Keep the sanitized `Document` detached as the compiler and recipe-execution root.
- Serialize a display copy into a dedicated `srcdoc` frame with `sandbox=""`. Grant no same-origin access, scripts, forms, popups, downloads or top navigation.
- Keep fixture CSS inside the frame so it cannot style the workbench.
- After a Graft-owned local view change, serialize the detached document again so the inert preview reflects the result.
- Register tools on Graft's top-level `document.modelContext`, not the preview frame.
- Intercept search and local-cart intent in Graft-owned code. The fixture form itself never submits or navigates.

This split keeps the visible source page isolated while the browser agent receives tools from the trusted Graft application document.

## 6. Derivation recipes

| Recipe | Detection | Contract | Execution |
| --- | --- | --- | --- |
| R1, search or filter | A GET-style form with labelled controls and search or filter intent | Typed fields, enums from safe options and only relevant required keys | Apply fixture form state, submit no network request and return visible results |
| R3, collection | Three or more structurally similar articles with stable identity | `offset`, `limit` and a stable-record detail key where available | Return normalized records or one selected record with explicit truncation metadata |
| R4, semantic table | Caption, header cells and body rows | Column filters, pagination and a stable row key where available | Return rows keyed by header names or one selected row |
| R7, local demo cart | Signal Cabinet's explicitly marked owned form only | `product_id` enum and integer quantity from 1 to 3 | Wait for confirmation, mutate in-memory demo output and return the new local state |
| R8, semantic section group | Two to 25 sibling `section`, `article` or region elements sharing one safe `data-graft-section` noun, unique IDs, headings and summaries | Bounded list pagination plus a closed target ID enum | Return exact section records or scroll the local viewport to one still-matching section without directly clicking, navigating or fetching |
| R9, page orientation | Page title, headings and bounded visible text | No arguments | Return an untrusted page summary or heading outline |

Repeated regions collapse to one parameterized tool. Graft must not emit one tool per product, article or row.

## 7. Confidence and publication

Confidence is evidence, not a probability claim. The scorer rewards accessible names, typed fields, stable IDs, semantic containers and unique selectors. It penalizes positional selectors, missing labels, collisions and ambiguous repeated structures.

- `auto`: complete contract with a unique execution target and no safety ambiguity
- `held`: potentially useful but requires a human decision
- `rejected`: unsafe, unsupported or too ambiguous to execute
- `published`: a held or edited candidate that passed local validation
- `stale`: a previously valid binding that no longer resolves exactly once

Every score must have at least one positive or negative reason visible beside it. Human edits can change only a bounded snake-case name and description. They cannot change schemas, selectors, recipe bindings, annotations, fixture ownership or executor kind.

**Save and register** validates the edit, marks the candidate `published`, persists the versioned override and refreshes WebMCP registration so the repaired contract becomes callable immediately.

## 8. WebMCP integration

The current producer surface is `document.modelContext`. The `navigator` alias exists only as a compatibility fallback for Chrome 149 and is deprecated from Chrome 150.

```ts
const context = document.modelContext ?? navigator.modelContext
const registration = new AbortController()

await context.registerTool({
  name: candidate.name,
  description: candidate.description,
  inputSchema: candidate.inputSchema,
  annotations: {
    readOnlyHint: candidate.annotations.readOnlyHint,
    untrustedContentHint: true,
  },
  execute: async (input, { signal }) => {
    signal.throwIfAborted()
    return executeRecipe(candidate, input, signal)
  },
}, { signal: registration.signal })
```

Implementation requirements:

- Feature-detect the API and render an unsupported-browser diagnostic instead of throwing.
- Use one registration `AbortController` per published set. `refresh()` aborts the old set before registering a new set.
- Do not refresh while an execution is unresolved. Queue one refresh after the call settles.
- Reject duplicate names before calling the browser API.
- Forward execution cancellation into confirmation waits and recipe work.
- Return a plain JSON-serializable value. Do not return MCP server content blocks.
- Use direct `annotations.readOnlyHint` and `annotations.untrustedContentHint` support.
- Keep tool names and descriptions within Chrome's current recommendations: 30 characters for names, 500 for tool descriptions and 150 for parameter descriptions. The core executor defaults tool output to about 1.5K characters. These values are guidance, not specification limits.
- The interactive demo layer explicitly passes an 8K-character ceiling for the bounded owned-fixture judge path so the six-record proof call remains complete. This exception stays capped, does not change the core executor default and does not extend to future input paths implicitly.

The production judge path does not depend on an origin trial token. ChatGPT's in-app browser supports WebMCP directly. Chrome 149 or later can use `chrome://flags/#enable-webmcp-testing` for judging and local verification.

## 9. Execution rules

1. Validate input against the generated schema and recipe bounds.
2. Resolve the binding to exactly one semantic target.
3. Start a timeline event.
4. For the local cart only, present the resolved tool and arguments for confirmation.
5. Check the execution signal before every state transition.
6. Apply the recipe through Graft-owned functions, never imported code.
7. Return bounded structured data with an explicit truncated count where needed.
8. Complete the timeline event. Expose stable error codes for cancellation, invalid input, stale binding and unsupported execution.

Read-only search and filter tools may change the visible local view. They do not change the underlying fixture data, storage or any remote system.

## 10. Local persistence

Only reviewed overrides and non-sensitive UI preferences may be stored in `localStorage`.

- Namespace every key as `graft:review:<fixture-id>` and require envelope `version: 1`.
- Parse stored data through the same validator used for editor input.
- Ignore and replace malformed or unknown versions.
- Never store source HTML, tool-call content from a custom source, confirmation state or demo-cart state.

## 11. Export format

The downloaded JavaScript adapter contains:

- A versioned `graftManifest` with every reviewed candidate, provenance, binding and status
- A filtered `graftTools` array containing only `auto` and `published` contracts
- The audited DOM execution runtime for approved reads and bounded local page effects
- `registerGraftTools({ handlers })`, with optional owner overrides for generated handlers
- Awaited WebMCP registration with annotations, partial-registration rollback, a structured report and an async cleanup function
- Held writes as manifest metadata only, never silently registered without owner code
- A clear owner-review and integration-test warning

The bundle must not contain fixture page HTML, imported scripts, browser storage or live functions serialized from the application. The inlined runtime resolves only the reviewed selectors and recipes. Consequential business logic remains owner-authored.

## 12. Verification

### Deterministic tests

- Sanitizer removes each active-content class and retains required semantic elements.
- Each fixture derives its expected tool names and schema shapes.
- Repeated content collapses into one parameterized tool.
- Confidence reasons and status remain stable across runs.
- Only `auto` and `published` candidates are offered to registration.
- Refresh aborts old registration before creating a new set.
- Execution cancellation produces no local mutation.
- `add_to_demo_cart` rejects unknown product IDs and quantities outside 1 to 3.
- Local overrides validate, merge and persist through a recompile.
- Export contains annotations, eligible contracts, the bundled DOM runtime, awaited `registerGraftTools({ handlers })`, rollback reporting, cleanup and no active imported content.

### Browser checks

- Run the full flow in the latest ChatGPT desktop in-app browser.
- Run the full flow in Chrome 149 or later with WebMCP testing enabled.
- Verify registered tools, exact arguments, cancellation and return payloads.
- Inspect desktop at 1440px and mobile at 360px.
- Complete five consecutive primary demo rehearsals before recording.

### Commands

```bash
npm install
npm test
npm run build
npm run dev
```

`npm run dev` mounts the production intake and verification handlers at `/api/fetch` and `/api/verify`. `npm run preview` serves only the static production bundle after `npm run build`.

## 13. Failure behavior

| Failure | User-visible response | Safe recovery |
| --- | --- | --- |
| WebMCP unavailable | Browser support panel with the missing surface and official setup path | Enable the official Chrome flag or use ChatGPT's in-app browser |
| Candidate held | Reasons and edit controls, no registration claim | Review and publish or leave held |
| Stale binding | A stale-contract error in the timeline and candidate panel | Recompile, then hold the candidate if the binding remains stale |
| Invalid editor input | Field-level validation and unchanged saved contract | Correct the field |
| Cancelled execution | `cancelled` timeline state and no mutation | Retry deliberately |
| Sanitizer rejection | Removed-feature report and no preview execution | Use an owned fixture |

## 14. Demo and submission flow

The finished submission video follows eight acts: migration gap, compile, inspect, execute, govern, owner-side action, external verification and close. It shows Graft's seven live control tools, a real `list_products` call, a held write, a separate owner adapter, a real `add_to_demo_cart` result and an exact 5 of 5 deployment verification. The exact timing and evidence checklist live in [DEMO_RUNBOOK.md](DEMO_RUNBOOK.md).

Before submission, verify the production URL in both official judge browser paths, run the build and test commands from a clean install and confirm the public repository exposes its MIT license.

## 15. Official references

- [WebMCP draft specification](https://webmachinelearning.github.io/webmcp/)
- [Chrome WebMCP overview](https://developer.chrome.com/docs/ai/webmcp)
- [Chrome imperative API](https://developer.chrome.com/docs/ai/webmcp/imperative-api)
- [Chrome WebMCP best practices](https://developer.chrome.com/docs/ai/webmcp/best-practices)
- [Chrome WebMCP tool security](https://developer.chrome.com/docs/ai/webmcp/secure-tools)
- [Chrome WebMCP evals](https://developer.chrome.com/docs/ai/webmcp/evals)
