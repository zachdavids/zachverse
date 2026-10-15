import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  browserCheck,
  type Focus,
  focusProblems,
  type Measure,
  type Open,
  open,
  type PageReport,
  SETTLE_MS,
  pageProblems,
  serve,
} from './browser-check-lib.ts';

const RELEASE = '0123456789abcdef0123456789abcdef01234567';
const ORIGIN = 'https://example.com';

// A page as it should be: status 200, everything loaded, nothing wider than the window.
const goodMeasure = (): Measure => ({
  release: RELEASE,
  scrollWidth: 320,
  clientWidth: 320,
  viewportHeight: 800,
  heading: { text: 'A Name', left: 16, right: 304, top: 24, bottom: 64, width: 288, height: 40, visible: true },
  stylesheets: [{ href: `${ORIGIN}/assets/index-AbCd1234.css`, rules: 12 }],
  scripts: [`${ORIGIN}/assets/index-EfGh5678.js`],
});
const goodReport = (url = `${ORIGIN}/`, status = 200, change: Partial<PageReport> = {}): PageReport => ({
  url,
  status,
  pageErrors: [],
  consoleErrors: [],
  failedRequests: [],
  responses: [
    { url, status },
    { url: `${ORIGIN}/assets/index-AbCd1234.css`, status: 200 },
    { url: `${ORIGIN}/assets/index-EfGh5678.js`, status: 200 },
  ],
  measure: goodMeasure(),
  focus: { tag: 'a', outlineStyle: 'solid', outlineWidth: '2px', outlineColor: 'rgb(0, 0, 0)', boxShadow: 'none' },
  ...change,
});

describe('pageProblems', () => {
  it('finds nothing wrong with a page that loaded cleanly', () => {
    expect(pageProblems(goodReport(), { status: 200, release: RELEASE })).toEqual([]);
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
    expect(pageProblems(report, { status: 200, release: RELEASE })).toEqual([
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
    expect(pageProblems(report, { status: 404, release: RELEASE })).toEqual([]);
    // Any other console error on the 404 page is a problem, even at its own URL.
    const broken = goodReport(url, 404, { consoleErrors: [{ text: 'the 404 page is broken', url }] });
    expect(pageProblems(broken, { status: 404, release: RELEASE })).toEqual(['console error: the 404 page is broken']);
    // On a page that should load, the same response is a problem.
    expect(pageProblems(report, { status: 200, release: RELEASE })).toEqual([
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
    expect(pageProblems(missing, { status: 200, release: RELEASE })).toEqual([
      `script ${ORIGIN}/assets/index-EfGh5678.js did not load`,
      `stylesheet ${ORIGIN}/a-AbCd1234.css did not load, or has no rules`,
      `stylesheet ${ORIGIN}/b-AbCd1234.css did not load, or has no rules`,
    ]);
    const unstyled = goodReport(`${ORIGIN}/`, 200, { measure: { ...goodMeasure(), stylesheets: [] } });
    expect(pageProblems(unstyled, { status: 200, release: RELEASE })).toEqual(['the page links no stylesheet']);
    // A script that got an error response did not load either.
    const failedScript = goodReport(`${ORIGIN}/`, 200, {
      responses: [{ url: `${ORIGIN}/assets/index-EfGh5678.js`, status: 404 }, { url: `${ORIGIN}/`, status: 200 }],
    });
    expect(pageProblems(failedScript, { status: 200, release: RELEASE })).toContain(
      `script ${ORIGIN}/assets/index-EfGh5678.js did not load`,
    );
  });

  it('reports a page that scrolls sideways, and a heading that is missing, empty, hidden, or off the screen', () => {
    const page = (measure: Partial<Measure>) =>
      pageProblems(goodReport(`${ORIGIN}/`, 200, { measure: { ...goodMeasure(), ...measure } }), { status: 200, release: RELEASE });
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
    expect(pageProblems(named(null), { status: 200, release: RELEASE })).toEqual([
      `the page names release (none), not ${RELEASE}`,
    ]);
    expect(pageProblems(named(RELEASE), { status: 200, release: null })).toEqual([
      `the page names release ${RELEASE}, not (none)`,
    ]);
    expect(pageProblems(named(null), { status: 200, release: null })).toEqual([]);
  });
});

describe('focusProblems', () => {
  const focus = (change: Partial<Focus>): Focus => ({
    tag: 'a',
    outlineStyle: 'solid',
    outlineWidth: '2px',
    outlineColor: 'rgb(0, 0, 0)',
    boxShadow: 'none',
    ...change,
  });
  const none = { outlineStyle: 'none', outlineWidth: '0px' };

  it('accepts focus shown by an outline or a shadow', () => {
    expect(focusProblems(focus({}))).toEqual([]);
    expect(focusProblems(focus({ outlineColor: 'rgba(0, 0, 255, 0.5)' }))).toEqual([]);
    expect(focusProblems(focus({ ...none, tag: 'button', boxShadow: 'rgb(0, 0, 0) 0px 0px 0px 2px' }))).toEqual([]);
    // One visible colour is enough, and a colour syntax it cannot read gets the benefit of the doubt.
    const twoShadows = 'rgba(0, 0, 0, 0) 0px 0px 0px 1px, rgb(0, 0, 255) 0px 0px 0px 3px';
    expect(focusProblems(focus({ ...none, boxShadow: twoShadows }))).toEqual([]);
    expect(focusProblems(focus({ ...none, boxShadow: 'oklch(0.5 0.1 200) 0px 0px 0px 2px' }))).toEqual([]);
  });

  it('reports focus that lands nowhere, or shows nothing', () => {
    expect(focusProblems(null)).toEqual(['a Tab press focused nothing']);
    expect(focusProblems(undefined)).toEqual(['a Tab press focused nothing']);
    for (const change of [
      { outlineStyle: 'none' },
      { outlineWidth: '0px' },
      { outlineColor: 'rgba(0, 0, 0, 0)' },
      { outlineColor: 'transparent' },
      { ...none, boxShadow: 'rgba(0, 0, 0, 0) 0px 0px 0px 2px' },
    ]) {
      expect(focusProblems(focus(change)), JSON.stringify(change)).toEqual(['the focused <a> shows no focus indicator']);
    }
  });
});

describe('browserCheck', () => {
  const CHECKS = [
    'the home page works in a 320-pixel window, and shows keyboard focus',
    'the home page works in a 1280-pixel window',
    'a missing page shows the 404 page, with status 404, and works',
  ];
  const target = { origin: ORIGIN, release: RELEASE, probe: 'browser-check-probe' };

  it('loads the home page at both widths, pressing Tab once, and a missing page, and passes a site that works', async () => {
    const open = vi.fn<Open>(async (url) => goodReport(url, url.endsWith('/browser-check-probe/') ? 404 : 200));
    expect(await browserCheck(target, open)).toEqual({ passed: CHECKS, failures: [] });
    expect(open.mock.calls).toEqual([
      [`${ORIGIN}/`, 320, true],
      [`${ORIGIN}/`, 1280, false],
      [`${ORIGIN}/browser-check-probe/`, 320, false],
    ]);
  });

  it('reports each check that failed, a focus problem with the first, and one that could not run', async () => {
    const open = vi.fn<Open>(async (url, width) => {
      if (width === 1280) throw new Error('browser crashed');
      if (url.endsWith('/browser-check-probe/')) throw 'navigation failed';
      return goodReport(url, 200, { focus: null, pageErrors: ['boom'] });
    });
    expect(await browserCheck(target, open)).toEqual({
      passed: [],
      failures: [
        `${CHECKS[0]}: a script threw: boom`,
        `${CHECKS[0]}: a Tab press focused nothing`,
        `${CHECKS[1]}: browser crashed`,
        `${CHECKS[2]}: navigation failed`,
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
});

describe('open', () => {
  // A Playwright browser whose page answers goto with status and fires the events listed in script before it does.
  function fakeBrowser(status: number | null, script: (page: EventEmitter) => void = () => {}) {
    const calls: string[] = [];
    const page = Object.assign(new EventEmitter(), {
      goto: vi.fn(async (url: string, options: object) => {
        calls.push(`goto ${url} ${JSON.stringify(options)}`);
        script(page);
        return status === null ? null : { status: () => status };
      }),
      evaluate: vi.fn(async (fn: () => unknown) => {
        calls.push(`evaluate ${fn.name}`);
        return fn.name === 'measure' ? goodMeasure() : goodReport().focus;
      }),
      waitForTimeout: vi.fn(async (ms: number) => calls.push(`wait ${ms}`)),
      keyboard: { press: vi.fn(async (key: string) => calls.push(`press ${key}`)) },
    });
    const context = { newPage: async () => page, close: vi.fn(async () => calls.push('close')) };
    const browser = { newContext: vi.fn(async (options: object) => (calls.push(`context ${JSON.stringify(options)}`), context)) };
    return { browser: browser as unknown as Browser, calls };
  }

  it('loads the page in a window of the width asked for, collects what failed, measures it, and closes it', async () => {
    const { browser, calls } = fakeBrowser(200, (page) => {
      page.emit('pageerror', new Error('boom'));
      page.emit('console', { type: () => 'error', text: () => 'bad', location: () => ({ url: `${ORIGIN}/x.js` }) });
      page.emit('console', { type: () => 'log', text: () => 'fine', location: () => ({ url: `${ORIGIN}/x.js` }) });
      page.emit('requestfailed', { url: () => `${ORIGIN}/font.woff2`, failure: () => ({ errorText: 'net::ERR_FAILED' }) });
      page.emit('requestfailed', { url: () => `${ORIGIN}/other`, failure: () => null });
      page.emit('response', { url: () => `${ORIGIN}/`, status: () => 200 });
    });
    expect(await open(browser, `${ORIGIN}/`, 320, true)).toEqual({
      url: `${ORIGIN}/`,
      status: 200,
      pageErrors: ['boom'],
      consoleErrors: [{ text: 'bad', url: `${ORIGIN}/x.js` }],
      failedRequests: [`${ORIGIN}/font.woff2 (net::ERR_FAILED)`, `${ORIGIN}/other (undefined)`],
      responses: [{ url: `${ORIGIN}/`, status: 200 }],
      measure: goodMeasure(),
      focus: goodReport().focus,
    });
    expect(calls).toEqual([
      'context {"viewport":{"width":320,"height":800}}',
      `goto ${ORIGIN}/ {"waitUntil":"networkidle"}`,
      `wait ${SETTLE_MS}`,
      'evaluate measure',
      'press Tab',
      'evaluate measureFocus',
      'close',
    ]);
  });

  it('presses nothing without tab, reports no response as status 0, and closes the context when loading fails', async () => {
    const quiet = fakeBrowser(null);
    const report = await open(quiet.browser, `${ORIGIN}/`, 1280, false);
    expect({ status: report.status, focus: report.focus }).toEqual({ status: 0, focus: undefined });
    expect(quiet.calls.filter((call) => call.startsWith('press'))).toEqual([]);

    const failing = fakeBrowser(200, () => {
      throw new Error('net::ERR_NAME_NOT_RESOLVED');
    });
    await expect(open(failing.browser, `${ORIGIN}/`, 320, false)).rejects.toThrow('net::ERR_NAME_NOT_RESOLVED');
    expect(failing.calls.at(-1)).toBe('close');
  });
});
