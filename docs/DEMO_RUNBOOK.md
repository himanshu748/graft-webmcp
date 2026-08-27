# Graft Demo Runbook

**Target length:** 2:35 to 2:50  
**Hard limit:** Under 3:00  
**Recording rule:** Use one continuous product flow with the browser chrome visible. Remove dead time between acts, but do not cut inside a tool call.

## 1. What the demo must prove

By the end, a judge should be able to repeat four facts:

1. Graft compiles owned static page semantics into typed WebMCP candidates.
2. It explains uncertainty and keeps a human in the repair loop.
3. The registered tool is genuinely called through WebMCP and the result is visible.
4. The sole write action is a confirmed local simulation, then the reviewed contract can be exported for owner-side work.

Do not claim arbitrary URL support, a global registry, third-party mutation, origin-policy bypass or universal compatibility.

## 2. Preflight, 30 minutes before recording

### Build

- Run `npm test` and save a screenshot of the passing summary as backup evidence.
- Run `npm run build`.
- Start the production build with `npm run preview` or use the deployed live URL.
- Open a fresh Graft session. If a rehearsal review is still saved, remove only `graft:review:catalog` from local storage, then reload.
- Confirm the live compile finishes on load, the badge reports the full native tool count, and the six preset pages load with no console errors.
- Confirm export downloads and opens as expected.

### Browser

Use the latest ChatGPT desktop in-app browser first. The official alternative is Chrome 149 or later with `chrome://flags/#enable-webmcp-testing` enabled followed by a browser restart.

- Confirm the page reports the native WebMCP surface as available.
- Confirm `document.modelContext` is used. Chrome 149 may use the compatibility fallback.
- Confirm the expected Signal Cabinet tools are registered.
- Call one read tool, run `graft_verify_url` against the deployed owner site, then recompile a different URL.
- Close unrelated tabs and hide personal bookmarks, notifications, account names and extensions.

An origin trial token is optional and is not part of the demo dependency.

### Capture

- Record 1440 × 900 or 1920 × 1080 at 30 fps.
- Keep the URL bar visible.
- Use browser zoom that keeps the fixture, inspector and timeline legible.
- Record clean spoken audio. Do not use copyrighted music.
- Use only Graft's original fixtures and marks.
- Rehearse the complete take five times. If any take fails, fix the failure or shorten the flow before recording.

## 3. Primary take

| Time | Screen action | Voiceover |
| --- | --- | --- |
| 0:00 to 0:15 | Open Graft on the fixture chooser. Pause on the one-line product claim and trust boundary. | “WebMCP lets a page give agents reliable tools. The migration work still starts with deciding what those tools should be. Graft turns an owned page snapshot into a reviewable first contract.” |
| 0:15 to 0:35 | Choose **Signal Cabinet**. Show **Owned static fixture**, then select **Recompile snapshot** so the three compiler stages are visible. | “This is an original static fixture. Graft parses it as untrusted content, removes active behavior and compiles only its semantic HTML.” |
| 0:35 to 0:55 | Let the candidate list settle. Point to `search_catalog`, `list_products`, `get_product` and the held `add_to_demo_cart`. Open one read candidate to show schema, annotations and confidence reasons. | “The compiler found a search form, a repeated product collection and stable product details. Each candidate has a typed schema, provenance and evidence. Only approved candidates reach the browser.” |
| 0:55 to 1:20 | Ask the agent: **“List the products in Signal Cabinet and tell me which one is cheapest.”** Keep the Graft timeline and fixture visible. | “This is the proof point. The agent receives a WebMCP contract instead of guessing at coordinates.” |
| 1:20 to 1:32 | Show the `list_products` timeline row, expand exact arguments and returned JSON, then point to **Cable Dock 8 at $86** in the fixture. | “The call ran through `document.modelContext`. Graft records the exact input, result and duration. Snapshot-derived output is marked untrusted.” |
| 1:32 to 1:55 | Open the held cart candidate, choose **Edit** and replace the description with: **“Add an allowlisted Signal Cabinet product to the local demo cart. Pass the exact product_id from list_products and a quantity from 1 to 3. Requires confirmation and never sends a network request.”** Choose **Save and register**, then point to Published state. | “Graft does not hide uncertainty. This candidate is held because it mutates state. A human repairs the contract before it can register.” |
| 1:55 to 2:18 | Ask: **“Add one Cable Dock 8 to the demo cart.”** Show the confirmation with `product_id: "cable-dock-8"` and `quantity: 1`. Confirm, then show the local demo-cart output change and successful timeline row. | “This is the only write in the build. It accepts an allowlisted fixture product and quantity, waits for confirmation and changes only this in-memory demo output. There is no checkout or network write.” |
| 2:18 to 2:33 | Switch quickly to **Basin Ledger**, compile and show `filter_batches`, `list_batches` and `get_batch`. | “The compiler is source-agnostic even though the judged inputs are deliberately owned. The same recipes produce a different tool surface for a semantic table.” |
| 2:33 to 2:46 | Return to the reviewed contract and click **Download adapter**. Show `graft-catalog.js` in the download tray. If time allows, open it at `registerGraftTools(handlers)`. | “The reviewed descriptors and registration stub become an owner-side migration starting point. The owner still supplies production handlers and tests.” |
| 2:46 to 2:55 | End on the product line and trust statement. | “Graft is a governed tool layer for websites that never shipped one: explainable, repairable and safe by construction.” |

## 4. Deterministic rehearsal prompts

| Fixture | Prompt | Expected evidence |
| --- | --- | --- |
| Signal Cabinet | “List the products in Signal Cabinet and tell me which one is cheapest.” | `list_products`; Cable Dock 8 at $86 |
| Mossbank Field Guide | “List the field guide entries about recording.” | `list_entries`; Log surface water and Return to a marker |
| Basin Ledger | “Which batches are not Ready and how many available kilograms do they total?” | `list_batches`; BL-2048, BL-2054 and BL-2060; 481 kg |
| Signal Cabinet | “Add one Cable Dock 8 to the demo cart.” | `add_to_demo_cart`; confirmation for `cable-dock-8`, quantity 1 and one local output update |

Run each prompt twice before recording. If the model wording varies, score the tool selection, arguments and factual result rather than exact prose.

## 5. On-screen proof checklist

The final video must visibly contain:

- An owned-fixture label
- A sanitizer or trust-state signal
- At least three derived candidate names
- A JSON Schema or typed input field
- Visible read-only and untrusted-content annotation values
- Registered WebMCP status
- An agent-triggered call with exact arguments and returned data
- One held-to-published transition
- A confirmation before the local mutation
- The changed local demo-cart output
- A second fixture with a different semantic structure
- A reviewed export artifact

## 6. Failure branches

### Agent does not choose `list_products`

Do not retry with a long explanation. Use the deterministic prompt: **“Call `list_products` and return the product with the lowest price.”** If the tool still is not called, stop recording and inspect registration. Do not film a manual executor and describe it as an agent call.

### WebMCP is unavailable

Show the product's browser-support diagnostic only if it is part of an intentional backup explanation. For the submission take, stop, verify the official judge browser path and restart the recording after native registration is observed.

### Cart confirmation or mutation fails

Cancel the take. Do not click the fixture manually. Verify the candidate is published, product ID is allowlisted, quantity is 1 to 3 and the demo cart returns to empty after recompiling the fixture.

### Second fixture takes too long

Cut the Mossbank or Basin execution, not the primary proof. A stable candidate list on a second structure is enough to establish generality within the P0 claim.

### Export fails

Do not substitute an unverified file. Restart the session, repeat the reviewed export and confirm that the downloaded adapter contains the eligible descriptors plus `registerGraftTools(handlers)` before recording again.

## 7. Submission packaging

Before uploading:

- Keep the final edit below 2:55 to leave platform timing margin.
- Watch the uploaded YouTube version from start to finish with captions off and audio on.
- Make the YouTube video public.
- Confirm it contains no third-party trademarks, music or unlicensed material.
- Put the public video URL, working live URL and public repository URL in Devpost.
- Confirm the repository contains all source, instructions and a detectable OSS license visible in the repository About section.
- Use the English write-up to explain fit, user experience, human-agent collaboration and WebMCP implementation.

## 8. Evidence stills

Capture these after the video, in case the submission gallery supports images:

1. Fixture and candidate inspector side by side
2. Expanded successful `list_products` timeline event
3. Local mutation confirmation with the demo-only boundary visible
4. Basin Ledger candidate set
5. Export preview with review warning

## 9. Official requirements

The authoritative timing, deliverables and judging language are in the [challenge overview](https://webmcp.devpost.com/) and [official rules](https://webmcp.devpost.com/rules).
