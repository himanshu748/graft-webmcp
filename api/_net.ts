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
  const a = parts[0] ?? -1;
  const b = parts[1] ?? -1;
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

const hostVerdictCache = new Map<string, boolean>();

/**
 * `isObviouslyPrivateHost` only catches literal addresses. A public hostname
 * with a private A record walks straight past it, which is the standard way to
 * reach a cloud metadata endpoint. Egress decisions must resolve the name.
 *
 * Residual risk: Chromium resolves independently, so a DNS entry that answers
 * differently between our lookup and its own (rebinding) is not closed by this.
 * Closing that needs network-level egress control, which a serverless function
 * does not have.
 */
export async function isHostAllowedForEgress(host: string): Promise<boolean> {
  const lower = host.toLowerCase();
  const cached = hostVerdictCache.get(lower);
  if (cached !== undefined) return cached;

  let allowed: boolean;
  if (isObviouslyPrivateHost(lower)) {
    allowed = false;
  } else if (isIP(lower)) {
    allowed = !isPrivateAddress(lower);
  } else {
    try {
      const resolved = await lookup(lower, { all: true });
      allowed = resolved.length > 0 && !resolved.some((entry) => isPrivateAddress(entry.address));
    } catch {
      allowed = false;
    }
  }

  if (hostVerdictCache.size > 500) hostVerdictCache.clear();
  hostVerdictCache.set(lower, allowed);
  return allowed;
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
