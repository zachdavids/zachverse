import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import type { Browser } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AXE_TAGS,
  axeProblems,
  BROWSER_REQUEST_BUDGET,
  browserCheck,
  FOCUS_SETTLE_MS,
  type Focus,
  focusProblems,
  type Measure,
  type Named,
  type Open,
  open,
  type PageReport,
  SETTLE_MS,
  pageProblems,
  serve,
  TAB_LIMIT,
  tabProblems,
} from './browser-check-lib.ts';

const RELEASE = '0123456789abcdef0123456789abcdef01234567';
const ORIGIN = 'https://example.com';

// The page's two Tab stops, as measure lists them, and as measureFocus reads one once a Tab press has focused it, after
// the one before it in document order.
const RESUME: Named = { tag: 'a', name: 'Résumé', index: 0 };
const EMAIL: Named = { tag: 'a', name: 'mailto:someone@example.com', index: 1 };
const focused = (element: Named, change: Partial<Focus> = {}): Focus => ({
  ...element,
  forward: true,
  visible: true,
  outlineStyle: 'solid',
  outlineWidth: '2px',
  outlineColor: 'rgb(0, 0, 0)',
  boxShadow: 'none',
  left: 16,
  right: 120,
  top: 300,
  bottom: 340,
  ...change,
});

// A page as it should be: status 200, everything loaded, nothing wider than the window, its canonical URL named, and
// each Tab stop focused once, in order, showing its focus.
const goodMeasure = (): Measure => ({
  release: RELEASE,
  canonical: `${ORIGIN}/`,
  scrollWidth: 320,
  clientWidth: 320,
  viewportHeight: 800,
  heading: { text: 'A Name', left: 16, right: 304, top: 24, bottom: 64, width: 288, height: 40, visible: true },
  stylesheets: [{ href: `${ORIGIN}/assets/index-AbCd1234.css`, rules: 12 }],
  scripts: [`${ORIGIN}/assets/index-EfGh5678.js`],
  tabStops: [RESUME, EMAIL],
});
const goodReport = (url = `${ORIGIN}/`, status = 200, change: Partial<PageReport> = {}): PageReport => ({
  url,
  status,
  requests: 3,
  pageErrors: [],
  consoleErrors: [],
  failedRequests: [],
  responses: [
    { url, status },
    { url: `${ORIGIN}/assets/index-AbCd1234.css`, status: 200 },
    { url: `${ORIGIN}/assets/index-EfGh5678.js`, status: 200 },
  ],
  measure: goodMeasure(),
  walk: { stops: [focused(RESUME), focused(EMAIL)], ended: true },
  violations: [],
  ...change,
});
const EXPECTED = { status: 200, release: RELEASE, canonical: `${ORIGIN}/` };

describe('pageProblems', () => {
  it('finds nothing wrong with a page that loaded cleanly', () => {
    expect(pageProblems(goodReport(), EXPECTED)).toEqual([]);
  });

  it('reports the status, script errors, console errors, failed requests, and error responses', () => {
    const report = goodReport(`${ORIGIN}/`, 500, {
      pageErrors: ['boom'],
      consoleErrors: [{ text: 'mutant', url: `${ORIGIN}/assets/index-EfGh5678.js` }],
      failedRequests: [`${ORIGIN}/font.woff2 (net::ERR_FAILED)`],
      responses: [
        { url: `${ORIGIN}/`, status: 500 },
        { url: `${ORIGIN}/assets/index-AbCd1234.css`, status: 200 },
        { url: `${ORIGIN}/assets/index-EfGh5678.js`, status: 200 },
        { url: `${ORIGIN}/favicon.svg`, status: 403 },
      ],
    });
    expect(pageProblems(report, EXPECTED)).toEqual([
      'status 500, not 200',
      'a script threw: boom',
      'console error: mutant',
      `a request failed: ${ORIGIN}/font.woff2 (net::ERR_FAILED)`,
      `${ORIGIN}/ got status 500`,
      `${ORIGIN}/favicon.svg got status 403`,
    ]);
  });

  it("lets a 404 page's own response, and the console error Chromium logs for it, through", () => {
    const url = `${ORIGIN}/missing/`;
    const report = goodReport(url, 404, {
      consoleErrors: [{ text: 'Failed to load resource: the server responded with a status of 404', url }],
    });
    expect(pageProblems(report, { ...EXPECTED, status: 404 })).toEqual([]);
    // Any other console error on the 404 page is a problem, even at its own URL.
    const broken = goodReport(url, 404, { consoleErrors: [{ text: 'the 404 page is broken', url }] });
    expect(pageProblems(broken, { ...EXPECTED, status: 404 })).toEqual(['console error: the 404 page is broken']);
    // On a page that should load, the same response is a problem.
    expect(pageProblems(report, EXPECTED)).toEqual([
      'status 404, not 200',
      'console error: Failed to load resource: the server responded with a status of 404',
      `${url} got status 404`,
    ]);
  });

  it('reports scripts and stylesheets that did not load, and a page with no stylesheet', () => {
    const missing = goodReport(`${ORIGIN}/`, 200, {
      responses: [{ url: `${ORIGIN}/`, status: 200 }],
      measure: { ...goodMeasure(), stylesheets: [{ href: `${ORIGIN}/a-AbCd1234.css`, rules: null }, { href: `${ORIGIN}/b-AbCd1234.css`, rules: 0 }] },
    });
    expect(pageProblems(missing, EXPECTED)).toEqual([
      `script ${ORIGIN}/assets/index-EfGh5678.js did not load`,
      `stylesheet ${ORIGIN}/a-AbCd1234.css did not load, or has no rules`,
      `stylesheet ${ORIGIN}/b-AbCd1234.css did not load, or has no rules`,
    ]);
    const unstyled = goodReport(`${ORIGIN}/`, 200, { measure: { ...goodMeasure(), stylesheets: [] } });
    expect(pageProblems(unstyled, EXPECTED)).toEqual(['the page links no stylesheet']);
    // A script that got an error response did not load either.
    const failedScript = goodReport(`${ORIGIN}/`, 200, {
      responses: [{ url: `${ORIGIN}/assets/index-EfGh5678.js`, status: 404 }, { url: `${ORIGIN}/`, status: 200 }],
    });
    expect(pageProblems(failedScript, EXPECTED)).toContain(`script ${ORIGIN}/assets/index-EfGh5678.js did not load`);
  });

  it('reports a page that scrolls sideways, and a heading that is missing, empty, hidden, or off the screen', () => {
    const page = (measure: Partial<Measure>) =>
      pageProblems(goodReport(`${ORIGIN}/`, 200, { measure: { ...goodMeasure(), ...measure } }), EXPECTED);
    const heading = goodMeasure().heading!;
    expect(page({ scrollWidth: 2000 })).toEqual(['the page scrolls sideways: 2000px wide in a 320px window']);
    expect(page({ heading: null })).toEqual(['the page shows no main heading']);
    expect(page({ heading: { ...heading, text: '' } })).toEqual(['the page shows no main heading']);
    expect(page({ heading: { ...heading, width: 0 } })).toEqual(['the page shows no main heading']);
    expect(page({ heading: { ...heading, height: 0 } })).toEqual(['the page shows no main heading']);
    expect(page({ heading: { ...heading, left: -400 } })).toEqual(['the main heading runs off the screen']);
    expect(page({ heading: { ...heading, right: 321 } })).toEqual(['the main heading runs off the screen']);
    expect(page({ heading: { ...heading, top: -50 } })).toEqual(['the main heading runs off the screen']);
    expect(page({ heading: { ...heading, bottom: 801 } })).toEqual(['the main heading runs off the screen']);
    expect(page({ heading: { ...heading, visible: false } })).toEqual(['the main heading is hidden, or fully transparent']);
  });

  it('reports a page that names another release than the one expected, or none', () => {
    const named = (release: string | null) => goodReport(`${ORIGIN}/`, 200, { measure: { ...goodMeasure(), release } });
    expect(pageProblems(named(null), EXPECTED)).toEqual([`the page names release (none), not ${RELEASE}`]);
    expect(pageProblems(named(RELEASE), { ...EXPECTED, release: null })).toEqual([
      `the page names release ${RELEASE}, not (none)`,
    ]);
    expect(pageProblems(named(null), { ...EXPECTED, release: null })).toEqual([]);
  });

  it('reports a page that names another canonical URL than its own, or none, and a 404 page that names one', () => {
    const named = (canonical: string | null) =>
      goodReport(`${ORIGIN}/`, 200, { measure: { ...goodMeasure(), canonical } });
    expect(pageProblems(named(`${ORIGIN}/resume/`), EXPECTED)).toEqual([
      `the page names canonical URL ${ORIGIN}/resume/, not ${ORIGIN}/`,
    ]);
    expect(pageProblems(named(null), EXPECTED)).toEqual([`the page names canonical URL (none), not ${ORIGIN}/`]);
    expect(pageProblems(named(`${ORIGIN}/`), { ...EXPECTED, canonical: null })).toEqual([
      `the page names canonical URL ${ORIGIN}/, not (none)`,
    ]);
    expect(pageProblems(named(null), { ...EXPECTED, canonical: null })).toEqual([]);
  });
});

describe('focusProblems', () => {
  const none = { outlineStyle: 'none', outlineWidth: '0px' };

  it('accepts focus shown by an outline or a shadow layer in a visible colour', () => {
    for (const change of [
      {},
      { outlineColor: 'rgba(0, 0, 255, 0.5)' },
      // Opaque black: a last component of 0 is blue, not alpha.
      { outlineColor: 'rgb(0, 0, 0)' },
      { outlineColor: 'oklch(0.5 0.1 200 / 0.8)' },
      { ...none, tag: 'button', boxShadow: 'rgb(0, 0, 0) 0px 0px 0px 2px' },
      { ...none, boxShadow: 'rgba(0, 0, 0, 0) 0px 0px 0px 1px, rgb(0, 0, 255) 0px 0px 0px 3px' },
      // Tailwind v4's ring: transparent layers beside a visible oklch() one.
      { ...none, boxShadow: 'rgba(0, 0, 0, 0) 0px 0px 0px 0px, oklch(0.623 0.214 259.815) 0px 0px 0px 2px' },
      { ...none, boxShadow: 'oklch(0.5 0.1 200) 2px 2px 4px 0px inset' },
    ]) {
      expect(focusProblems(focused(RESUME, change)), JSON.stringify(change)).toEqual([]);
    }
  });

  it('reports focus that shows nothing, naming the element by its tag and its text or href', () => {
    for (const change of [
      { outlineStyle: 'none' },
      { outlineWidth: '0px' },
      { outlineColor: 'rgba(0, 0, 0, 0)' },
      { outlineColor: 'transparent' },
      { outlineColor: 'oklch(0.5 0.1 200 / 0)' },
      { outlineColor: 'color(srgb 0 0 0 / 0)' },
      { ...none, boxShadow: 'rgba(0, 0, 0, 0) 0px 0px 0px 2px' },
      { ...none, boxShadow: 'oklch(0.5 0.1 200 / 0) 0px 0px 0px 2px, rgba(0, 0, 0, 0) 0px 0px 0px 2px' },
      // A visible colour with no size shows nothing either.
      { ...none, boxShadow: 'rgb(0, 0, 0) 0px 0px 0px 0px' },
    ]) {
      expect(focusProblems(focused(RESUME, change)), JSON.stringify(change)).toEqual([
        'the focused <a> "Résumé" shows no focus indicator',
      ]);
    }
    expect(focusProblems(focused(EMAIL, none))).toEqual([
      'the focused <a> "mailto:someone@example.com" shows no focus indicator',
    ]);
    // An element with neither text nor an href goes by its tag.
    expect(focusProblems(focused({ tag: 'input', name: '', index: 2 }, none))).toEqual([
      'the focused <input> shows no focus indicator',
    ]);
  });

  it('cuts a name longer than 60 characters to 59 and an ellipsis, counting characters, not UTF-16 code units', () => {
    const named = (name: string) => focusProblems(focused({ tag: 'a', name, index: 2 }, none));
    expect(named('x'.repeat(60))).toEqual([`the focused <a> "${'x'.repeat(60)}" shows no focus indicator`]);
    expect(named('x'.repeat(61))).toEqual([`the focused <a> "${'x'.repeat(59)}…" shows no focus indicator`]);
    // Each of these is two code units.
    expect(named('𝑥'.repeat(61))).toEqual([`the focused <a> "${'𝑥'.repeat(59)}…" shows no focus indicator`]);
  });
});

describe('tabProblems', () => {
  const walked = (stops: Focus[], ended = true) =>
    tabProblems(goodReport(`${ORIGIN}/`, 200, { walk: { stops, ended } }));
  // An element Tab should not stop at, such as a scrolling region, which the page knows by the next number after its
  // two Tab stops.
  const CLEAR: Named = { tag: 'div', name: '', index: 2 };

  it('passes a walk that stops at each Tab stop once, in document order, showing its focus on the screen', () => {
    expect(tabProblems(goodReport())).toEqual([]);
    // A stop that fills the window is still wholly on the screen.
    expect(walked([focused(RESUME, { left: 0, right: 320, top: 0, bottom: 800 }), focused(EMAIL)])).toEqual([]);
  });

  it('reports a walk that focused nothing, or never ran', () => {
    expect(walked([])).toEqual(['a Tab press focused nothing']);
    expect(tabProblems(goodReport(`${ORIGIN}/`, 200, { walk: undefined }))).toEqual(['a Tab press focused nothing']);
  });

  it('reports a stop that shows no focus, does not show itself, or is not wholly on the screen once the browser has scrolled to it', () => {
    expect(walked([focused(RESUME, { outlineStyle: 'none' }), focused(EMAIL)])).toEqual([
      'the focused <a> "Résumé" shows no focus indicator',
    ]);
    // As a link would that is transparent even with the focus, unlike a skip link that appears with it.
    expect(walked([focused(RESUME, { visible: false }), focused(EMAIL)])).toEqual([
      'the focused <a> "Résumé" is hidden, or fully transparent',
    ]);
    for (const change of [{ left: -1 }, { right: 321 }, { top: -1 }, { bottom: 801 }]) {
      expect(walked([focused(RESUME), focused(EMAIL, change)]), JSON.stringify(change)).toEqual([
        'the focused <a> "mailto:someone@example.com" runs off the screen',
      ]);
    }
  });

  it('reports a Tab stop never reached, a stop that is not a Tab stop, and a walk out of document order', () => {
    expect(walked([focused(RESUME)])).toEqual(['Tab never reaches <a> "mailto:someone@example.com"']);
    expect(walked([focused(RESUME), focused(EMAIL), focused(CLEAR)])).toEqual([
      "Tab stops at <div>, which is not one of the page's Tab stops",
    ]);
    // As a positive tabindex would order them.
    expect(walked([focused(EMAIL), focused(RESUME, { forward: false })])).toEqual([
      'Tab goes back from <a> "mailto:someone@example.com" to <a> "Résumé"',
    ]);
    // The order is the page's own, whatever numbers the elements go by: here, the page knows the div by a number after
    // the links', but it comes before the second.
    expect(walked([focused(RESUME), focused(CLEAR), focused(EMAIL)])).toEqual([
      "Tab stops at <div>, which is not one of the page's Tab stops",
    ]);
  });

  it('reports a press that leaves the focus where it was, as one inside a frame does, and only the first press that does not move forward', () => {
    expect(walked([focused(RESUME), focused(RESUME, { forward: false }), focused(EMAIL)])).toEqual([
      'Tab stops at <a> "Résumé" twice in a row',
    ]);
    // Only the first press that does not move forward is reported.
    expect(
      walked([focused(EMAIL), focused(EMAIL, { forward: false }), focused(RESUME, { forward: false })]),
    ).toEqual(['Tab stops at <a> "mailto:someone@example.com" twice in a row']);
  });

  it('reports a walk caught in a focus trap, and each problem of the stops it cycles through once', () => {
    // The email link, reached forward from the first stop, and then back from the div, again and again.
    const email = focused(EMAIL, { outlineStyle: 'none' });
    const back = { ...email, forward: false };
    const cycle = Array.from({ length: (TAB_LIMIT - 4) / 2 }, () => [back, focused(CLEAR)]).flat();
    const trapped = [focused(RESUME), email, focused(CLEAR), ...cycle, back];
    expect(trapped).toHaveLength(TAB_LIMIT);
    expect(walked(trapped, false)).toEqual([
      'the focused <a> "mailto:someone@example.com" shows no focus indicator',
      "Tab stops at <div>, which is not one of the page's Tab stops",
      'Tab goes back from <div> to <a> "mailto:someone@example.com"',
      `${TAB_LIMIT} Tab presses neither came back to the first stop nor left the page`,
    ]);
  });
});

describe('axeProblems', () => {
  it("passes a page that breaks none of axe-core's rules, and reports a load that did not run them", () => {
    expect(axeProblems(goodReport())).toEqual([]);
    expect(axeProblems(goodReport(`${ORIGIN}/`, 200, { violations: undefined }))).toEqual(['axe-core did not run']);
  });

  it('reports each rule the page breaks, how serious axe-core rates it, and up to three elements that break it', () => {
    const violations = [
      { id: 'image-alt', impact: 'critical', targets: ['img'] },
      { id: 'link-name', impact: 'serious', targets: ['a:nth-child(1)', 'a:nth-child(2)', 'a:nth-child(3)'] },
      { id: 'list', impact: 'serious', targets: ['ul', 'ol', 'nav > ul', 'footer > ul', 'main > ul'] },
      { id: 'region', impact: null, targets: ['p'] },
      { id: 'landmark-unique', targets: ['nav'] },
    ];
    expect(axeProblems(goodReport(`${ORIGIN}/`, 200, { violations }))).toEqual([
      'axe-core rule image-alt (critical) fails at img',
      'axe-core rule link-name (serious) fails at a:nth-child(1), a:nth-child(2), a:nth-child(3)',
      'axe-core rule list (serious) fails at ul, ol, nav > ul, and 2 more',
      'axe-core rule region (no impact given) fails at p',
      'axe-core rule landmark-unique (no impact given) fails at nav',
    ]);
  });
});

describe('browserCheck', () => {
  // The pages are served locally, but name their canonical URLs at the site's own origin.
  const LOCAL = 'http://127.0.0.1:4173';
  const target = { origin: LOCAL, canonicalOrigin: ORIGIN, release: RELEASE, probe: 'browser-check-probe' };
  const pages = [{ path: '/' }, { path: '/about/' }, { path: null }];
  const CHECKS = [
    "the page at / works in a 320-pixel window, passes axe-core's rules, and shows keyboard focus at every Tab stop",
    "the page at / works in a 768-pixel window, and passes axe-core's rules",
    "the page at / works in a 1280-pixel window, and passes axe-core's rules",
    "the page at / works in a 320-pixel window in dark mode, passes axe-core's rules, and shows keyboard focus at " +
      'every Tab stop',
    'the page at / loads with a query string, naming its canonical URL',
    "the page at /about/ works in a 320-pixel window, passes axe-core's rules, and shows keyboard focus at every " +
      'Tab stop',
    "the page at /about/ works in a 768-pixel window, and passes axe-core's rules",
    "the page at /about/ works in a 1280-pixel window, and passes axe-core's rules",
    "the page at /about/ works in a 320-pixel window in dark mode, passes axe-core's rules, and shows keyboard " +
      'focus at every Tab stop',
    'the page at /about/ loads at /about too, naming its canonical URL',
    'the page at /about/ loads with a query string, naming its canonical URL',
    'the page at /about/ works when reloaded',
    'a missing page below /about/ gets the 404 page, with status 404',
    "a missing page shows the 404 page, with status 404, which works, passes axe-core's rules, and shows " +
      'keyboard focus at every Tab stop',
    "a missing page shows the 404 page in dark mode, with status 404, which works, passes axe-core's rules, and " +
      'shows keyboard focus at every Tab stop',
  ];
  // The page CloudFront serves at a URL: the one at its address, with or without the trailing slash and whatever the
  // query string, or the 404 page, as null, at every other address.
  const cloudFront = (url: string) => {
    const { pathname } = new URL(url);
    const path = pathname.endsWith('/') ? pathname : `${pathname}/`;
    return pages.some((page) => page.path === path) ? path : null;
  };
  // A site whose host serves each URL the page serves names: that page, naming its canonical URL, or the 404 page,
  // which names none, with status 404.
  const site = (serves: (url: string) => string | null = cloudFront) =>
    vi.fn<Open>(async (url) => {
      const path = serves(url);
      const canonical = path === null ? null : `${ORIGIN}${path}`;
      return goodReport(url, path === null ? 404 : 200, { measure: { ...goodMeasure(), canonical } });
    });

  it('loads every page at three widths and in dark mode, its other addresses, a reload, and missing pages, one at a time, and passes a site that works', async () => {
    const open = site();
    expect(await browserCheck(target, pages, open)).toEqual({
      passed: [...CHECKS, 'the 15 page loads sent 45 requests, within the budget of 200'],
      failures: [],
    });
    // toStrictEqual, so that no load carries an option set to undefined.
    expect(open.mock.calls).toStrictEqual([
      [`${LOCAL}/`, 320, { tab: true, axe: true }],
      [`${LOCAL}/`, 768, { axe: true }],
      [`${LOCAL}/`, 1280, { axe: true }],
      [`${LOCAL}/`, 320, { tab: true, axe: true, dark: true }],
      [`${LOCAL}/?from=browser-check`, 320, {}],
      [`${LOCAL}/about/`, 320, { tab: true, axe: true }],
      [`${LOCAL}/about/`, 768, { axe: true }],
      [`${LOCAL}/about/`, 1280, { axe: true }],
      [`${LOCAL}/about/`, 320, { tab: true, axe: true, dark: true }],
      [`${LOCAL}/about`, 320, {}],
      [`${LOCAL}/about/?from=browser-check`, 320, {}],
      [`${LOCAL}/about/`, 320, { reload: true }],
      [`${LOCAL}/about/browser-check-probe/`, 320, {}],
      [`${LOCAL}/browser-check-probe/`, 320, { tab: true, axe: true }],
      [`${LOCAL}/browser-check-probe/`, 320, { tab: true, axe: true, dark: true }],
    ]);
  });

  it('with a screenshots directory, saves each page at each width and in dark mode, and nothing for the other loads', async () => {
    const open = site();
    await browserCheck({ ...target, screenshots: 'shots' }, pages, open);
    expect(open.mock.calls).toStrictEqual([
      [`${LOCAL}/`, 320, { tab: true, axe: true, screenshot: 'shots/home-320.png' }],
      [`${LOCAL}/`, 768, { axe: true, screenshot: 'shots/home-768.png' }],
      [`${LOCAL}/`, 1280, { axe: true, screenshot: 'shots/home-1280.png' }],
      [`${LOCAL}/`, 320, { tab: true, axe: true, dark: true, screenshot: 'shots/home-320-dark.png' }],
      [`${LOCAL}/?from=browser-check`, 320, {}],
      [`${LOCAL}/about/`, 320, { tab: true, axe: true, screenshot: 'shots/about-320.png' }],
      [`${LOCAL}/about/`, 768, { axe: true, screenshot: 'shots/about-768.png' }],
      [`${LOCAL}/about/`, 1280, { axe: true, screenshot: 'shots/about-1280.png' }],
      [`${LOCAL}/about/`, 320, { tab: true, axe: true, dark: true, screenshot: 'shots/about-320-dark.png' }],
      [`${LOCAL}/about`, 320, {}],
      [`${LOCAL}/about/?from=browser-check`, 320, {}],
      [`${LOCAL}/about/`, 320, { reload: true }],
      [`${LOCAL}/about/browser-check-probe/`, 320, {}],
      [`${LOCAL}/browser-check-probe/`, 320, { tab: true, axe: true, screenshot: 'shots/not-found-320.png' }],
      [
        `${LOCAL}/browser-check-probe/`,
        320,
        { tab: true, axe: true, dark: true, screenshot: 'shots/not-found-320-dark.png' },
      ],
    ]);
    // A page deeper down is named by its whole address.
    const deep = site();
    await browserCheck({ ...target, screenshots: 'shots' }, [{ path: '/work/feature-gating/' }], deep);
    expect(deep.mock.calls[0]).toStrictEqual([
      `${LOCAL}/work/feature-gating/`,
      320,
      { tab: true, axe: true, screenshot: 'shots/work-feature-gating-320.png' },
    ]);
  });

  it('starts each load only once the one before it has finished', async () => {
    let loading = 0;
    let most = 0;
    const open = vi.fn<Open>(async (url) => {
      most = Math.max(most, ++loading);
      await new Promise((resolve) => setTimeout(resolve, 1));
      loading--;
      return goodReport(url);
    });
    await browserCheck(target, pages, open);
    expect([open.mock.calls.length, most]).toEqual([15, 1]);
  });

  it('reports a site that serves its home page at every address, as a host for a single-page app might', async () => {
    const { failures } = await browserCheck(target, pages, site(() => '/'));
    const wrongPage = `the page names canonical URL ${ORIGIN}/, not ${ORIGIN}/about/`;
    expect(failures).toEqual([
      ...CHECKS.slice(5, 12).map((check) => `${check}: ${wrongPage}`),
      ...CHECKS.slice(12).flatMap((check) => [
        `${check}: status 200, not 404`,
        `${check}: the page names canonical URL ${ORIGIN}/, not (none)`,
      ]),
    ]);
  });

  it('reports a page missing without its trailing slash, as from a host that does not map paths as CloudFront does', async () => {
    const open = site((url) => (url === `${LOCAL}/about` ? null : cloudFront(url)));
    const { failures } = await browserCheck(target, pages, open);
    expect(failures).toEqual([
      `${CHECKS[9]}: status 404, not 200`,
      `${CHECKS[9]}: ${LOCAL}/about got status 404`,
      `${CHECKS[9]}: the page names canonical URL (none), not ${ORIGIN}/about/`,
    ]);
  });

  it('reports the Tab walk and axe-core with the load they ran in, the 404 page in both modes included, and a load that could not run', async () => {
    const open = vi.fn<Open>(async (url, width, options) => {
      if (width === 1280) throw new Error('browser crashed');
      if (options.reload) throw 'navigation failed';
      return goodReport(url, url.includes('browser-check-probe') ? 404 : 200, {
        measure: { ...goodMeasure(), canonical: null },
        walk: { stops: [], ended: true },
        violations: [{ id: 'image-alt', impact: 'critical', targets: ['img'] }],
      });
    });
    const { passed, failures } = await browserCheck(target, [{ path: '/about/' }, { path: null }], open);
    const unnamed = `the page names canonical URL (none), not ${ORIGIN}/about/`;
    const axe = 'axe-core rule image-alt (critical) fails at img';
    expect(failures).toEqual([
      `${CHECKS[5]}: ${unnamed}`,
      `${CHECKS[5]}: a Tab press focused nothing`,
      `${CHECKS[5]}: ${axe}`,
      `${CHECKS[6]}: ${unnamed}`,
      `${CHECKS[6]}: ${axe}`,
      `${CHECKS[7]}: browser crashed`,
      `${CHECKS[8]}: ${unnamed}`,
      `${CHECKS[8]}: a Tab press focused nothing`,
      `${CHECKS[8]}: ${axe}`,
      `${CHECKS[9]}: ${unnamed}`,
      `${CHECKS[10]}: ${unnamed}`,
      `${CHECKS[11]}: navigation failed`,
      // The 404 page names no canonical URL, as it should, so only the walk and the rules fail it.
      `${CHECKS[13]}: a Tab press focused nothing`,
      `${CHECKS[13]}: ${axe}`,
      `${CHECKS[14]}: a Tab press focused nothing`,
      `${CHECKS[14]}: ${axe}`,
    ]);
    // The URL-form loads run neither, and a missing page names no canonical URL. A load that failed reported nothing,
    // so its requests are not counted.
    expect(passed).toEqual([CHECKS[12], 'the 8 page loads sent 24 requests, within the budget of 200']);
  });

  it('fails a run whose loads send more requests than its budget, with one failure for them all', async () => {
    // Seven loads, each sending the next of counts.
    const homeOnly = [{ path: '/' }, { path: null }];
    const counted = (counts: number[]): Open => {
      const open = site();
      return async (...args) => ({ ...(await open(...args)), requests: counts.shift()! });
    };
    const shares = (last: number) => [...Array.from({ length: 6 }, () => (BROWSER_REQUEST_BUDGET - 20) / 6), last];
    const within = await browserCheck(target, homeOnly, counted(shares(20)));
    expect(within).toEqual({
      passed: [
        ...CHECKS.slice(0, 5),
        ...CHECKS.slice(13),
        'the 7 page loads sent 200 requests, within the budget of 200',
      ],
      failures: [],
    });
    const over = await browserCheck(target, homeOnly, counted(shares(21)));
    expect(over).toEqual({
      passed: [...CHECKS.slice(0, 5), ...CHECKS.slice(13)],
      failures: [
        "the 7 page loads sent 201 requests, more than the budget of 200, a fifth of the web ACL's rate limit for one " +
          'address (ADR 0007)',
      ],
    });
  });
});

describe('serve', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function build(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'browser-check-serve-'));
    dirs.push(dir);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    return dir;
  }

  it('serves the build as CloudFront serves the bucket: index.html for a directory, the 404 page for a miss', async () => {
    const dir = build({
      'index.html': 'home',
      '404.html': 'not found',
      'about/index.html': 'about',
      'assets/index-AbCd1234.css': 'body{}',
    });
    const server = await serve(dir);
    try {
      const get = async (path: string) => {
        const response = await fetch(`${server.origin}${path}`);
        return [response.status, response.headers.get('content-type'), response.headers.get('cache-control'), await response.text()];
      };
      expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(await get('/')).toEqual([200, 'text/html; charset=utf-8', 'no-cache', 'home']);
      expect(await get('/about/')).toEqual([200, 'text/html; charset=utf-8', 'no-cache', 'about']);
      expect(await get('/about')).toEqual([200, 'text/html; charset=utf-8', 'no-cache', 'about']);
      expect(await get('/assets/index-AbCd1234.css')).toEqual([
        200,
        'text/css; charset=utf-8',
        'public, max-age=31536000, immutable',
        'body{}',
      ]);
      expect(await get('/missing/')).toEqual([404, 'text/html; charset=utf-8', 'no-cache', 'not found']);
      expect(await get('/../../etc/passwd')).toEqual([404, 'text/html; charset=utf-8', 'no-cache', 'not found']);
    } finally {
      await server.close();
    }
  });

  it('needs a 404 page to serve', async () => {
    const dir = build({ 'index.html': 'home' });
    await expect(serve(dir)).rejects.toThrow(`${dir} has no 404.html to serve.`);
  });

  // fetch would decode the body itself, so these read the bytes as sent.
  function getRaw(url: string, acceptEncoding: string) {
    return new Promise<{ status?: number; encoding?: string; body: Buffer }>((resolve, reject) => {
      httpGet(url, { headers: { 'accept-encoding': acceptEncoding } }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            encoding: response.headers['content-encoding'],
            body: Buffer.concat(chunks),
          }),
        );
      }).on('error', reject);
    });
  }

  it('compresses what CloudFront would, in the encoding it would choose, and the 404 page too', async () => {
    const script = `console.log(${JSON.stringify('x'.repeat(2000))});`;
    const missing = `<!doctype html><title>Missing</title>${'<p>gone</p>'.repeat(100)}`;
    const dir = build({ 'index.html': 'home', '404.html': missing, 'assets/index-AbCd1234.js': script });
    const server = await serve(dir);
    try {
      const url = `${server.origin}/assets/index-AbCd1234.js`;
      const br = await getRaw(url, 'gzip, deflate, br, zstd');
      expect([br.status, br.encoding, brotliDecompressSync(br.body).toString()]).toEqual([200, 'br', script]);
      // A second request gets the same bytes: each file is compressed once, before the server starts.
      expect((await getRaw(url, 'br')).body).toEqual(br.body);
      const gzip = await getRaw(url, 'gzip');
      expect([gzip.status, gzip.encoding, gunzipSync(gzip.body).toString()]).toEqual([200, 'gzip', script]);
      const plain = await getRaw(url, 'identity');
      expect([plain.status, plain.encoding, plain.body.toString()]).toEqual([200, undefined, script]);
      // Under 1,000 bytes, the home page goes out as it is.
      expect(await getRaw(`${server.origin}/`, 'br')).toEqual({ status: 200, encoding: undefined, body: Buffer.from('home') });
      const notFound = await getRaw(`${server.origin}/nowhere/`, 'br');
      expect([notFound.status, notFound.encoding, brotliDecompressSync(notFound.body).toString()]).toEqual([
        404,
        'br',
        missing,
      ]);
    } finally {
      await server.close();
    }
  });
});

describe('open', () => {
  // axe-core's browser build, which open adds to the page inline.
  const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
  const VIOLATIONS = [{ id: 'image-alt', impact: 'critical', targets: ['img'] }];

  // A Playwright browser whose page answers each navigation, goto and then any reload, with the next of statuses,
  // firing the events listed in script, on the page or its context, before it does; each Tab press focuses the next of
  // focuses, then nothing.
  function fakeBrowser(
    statuses: (number | null)[],
    script: (page: EventEmitter, context: EventEmitter) => void = () => {},
    focuses: Focus[] = [],
  ) {
    const calls: string[] = [];
    const [answers, presses] = [[...statuses], [...focuses]];
    const navigate = (call: string) => {
      calls.push(call);
      script(page, context);
      const status = answers.shift();
      return status === null ? null : { status: () => status };
    };
    const page = Object.assign(new EventEmitter(), {
      goto: vi.fn(async (url: string, options: object) => navigate(`goto ${url} ${JSON.stringify(options)}`)),
      reload: vi.fn(async (options: object) => navigate(`reload ${JSON.stringify(options)}`)),
      evaluate: vi.fn(async (fn: (arg: unknown) => unknown, arg?: unknown) => {
        calls.push(`evaluate ${fn.name}${arg === undefined ? '' : ` ${JSON.stringify(arg)}`}`);
        if (fn.name === 'measure') return goodMeasure();
        return fn.name === 'measureFocus' ? (presses.shift() ?? null) : VIOLATIONS;
      }),
      addScriptTag: vi.fn(async ({ content }: { content: string }) =>
        calls.push(`add ${content === AXE ? 'axe-core' : content}`),
      ),
      waitForTimeout: vi.fn(async (ms: number) => calls.push(`wait ${ms}`)),
      screenshot: vi.fn(async (options: object) => calls.push(`screenshot ${JSON.stringify(options)}`)),
      keyboard: { press: vi.fn(async (key: string) => calls.push(`press ${key}`)) },
    });
    const context = Object.assign(new EventEmitter(), {
      newPage: async () => page,
      close: vi.fn(async () => calls.push('close')),
    });
    const browser = { newContext: vi.fn(async (options: object) => (calls.push(`context ${JSON.stringify(options)}`), context)) };
    return { browser: browser as unknown as Browser, calls };
  }

  it('loads the page in a window of the width asked for, in light mode, collects what failed, counts its requests, measures it, and closes it', async () => {
    const { browser, calls } = fakeBrowser([200], (page, context) => {
      context.emit('request', {});
      page.emit('pageerror', new Error('boom'));
      page.emit('console', { type: () => 'error', text: () => 'bad', location: () => ({ url: `${ORIGIN}/x.js` }) });
      page.emit('console', { type: () => 'log', text: () => 'fine', location: () => ({ url: `${ORIGIN}/x.js` }) });
      // The context hears of every request the page hears of, and of its service worker's too, so only its count.
      context.emit('request', {});
      page.emit('request', {});
      page.emit('requestfailed', { url: () => `${ORIGIN}/font.woff2`, failure: () => ({ errorText: 'net::ERR_FAILED' }) });
      page.emit('requestfailed', { url: () => `${ORIGIN}/other`, failure: () => null });
      page.emit('response', { url: () => `${ORIGIN}/`, status: () => 200 });
    });
    expect(await open(browser, `${ORIGIN}/`, 320, {})).toEqual({
      url: `${ORIGIN}/`,
      status: 200,
      requests: 2,
      pageErrors: ['boom'],
      consoleErrors: [{ text: 'bad', url: `${ORIGIN}/x.js` }],
      failedRequests: [`${ORIGIN}/font.woff2 (net::ERR_FAILED)`, `${ORIGIN}/other (undefined)`],
      responses: [{ url: `${ORIGIN}/`, status: 200 }],
      measure: goodMeasure(),
    });
    // Without the options, it neither walks the Tab stops nor runs axe-core.
    expect(calls).toEqual([
      'context {"viewport":{"width":320,"height":800},"colorScheme":"light"}',
      `goto ${ORIGIN}/ {"waitUntil":"networkidle"}`,
      `wait ${SETTLE_MS}`,
      'evaluate measure',
      'close',
    ]);
  });

  it('saves a screenshot of the whole page when asked, after measuring it and before the first Tab press', async () => {
    const { browser, calls } = fakeBrowser([200], () => {}, [focused(RESUME)]);
    await open(browser, `${ORIGIN}/`, 768, { tab: true, screenshot: 'shots/home-768.png' });
    expect(calls).toEqual([
      'context {"viewport":{"width":768,"height":800},"colorScheme":"light"}',
      `goto ${ORIGIN}/ {"waitUntil":"networkidle"}`,
      `wait ${SETTLE_MS}`,
      'evaluate measure',
      'screenshot {"path":"shots/home-768.png","fullPage":true}',
      'press Tab',
      `evaluate measureFocus ${FOCUS_SETTLE_MS}`,
      'press Tab',
      `evaluate measureFocus ${FOCUS_SETTLE_MS}`,
      'close',
    ]);
  });

  it("reloads the page when asked, and reports the reload's status and the requests of both loads", async () => {
    const { browser, calls } = fakeBrowser([500, 200], (_, context) => context.emit('request', {}));
    expect(await open(browser, `${ORIGIN}/about/`, 320, { reload: true })).toMatchObject({ status: 200, requests: 2 });
    expect(calls).toEqual([
      'context {"viewport":{"width":320,"height":800},"colorScheme":"light"}',
      `goto ${ORIGIN}/about/ {"waitUntil":"networkidle"}`,
      'reload {"waitUntil":"networkidle"}',
      `wait ${SETTLE_MS}`,
      'evaluate measure',
      'close',
    ]);
  });

  it('presses Tab from the fresh load until the focus leaves the page, giving each stop time to settle, then runs axe-core, added inline, in dark mode when asked', async () => {
    const { browser, calls } = fakeBrowser([200], () => {}, [focused(RESUME), focused(EMAIL)]);
    expect(await open(browser, `${ORIGIN}/`, 320, { tab: true, axe: true, dark: true })).toMatchObject({
      walk: { stops: [focused(RESUME), focused(EMAIL)], ended: true },
      violations: VIOLATIONS,
    });
    expect(calls).toEqual([
      'context {"viewport":{"width":320,"height":800},"colorScheme":"dark"}',
      `goto ${ORIGIN}/ {"waitUntil":"networkidle"}`,
      `wait ${SETTLE_MS}`,
      'evaluate measure',
      ...Array.from({ length: 3 }, () => ['press Tab', `evaluate measureFocus ${FOCUS_SETTLE_MS}`]).flat(),
      'add axe-core',
      `evaluate audit ${JSON.stringify(AXE_TAGS)}`,
      'close',
    ]);
    expect(AXE_TAGS).toEqual(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']);
    // Longer than Chromium's longest smooth scroll, about 1.5 seconds.
    expect(FOCUS_SETTLE_MS).toBe(3000);
  });

  it('ends the walk when the focus comes back to the first stop from another, or after TAB_LIMIT presses that do neither', async () => {
    const back = fakeBrowser([200], () => {}, [focused(RESUME), focused(EMAIL), focused(RESUME), focused(EMAIL)]);
    const report = await open(back.browser, `${ORIGIN}/`, 320, { tab: true });
    expect(report.walk).toEqual({ stops: [focused(RESUME), focused(EMAIL)], ended: true });
    expect(back.calls.filter((call) => call === 'press Tab')).toHaveLength(3);
    // Without axe, nothing is added to the page.
    expect([report.violations, back.calls.filter((call) => call.startsWith('add'))]).toEqual([undefined, []]);

    // A press that leaves the focus on the first stop, as one inside a frame does, is a stop of its own.
    const stay = [focused(RESUME), focused(RESUME, { forward: false }), focused(EMAIL)];
    const stayed = fakeBrowser([200], () => {}, [...stay, focused(RESUME)]);
    expect((await open(stayed.browser, `${ORIGIN}/`, 320, { tab: true })).walk).toEqual({ stops: stay, ended: true });
    expect(stayed.calls.filter((call) => call === 'press Tab')).toHaveLength(4);

    const stops = Array.from({ length: TAB_LIMIT + 1 }, (_, index) =>
      focused({ tag: 'a', name: `Link ${index}`, index }),
    );
    const trap = fakeBrowser([200], () => {}, stops);
    expect((await open(trap.browser, `${ORIGIN}/`, 320, { tab: true })).walk).toEqual({
      stops: stops.slice(0, TAB_LIMIT),
      ended: false,
    });
    expect(trap.calls.filter((call) => call === 'press Tab')).toHaveLength(TAB_LIMIT);
  });

  it('reports no response as status 0, and closes the context when loading fails', async () => {
    const quiet = fakeBrowser([null]);
    expect((await open(quiet.browser, `${ORIGIN}/`, 1280, {})).status).toBe(0);

    const failing = fakeBrowser([200], () => {
      throw new Error('net::ERR_NAME_NOT_RESOLVED');
    });
    await expect(open(failing.browser, `${ORIGIN}/`, 320, {})).rejects.toThrow('net::ERR_NAME_NOT_RESOLVED');
    expect(failing.calls.at(-1)).toBe('close');
  });

  it('reads axe-core when a load first runs its rules, not when the module is imported, and only once', async () => {
    const read = vi.fn(readFileSync);
    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:fs')>()),
      readFileSync: read,
    }));
    try {
      const fresh = await import('./browser-check-lib.ts');
      expect(read).not.toHaveBeenCalled();
      const { browser, calls } = fakeBrowser([200, 200, 200]);
      await fresh.open(browser, `${ORIGIN}/`, 320, {});
      expect(read).not.toHaveBeenCalled();
      await fresh.open(browser, `${ORIGIN}/`, 320, { axe: true });
      await fresh.open(browser, `${ORIGIN}/`, 768, { axe: true });
      expect(read.mock.calls).toEqual([[createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8']]);
      expect(calls.filter((call) => call.startsWith('add'))).toEqual(['add axe-core', 'add axe-core']);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
});
