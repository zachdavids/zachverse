// @vitest-environment jsdom
// measure, measureFocus, and audit run inside the page; jsdom stands in for it here. jsdom has no layout, so the tests
// set the sizes the checks read.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AXE_TAGS, audit, FOCUS_SETTLE_MS, measure, measureFocus } from './browser-check-lib.ts';

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  // What measure and measureFocus leave in the page.
  delete (window as { browserCheck?: unknown }).browserCheck;
});

// A box for an element, as layout would give it.
function place(element: Element, box: { left: number; right: number; top: number; width: number; height: number }) {
  const bottom = box.top + box.height;
  element.getBoundingClientRect = () => ({ ...box, bottom, x: box.left, y: box.top, toJSON: () => box }) as DOMRect;
}

// A link's box, top pixels down the window, for a link the browser is scrolling.
const linkAt = (top: number) =>
  ({ left: 16, right: 120, top, bottom: top + 40, width: 104, height: 40, x: 16, y: top, toJSON: () => ({}) }) as DOMRect;

describe('measure', () => {
  it('reads the release, the canonical URL, the page width, the heading, the stylesheets and their rules, and the scripts', () => {
    const release = '0123456789abcdef0123456789abcdef01234567';
    document.head.innerHTML = [
      `<meta name="zachverse-release" content="${release}" />`,
      '<link rel="canonical" href="https://example.com/" />',
      '<link rel="stylesheet" href="/assets/index-AbCd1234.css">',
      '<link rel="stylesheet" href="/assets/missing-AbCd1234.css">',
      '<link rel="stylesheet" href="https://other.example/x.css">',
      '<script type="module" src="/assets/index-EfGh5678.js"></script>',
    ].join('');
    document.body.innerHTML = '<main><h1>  A Name  </h1></main>';
    const [, loaded, missing, foreign] = document.querySelectorAll('link');
    Object.defineProperty(loaded, 'sheet', { value: { cssRules: { length: 12 } } });
    Object.defineProperty(missing, 'sheet', { value: null });
    // A sheet from another origin throws when its rules are read.
    Object.defineProperty(foreign, 'sheet', {
      value: {
        get cssRules() {
          throw new DOMException('cross-origin', 'SecurityError');
        },
      },
    });
    place(document.querySelector('h1')!, { left: 16, right: 304, top: 24, width: 288, height: 40 });
    Object.defineProperty(document.documentElement, 'scrollWidth', { value: 320, configurable: true });
    Object.defineProperty(document.documentElement, 'clientWidth', { value: 320, configurable: true });

    expect(measure()).toEqual({
      release,
      canonical: 'https://example.com/',
      scrollWidth: 320,
      clientWidth: 320,
      viewportHeight: window.innerHeight,
      heading: { text: 'A Name', left: 16, right: 304, top: 24, bottom: 64, width: 288, height: 40, visible: true },
      stylesheets: [
        { href: `${location.origin}/assets/index-AbCd1234.css`, rules: 12 },
        { href: `${location.origin}/assets/missing-AbCd1234.css`, rules: null },
        { href: 'https://other.example/x.css', rules: null },
      ],
      scripts: [`${location.origin}/assets/index-EfGh5678.js`],
      tabStops: [],
    });
  });

  it('reads a page with no release, canonical URL, heading, stylesheet, script, or Tab stop, and measures the root element when no element scrolls', () => {
    const scrolling = Object.getOwnPropertyDescriptor(Document.prototype, 'scrollingElement');
    Object.defineProperty(document, 'scrollingElement', { value: null, configurable: true });
    try {
      Object.defineProperty(document.documentElement, 'scrollWidth', { value: 500, configurable: true });
      Object.defineProperty(document.documentElement, 'clientWidth', { value: 320, configurable: true });
      expect(measure()).toEqual({
        release: null,
        canonical: null,
        scrollWidth: 500,
        clientWidth: 320,
        viewportHeight: window.innerHeight,
        heading: null,
        stylesheets: [],
        scripts: [],
        tabStops: [],
      });
    } finally {
      delete (document as { scrollingElement?: unknown }).scrollingElement;
      if (scrolling) Object.defineProperty(Document.prototype, 'scrollingElement', scrolling);
    }
  });

  it('reads the canonical URL as the page writes it, not resolved against the address it was loaded from', () => {
    document.head.innerHTML = '<link rel="canonical" href="/resume/" />';
    expect(measure().canonical).toBe('/resume/');
  });

  it('lists the Tab stops in document order, each known by its place among them: the links, buttons, fields, frames, summaries, media controls, editable regions, and tabindex elements shown', () => {
    document.body.innerHTML = [
      '<nav><a href="/">Home</a><a>No address</a></nav>',
      '<a href="/resume/">  Two\n   words </a>',
      '<a href="mailto:someone@example.com"></a>',
      '<button>Go</button>',
      '<input name="q"><select><option>One</option></select><textarea></textarea>',
      '<iframe title="A frame"></iframe>',
      '<details><summary>More</summary><summary>Not the summary</summary></details>',
      '<audio controls></audio><video controls></video><video></video>',
      '<div contenteditable>Notes</div><p contenteditable="false">Fixed</p>',
      '<div tabindex="0">Card</div>',
      // Transparent, as a skip link is until it has the focus, but Tab reaches it all the same.
      '<a href="#main" style="opacity: 0">Skip</a>',
      // None of these: out of the order, disabled, hidden from the form, inert, or hidden.
      '<div tabindex="-1">Target</div><a href="/skipped" tabindex="-1">Skipped</a>',
      '<div contenteditable tabindex="-1">Out</div>',
      '<button disabled>Off</button><input type="hidden" name="h">',
      '<div inert><a href="/inert">Inert</a></div>',
      '<a href="/hidden" style="visibility: hidden">Hidden</a>',
    ].join('');
    expect(measure().tabStops).toEqual(
      [
        ['a', 'Home'],
        ['a', 'Two words'],
        // With no text, the href names it, and with neither, nothing does.
        ['a', 'mailto:someone@example.com'],
        ['button', 'Go'],
        ['input', ''],
        ['select', 'One'],
        ['textarea', ''],
        ['iframe', ''],
        ['summary', 'More'],
        ['audio', ''],
        ['video', ''],
        ['div', 'Notes'],
        ['div', 'Card'],
        ['a', 'Skip'],
      ].map(([tag, name], index) => ({ tag, name, index })),
    );
  });

  it("asks the browser's checkVisibility whether a Tab stop is hidden, but not whether it is transparent", () => {
    document.body.innerHTML = '<a href="/a">Shown</a><a href="/b">Not shown</a>';
    const asked: unknown[] = [];
    for (const link of document.querySelectorAll('a')) {
      const shown = link.textContent === 'Shown';
      Object.assign(link, { checkVisibility: (options: unknown) => (asked.push(options), shown) });
    }
    expect(measure().tabStops).toEqual([{ tag: 'a', name: 'Shown', index: 0 }]);
    expect(asked).toEqual(Array.from({ length: 2 }, () => ({ opacityProperty: false, visibilityProperty: true })));
  });
});

describe("measure: the heading's visibility", () => {
  const headingOf = (html: string) => {
    document.body.innerHTML = html;
    place(document.querySelector('h1')!, { left: 16, right: 304, top: 24, width: 288, height: 40 });
    return measure().heading!;
  };

  it('reads a heading hidden or fully transparent through its own style, where the browser cannot say', () => {
    expect(headingOf('<h1 style="visibility: hidden">A</h1>').visible).toBe(false);
    expect(headingOf('<h1 style="opacity: 0">A</h1>').visible).toBe(false);
    expect(headingOf('<h1 style="opacity: 0.5">A</h1>').visible).toBe(true);
  });

  it("asks the browser's checkVisibility, which also sees an ancestor's opacity, where it has one", () => {
    document.body.innerHTML = '<div style="opacity: 0"><h1>A</h1></div>';
    const heading = document.querySelector('h1')!;
    place(heading, { left: 16, right: 304, top: 24, width: 288, height: 40 });
    const asked: unknown[] = [];
    Object.assign(heading, { checkVisibility: (options: unknown) => (asked.push(options), false) });
    expect(measure().heading!.visible).toBe(false);
    expect(asked).toEqual([{ opacityProperty: true, visibilityProperty: true }]);
  });
});

describe('measureFocus', () => {
  it('reads the focused element, named and known as measure knows the Tab stops, its box, whether it shows, and the styles that would show its focus', async () => {
    document.body.innerHTML = '<p>Text</p><a href="/x" style="outline: 2px solid blue; box-shadow: none"> The   x </a>';
    const link = document.querySelector('a')!;
    place(link, { left: 16, right: 120, top: 300, width: 104, height: 40 });
    measure();
    link.focus();
    expect(await measureFocus(FOCUS_SETTLE_MS)).toEqual({
      tag: 'a',
      name: 'The x',
      index: 0,
      forward: true,
      visible: true,
      outlineStyle: expect.any(String),
      outlineWidth: expect.any(String),
      outlineColor: expect.any(String),
      boxShadow: expect.any(String),
      left: 16,
      right: 120,
      top: 300,
      bottom: 340,
    });
  });

  it('knows each element by itself, wherever the page moves the others, giving one that is not a Tab stop the next number after them, and says whether it follows the one focused before it', async () => {
    document.body.innerHTML = [
      '<a href="/a">Email</a><a href="/b">GitHub</a><a href="/c">LinkedIn</a>',
      // Focusable, but out of the Tab order.
      '<div tabindex="-1">Target</div>',
    ].join('');
    const [email, github, linkedin] = document.querySelectorAll('a');
    const target = document.querySelector('div')!;
    measure();
    const press = async (element: HTMLElement) => {
      element.focus();
      const { name, index, forward } = (await measureFocus(0))!;
      return { name, index, forward };
    };
    expect(await press(email!)).toEqual({ name: 'Email', index: 0, forward: true });
    // A tooltip shown on focus moves every later element's place in the document.
    email!.after(Object.assign(document.createElement('span'), { textContent: 'Copied' }));
    expect(await press(github!)).toEqual({ name: 'GitHub', index: 1, forward: true });
    expect(await press(target)).toEqual({ name: 'Target', index: 3, forward: true });
    expect(await press(linkedin!)).toEqual({ name: 'LinkedIn', index: 2, forward: false });
    expect(await press(target)).toEqual({ name: 'Target', index: 3, forward: true });
    // Still on the same element: no step forward.
    expect(await press(target)).toEqual({ name: 'Target', index: 3, forward: false });
  });

  it('knows elements in the order they are focused when measure has not run', async () => {
    document.body.innerHTML = '<button>One</button><button>Two</button>';
    const [one, two] = document.querySelectorAll('button');
    two!.focus();
    expect(await measureFocus(0)).toMatchObject({ name: 'Two', index: 0, forward: true });
    one!.focus();
    expect(await measureFocus(0)).toMatchObject({ name: 'One', index: 1, forward: false });
  });

  it('reads the box once it has held still for two animation frames, as a smooth scroll leaves it', async () => {
    document.body.innerHTML = '<a href="/far">Far below</a>';
    const link = document.querySelector('a')!;
    // A frame before the scroll starts, then the scroll moving the link up the window until it stops.
    const tops = [3026, 3026, 2000, 900, 391, 391, 391];
    let reads = 0;
    link.getBoundingClientRect = () => linkAt(tops[reads++]!);
    link.focus();
    expect(await measureFocus(FOCUS_SETTLE_MS)).toMatchObject({ left: 16, right: 120, top: 391, bottom: 431 });
    expect(reads).toBe(tops.length);
  });

  it('measures an element that never holds still where it is once settleMs have passed, and at once with none', async () => {
    document.body.innerHTML = '<a href="/moving">Moving</a>';
    const link = document.querySelector('a')!;
    let top = 1000;
    link.getBoundingClientRect = () => {
      top -= 10;
      return linkAt(top);
    };
    link.focus();
    const focus = await measureFocus(50);
    // Read where it last was, after at least one frame.
    expect([focus!.top, top < 990]).toEqual([top, true]);
    const last = top;
    expect(await measureFocus(0)).toMatchObject({ top: last - 10 });
  });

  it('reads a focused element hidden or fully transparent through its own style, where the browser cannot say', async () => {
    document.body.innerHTML = [
      '<a href="/a" style="opacity: 0">Clear</a>',
      '<a href="/b" style="visibility: hidden">Hidden</a>',
      '<a href="/c" style="opacity: 0.5">Faint</a>',
    ].join('');
    const visible: boolean[] = [];
    for (const link of document.querySelectorAll('a')) {
      link.focus();
      visible.push((await measureFocus(0))!.visible);
    }
    expect(visible).toEqual([false, false, true]);
  });

  it("asks the browser's checkVisibility whether a focused element shows, which also sees an ancestor's opacity, where it has one", async () => {
    document.body.innerHTML = '<div style="opacity: 0"><a href="/skip">Skip</a></div>';
    const link = document.querySelector('a')!;
    const asked: unknown[] = [];
    Object.assign(link, { checkVisibility: (options: unknown) => (asked.push(options), false) });
    link.focus();
    expect((await measureFocus(0))!.visible).toBe(false);
    expect(asked).toEqual([{ opacityProperty: true, visibilityProperty: true }]);
  });

  it('names a focused element with no text by its href, and one with neither by nothing', async () => {
    document.body.innerHTML = '<a href="mailto:someone@example.com"></a><button></button>';
    document.querySelector('a')!.focus();
    expect((await measureFocus(0))?.name).toBe('mailto:someone@example.com');
    document.querySelector('button')!.focus();
    expect(await measureFocus(0)).toMatchObject({ tag: 'button', name: '' });
  });

  it('reads nothing when nothing has the focus', async () => {
    document.body.innerHTML = '<p>text</p>';
    expect(await measureFocus(0)).toBeNull();
    const active = Object.getOwnPropertyDescriptor(Document.prototype, 'activeElement');
    Object.defineProperty(document, 'activeElement', { value: null, configurable: true });
    try {
      expect(await measureFocus(0)).toBeNull();
    } finally {
      delete (document as { activeElement?: unknown }).activeElement;
      if (active) Object.defineProperty(Document.prototype, 'activeElement', active);
    }
  });
});

describe('audit', () => {
  // The browser check adds axe-core's browser build to the page; here, the same build, loaded in jsdom's window.
  it("runs axe-core's rules with the tags asked for, and lists each rule the page breaks with the elements that break it", async () => {
    const { default: axe } = await import('axe-core');
    Object.assign(window, { axe });
    const run = vi.spyOn(axe, 'run');
    // jsdom has no canvas, which axe-core draws text on to tell icon fonts apart, and says so for every call.
    const canvas = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    document.documentElement.lang = 'en';
    try {
      document.head.innerHTML = '<title>A page</title>';
      document.body.innerHTML = '<main><h1>A Name</h1><img src="/a.png"><img src="/b.png"><div id="host"></div></main>';
      // An element in a shadow root is named by its host's selector, then its own.
      const shadow = document.querySelector('#host')!.attachShadow({ mode: 'open' });
      shadow.innerHTML = '<img src="/c.png">';
      expect(await audit(AXE_TAGS)).toEqual([
        { id: 'image-alt', impact: 'critical', targets: ['img[src="/a.png"]', 'img[src="/b.png"]', '#host img[src="/c.png"]'] },
      ]);
      expect(run).toHaveBeenCalledExactlyOnceWith(document, { runOnly: { type: 'tag', values: [...AXE_TAGS] } });
      // With every image described, the page breaks none.
      for (const image of [...document.querySelectorAll('img'), ...shadow.querySelectorAll('img')]) image.alt = 'A picture';
      expect(await audit(AXE_TAGS)).toEqual([]);
    } finally {
      run.mockRestore();
      canvas.mockRestore();
      document.documentElement.removeAttribute('lang');
    }
  });
});
