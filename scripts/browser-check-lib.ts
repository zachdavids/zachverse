// The browser check (ADR 0006): every page loaded in headless Chromium, as a visitor's browser loads it, for what the
// HTTP smoke test cannot see: scripts that throw, console errors, requests that fail, stylesheets that do not apply,
// layouts that scroll sideways, keyboard focus that cannot be seen or reached, and what axe-core's accessibility rules
// find, in light and dark mode; and each page at the other addresses infra/functions/viewer-request.js serves it at,
// and a missing page below it.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import type { Browser, Page } from 'playwright';
import { type SiteFile, siteFiles } from './release-lib.ts';

/**
 * An element as a problem names it: its tag, and its text, or its href when it has none; and the number the page knows
 * it by, which tells two elements with the same name apart: a Tab stop's place among the page's Tab stops, in document
 * order, or, for any other element a Tab press focuses, the next number after them, the same each time.
 */
export interface Named {
  tag: string;
  name: string;
  index: number;
}

/** What the checks read from a rendered page. */
export interface Measure {
  release: string | null;
  /** The href of the page's link rel="canonical", as written, or null when it has none. */
  canonical: string | null;
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
  /**
   * The elements Tab should stop at, in document order, each known by its place here: every focusable one not hidden.
   */
  tabStops: Named[];
}

/**
 * The element a Tab press focused: where it lies from the one focused before it, whether it shows, its box once the
 * browser has scrolled it into view, and the styles that would show its focus.
 */
export interface Focus extends Named {
  /** After the element the press before focused, in document order, which that element itself is not; or the first. */
  forward: boolean;
  /** Neither hidden nor fully transparent, itself or through an ancestor, once it has the focus. */
  visible: boolean;
  outlineStyle: string;
  outlineWidth: string;
  outlineColor: string;
  boxShadow: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Tab presses from a fresh load: each element they focused, until the focus came back to the first or left the page,
 * which ended says happened within TAB_LIMIT presses.
 */
export interface Walk {
  stops: Focus[];
  ended: boolean;
}

/** An axe-core rule the page breaks: its id, how serious axe rates breaking it, and each element that does. */
export interface Violation {
  id: string;
  impact?: string | null;
  targets: string[];
}

/**
 * What measure leaves in the page for measureFocus: the elements the page knows by number (Named), its Tab stops first,
 * and the element the last Tab press focused. Each load opens a new page, so each walk starts with its own.
 */
interface Memory {
  elements: Element[];
  focused?: Element;
}

/** The page's window, as measure and measureFocus share it. */
interface PageWindow {
  browserCheck?: Memory;
}

/** What the browser saw while loading one page, as scripts/browser-check.ts collects it. */
export interface PageReport {
  url: string;
  status: number;
  /** Every request the load sent, its service worker's and a reload's included, for the run's request budget. */
  requests: number;
  pageErrors: string[];
  consoleErrors: { text: string; url: string }[];
  failedRequests: string[];
  responses: { url: string; status: number }[];
  measure: Measure;
  /** With the tab option. */
  walk?: Walk;
  /** With the axe option. */
  violations?: Violation[];
}

/** What open does besides loading the page and measuring it. */
export interface LoadOptions {
  /** Reloads the page once it has loaded, as a visitor's refresh does, and reports on the reload. */
  reload?: boolean;
  /** Presses Tab until the focus comes back to the first stop or leaves the page (Walk). */
  tab?: boolean;
  /** Runs axe-core's rules (AXE_TAGS). */
  axe?: boolean;
  /** Loads the page in dark mode (prefers-color-scheme: dark), which the site's stylesheet gives its own colours. */
  dark?: boolean;
}

/** Loads url in a window width pixels wide and reports on it. */
export type Open = (url: string, width: number, options: LoadOptions) => Promise<PageReport>;

/** A page of the site, from the table in src/content/site.ts: its address, or null for the 404 page. */
export interface SitePage {
  readonly path: string | null;
}

export interface Target {
  /** Where the pages are: a local server's origin, or the site's own. */
  origin: string;
  /** The site's own origin, which every page's canonical URL names, wherever the pages are served from. */
  canonicalOrigin: string;
  /** The release the pages must name, or null for a build that names none. */
  release: string | null;
  /** A path segment no release has, different on each run, for the missing pages. */
  probe: string;
}

export interface Result {
  passed: string[];
  failures: string[];
}

/**
 * Runs in the page, through Playwright, and in jsdom in the tests, so it uses only the DOM: what the checks read from
 * the rendered page. It leaves the page's Tab stops in the page, for measureFocus.
 */
export function measure(): Measure {
  const heading = document.querySelector('h1');
  const box = heading?.getBoundingClientRect();
  const root = document.scrollingElement ?? document.documentElement;
  // Chromium's checkVisibility also sees an ancestor's opacity; jsdom lacks it, and its own style is what it has.
  const visible = (element: Element, opacity: boolean) => {
    if (typeof element.checkVisibility === 'function') {
      return element.checkVisibility({ opacityProperty: opacity, visibilityProperty: true });
    }
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && !(opacity && style.opacity === '0');
  };
  const sheetRules = (link: HTMLLinkElement) => {
    try {
      return link.sheet ? link.sheet.cssRules.length : null;
    } catch {
      // A sheet from another origin hides its rules; the site serves its own.
      return null;
    }
  };
  // What Chromium's Tab reaches: links, buttons, form fields, frames, a details element's summary, a media player's
  // controls, editable regions, and any element with a tabindex; but not one that is disabled, inert, or hidden, or
  // whose tabindex attribute leaves its tabIndex negative. That is a negative value, which takes an element out of the
  // order on purpose, as a roving tabindex does in a toolbar, or an invalid one on an element Tab skips anyway. Without
  // the attribute, tabIndex is no guide: Chromium gives an editable region -1, though Tab reaches it. A transparent
  // element still counts, since Tab reaches it, as it does a skip link shown on focus; measureFocus reads whether it
  // shows then. Left out: a radio group, which is one Tab stop; an image map's areas, which have no box of their own to
  // judge; and a scrolling region, which Chromium stops at too, and axe-core's scrollable-region-focusable rule
  // reports. The site has none of them.
  const focusable = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    'iframe',
    'details > summary:first-of-type',
    'audio[controls]',
    'video[controls]',
    '[contenteditable]:not([contenteditable="false"])',
    '[tabindex]',
  ].join(', ');
  const tabStops = [...document.querySelectorAll<HTMLElement>(focusable)].filter(
    (element) =>
      !(element.hasAttribute('tabindex') && element.tabIndex < 0) &&
      !element.matches(':disabled') &&
      element.closest('[inert]') === null &&
      visible(element, false),
  );
  // Kept in the page, where measureFocus knows a Tab stop by its place in this list, wherever the page moves it.
  (window as unknown as PageWindow).browserCheck = { elements: tabStops };
  return {
    release: document.querySelector('meta[name="zachverse-release"]')?.getAttribute('content') ?? null,
    canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null,
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
            visible: visible(heading, true),
          }
        : null,
    stylesheets: [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map((link) => ({
      href: link.href,
      rules: sheetRules(link),
    })),
    scripts: [...document.querySelectorAll<HTMLScriptElement>('script[src]')].map((script) => script.src),
    tabStops: tabStops.map((element, index) => ({
      tag: element.tagName.toLowerCase(),
      name: element.textContent!.replace(/\s+/g, ' ').trim() || element.getAttribute('href') || '',
      index,
    })),
  };
}

/**
 * Runs in the page after a Tab press, as measure does: the focused element, named and known as measure knows the Tab
 * stops; where it lies from the element focused before it; and, once the browser has scrolled it into view, its box,
 * whether it shows, and the styles that would show its focus. A smooth scroll can still be moving the element when the
 * press returns, so the box is read once it has held still for two animation frames, as Playwright's own stability
 * check reads one, or once settleMs have passed.
 */
export async function measureFocus(settleMs: number): Promise<Focus | null> {
  const element = document.activeElement;
  if (element === null || element === document.body) return null;
  // The element itself is what is looked up, so the page may add, remove, or move others in between, as a tooltip
  // shown on focus does.
  const memory = ((window as unknown as PageWindow).browserCheck ??= { elements: [] });
  let index = memory.elements.indexOf(element);
  if (index === -1) index = memory.elements.push(element) - 1;
  // compareDocumentPosition gives the element itself 0: no step forward.
  const { focused } = memory;
  const forward =
    focused === undefined || (focused.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  memory.focused = element;
  const place = () => {
    const { left, right, top, bottom } = element.getBoundingClientRect();
    return { left, right, top, bottom };
  };
  let box = place();
  const start = performance.now();
  let still = 0;
  while (still < 2 && performance.now() - start < settleMs) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const next = place();
    still = JSON.stringify(next) === JSON.stringify(box) ? still + 1 : 0;
    box = next;
  }
  const style = getComputedStyle(element);
  return {
    tag: element.tagName.toLowerCase(),
    // An element's textContent is never null.
    name: element.textContent!.replace(/\s+/g, ' ').trim() || element.getAttribute('href') || '',
    index,
    forward,
    // As measure reads the heading: Chromium's checkVisibility, or, in jsdom, the element's own style.
    visible:
      typeof element.checkVisibility === 'function'
        ? element.checkVisibility({ opacityProperty: true, visibilityProperty: true })
        : style.visibility !== 'hidden' && style.opacity !== '0',
    outlineStyle: style.outlineStyle,
    outlineWidth: style.outlineWidth,
    outlineColor: style.outlineColor,
    boxShadow: style.boxShadow,
    ...box,
  };
}

/** The rules axe-core checks: WCAG 2.0, 2.1, and 2.2 at levels A and AA, and Deque's best practices. */
export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] as const;

/**
 * Runs in the page once axe-core has been added to it, as measure does: each rule with one of tags that the page
 * breaks, and the elements that break it.
 */
export async function audit(tags: readonly string[]): Promise<Violation[]> {
  const { axe } = window as unknown as { axe: typeof import('axe-core') };
  const { violations } = await axe.run(document, { runOnly: { type: 'tag', values: [...tags] } });
  return violations.map(({ id, impact, nodes }) => ({
    id,
    impact,
    targets: nodes.map(({ target }) => target.flat().join(' ')),
  }));
}

/** Problems with one page: its status, what failed while it loaded, what it looks like, and the URLs it names. */
export function pageProblems(
  report: PageReport,
  expected: { status: number; release: string | null; canonical: string | null },
): string[] {
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
  if (page.canonical !== expected.canonical) {
    found.push(`the page names canonical URL ${page.canonical ?? '(none)'}, not ${expected.canonical ?? '(none)'}`);
  }
  return found;
}

// A colour that shows nothing: transparent, or an alpha of 0, written after three commas, as in rgba(), or after a
// slash, as in the oklch(), lab(), and color() values Chromium computes for other colour spaces (src/styles.test.ts reads
// authored colours the same way).
const ZERO_ALPHA =
  /^(?:transparent|#[\da-f]{3}0|#[\da-f]{6}00|[a-z-]+\((?:[^,()]*,){3}\s*0*\.?0+%?\s*\)|[a-z-]+\([^()]*\/\s*0*\.?0+%?\s*\))$/i;

/** A computed box-shadow's layers, split at the commas outside parentheses. */
function shadowLayers(boxShadow: string): string[] {
  const layers: string[] = [];
  let depth = 0;
  let start = 0;
  [...boxShadow].forEach((character, i) => {
    if (character === '(') depth++;
    else if (character === ')') depth--;
    else if (character === ',' && depth === 0) {
      layers.push(boxShadow.slice(start, i).trim());
      start = i + 1;
    }
  });
  return [...layers, boxShadow.slice(start).trim()];
}

/** Whether a computed box-shadow layer shows: a colour, which Chromium writes first, that is not transparent, and some size. */
function layerShows(layer: string): boolean {
  const [, colour, rest] = /^([a-z-]+\([^()]*\)|\S*)\s*(.*)$/i.exec(layer)!;
  const lengths = rest!.split(/\s+/).map((token) => Number.parseFloat(token)).filter((length) => !Number.isNaN(length));
  return !ZERO_ALPHA.test(colour!) && lengths.some((length) => length !== 0);
}

/**
 * An element as a problem names it: its tag, then its text or href, if it has either, cut to 60 characters, since a
 * link around a card would put the card's whole text in every line.
 */
function named({ tag, name }: Named): string {
  const characters = [...name];
  const shown = characters.length > 60 ? `${characters.slice(0, 59).join('')}…` : name;
  return name === '' ? `<${tag}>` : `<${tag}> ${JSON.stringify(shown)}`;
}

/** Problems with one Tab stop's focus: the element must show that it has it. */
export function focusProblems(focus: Focus): string[] {
  const outlined = focus.outlineStyle !== 'none' && focus.outlineWidth !== '0px' && !ZERO_ALPHA.test(focus.outlineColor);
  const shadowed = focus.boxShadow !== 'none' && shadowLayers(focus.boxShadow).some(layerShows);
  return outlined || shadowed ? [] : [`the focused ${named(focus)} shows no focus indicator`];
}

/**
 * Problems with the Tab walk: Tab must stop at each of the page's Tab stops once, in document order, and then come back
 * to the first or leave the page; and each stop must show, with its focus, wholly on the screen once the browser has
 * scrolled it into view.
 */
export function tabProblems(report: PageReport): string[] {
  const { measure: page, walk } = report;
  if (walk === undefined || walk.stops.length === 0) return ['a Tab press focused nothing'];
  const { stops } = walk;
  const found: string[] = [];
  const expected = new Set(page.tabStops.map(({ index }) => index));
  for (const stop of stops) {
    found.push(...focusProblems(stop));
    if (!stop.visible) found.push(`the focused ${named(stop)} is hidden, or fully transparent`);
    if (stop.left < 0 || stop.right > page.clientWidth || stop.top < 0 || stop.bottom > page.viewportHeight) {
      found.push(`the focused ${named(stop)} runs off the screen`);
    }
    if (!expected.has(stop.index)) found.push(`Tab stops at ${named(stop)}, which is not one of the page's Tab stops`);
  }
  const reached = new Set(stops.map(({ index }) => index));
  for (const element of page.tabStops) {
    if (!reached.has(element.index)) found.push(`Tab never reaches ${named(element)}`);
  }
  // The first press that does not move the focus forward: back to an earlier element, or not off the element it was
  // on. The second is what a press inside a frame, a shadow root, or a media player's controls looks like, since the
  // page's active element stays the one that holds them, so this check cannot judge what has the focus. Stopping at an
  // element twice, apart, takes a step back in between, so this covers that too; coming back to the first stop ends
  // the walk.
  const back = stops.findIndex((stop, i) => i > 0 && !stop.forward);
  if (back > 0) {
    const [from, to] = [stops[back - 1]!, stops[back]!];
    found.push(
      from.index === to.index
        ? `Tab stops at ${named(to)} twice in a row`
        : `Tab goes back from ${named(from)} to ${named(to)}`,
    );
  }
  if (!walk.ended) found.push(`${TAB_LIMIT} Tab presses neither came back to the first stop nor left the page`);
  // A focus trap repeats the problems of the stops it cycles through; each is reported once.
  return [...new Set(found)];
}

/** axe-core's findings: each rule the page breaks, how serious axe rates it, and up to three elements that break it. */
export function axeProblems(report: PageReport): string[] {
  if (report.violations === undefined) return ['axe-core did not run'];
  return report.violations.map(({ id, impact, targets }) => {
    const more = targets.length > 3 ? `, and ${targets.length - 3} more` : '';
    return `axe-core rule ${id} (${impact ?? 'no impact given'}) fails at ${targets.slice(0, 3).join(', ')}${more}`;
  });
}

type Check = [string, () => Promise<string[]>];
type Expected = Parameters<typeof pageProblems>[1];

/**
 * Checks every page in pages, one load at a time. A page with an address is loaded in a 320-pixel window, where Tab
 * walks its stops, and in a 768- and a 1280-pixel one, passing axe-core's rules in each; then in dark mode, in a
 * 320-pixel window again, with the walk and the rules; and then with a query string. A page below the root is also
 * loaded without its trailing slash, and reloaded, and a missing page below it must get the 404 page. The 404 page
 * itself is loaded at a path no release has, in light and in dark mode, with the walk and the rules. All the loads
 * together must stay within BROWSER_REQUEST_BUDGET.
 */
export async function browserCheck(target: Target, pages: readonly SitePage[], open: Open): Promise<Result> {
  const { origin, canonicalOrigin, release, probe } = target;
  let loads = 0;
  let requests = 0;
  // A load that throws reports nothing, so its requests go uncounted; its check fails anyway.
  const load = async (url: string, width: number, options: LoadOptions) => {
    const report = await open(url, width, options);
    loads++;
    requests += report.requests;
    return report;
  };
  // A load in a 320-pixel window that walks the Tab stops and runs axe-core's rules too.
  const audited = (url: string, expected: Expected, options: LoadOptions) => async () => {
    const report = await load(url, 320, { tab: true, axe: true, ...options });
    return [...pageProblems(report, expected), ...tabProblems(report), ...axeProblems(report)];
  };
  const missing = { status: 404, release, canonical: null };
  const checks: Check[] = [];
  for (const { path } of pages) {
    if (path === null) {
      const url = `${origin}/${probe}/`;
      checks.push(
        [
          "a missing page shows the 404 page, with status 404, which works, passes axe-core's rules, and shows " +
            'keyboard focus at every Tab stop',
          audited(url, missing, {}),
        ],
        [
          "a missing page shows the 404 page in dark mode, with status 404, which works, passes axe-core's rules, " +
            'and shows keyboard focus at every Tab stop',
          audited(url, missing, { dark: true }),
        ],
      );
      continue;
    }
    const url = `${origin}${path}`;
    const expected = { status: 200, release, canonical: `${canonicalOrigin}${path}` };
    checks.push(
      [
        `the page at ${path} works in a 320-pixel window, passes axe-core's rules, and shows keyboard focus at every ` +
          'Tab stop',
        audited(url, expected, {}),
      ],
      ...[768, 1280].map((width): Check => [
        `the page at ${path} works in a ${width}-pixel window, and passes axe-core's rules`,
        async () => {
          const report = await load(url, width, { axe: true });
          return [...pageProblems(report, expected), ...axeProblems(report)];
        },
      ]),
      [
        `the page at ${path} works in a 320-pixel window in dark mode, passes axe-core's rules, and shows keyboard ` +
          'focus at every Tab stop',
        audited(url, expected, { dark: true }),
      ],
    );
    const query: Check = [
      `the page at ${path} loads with a query string, naming its canonical URL`,
      async () => pageProblems(await load(`${url}?from=browser-check`, 320, {}), expected),
    ];
    // The root has no address without its trailing slash, and a missing page below it is the 404 page's own check.
    if (path === '/') {
      checks.push(query);
      continue;
    }
    // Every address in the table ends in a slash (src/content/content.test.ts), and the viewer-request function serves
    // the same page without it.
    checks.push(
      [
        `the page at ${path} loads at ${path.slice(0, -1)} too, naming its canonical URL`,
        async () => pageProblems(await load(url.slice(0, -1), 320, {}), expected),
      ],
      query,
      [
        `the page at ${path} works when reloaded`,
        async () => pageProblems(await load(url, 320, { reload: true }), expected),
      ],
      [
        `a missing page below ${path} gets the 404 page, with status 404`,
        async () => pageProblems(await load(`${url}${probe}/`, 320, {}), missing),
      ],
    );
  }
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
  const sent = `the ${loads} page loads sent ${requests} requests`;
  if (requests > BROWSER_REQUEST_BUDGET) {
    failures.push(
      `${sent}, more than the budget of ${BROWSER_REQUEST_BUDGET}, a fifth of the web ACL's rate limit for one ` +
        'address (ADR 0007)',
    );
  } else {
    passed.push(`${sent}, within the budget of ${BROWSER_REQUEST_BUDGET}`);
  }
  return { passed, failures };
}

// The content types CloudFront compresses, of those release-lib.ts gives files, and the sizes it compresses: 1,000 to
// 10,000,000 bytes (https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/ServingCompressedFiles.html,
// read 2026-10-18). The distribution's behavior compresses (infra/lib/site-stack.ts).
const COMPRESSED_TYPES = /^(?:text\/(?:html|javascript|css|plain)|application\/(?:json|xml)|image\/svg\+xml)(?:;|$)/;

/**
 * The encoding CloudFront would send file in to a browser that accepts the encodings named in acceptEncoding: Brotli
 * when the browser takes both it and gzip, as CloudFront prefers it, and none for a type or size it leaves alone.
 */
export function encodingFor(file: Pick<SiteFile, 'contentType' | 'body'>, acceptEncoding = ''): 'br' | 'gzip' | null {
  const { length } = file.body;
  if (!COMPRESSED_TYPES.test(file.contentType) || length < 1000 || length > 10_000_000) return null;
  const accepted = acceptEncoding.toLowerCase().split(',').map((part) => part.split(';')[0]!.trim());
  if (accepted.includes('br')) return 'br';
  return accepted.includes('gzip') ? 'gzip' : null;
}

/**
 * Serves the files in dir as CloudFront serves the bucket: a directory path gets its index.html, through the
 * viewer-request function's mapping, a missing file gets the 404 page with status 404, and a file CloudFront would
 * compress goes out compressed, so a browser downloads what it would from the site. The files are read once, up
 * front, and a request only looks one up by name.
 */
export async function serve(dir: string): Promise<{ origin: string; close: () => Promise<void> }> {
  const files = new Map(siteFiles(dir).map((file) => [file.path, file]));
  const notFound = files.get('404.html');
  if (notFound === undefined) throw new Error(`${dir} has no 404.html to serve.`);
  const compressed = new Map<string, Buffer>();
  const server = createServer((req, res) => {
    // A request an HTTP server receives always has a URL.
    const path = new URL(req.url!, 'http://localhost').pathname;
    const name = path.slice(path.lastIndexOf('/') + 1);
    const key = path.slice(1) + (name === '' ? 'index.html' : name.includes('.') ? '' : '/index.html');
    const file = files.get(key);
    const served = file ?? notFound;
    const encoding = encodingFor(served, req.headers['accept-encoding']);
    const headers: Record<string, string> = { 'content-type': served.contentType, 'cache-control': served.cacheControl };
    let body = served.body;
    if (encoding !== null) {
      const cacheKey = `${encoding} ${served.path}`;
      body = compressed.get(cacheKey) ?? (encoding === 'br' ? brotliCompressSync(body) : gzipSync(body));
      compressed.set(cacheKey, body);
      headers['content-encoding'] = encoding;
    }
    res.writeHead(file ? 200 : 404, headers);
    res.end(body);
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

/**
 * The most Tab presses one walk makes. A walk that by then has neither come back to its first stop nor left the page
 * fails, as one caught in a focus trap would.
 */
export const TAB_LIMIT = 100;

/**
 * The longest a Tab stop is given to hold still before it is measured. Chromium's smooth scroll to a focused element
 * takes up to about 1.5 seconds, however far away the element is (measured in its headless shell, version 153, from
 * 800 to 200,000 pixels away); an element still moving after this is measured where it is.
 */
export const FOCUS_SETTLE_MS = 3000;

/**
 * The most requests one browser check may send to the site. They all come from one runner address, which the web
 * ACL's rate limit counts (infra/lib/site-stack.ts, RATE_LIMIT_PER_IP), so this is a fifth of that limit, leaving the
 * rest to visitors who share the address; tests/repo-policy.test.ts keeps the two in step (docs/phase-2-inputs.md,
 * "Browser check").
 */
export const BROWSER_REQUEST_BUDGET = 200;

// axe-core's browser build, read when a load first runs its rules, and kept: a module that imports only encodingFor,
// serve, or the budget reads nothing, and needs no axe-core installed. open adds it to each page it audits as an inline
// script, so it costs the site no request; a Content-Security-Policy that blocks inline scripts would block it too
// (docs/phase-2-inputs.md, "Headers").
let axeSource: string | undefined;

/**
 * Presses Tab from a fresh load until the focus comes back to its first stop from another element, or leaves the
 * page, at most TAB_LIMIT times.
 */
async function walkTabStops(page: Page): Promise<Walk> {
  const stops: Focus[] = [];
  while (stops.length < TAB_LIMIT) {
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(measureFocus, FOCUS_SETTLE_MS);
    // A press that leaves the focus on the first stop, as inside a frame, has not come back to it.
    if (focus === null || (focus.index === stops[0]?.index && focus.index !== stops.at(-1)!.index)) {
      return { stops, ended: true };
    }
    stops.push(focus);
  }
  return { stops, ended: false };
}

/**
 * Loads url in its own browser context, in light mode unless options asks for dark, collecting what failed and counting
 * the requests it sent, and measures the page; options adds a reload before the measure, and the Tab walk and
 * axe-core's rules after it.
 */
export async function open(browser: Browser, url: string, width: number, options: LoadOptions): Promise<PageReport> {
  const context = await browser.newContext({
    viewport: { width, height: 800 },
    colorScheme: options.dark ? 'dark' : 'light',
  });
  try {
    const page = await context.newPage();
    const report: Omit<PageReport, 'status' | 'measure' | 'walk' | 'violations'> = {
      url,
      requests: 0,
      pageErrors: [],
      consoleErrors: [],
      failedRequests: [],
      responses: [],
    };
    // Counted on the context, which Chromium tells of the requests of the page, its workers, and its service worker,
    // where the page hears of only the first two. A request the browser's cache answers counts too, so the count is
    // never below what reaches the site.
    context.on('request', () => report.requests++);
    page.on('pageerror', (error) => report.pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') report.consoleErrors.push({ text: message.text(), url: message.location().url });
    });
    page.on('requestfailed', (request) => report.failedRequests.push(`${request.url()} (${request.failure()?.errorText})`));
    page.on('response', (response) => report.responses.push({ url: response.url(), status: response.status() }));
    // Waits until the network has been idle for half a second, so scripts and stylesheets have loaded and run, then a
    // little longer, for errors a script reports late.
    let response = await page.goto(url, { waitUntil: 'networkidle' });
    // Chromium revalidates the page on a reload and reports the status of the copy it shows: 200, even when the
    // server answered 304, as CloudFront does for a page whose ETag has not changed.
    if (options.reload) response = await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(SETTLE_MS);
    const measured = await page.evaluate(measure);
    // The walk starts from the fresh load, with nothing focused, where a visitor's first Tab press starts.
    const walk = options.tab ? await walkTabStops(page) : undefined;
    let violations: Violation[] | undefined;
    if (options.axe) {
      axeSource ??= readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
      await page.addScriptTag({ content: axeSource });
      violations = await page.evaluate(audit, AXE_TAGS);
    }
    return { ...report, status: response?.status() ?? 0, measure: measured, walk, violations };
  } finally {
    await context.close();
  }
}
