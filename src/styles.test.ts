// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { pageIds } from './App.tsx';
import { render } from './entry-server.tsx';

// jsdom parses CSS but does no layout, so these pin the rules the responsive,
// keyboard-friendly placeholder depends on rather than measuring a page.
let rules: CSSStyleRule[] = [];

// A path, not a URL: node:fs rejects jsdom's URL objects.
const css = readFileSync(join(import.meta.dirname, 'styles.css'), 'utf8');

// Style rules, including those inside @media.
function styleRules(list: CSSRuleList): CSSStyleRule[] {
  return Array.from(list).flatMap((rule) => {
    if (rule instanceof CSSStyleRule) return [rule];
    return 'cssRules' in rule ? styleRules(rule.cssRules as CSSRuleList) : [];
  });
}

// Makes `text` the document's only stylesheet.
function load(text: string) {
  const style = document.createElement('style');
  style.textContent = text;
  document.head.replaceChildren(style);
  rules = styleRules(style.sheet!.cssRules);
}

// Each width or min-width that its container does not set: anything but auto, a
// percentage, min() with a percentage, or a percentage less a length.
function fixedWidths(): string[] {
  return rules.flatMap((rule) =>
    ['width', 'min-width']
      .map((property) => [property, rule.style.getPropertyValue(property)] as const)
      .filter(([, value]) => !/^(?:|auto|\d+(?:\.\d+)?%|min\(.*%.*\)|calc\(\d+(?:\.\d+)?% - .+\))$/.test(value))
      .map(([property, value]) => `${rule.selectorText} { ${property}: ${value} }`),
  );
}

// The flex-wrap values the rules for the contact links set. Those inside @media
// count too: jsdom matches no media feature, and a 320 px screen may match one.
function linksWrap(): string[] {
  document.body.innerHTML = render('home');
  const links = document.querySelector('.links')!;
  const values = rules
    .filter((rule) => links.matches(rule.selectorText))
    .map((rule) => rule.style.getPropertyValue('flex-wrap'))
    .filter((value) => value !== '');
  return [...new Set(values)];
}

// What keeps a focused link's outline from showing: no visible line style, or a
// none style or zero width from any rule (an omitted width is medium). Each
// property is read as jsdom cascades it, but only where a rule for the link sets
// it: jsdom keeps the shorthand whole and gives an unset longhand its initial value.
function hiddenOutline(): string[] {
  document.body.innerHTML = render('home');
  const link = document.querySelector('a')!;
  link.focus();
  const computed = getComputedStyle(link);
  // Rules inside @media are left out, as jsdom's cascade matches no media feature.
  const applied = rules.filter((rule) => rule.parentRule === null && link.matches(rule.selectorText));
  const values = ['outline', 'outline-style', 'outline-width']
    .filter((property) => applied.some((rule) => rule.style.getPropertyValue(property) !== ''))
    .flatMap((property) => {
      // Split at spaces outside parentheses, so var(--accent) or rgb(0 0 0) stays whole.
      const parts = computed.getPropertyValue(property).match(/[^\s(]+(?:\([^)]*\))?/g) ?? [];
      return parts.map((part) => `${property}: ${part}`);
    });
  const hiding = values.filter((value) => /: (?:none|0*\.?0+[a-z]*)$/.test(value));
  const shown = values.some((value) => /: (?:solid|dashed|dotted|double|groove|ridge|inset|outset)$/.test(value));
  return shown ? hiding : ['no visible line style', ...hiding];
}

beforeEach(() => load(css));

describe('styles.css', () => {
  it.each(pageIds)('has rules for every class the %s page renders', (page) => {
    const styled = new Set(rules.flatMap((rule) => rule.selectorText.match(/(?<=\.)[\w-]+/g) ?? []));
    document.body.innerHTML = render(page);
    const classes = Array.from(document.body.querySelectorAll('[class]'), (element) => [...element.classList]).flat();
    expect(classes).not.toHaveLength(0);
    expect(classes.filter((name) => !styled.has(name))).toEqual([]);
  });

  // WCAG 1.4.10: at 320 CSS px the page reflows instead of scrolling sideways.
  it('sets no fixed width, and lets the contact links wrap', () => {
    expect(fixedWidths()).toEqual([]);
    expect(linksWrap()).toEqual(['wrap']);
  });

  // WCAG 2.4.7: keyboard users can see which link has focus.
  it('outlines a focused link', () => {
    expect(hiddenOutline()).toEqual([]);
  });

  it('gives the dark scheme its own value for every color', () => {
    const colors = (rule?: CSSStyleRule) =>
      Array.from(rule?.style ?? [], String)
        .filter((name) => name.startsWith('--'))
        .sort();
    const roots = rules.filter((rule) => rule.selectorText === ':root');
    const light = roots.find((rule) => rule.parentRule === null);
    const dark = roots.find(
      ({ parentRule }) =>
        parentRule instanceof CSSMediaRule && parentRule.conditionText === '(prefers-color-scheme: dark)',
    );
    expect(colors(light)).not.toHaveLength(0);
    expect(colors(dark)).toEqual(colors(light));
  });

  // Browsers give paragraphs, lists, and headings a bottom margin, which would
  // add to the card's bottom padding.
  it.each(pageIds)('ends the %s card with no bottom margin', (page) => {
    document.body.innerHTML = render(page);
    const last = document.querySelector('.card')!.lastElementChild!;
    const margins = rules
      .filter((rule) => last.matches(rule.selectorText))
      .map((rule) => rule.style.getPropertyValue('margin-bottom'))
      .filter((margin) => margin !== '');
    expect(margins).not.toHaveLength(0);
    expect(margins.filter((margin) => parseFloat(margin) !== 0)).toEqual([]);
  });
});

// The checks read what rules do rather than how they are written, so equivalent
// rewrites pass and rewrites that break the layout or the focus outline fail.
describe('the styles.css checks', () => {
  it.each(['width: min(100%, 40rem)', 'width: calc(100% - 0px)'])('take %s as set by its container', (declaration) => {
    load(`#root { ${declaration}; }`);
    expect(fixedWidths()).toEqual([]);
  });

  it.each(['width: 40rem', 'min-width: max(100%, 40rem)', 'width: calc(100% + 2rem)'])(
    'take %s as fixed',
    (declaration) => {
      load(`#root { ${declaration}; }`);
      expect(fixedWidths()).toEqual([`#root { ${declaration} }`]);
    },
  );

  it.each([
    ['a second rule', '.links { display: flex; } .links { flex-wrap: wrap; }', ['wrap']],
    ['a later rule', '.links { flex-wrap: wrap; } .links { flex-wrap: nowrap; }', ['wrap', 'nowrap']],
    [
      '@media',
      '.links { flex-wrap: wrap; } @media (max-width: 30rem) { .links { flex-wrap: nowrap; } }',
      ['wrap', 'nowrap'],
    ],
  ])('read flex-wrap for the contact links from %s', (_, text, values) => {
    load(text);
    expect(linksWrap()).toEqual(values);
  });

  it.each([
    ['the shorthand with a rem width', 'a:focus-visible { outline: 0.125rem solid var(--accent); }', []],
    [
      'longhands',
      'a:focus-visible { outline-width: 0.125rem; outline-style: solid; outline-color: var(--accent); }',
      [],
    ],
    ['a color with spaces', 'a:focus-visible { outline: 2px solid rgb(0 0 0); }', []],
    ['a zero width', 'a:focus-visible { outline: 0 solid var(--accent); }', ['outline: 0']],
    [
      'a later longhand',
      'a:focus-visible { outline: 2px solid var(--accent); } a:focus-visible { outline-style: none; }',
      ['outline-style: none'],
    ],
    [
      'a later shorthand',
      'a:focus-visible { outline-style: solid; outline-width: 2px; } a:focus-visible { outline: none; }',
      ['outline: none'],
    ],
    // jsdom gives a longhand that only an @media rule sets its initial value, none.
    [
      'a longhand inside @media',
      'a:focus-visible { outline: 2px solid; } @media (forced-colors: active) { a { outline-style: dotted; } }',
      [],
    ],
    // jsdom lets its own :focus-visible { outline: auto } outrank this rule, which
    // browsers do not, but auto is no line style either.
    ['only a reset', 'a { outline: none; }', ['no visible line style']],
  ])('find what hides a focus outline set by %s', (_, text, hidden) => {
    load(text);
    expect(hiddenOutline()).toEqual(hidden);
  });
});
