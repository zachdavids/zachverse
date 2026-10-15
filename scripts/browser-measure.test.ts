// @vitest-environment jsdom
// measure and measureFocus run inside the page; jsdom stands in for it here. jsdom has no layout, so the tests set the
// sizes the checks read.
import { afterEach, describe, expect, it } from 'vitest';
import { measure, measureFocus } from './browser-check-lib.ts';

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

// A box for an element, as layout would give it.
function place(element: Element, box: { left: number; right: number; width: number; height: number }) {
  element.getBoundingClientRect = () => ({ ...box, top: 0, bottom: box.height, x: box.left, y: 0, toJSON: () => box }) as DOMRect;
}

describe('measure', () => {
  it('reads the release, the page width, the heading, the stylesheets and their rules, and the scripts', () => {
    const release = '0123456789abcdef0123456789abcdef01234567';
    document.head.innerHTML = [
      `<meta name="zachverse-release" content="${release}" />`,
      '<link rel="stylesheet" href="/assets/index-AbCd1234.css">',
      '<link rel="stylesheet" href="/assets/missing-AbCd1234.css">',
      '<link rel="stylesheet" href="https://other.example/x.css">',
      '<script type="module" src="/assets/index-EfGh5678.js"></script>',
    ].join('');
    document.body.innerHTML = '<main><h1>  A Name  </h1></main>';
    const [loaded, missing, foreign] = document.querySelectorAll('link');
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
    place(document.querySelector('h1')!, { left: 16, right: 304, width: 288, height: 40 });
    Object.defineProperty(document.documentElement, 'scrollWidth', { value: 320, configurable: true });
    Object.defineProperty(document.documentElement, 'clientWidth', { value: 320, configurable: true });

    expect(measure()).toEqual({
      release,
      scrollWidth: 320,
      clientWidth: 320,
      heading: { text: 'A Name', left: 16, right: 304, width: 288, height: 40 },
      stylesheets: [
        { href: `${location.origin}/assets/index-AbCd1234.css`, rules: 12 },
        { href: `${location.origin}/assets/missing-AbCd1234.css`, rules: null },
        { href: 'https://other.example/x.css', rules: null },
      ],
      scripts: [`${location.origin}/assets/index-EfGh5678.js`],
    });
  });

  it('reads a page with no release, heading, stylesheet, or script, and measures the root element when no element scrolls', () => {
    const scrolling = Object.getOwnPropertyDescriptor(Document.prototype, 'scrollingElement');
    Object.defineProperty(document, 'scrollingElement', { value: null, configurable: true });
    try {
      Object.defineProperty(document.documentElement, 'scrollWidth', { value: 500, configurable: true });
      Object.defineProperty(document.documentElement, 'clientWidth', { value: 320, configurable: true });
      expect(measure()).toEqual({
        release: null,
        scrollWidth: 500,
        clientWidth: 320,
        heading: null,
        stylesheets: [],
        scripts: [],
      });
    } finally {
      delete (document as { scrollingElement?: unknown }).scrollingElement;
      if (scrolling) Object.defineProperty(Document.prototype, 'scrollingElement', scrolling);
    }
  });
});

describe('measureFocus', () => {
  it('reads the focused element and the styles that would show its focus', () => {
    document.body.innerHTML = '<a href="/x" style="outline: 2px solid blue; box-shadow: none">x</a>';
    document.querySelector('a')!.focus();
    expect(measureFocus()).toMatchObject({ tag: 'a', outlineStyle: expect.any(String), boxShadow: expect.any(String) });
  });

  it('reads nothing when nothing has the focus', () => {
    document.body.innerHTML = '<p>text</p>';
    expect(measureFocus()).toBeNull();
    const active = Object.getOwnPropertyDescriptor(Document.prototype, 'activeElement');
    Object.defineProperty(document, 'activeElement', { value: null, configurable: true });
    try {
      expect(measureFocus()).toBeNull();
    } finally {
      delete (document as { activeElement?: unknown }).activeElement;
      if (active) Object.defineProperty(Document.prototype, 'activeElement', active);
    }
  });
});
