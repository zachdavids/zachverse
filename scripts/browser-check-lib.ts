// The browser check (ADR 0006): the pages loaded in headless Chromium, as a visitor's browser loads them, for what the
// HTTP smoke test cannot see: scripts that throw, console errors, requests that fail, stylesheets that do not apply,
// layouts that scroll sideways on a phone, and keyboard focus that cannot be seen.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Browser } from 'playwright';
import { siteFiles } from './release-lib.ts';

/** What the checks read from a rendered page. */
export interface Measure {
  release: string | null;
  scrollWidth: number;
  clientWidth: number;
  /** The window's height, which the main heading must fit inside. */
  viewportHeight: number;
  heading: {
    text: string;
    left: number;
    right: number;
    top: number;
    bottom: number;
    width: number;
    height: number;
    /** Neither hidden nor fully transparent, itself or through an ancestor. */
    visible: boolean;
  } | null;
  /** Each linked stylesheet and its rule count, or null when it did not load. */
  stylesheets: { href: string; rules: number | null }[];
  scripts: string[];
}

/** The element a Tab press focused, and the styles that would show it. */
export interface Focus {
  tag: string;
  outlineStyle: string;
  outlineWidth: string;
  outlineColor: string;
  boxShadow: string;
}

/** What the browser saw while loading one page, as scripts/browser-check.ts collects it. */
export interface PageReport {
  url: string;
  status: number;
  pageErrors: string[];
  consoleErrors: { text: string; url: string }[];
  failedRequests: string[];
  responses: { url: string; status: number }[];
  measure: Measure;
  focus?: Focus | null;
}

/** Loads url in a window width pixels wide and reports on it; with tab, it also presses Tab and reports the focus. */
export type Open = (url: string, width: number, tab: boolean) => Promise<PageReport>;

export interface Target {
  /** Where the pages are: a local server's origin, or the site's own. */
  origin: string;
  /** The release the pages must name, or null for a build that names none. */
  release: string | null;
  /** A path segment no release has, different on each run, for the 404 page. */
  probe: string;
}

export interface Result {
  passed: string[];
  failures: string[];
}

/**
 * Runs in the page, through Playwright, and in jsdom in the tests, so it uses only the DOM: what the checks read from
 * the rendered page.
 */
export function measure(): Measure {
  const heading = document.querySelector('h1');
  const box = heading?.getBoundingClientRect();
  const root = document.scrollingElement ?? document.documentElement;
  // Chromium's checkVisibility also sees an ancestor's opacity; jsdom lacks it, and its own style is what it has.
  const visible = (element: Element) => {
    if (typeof element.checkVisibility === 'function') {
      return element.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    }
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.opacity !== '0';
  };
  const sheetRules = (link: HTMLLinkElement) => {
    try {
      return link.sheet ? link.sheet.cssRules.length : null;
    } catch {
      // A sheet from another origin hides its rules; the site serves its own.
      return null;
    }
  };
  return {
    release: document.querySelector('meta[name="zachverse-release"]')?.getAttribute('content') ?? null,
    scrollWidth: root.scrollWidth,
    clientWidth: root.clientWidth,
    viewportHeight: window.innerHeight,
    heading:
      heading && box
        ? {
            // An element's textContent is never null.
            text: heading.textContent!.trim(),
            left: box.left,
            right: box.right,
            top: box.top,
            bottom: box.bottom,
            width: box.width,
            height: box.height,
            visible: visible(heading),
          }
        : null,
    stylesheets: [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map((link) => ({
      href: link.href,
      rules: sheetRules(link),
    })),
    scripts: [...document.querySelectorAll<HTMLScriptElement>('script[src]')].map((script) => script.src),
  };
}

/** Runs in the page after a Tab press, as measure does: the focused element and the styles that would show it. */
export function measureFocus(): Focus | null {
  const element = document.activeElement;
  if (element === null || element === document.body) return null;
  const style = getComputedStyle(element);
  return {
    tag: element.tagName.toLowerCase(),
    outlineStyle: style.outlineStyle,
    outlineWidth: style.outlineWidth,
    outlineColor: style.outlineColor,
    boxShadow: style.boxShadow,
  };
}

/** Problems with one page: its status, what failed while it loaded, and what it looks like. */
export function pageProblems(report: PageReport, expected: { status: number; release: string | null }): string[] {
  const found: string[] = [];
  if (report.status !== expected.status) found.push(`status ${report.status}, not ${expected.status}`);
  // A 404 page's own response is the one failure its browser should see, and Chromium logs it as an error too: that one
  // message, at the page's own URL, and no other.
  const ownFailure = (url: string) => expected.status === 404 && url === report.url;
  const ownFailureLogged = ({ text, url }: { text: string; url: string }) =>
    ownFailure(url) && text.startsWith('Failed to load resource: the server responded with a status of 404');
  found.push(...report.pageErrors.map((error) => `a script threw: ${error}`));
  found.push(...report.consoleErrors.filter((error) => !ownFailureLogged(error)).map(({ text }) => `console error: ${text}`));
  found.push(...report.failedRequests.map((request) => `a request failed: ${request}`));
  found.push(
    ...report.responses
      .filter(({ url, status }) => status >= 400 && !ownFailure(url))
      .map(({ url, status }) => `${url} got status ${status}`),
  );
  const { measure: page } = report;
  for (const src of page.scripts) {
    if (!report.responses.some(({ url, status }) => url === src && status < 400)) found.push(`script ${src} did not load`);
  }
  if (page.stylesheets.length === 0) found.push('the page links no stylesheet');
  for (const { href, rules } of page.stylesheets) {
    if (!rules) found.push(`stylesheet ${href} did not load, or has no rules`);
  }
  if (page.scrollWidth > page.clientWidth) {
    found.push(`the page scrolls sideways: ${page.scrollWidth}px wide in a ${page.clientWidth}px window`);
  }
  const { heading } = page;
  if (heading === null || heading.text === '' || heading.width === 0 || heading.height === 0) {
    found.push('the page shows no main heading');
  } else if (!heading.visible) {
    found.push('the main heading is hidden, or fully transparent');
  } else if (
    heading.left < 0 ||
    heading.right > page.clientWidth ||
    heading.top < 0 ||
    heading.bottom > page.viewportHeight
  ) {
    found.push('the main heading runs off the screen');
  }
  if (page.release !== expected.release) {
    found.push(`the page names release ${page.release ?? '(none)'}, not ${expected.release ?? '(none)'}`);
  }
  return found;
}

// A computed colour that shows nothing: Chromium writes a fully transparent one as rgba(r, g, b, 0).
const TRANSPARENT = /^(?:transparent|rgba\([^)]*,\s*0(?:\.0+)?\))$/;

/** Problems with where a Tab press put the focus: it must land on an element that shows it has the focus. */
export function focusProblems(focus: Focus | null | undefined): string[] {
  if (!focus) return ['a Tab press focused nothing'];
  const outlined =
    focus.outlineStyle !== 'none' && focus.outlineWidth !== '0px' && !TRANSPARENT.test(focus.outlineColor);
  // A shadow whose colours are all transparent shows nothing; one in a colour syntax this cannot read gets the benefit.
  const colours = focus.boxShadow.match(/rgba?\([^)]*\)/g) ?? [];
  const shadowed =
    focus.boxShadow !== 'none' && !(colours.length > 0 && colours.every((colour) => TRANSPARENT.test(colour)));
  return outlined || shadowed ? [] : [`the focused <${focus.tag}> shows no focus indicator`];
}

/** Checks the home page at a phone's width and a desktop's, its keyboard focus, and the 404 page. */
export async function browserCheck(target: Target, open: Open): Promise<Result> {
  const home = `${target.origin}/`;
  const missing = `${target.origin}/${target.probe}/`;
  const { release } = target;
  const checks: [string, () => Promise<string[]>][] = [
    [
      'the home page works in a 320-pixel window, and shows keyboard focus',
      async () => {
        const report = await open(home, 320, true);
        return [...pageProblems(report, { status: 200, release }), ...focusProblems(report.focus)];
      },
    ],
    [
      'the home page works in a 1280-pixel window',
      async () => pageProblems(await open(home, 1280, false), { status: 200, release }),
    ],
    [
      'a missing page shows the 404 page, with status 404, and works',
      async () => pageProblems(await open(missing, 320, false), { status: 404, release }),
    ],
  ];
  const passed: string[] = [];
  const failures: string[] = [];
  for (const [name, check] of checks) {
    let problems: string[];
    try {
      problems = await check();
    } catch (error) {
      problems = [error instanceof Error ? error.message : String(error)];
    }
    if (problems.length === 0) passed.push(name);
    else failures.push(...problems.map((problem) => `${name}: ${problem}`));
  }
  return { passed, failures };
}

/**
 * Serves the files in dir as CloudFront serves the bucket: a directory path gets its index.html, through the
 * viewer-request function's mapping, and a missing file gets the 404 page with status 404. The files are read once,
 * up front, and a request only looks one up by name.
 */
export async function serve(dir: string): Promise<{ origin: string; close: () => Promise<void> }> {
  const files = new Map(siteFiles(dir).map((file) => [file.path, file]));
  const notFound = files.get('404.html');
  if (notFound === undefined) throw new Error(`${dir} has no 404.html to serve.`);
  const server = createServer((req, res) => {
    // A request an HTTP server receives always has a URL.
    const path = new URL(req.url!, 'http://localhost').pathname;
    const name = path.slice(path.lastIndexOf('/') + 1);
    const key = path.slice(1) + (name === '' ? 'index.html' : name.includes('.') ? '' : '/index.html');
    const file = files.get(key);
    const served = file ?? notFound;
    res.writeHead(file ? 200 : 404, { 'content-type': served.contentType, 'cache-control': served.cacheControl });
    res.end(served.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** How long a page is watched after its network goes quiet, before it is measured. */
export const SETTLE_MS = 2000;

/** Loads url in its own browser context, collecting what failed, and measures the page; with tab, also the focus. */
export async function open(browser: Browser, url: string, width: number, tab: boolean): Promise<PageReport> {
  const context = await browser.newContext({ viewport: { width, height: 800 } });
  try {
    const page = await context.newPage();
    const report: Omit<PageReport, 'status' | 'measure' | 'focus'> = {
      url,
      pageErrors: [],
      consoleErrors: [],
      failedRequests: [],
      responses: [],
    };
    page.on('pageerror', (error) => report.pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') report.consoleErrors.push({ text: message.text(), url: message.location().url });
    });
    page.on('requestfailed', (request) => report.failedRequests.push(`${request.url()} (${request.failure()?.errorText})`));
    page.on('response', (response) => report.responses.push({ url: response.url(), status: response.status() }));
    // Waits until the network has been idle for half a second, so scripts and stylesheets have loaded and run, then a
    // little longer, for errors a script reports late.
    const response = await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(SETTLE_MS);
    const measured = await page.evaluate(measure);
    let focus;
    if (tab) {
      await page.keyboard.press('Tab');
      focus = await page.evaluate(measureFocus);
    }
    return { ...report, status: response?.status() ?? 0, measure: measured, focus };
  } finally {
    await context.close();
  }
}
