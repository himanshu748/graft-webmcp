# Devpost submission text

Paste the section below into the Devpost description field. The video shot list follows it.

---

## Graft

**A governed tool layer for websites that never shipped one.**

Live: https://graft-webmcp.vercel.app
Repo: https://github.com/himanshu748/graft-webmcp

### Why this is a strong fit for WebMCP

WebMCP has a supply problem, not a demand problem. The clients arrived: Chrome ships the origin trial, Edge has it behind a flag, and the ChatGPT desktop in-app browser speaks it. The supply did not. The WebMCP Directory, the closest thing to a census, lists roughly 300 sites. There are a few hundred million websites.

Every tool that exists today sits on the same side of the fence. It helps a site owner add tools to code they own. Graft removes the owner from the loop: paste any public URL and the page becomes a set of typed, reviewable WebMCP contracts without asking the site for anything.

That is the exact gap the standard is stuck in, and it is a problem you can watch someone have in ten seconds.

### How it creates a better user experience

Today an agent facing an ordinary website guesses. It reads the DOM or a screenshot, infers what a button probably does, and acts on that inference. The failure mode is silent and confident.

Graft replaces the guess with a contract. Every tool carries a typed JSON Schema, a `readOnlyHint`, an `untrustedContentHint`, and a confidence score with the evidence behind it in plain language. You see why a tool scored 95 or why it was held at 55 before anything registers. Ambiguous contracts are held for a human rather than registered silently, and a write contract with no bound handler is never registered automatically no matter how confident the derivation looks.

The human stays in the loop where it matters and gets out of the way where it does not.

### What people and agents can do together that was not possible before

Point an agent at a site that has never heard of WebMCP and have it work from a real contract instead of a guess.

On `books.toscrape.com`, Graft derives `list_products`, `get_product`, `list_navigation` and an `add_to_basket` write candidate. On `python.org` it derives ten tools including `search_this_site`, `list_latest_news` and `list_upcoming_events` with matching detail tools. Neither site knows Graft exists.

The reviewed result exports as a manifest plus a `registerGraftTools(handlers)` adapter, so the same pass that makes a page agent-usable today is the migration artifact the owner ships tomorrow. Discover with Graft, harden in your own repo.

### Implementation approach

A server endpoint reads the target page once, strips the response headers that block embedding, inlines external stylesheets, and returns the markup. It never forwards cookies or credentials, never caches target content, honours `robots.txt`, refuses auth, banking, mail and government domains by policy, and revalidates every redirect hop against private address ranges so the fetch cannot be turned into an SSRF.

The client sanitizes that markup into an inert snapshot, removing scripts, frames and every network-capable attribute, then compiles it. Nine recipes cover search forms, repeated content regions, data tables, navigation, page structure and write controls. Site chrome is excluded from content recipes, because a nav bar repeats exactly like a product grid does.

Every candidate is scored. A name lifted from a class attribute is not an accessible name, and the rubric says so out loud. Repeated identical write controls collapse into one parameterized tool, because twenty tools named `add_to_basket_1` through `_20` hand the agent a coin flip.

Approved tools register through `document.modelContext.registerTool` with an `AbortController` per tool set, falling back to `navigator.modelContext` only for Chrome 149. Re-derivation diffs the tool set and re-registers when the page changes. Every call appears in a visible timeline with its exact arguments and result.

### Honest limits

Measured, not asserted. Semantic sites compile well. Sites behind bot protection refuse the read: Stack Overflow answers 403 and Allrecipes answers 402, and Graft reports what happened instead of spinning. Heavily client-rendered pages give up little, because the server receives a shell. Where derivation is weak the confidence gate holds or rejects the candidate rather than shipping a tool an agent cannot aim.

---

## Video shot list, under 3 minutes

Record in the ChatGPT desktop in-app browser, or Chrome 149+ with `chrome://flags/#enable-webmcp-testing` enabled, so tools actually register. Keep the URL bar visible throughout. No cuts inside an agent call.

**0:00 to 0:20. The problem.**
Open `books.toscrape.com` directly. Ask the agent to find the cheapest in-stock book. It guesses or fumbles. Say the line: roughly 300 sites speak WebMCP, and there are a few hundred million websites.

**0:20 to 1:05. The graft.**
Open Graft. It has already compiled that same site. Six tools. Open `list_products` and show the schema, the annotations, and the confidence reasons. Ask the agent the same question, word for word. It calls the tool and answers. Expand the call to show exact arguments and returned rows.

**1:05 to 1:35. Generality.**
Paste `https://www.python.org` into the field. Ten tools appear, including `search_this_site` and `list_upcoming_events`. This is the beat that proves it is a compiler and not three hardcoded demos.

**1:35 to 2:10. Governance.**
Show `add_to_basket` held at 55, and read its reason: a write contract with no bound handler is never registered automatically. Then paste a site that refuses, and show the failure card naming the cause.

**2:10 to 2:40. Adoption.**
Edit a tool description in the inspector, save and register, then export the adapter. Say the line: discover with Graft, harden in your own repo.

**2:40 to 3:00. The claim.**
Back to the tool count. The clients arrived. The supply did not. Graft is the supply side.
