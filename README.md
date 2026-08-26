# Graft

**A governed tool layer for websites that never shipped one.**

Graft compiles an owned static page snapshot into explainable WebMCP tool candidates. A human can inspect the generated schemas, repair uncertain contracts, register approved tools in the browser and export the reviewed result as a starting point for owner-side integration.

The challenge build is deliberately narrow: three original fixtures, no arbitrary-site proxy, no imported scripts, no credential forwarding and one confirmed local-only mutation.

## What it proves

- Useful WebMCP contracts can be proposed from semantic forms, repeated content and tables.
- Confidence should be inspectable. Ambiguous tools are held instead of silently registered.
- Snapshot-derived output can be registered with `untrustedContentHint` and safe tools with `readOnlyHint`.
- A reviewed tool can execute through the browser's WebMCP surface with exact arguments and results visible in a local timeline.
- Generated contracts are most useful as an owner-reviewed migration artifact, not as unexamined production code.

## Judge path, under 60 seconds

1. Open Graft in the ChatGPT desktop in-app browser. Alternatively, use Chrome 149 or later with `chrome://flags/#enable-webmcp-testing` enabled.
2. Choose **Signal Cabinet** and compile the owned snapshot.
3. Inspect `list_products`, including its schema, confidence reasons and annotations.
4. Ask the agent: **“List the products in Signal Cabinet and tell me which one is cheapest.”**
5. Confirm the answer identifies **Cable Dock 8 at $86**, then expand the successful call to see its arguments and returned data.
6. Open `add_to_demo_cart`, edit its bounded name or description, then choose **Save and register** before confirming one local simulated cart action.
7. Switch to **Basin Ledger** to see the same compiler produce a table-oriented tool set.
8. Export the reviewed contract.

The interface remains usable when native WebMCP is unavailable, but it reports that state clearly and does not claim tools were registered.

## Owned fixtures

| Fixture | Semantic input | Expected tools |
| --- | --- | --- |
| **Signal Cabinet** | Search form, repeated product articles, product details and a local demo-cart output | `search_catalog`, `list_products`, `get_product`, `add_to_demo_cart` |
| **Mossbank Field Guide** | Search form, topic navigation, knowledge articles and glossary details | `search_field_guide`, `list_entries`, `read_entry` |
| **Basin Ledger** | Filter form, captioned data table, typed values and dated records | `filter_batches`, `list_batches`, `get_batch` |

All fixture names, copy, marks and CSS are original. Fixtures are static, inline and asset-free.

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

The compiler core is source-agnostic, but P0 intake is fixture-only. Permissioned pasted HTML, snapshot upload and URL intake belong to the next product phase. They are not part of the submission claim.

Local repair is intentionally bounded to a unique snake-case tool name and a 20 to 500 character description. Graft saves those fields plus publication status in a versioned fixture-scoped envelope. The downloaded adapter includes the full reviewed manifest, eligible descriptors and an async `registerGraftTools(handlers)` helper. It awaits native registration, reports missing handlers or failures, rolls back partial registration and exposes cleanup. Owners still provide every production handler and its tests.

## WebMCP contract

Graft prefers the current `document.modelContext` surface. It checks `navigator.modelContext` only for Chrome 149 compatibility.

```ts
const context = document.modelContext ?? navigator.modelContext
const registration = new AbortController()

await context.registerTool({
  name: 'list_products',
  description: 'List products visible in the owned catalog fixture.',
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
    return listOwnedFixtureProducts(input)
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

- No arbitrary URL proxy and no third-party live page execution
- No imported scripts, inline event handlers, embedded documents or active form destinations
- No cookies, credentials, authenticated state or remote registry
- Snapshot text is bounded and always treated as untrusted content
- Derived contracts map only to built-in recipe executors, never `eval` or imported behavior
- Ambiguous tools are held and stale bindings fail closed
- `add_to_demo_cart` is the only mutation: allowlisted fixture product, quantity 1 to 3, human confirmation and in-memory state only
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
