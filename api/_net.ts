import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const MAX_BYTES = 3_000_000;
export const TIMEOUT_MS = 12_000;
export const UA =
  "GraftBot/0.1 (+https://github.com/himanshu748/graft-webmcp) snapshot-compiler";

/** Categories we refuse on principle, not because they are hard. */
const DENY_PATTERNS = [
  /(^|\.)(bank|banking|chase|wellsfargo|hsbc|barclays|citi)\./i,
  /(^|\.)(paypal|stripe|venmo|wise)\.com$/i,
  /(^|\.)(login|signin|auth|account|accounts|id)\./i,
  /(^|\.)(gov|nhs)\.[a-z.]+$/i,
  /(^|\.)(mail|inbox|webmail)\./i,
];

export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const v6 = address.toLowerCase();
    if (v6 === "::1" || v6 === "::") return true;
    if (v6.startsWith("fc") || v6.startsWith("fd")) return true;
    // IPv6 link-local covers fe80::/10, including fe9*, fea*, and feb*.
    if (/^fe[89ab]/.test(v6)) return true;
    // Deprecated site-local (fec0::/10), multicast (ff00::/8), and
    // documentation (2001:db8::/32) ranges are not public fetch targets.
    if (/^fe[c-f]/.test(v6) || v6.startsWith("ff")) return true;
    if (/^2001:0?db8(?::|$)/.test(v6)) return true;
    // Transition/translation addresses can encapsulate IPv4 destinations.
    // They are not safe substitutes for directly validated public IPs: 6to4
    // embeds an IPv4 router, Teredo uses IPv4 relays, and NAT64 can translate
    // otherwise blocked RFC1918/loopback addresses.
    if (/^2002(?::|$)/.test(v6)) return true; // 6to4 (2002::/16)
    if (/^2001:(?:0{1,4})?(?::|$)/.test(v6)) return true; // Teredo (2001::/32)
    if (v6.startsWith("64:ff9b:")) return true; // NAT64 well-known/local-use prefixes
    if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
    return false;
  }
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return true;
  const a = parts[0] ?? -1;
  const b = parts[1] ?? -1;
  const c = parts[2] ?? -1;
  const d = parts[3] ?? -1;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  // Reserved, documentation, benchmarking, multicast and future-use space
  // is not a public fetch target even if it is outside RFC1918 private space.
  // 192.0.0.9 and .10 are globally reachable anycast exceptions in IANA's registry.
  if (a === 192 && b === 0 && ((c === 0 && d !== 9 && d !== 10) || c === 2)) return true;
  if (a === 198 && ((b === 18 || b === 19) || (b === 51 && c === 100))) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

export class IntakeError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

// WHATWG URL.hostname includes brackets around IPv6 literals in Node.js.
// net.isIP expects the unbracketed address.
function unbracketIPv6Host(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * Server-side fetch is an SSRF surface, so every hop is validated rather than
 * only the URL the caller typed.
 */
export async function assertPublicHost(target: URL): Promise<void> {
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    throw new IntakeError(400, "scheme", "Only http and https URLs can be compiled.");
  }
  // A snapshot URL is public input, not an authentication channel. Reject
  // userinfo before any DNS lookup or request so URL-embedded credentials
  // cannot be sent to a remote site or echoed in the reported final URL.
  if (target.username || target.password) {
    throw new IntakeError(400, "credentials", "URLs containing embedded credentials are not supported.");
  }
  const host = unbracketIPv6Host(target.hostname.toLowerCase());
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new IntakeError(403, "private", "That host is not reachable from Graft.");
  }
  if (DENY_PATTERNS.some((pattern) => pattern.test(host))) {
    throw new IntakeError(
      403,
      "denylisted",
      "Graft does not compile authentication, banking, mail or government pages.",
      "This is a policy choice, not a technical limit.",
    );
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new IntakeError(403, "private", "That address is inside a private network.");
    }
    return;
  }
  let resolved: Array<{ address: string }>;
  try {
    resolved = await lookup(host, { all: true });
  } catch {
    throw new IntakeError(400, "dns", `Could not resolve ${host}.`);
  }
  if (resolved.some((entry) => isPrivateAddress(entry.address))) {
    throw new IntakeError(403, "private", "That host resolves to a private address.");
  }
}

/** Cheap synchronous screen for subresource requests during a render. */
export function isObviouslyPrivateHost(host: string): boolean {
  const lower = unbracketIPv6Host(host.toLowerCase());
  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".internal")) {
    return true;
  }
  return isIP(lower) ? isPrivateAddress(lower) : false;
}

/**
 * A public DNS answer must not authorize later requests to the same hostname:
 * it may resolve to a private address after a DNS change. In particular, do
 * not reuse an allow verdict across intercepted browser subresource requests.
 *
 * Residual risk: Chromium resolves independently after this check, so a DNS
 * change between our lookup and its connection remains a TOCTOU risk that
 * requires network-level egress restrictions to prevent.
 */
export async function isHostAllowedForEgress(host: string): Promise<boolean> {
  const lower = unbracketIPv6Host(host.toLowerCase());
  if (isObviouslyPrivateHost(lower)) return false;
  if (isIP(lower)) return !isPrivateAddress(lower);

  try {
    const resolved = await lookup(lower, { all: true });
    return resolved.length > 0 && !resolved.some((entry) => isPrivateAddress(entry.address));
  } catch {
    return false;
  }
}

/**
 * A chunked response has no content-length to check, so the cap is enforced
 * while reading. Buffering first and measuring afterwards is how a function
 * runs out of memory.
 */
export async function readCapped(response: Response, limit = MAX_BYTES): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > limit) {
    throw new IntakeError(413, "too-large", "That response is larger than Graft's size limit.");
  }

  const body = response.body;
  if (!body) return "";

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new IntakeError(413, "too-large", "That response is larger than Graft's size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(joined);
}

export function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}
