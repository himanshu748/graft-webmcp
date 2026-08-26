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
    if (v6.startsWith("fe80")) return true;
    if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
    return false;
  }
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return true;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
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

/**
 * Server-side fetch is an SSRF surface, so every hop is validated rather than
 * only the URL the caller typed.
 */
export async function assertPublicHost(target: URL): Promise<void> {
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    throw new IntakeError(400, "scheme", "Only http and https URLs can be compiled.");
  }
  const host = target.hostname.toLowerCase();
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
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".internal")) {
    return true;
  }
  return isIP(lower) ? isPrivateAddress(lower) : false;
}

export function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}
