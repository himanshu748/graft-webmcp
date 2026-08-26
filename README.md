# Graft

**A governed tool layer for websites that never shipped one.**

Paste any public URL. Graft reads that page once on the server, strips every script, frame and network attribute, then compiles what is left into typed WebMCP tool candidates. Each candidate carries a confidence score with its reasons, so you can see why a contract is trustworthy before you register it. Ambiguous tools are held for review instead of being registered silently.

**Live:** https://graft-webmcp.vercel.app

## What it does

- **Live intake.** Any public HTML page. Authentication, banking, mail and government domains are refused by policy, private and link-local addresses are refused at every redirect hop, and `robots.txt` is honoured.
- **Semantic derivation.** Search forms, repeated content regions and data tables become typed tools. Site chrome such as navigation, table-of-contents and footers is excluded, because a nav bar repeats exactly like content does.
- **Explainable confidence.** A name lifted from a class attribute is not an accessible name, and the difference is scored. Every tool shows the evidence behind its number.
- **Human repair.** Rename a tool, rewrite its description, then register it. Edits are stored per source and outrank re-derivation.
- **Governed execution.** Read-only tools carry `readOnlyHint`, all snapshot-derived tools carry `untrustedContentHint`, and every call appears in a visible timeline with its exact arguments and result.
- **Reviewed export.** Download the manifest and an `registerGraftTools(handlers)` adapter as a starting point for owner-side integration.

## What it proves

- Useful WebMCP contracts can be proposed from semantic forms, repeated content and tables on pages nobody wrote for agents.
- Confidence should be inspectable. Ambiguous tools are held instead of silently registered.
- Snapshot-derived output can be registered with `untrustedContentHint` and safe tools with `readOnlyHint`.
- A reviewed tool can execute through the browser's WebMCP surface with exact arguments and results visible in a local timeline.
- Generated contracts are most useful as an owner-reviewed migration artifact, not as unexamined production code.

## Judge path, under 60 seconds

1. Open https://graft-webmcp.vercel.app in the ChatGPT desktop in-app browser. Alternatively, use Chrome 149 or later with `chrome://flags/#enable-webmcp-testing` enabled.
2. The page compiles `books.toscrape.com` on load. No setup, no sign-in, no key.
3. Inspect `list_products`, including its schema, confidence reasons and annotations.
4. Ask the agent: **"List the products on this page and tell me which one is cheapest."**
5. Expand the successful call to see its arguments and returned data.
6. Paste a URL of your own into the intake field and compile it.
7. Switch to **Owned fixture** to see the same compiler run offline against bundled pages, including one confirmed local-only mutation.
8. Export the reviewed contract.

The interface remains usable when native WebMCP is unavailable, but it reports that state clearly and does not claim tools were registered.

## Honest limits

Measured against real pages, not asserted:

- Semantic sites compile well. `python.org` yields `search_this_site`, `list_latest_news` and `list_upcoming_events`. `arxiv.org` yields `search_arxiv` and `list_recent_submissions`.
- Sites behind bot protection refuse the read. Stack Overflow answers 403 and Allrecipes answers 402. Graft reports what happened instead of showing a spinner.
- Heavily client-rendered pages give up little, because the server receives a shell rather than content. `github.com/trending` produces no useful list tool.
- Where derivation is weak, the confidence gate holds or rejects the candidate rather than registering a tool an agent cannot aim.

Graft never forwards cookies or credentials, never caches target content and never executes target scripts. Only the reviewed tool metadata is stored, in your own browser.

## Bundled fixtures

These ship with Graft so the compiler can be demonstrated offline, and so a judge is never blocked by a network failure. All fixture names, copy, marks and CSS are original.

| Fixture | Semantic input | Expected tools |
| --- | --- | --- |
| **Signal Cabinet** | Search form, repeated product articles, product details and a local demo-cart output | `search_catalog`, `list_products`, `get_product`, `add_to_demo_cart` |
| **Mossbank Field Guide** | Search form, topic navigation, knowledge articles and glossary details | `search_field_guide`, `list_entries`, `read_entry` |
| **Basin Ledger** | Filter form, captioned data table, typed values and dated records | `filter_batches`, `list_batches`, `get_batch` |

Fixtures are static, inline and asset-free.

## How it works

```text
owned fixture
  -> inert snapshot and sanitizer report
  -> semantic recipes
  -> typed candidates with confidence evidence
  -> local review and validation
  -> auto/published gate
  -> document.modelContext.registerTool()
  -> visible execution timeline
  -> reviewed export
```

The compiler core is source-agnostic. Live URL intake, pasted markup and bundled fixtures all enter the same pipeline at the same point, which is why a fixture is a useful offline fallback rather than a separate code path.

Local repair is intentionally bounded to a unique snake-case tool name and a 20 to 500 character description. Graft saves those fields plus publication status in a versioned fixture-scoped envelope. The downloaded adapter includes the full reviewed manifest, eligible descriptors and an async `registerGraftTools(handlers)` helper. It awaits native registration, reports missing handlers or failures, rolls back partial registration and exposes cleanup. Owners still provide every production handler and its tests.

## WebMCP contract

Graft prefers the current `document.modelContext` surface. It checks `navigator.modelContext` only for Chrome 149 compatibility.

```ts
const context = document.modelContext ?? navigator.modelContext
const registration = new AbortController()

await context.registerTool({
  name: 'list_products',
  description: 'List products visible on the compiled page.',
  inputSchema: {
    type: 'object',
    properties: {
      offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 25 },
    },
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    untrustedContentHint: true,
  },
  execute: async (input, { signal }) => {
    signal.throwIfAborted()
    return listCompiledProducts(input)
  },
}, { signal: registration.signal })
```

Execution returns a plain JSON-serializable value. The registration signal removes the tool when the candidate set changes. The execution signal cancels in-flight work when the user or agent cancels the call.

Chrome recommends concise contracts: up to 30 characters for a name, 500 for a tool description, 150 for a parameter description and about 1.5K characters for one tool output. Graft treats those values as current guidance, not WebMCP specification limits. The core executor defaults to that output budget. The bounded owned-fixture judge path explicitly passes an 8K-character ceiling so its six-record proof call stays complete without changing the core default.

## Local development

### Requirements

- Node.js 20.19 or later
- npm 10 or later
- A current ChatGPT desktop app or Chrome 149 or later for native WebMCP verification

### Install and run

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:4173`, or use the local URL printed by Vite if that port is already occupied.

### Test and build

```bash
npm test
npm run build
npm run preview
```

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Vite development server |
| `npm test` | Run deterministic Vitest coverage once |
| `npm run test:watch` | Run Vitest in watch mode |
| `npm run build` | Type-check and create the production bundle |
| `npm run preview` | Serve the production bundle locally |

## Browser setup

### ChatGPT desktop

Open the running app in ChatGPT's in-app browser. The challenge documents this as a supported judge path with WebMCP available by default.

### Chrome

1. Install Chrome 149 or later.
2. Open `chrome://flags/#enable-webmcp-testing`.
3. Set the flag to **Enabled**.
4. Restart Chrome completely.
5. Open Graft and confirm its WebMCP diagnostic reports an available producer surface.

An origin trial token is not required for either official local judge path. Origin trials are time-limited and optional for a separate public Chrome deployment strategy.

## Project map

```text
public/fixtures/       original static fixture pages
src/data/              fixture metadata and bundled source
src/sanitize.ts        active-content removal and inert snapshot serialization
src/lib/               snapshot, derivation, confidence, execution and registration
src/App.tsx            workbench, inspector, timeline, confirmation and export UI
docs/PRD.md             product behavior and scored acceptance criteria
docs/TECHNICAL_SPEC.md  trust boundaries, compiler contracts and verification
docs/DEMO_RUNBOOK.md    exact sub-three-minute recording path
```

## Safety model

- Intake reads a page, it does not proxy one. Nothing is re-served under Graft's origin and the target's own scripts never run in your tab
- Target content is never cached. The intake response is `no-store` at the edge and nothing is written to disk
- Pages that need JavaScript are rendered in a sandboxed headless browser on the server, with credentials off, downloads off, dialogs dismissed and private-network subresources blocked. Nothing rendered there reaches your browser as executable code
- Every outbound fetch, including each external stylesheet, revalidates the host on every redirect hop against private and link-local ranges
- No imported scripts, inline event handlers, embedded documents or active form destinations
- No cookies, credentials, authenticated state or remote registry
- Snapshot text is bounded and always treated as untrusted content
- Derived contracts map only to built-in recipe executors, never `eval` or imported behavior
- Ambiguous tools are held and stale bindings fail closed
- `add_to_demo_cart` is the only mutation: allowlisted fixture product, quantity 1 to 3, human confirmation and in-memory state only
- A write contract derived from a page Graft does not own is always held, never registered automatically, and returns an explicit unbound-handler error if called
- Export is a reviewed migration starting point and still requires owner implementation, security review and integration tests

## Challenge fit

The official rules use four equally weighted Stage Two criteria:

| Criterion | Evidence in Graft |
| --- | --- |
| **WebMCP Leverage** | Typed runtime contracts, direct annotations, registration lifecycle, cancellation and live execution |
| **Execution** | Coherent first-run flow, three deterministic fixtures, honest browser diagnostics and tested failure states |
| **Potential Impact** | A concrete migration workflow for owners who have useful page semantics but no WebMCP contract yet |
| **Creativity & Ambition** | A DOM compiler and repair bench that previews the agent surface before source integration |

Stage One is pass or fail on viability, theme fit and meaningful API use. The submission must also include a working live URL, a public repository with a visible OSS license, an English write-up and a public YouTube demo under three minutes with audio.

## Documentation

- [Product requirements](docs/PRD.md)
- [Technical specification](docs/TECHNICAL_SPEC.md)
- [Demo runbook](docs/DEMO_RUNBOOK.md)

## Official references

- [WebMCP Challenge overview](https://webmcp.devpost.com/)
- [WebMCP Challenge official rules](https://webmcp.devpost.com/rules)
- [WebMCP draft specification](https://webmachinelearning.github.io/webmcp/)
- [Chrome WebMCP overview](https://developer.chrome.com/docs/ai/webmcp)
- [Chrome imperative API](https://developer.chrome.com/docs/ai/webmcp/imperative-api)
- [Chrome best practices](https://developer.chrome.com/docs/ai/webmcp/best-practices)
- [Chrome tool security](https://developer.chrome.com/docs/ai/webmcp/secure-tools)
- [Chrome WebMCP evals](https://developer.chrome.com/docs/ai/webmcp/evals)

## License

[MIT](LICENSE)
