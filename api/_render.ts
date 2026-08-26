import { isObviouslyPrivateHost, UA } from "./_net.js";

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
      try {
        const url = new URL(request.url());
        if (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "data:") {
          return void request.abort();
        }
        if (url.protocol !== "data:" && isObviouslyPrivateHost(url.hostname)) {
          return void request.abort();
        }
        if (BLOCKED_RESOURCES.has(request.resourceType())) return void request.abort();
        return void request.continue();
      } catch {
        return void request.abort();
      }
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

async function resolveArgs(): Promise<string[]> {
  if (process.env.GRAFT_CHROME_PATH) {
    return ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"];
  }
  try {
    const chromium = (await import("@sparticuz/chromium")).default;
    return chromium.args;
  } catch {
    return ["--no-sandbox"];
  }
}
