// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { prerenderPages, renderDocument } from '../scripts/prerender-lib.ts';
import type { PageId } from './App.tsx';
import { render } from './entry-server.tsx';

// main.tsx's one effect is handing #root to hydrateRoot. Spy on it, calling
// through to React, so tests see that hydration ran, not only that it was quiet.
const hydrateRoot = vi.hoisted(() => vi.fn<typeof import('react-dom/client').hydrateRoot>());
vi.mock('react-dom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-dom/client')>();
  hydrateRoot.mockImplementation(actual.hydrateRoot);
  return { ...actual, hydrateRoot };
});

// hydrateRoot's default onRecoverableError reports mismatches it recovers from
// as window error events; dev-only warnings, such as attribute mismatches React
// leaves unpatched, go to console.error. Record both.
let consoleError: MockInstance<typeof console.error>;
let windowErrors: unknown[] = [];

function recordWindowError(event: ErrorEvent) {
  event.preventDefault();
  windowErrors.push(event.error);
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  window.addEventListener('error', recordWindowError);
});

afterEach(() => {
  // Vitest clears mocks before each test, so these are this test's roots.
  for (const result of hydrateRoot.mock.results) {
    if (result.type === 'return') act(() => result.value.unmount());
  }
  window.removeEventListener('error', recordWindowError);
  windowErrors = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

// The page template: `npm run dev` serves it as is, and the build prerenders
// each page into it. A path, not a URL: node:fs rejects jsdom's URL objects.
const template = readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8');

// Mounts the #root of an HTML document, as the browser would parse it.
function mountDocumentRoot(html: string): HTMLElement {
  const root = new DOMParser().parseFromString(html, 'text/html').getElementById('root');
  if (!root) throw new Error('The document has no #root element');
  return document.body.appendChild(document.importNode(root, true));
}

// Mounts a hand-built #root: server markup plus a data-page value (omitted
// when undefined), for cases the prerender step never produces.
function mountRoot(markup: string, dataPage?: string): HTMLElement {
  const root = document.createElement('div');
  root.id = 'root';
  if (dataPage !== undefined) root.dataset.page = dataPage;
  root.innerHTML = markup;
  document.body.append(root);
  return root;
}

// Not a literal, so tsconfig.node.json does not type-check main.tsx: its CSS
// import needs the Vite types that tsconfig.app.json checks it with.
const clientEntry = './main.tsx';

// Runs the client entry and lets React finish hydrating, including reporting
// any recoverable errors.
async function hydrate() {
  await act(async () => {
    await import(clientEntry);
  });
}

// React hydrated #root as the given page, in StrictMode, without reporting
// anything, and kept the server-rendered nodes (a mismatch regenerates them).
function expectHydratedInPlace(root: HTMLElement, card: Element | null, page: PageId) {
  expect(hydrateRoot).toHaveBeenCalledExactlyOnceWith(
    root,
    expect.objectContaining({ type: StrictMode, props: { children: expect.objectContaining({ props: { page } }) } }),
  );
  expect(windowErrors).toEqual([]);
  expect(consoleError).not.toHaveBeenCalled();
  expect(root.firstElementChild).toBe(card);
}

const hydrationError = expect.objectContaining({ message: expect.stringContaining('Hydration failed') });

describe('client entry', () => {
  // Uses the real template and prerender step, so main.tsx and prerender-lib.ts
  // cannot drift apart on how the page id is recorded.
  it.each(prerenderPages)('hydrates the prerendered $file in place', async (page) => {
    const root = mountDocumentRoot(renderDocument(template, page, render(page.id)));
    const card = root.firstElementChild;
    await hydrate();
    expectHydratedInPlace(root, card, page.id);
  });

  it.each([
    { name: 'an unknown', dataPage: 'admin' },
    { name: 'a missing', dataPage: undefined },
  ])('hydrates the home page for $name data-page', async ({ dataPage }) => {
    const root = mountRoot(render('home'), dataPage);
    const card = root.firstElementChild;
    await hydrate();
    expectHydratedInPlace(root, card, 'home');
  });

  // Known behavior, not a goal: with no prerendered markup to hydrate, React
  // reports a mismatch on every dev page load before rendering on the client.
  it('reports a hydration error, then renders the home page, on the unprerendered dev page', async () => {
    const root = mountDocumentRoot(template);
    await hydrate();
    expect(windowErrors).toEqual([hydrationError]);
    expect(root.querySelector('h1')?.textContent).toBe('Zach Davids');
  });

  // Controls: each mismatch channel the tests above watch is live.
  it('reports a hydration error and re-renders when the markup is for another page', async () => {
    const root = mountRoot(render('not-found'), 'home');
    const card = root.firstElementChild;
    await hydrate();
    expect(windowErrors).toEqual([hydrationError]);
    expect(root.firstElementChild).not.toBe(card);
    expect(root.querySelector('h1')?.textContent).toBe('Zach Davids');
  });

  it('logs attribute mismatches, which React does not repair', async () => {
    const root = mountRoot(render('home').replace('class="role"', 'class="title"'), 'home');
    await hydrate();
    expect(consoleError.mock.calls.map(([message]) => message)).toContainEqual(
      expect.stringContaining("didn't match the client properties"),
    );
    expect(root.querySelector('.title')?.textContent).toBe('Senior Software Engineer at Amazon');
  });

  it('throws when the page has no #root element', async () => {
    document.body.innerHTML = '<div id="app"></div>';
    await expect(import(clientEntry)).rejects.toThrow(/^Missing #root element$/);
    expect(hydrateRoot).not.toHaveBeenCalled();
    expect(document.body.innerHTML).toBe('<div id="app"></div>');
  });
});
