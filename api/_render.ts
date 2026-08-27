import { isHostAllowedForEgress, UA } from "./_net.js";

const RENDER_TIMEOUT_MS = 20_000;
const SETTLE_MS = 1_200;
const BLOCKED_RESOURCES = new Set(["media", "font", "websocket", "manifest"]);

/**
 * Rendering means executing the target's JavaScript, which is a bigger trust
 * step than reading its HTML. Everything below exists to bound that: no
 * credentials, no downloads, no private-network subresources, hard timeout.
 */
export async function renderWithBrowser(target: URL): Promise<string | null> {
  const executablePath = await resolveExecutable();
  if (!executablePath) return null;

  const puppeteer = await import("puppeteer-core");
  const launchArgs = await resolveArgs();

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await puppeteer.launch({
      args: launchArgs,
      executablePath,
      headless: true,
      protocolTimeout: RENDER_TIMEOUT_MS,
    });

    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setJavaScriptEnabled(true);
    await page.setViewport({ width: 1280, height: 900 });
    await page.setCacheEnabled(false);
    await page.setRequestInterception(true);

    page.on("request", (request) => {
      void (async () => {
        try {
          const url = new URL(request.url());
          if (url.protocol === "data:" || url.protocol === "blob:") {
            return void (await request.continue().catch(() => {}));
          }
          if (url.protocol !== "https:" && url.protocol !== "http:") {
            return void (await request.abort().catch(() => {}));
          }
          if (BLOCKED_RESOURCES.has(request.resourceType())) {
            return void (await request.abort().catch(() => {}));
          }
          // Resolves the name rather than pattern-matching it, so a public
          // hostname pointing at a private address does not get through.
          if (!(await isHostAllowedForEgress(url.hostname))) {
            return void (await request.abort().catch(() => {}));
          }
          return void (await request.continue().catch(() => {}));
        } catch {
          return void (await request.abort().catch(() => {}));
        }
      })();
    });

    // A dialog blocks the render loop until something answers it.
    page.on("dialog", (dialog) => void dialog.dismiss().catch(() => {}));

    await page.goto(target.href, {
      waitUntil: "networkidle2",
      timeout: RENDER_TIMEOUT_MS,
    });
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

    return await page.content();
  } catch {
    return null;
  } finally {
    await browser?.close().catch(() => {});
  }
}

async function resolveExecutable(): Promise<string | null> {
  // Local development points at a real Chrome. Serverless uses the packaged one.
  const local = process.env.GRAFT_CHROME_PATH;
  if (local) return local;
  try {
    const chromium = (await import("@sparticuz/chromium")).default;
    return await chromium.executablePath();
  } catch {
    return null;
  }
}

/**
 * Chrome 149 ships WebMCP behind chrome://flags/#enable-webmcp-testing, which
 * a headless launch cannot click. Unknown feature names are ignored, so listing
 * the candidates is cheap and lets a newer build light up on its own.
 */
const WEBMCP_FLAGS = [
  "--enable-features=WebMCP,WebMCPTesting,WebModelContext,AIModelContext",
  "--enable-blink-features=WebMCP,ModelContext",
];

async function resolveArgs(): Promise<string[]> {
  if (process.env.GRAFT_CHROME_PATH) {
    return ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", ...WEBMCP_FLAGS];
  }
  try {
    const chromium = (await import("@sparticuz/chromium")).default;
    return [...chromium.args, ...WEBMCP_FLAGS];
  } catch {
    return ["--no-sandbox", ...WEBMCP_FLAGS];
  }
}

export interface NativeToolReport {
  modelContextPresent: boolean;
  surface: "document" | "navigator" | "none";
  /**
   * Older WebMCP builds return tool listings without the schema or annotation
   * fields. Without this, a missing field is indistinguishable from a browser
   * that will not show it, and the verifier would report false failures.
   */
  exposes: { inputSchema: boolean; annotations: boolean };
  tools: Array<{
    name: string;
    description: string;
    inputSchema: unknown;
    annotations: Record<string, unknown> | null;
  }>;
  userAgent: string;
}

/**
 * Reads a deployed site's own WebMCP surface. This is the other half of the
 * loop: Graft proposes contracts, the owner ships them, and this reports what
 * the browser actually sees afterwards.
 */
export async function readNativeTools(target: URL): Promise<NativeToolReport | null> {
  const executablePath = await resolveExecutable();
  if (!executablePath) return null;

  const puppeteer = await import("puppeteer-core");
  const launchArgs = await resolveArgs();

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await puppeteer.launch({
      args: launchArgs,
      executablePath,
      headless: true,
      protocolTimeout: RENDER_TIMEOUT_MS,
    });
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1280, height: 900 });
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      void (async () => {
        try {
          const url = new URL(request.url());
          if (url.protocol === "data:" || url.protocol === "blob:") {
            return void (await request.continue().catch(() => {}));
          }
          if (url.protocol !== "https:" && url.protocol !== "http:") {
            return void (await request.abort().catch(() => {}));
          }
          if (BLOCKED_RESOURCES.has(request.resourceType())) {
            return void (await request.abort().catch(() => {}));
          }
          if (!(await isHostAllowedForEgress(url.hostname))) {
            return void (await request.abort().catch(() => {}));
          }
          return void (await request.continue().catch(() => {}));
        } catch {
          return void (await request.abort().catch(() => {}));
        }
      })();
    });
    page.on("dialog", (dialog) => void dialog.dismiss().catch(() => {}));

    await page.goto(target.href, { waitUntil: "networkidle2", timeout: RENDER_TIMEOUT_MS });

    // Tools register after hydration, so a single read straight after load
    // would report an empty surface on a site that is perfectly correct.
    return await page.evaluate(async () => {
      /* eslint-disable */
      const doc: any = (globalThis as any).document;
      const nav: any = (globalThis as any).navigator;
      const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const read = () => doc?.modelContext ?? nav?.modelContext ?? null;

      let context = read() as {
        getTools?: () => Promise<Array<Record<string, unknown>>>;
      } | null;
      for (let attempt = 0; attempt < 12 && !context; attempt += 1) {
        await settle(500);
        context = read() as typeof context;
      }
      if (!context || typeof context.getTools !== "function") {
        return {
          modelContextPresent: false,
          surface: "none" as const,
          exposes: { inputSchema: false, annotations: false },
          tools: [],
          userAgent: String(nav?.userAgent ?? ""),
        };
      }

      let tools: Array<Record<string, unknown>> = [];
      for (let attempt = 0; attempt < 12; attempt += 1) {
        tools = (await context.getTools()) ?? [];
        if (tools.length > 0) break;
        await settle(500);
      }

      return {
        modelContextPresent: true,
        surface: doc?.modelContext ? ("document" as const) : ("navigator" as const),
        exposes: {
          // Chrome 149 returns these as null rather than omitting them, so a
          // loose comparison is what actually distinguishes "not shown" here.
          inputSchema: tools.some((tool) => tool.inputSchema != null),
          annotations: tools.some((tool) => tool.annotations != null),
        },
        tools: tools.map((tool) => ({
          name: String(tool.name ?? ""),
          description: String(tool.description ?? ""),
          inputSchema: tool.inputSchema ?? null,
          annotations: (tool.annotations as Record<string, unknown>) ?? null,
        })),
        userAgent: String(nav?.userAgent ?? ""),
      };
    });
  } catch {
    return null;
  } finally {
    await browser?.close().catch(() => {});
  }
}
