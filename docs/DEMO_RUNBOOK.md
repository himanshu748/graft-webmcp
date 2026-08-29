# Graft Demo Runbook

This document matches the finished WebMCP Challenge video.

**Runtime:** 2 minutes 25 seconds
**Format:** 1920 by 1080, 30 fps, H.264 video with AAC audio
**Narration:** AI-generated with Deepgram and disclosed during upload
**Rule:** Keep the public YouTube upload under three minutes with audio

## What the demo proves

By the end, a judge can repeat six facts:

1. Graft compiles semantic HTML into typed WebMCP candidates.
2. Graft itself is WebMCP-enabled through seven live `graft_` control tools.
3. Candidate schemas, annotations, confidence and evidence are inspectable.
4. A browser agent can call a compiled tool and receive structured results.
5. A derived write stays held until an owner binds and ships a handler.
6. Graft can verify the live tool surface on a separate deployed origin.

## Final scene plan

| Time | Scene | Visible proof |
| --- | --- | --- |
| 0:00 to 0:14 | The gap | “WebMCP is new. The web is not.” Graft is introduced as a governed migration layer. |
| 0:14 to 0:31 | Compile | Live Graft capture, seven `graft_` tools, five registered compiled tools and six candidates. ChatGPT discovers 12 page-defined tools and calls `graft_status`, which reports WebMCP available. |
| 0:31 to 0:50 | Inspect | The live `list_products` candidate shows a bounded JSON Schema, read-only and untrusted-content annotations plus confidence evidence. |
| 0:50 to 1:08 | Execute | A real WebMCP `list_products` call returns six structured products from a 20-product collection. |
| 1:08 to 1:25 | Govern | `add_to_basket` remains held at confidence 55 because it changes state and has no bound owner handler. |
| 1:25 to 1:47 | Ship and act | A separate owner site runs the exported adapter. ChatGPT calls `add_to_demo_cart` with `palm-relay` and quantity 2. The owner handler returns a matching Palm Relay cart result. |
| 1:47 to 2:08 | Verify | Graft verifies the owner deployment: six tools live, WebMCP supported, contracts well formed, names unique and exact reviewed match. Verdict: pass, 5 of 5 decisive checks. |
| 2:08 to 2:25 | Close | Discover, review, ship, verify and maintain. Live URL and open-source status remain on screen. |

## Reproducible judge path

1. Open https://graft-webmcp.vercel.app in ChatGPT's in-app browser.
2. Ask: `Use graft_status, then list every available graft_ tool.`
3. Confirm that seven `graft_` tools are discoverable and that `graft_status` reports WebMCP available.
4. Ask: `Call list_products with offset 0 and limit 6.`
5. Inspect the successful call and structured product result.
6. Open https://graft-owner-example.vercel.app.
7. Ask the agent to add two Palm Relay units to the demo cart through `add_to_demo_cart`.
8. Return to Graft and call `graft_verify_url` for the owner site with the expected six tool names.
9. Confirm the 5 of 5 pass and exact contract match.

The owner-site mutation is local demo state. It has no checkout, payment, delivery or remote purchase step.

## Evidence checklist

- Seven live Graft control tools
- Successful `graft_status` invocation
- Explicit WebMCP available result
- Candidate schema and annotations
- Exact `list_products` arguments
- Structured product results
- Held write with its reason
- Separate owner-site origin
- Exact `add_to_demo_cart` arguments and result
- Six deployed owner tools
- External 5 of 5 verification
- Graft live URL and logo

## Pre-upload checks

- Run `npm ci`, `npm test` and `npm run build`.
- Confirm the Graft, owner-site and GitHub URLs return successfully.
- Watch the final encoded video from start to finish with audio enabled.
- Confirm Palm Relay is shown during the Palm Relay tool call.
- Confirm no private tabs, credentials or personal notifications appear.
- Upload the video publicly to YouTube.
- Disclose that the narration is AI-generated with Deepgram.
- Add the public YouTube URL to Devpost.

## Recovery prompts

If an agent does not select the intended tool, use these bounded prompts:

- `Use graft_status and report whether WebMCP is available.`
- `Call list_products with offset 0 and limit 6.`
- `On the owner site, call add_to_demo_cart for palm-relay with quantity 2.`
- `Use graft_verify_url on the owner site and expect get_page_summary,get_page_outline,search_catalog,list_products,get_product,add_to_demo_cart.`

Do not substitute a manual click and describe it as a WebMCP call.

## Official requirements

The authoritative deliverables and timing rules are in the [challenge overview](https://webmcp.devpost.com/) and [official rules](https://webmcp.devpost.com/rules).
