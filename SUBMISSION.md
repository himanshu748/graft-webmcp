# Devpost submission text

Paste the section below into the Devpost description field. The video shot list follows it.

---

## Graft

**A governed tool layer for websites that never shipped one.**

Live: https://graft-webmcp.vercel.app
Repo: https://github.com/himanshu748/graft-webmcp

### Why this is a strong fit for WebMCP

WebMCP has a supply problem, not a demand problem. The clients arrived: Chrome ships the origin trial, Edge has it behind a flag, and the ChatGPT desktop in-app browser speaks it. The supply did not. The WebMCP Directory at webmcp.com, the closest thing to a public census, listed 306 sites when this was built. Every other site on the web exposes nothing.

Every tool that exists today sits on the same side of the fence. It helps a site owner add tools to code they own. Graft removes the owner from the loop: paste any public URL and the page becomes a set of typed, reviewable WebMCP contracts without asking the site for anything.

That is the exact gap the standard is stuck in, and it is a problem you can watch someone have in ten seconds.

### How it creates a better user experience

Today an agent facing an ordinary website guesses. It reads the DOM or a screenshot, infers what a button probably does, and acts on that inference. The failure mode is silent and confident.

Graft replaces the guess with a contract. Every tool carries a typed JSON Schema, a `readOnlyHint`, an `untrustedContentHint`, and a confidence score with the evidence behind it in plain language. You see why a tool scored 95 or why it was held at 55 before anything registers. Ambiguous contracts are held for a human rather than registered silently, and a write contract with no bound handler is never registered automatically no matter how confident the derivation looks.

The human stays in the loop where it matters and gets out of the way where it does not.

### What people and agents can do together that was not possible before

Point an agent at a site that has never heard of WebMCP and have it operate that site from a real contract instead of a guess.

Search is the clearest case. When a page's search form declares a GET endpoint, Graft derives a typed `search` tool that replays the query against the live site. Ask for `search_this_site("asyncio")` on python.org and the agent gets 20 current results, not a filter over the twenty rows that happened to be on the page. The site published no API, changed nothing and knows nothing about Graft.

On `books.toscrape.com`, Graft derives six contracts: five that register, including `list_products`, `get_product` and `list_navigation`, plus an `add_to_basket` write candidate that is held for review rather than registered. On `python.org` it derives ten tools including `search_this_site`, `list_latest_news` and `list_upcoming_events` with matching detail tools. Neither site knows Graft exists.

The reviewed result exports as a manifest plus a `registerGraftTools(handlers)` adapter, so the same pass that makes a page agent-usable today is the migration artifact the owner ships tomorrow. Discover with Graft, harden in your own repo.

Graft is also agent-operable as itself. It registers a control surface next to the tools it derives, so an agent can call `graft_compile_url("https://example.com")`, then `graft_list_candidates`, then `graft_inspect_candidate` to read the scored evidence, then `graft_set_candidate` to publish a held one. The agent drives Graft, and Graft makes any site drivable. Both layers run through the same WebMCP surface in the same tab.

### Implementation approach

A server endpoint reads the target page once, strips the response headers that block embedding, inlines external stylesheets, and returns the markup. It never forwards cookies or credentials, never caches target content (`no-store`, nothing on disk), honours `robots.txt`, and refuses auth, banking, mail and government domains by policy. Hosts are resolved rather than pattern-matched, so a public name pointing at a private address is refused. Every outbound request, the page and each external stylesheet alike, revalidates its host on every redirect hop against private and link-local ranges, because a stylesheet href is attacker-controlled too.

The client sanitizes that markup into an inert snapshot, removing scripts, frames and every network-capable attribute, then compiles it. Nine recipes cover search forms, repeated content regions, data tables, navigation, page structure and write controls. Site chrome is excluded from content recipes, because a nav bar repeats exactly like a product grid does.

Every candidate is scored. A name lifted from a class attribute is not an accessible name, and the rubric says so out loud. Repeated identical write controls collapse into one parameterized tool, because twenty tools named `add_to_basket_1` through `_20` hand the agent a coin flip.

Approved tools register through `document.modelContext.registerTool` with an `AbortController` per tool set, falling back to `navigator.modelContext` only for Chrome 149. Re-derivation diffs the tool set and re-registers when the page changes. Every call appears in a visible timeline with its exact arguments and result.

### Honest limits

Measured, not asserted. Semantic sites compile well. Sites behind bot protection refuse the read: Stack Overflow answers 403 and Allrecipes answers 402, and Graft reports what happened instead of spinning. When a page returns a shell, Graft renders it with a headless Chromium in the serverless function and compiles the result, which is how it compiles its own single-page app. Every request that browser makes has its host resolved and checked before it is allowed out. That Chromium runs with `--no-sandbox`, so isolation comes from the function boundary rather than the Chromium process sandbox, and DNS rebinding is not closed by it. If rendering still yields nothing, Graft says so and names the character count it read. Where derivation is weak the confidence gate holds or rejects the candidate rather than shipping a tool an agent cannot aim.

---

## Video shot list, under 3 minutes

Record in the ChatGPT desktop in-app browser, or Chrome 149+ with `chrome://flags/#enable-webmcp-testing` enabled, so tools actually register. Keep the URL bar visible throughout. No cuts inside an agent call.

**0:00 to 0:20. The problem.**
Open `books.toscrape.com` directly. Ask the agent to find the cheapest in-stock book. It guesses or fumbles. Say the line: the WebMCP directory listed 306 sites when this was built, and this is not one of them.

**0:20 to 1:05. The graft.**
Open Graft. It has already compiled that same site: five registered tools and one held candidate. Open `list_products` and show the schema, the annotations, and the confidence reasons. Ask the agent the same question, word for word. It calls the tool and answers. Expand the call to show exact arguments and returned rows.

**1:05 to 1:35. Generality.**
Paste `https://www.python.org` into the field. Ten tools appear. Ask the agent to search the site for asyncio. The call goes out to `python.org/search/?q=asyncio` and comes back with 20 live results. This is the beat that proves the agent is operating the site, not reading a copy of it.

**1:35 to 2:10. Governance.**
Show `add_to_basket` held at 55, and read its reason: a write contract with no bound handler is never registered automatically. Then paste a site that refuses, and show the failure card naming the cause.

**2:10 to 2:40. Graft operating itself.**
Without touching the interface, ask the agent to compile a different URL through `graft_compile_url`, list the candidates and publish a held one. The page updates as the agent works. Then `graft_export_adapter`. Say the line: discover with Graft, harden in your own repo.

**2:40 to 3:00. The claim.**
Back to the tool count. The clients arrived. The supply did not. Graft is the supply side.
