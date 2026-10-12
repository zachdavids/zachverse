// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { pageIds } from './App.tsx';
import { render } from './entry-server.tsx';

// jsdom parses CSS but does no layout, so these pin the rules the responsive,
// keyboard-friendly placeholder depends on rather than measuring a page.
let rules: CSSStyleRule[] = [];

// Style rules, including those inside @media.
function styleRules(list: CSSRuleList): CSSStyleRule[] {
  return Array.from(list).flatMap((rule) => {
    if (rule instanceof CSSStyleRule) return [rule];
    return 'cssRules' in rule ? styleRules(rule.cssRules as CSSRuleList) : [];
  });
}

beforeAll(() => {
  const style = document.createElement('style');
  // A path, not a URL: node:fs rejects jsdom's URL objects.
  style.textContent = readFileSync(join(import.meta.dirname, 'styles.css'), 'utf8');
  document.head.append(style);
  rules = styleRules(style.sheet!.cssRules);
});

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
    const fixed = rules.flatMap((rule) =>
      ['width', 'min-width']
        .map((property) => [property, rule.style.getPropertyValue(property)] as const)
        .filter(([, value]) => !/^(?:|auto|\d+(?:\.\d+)?%)$/.test(value))
        .map(([property, value]) => `${rule.selectorText} { ${property}: ${value} }`),
    );
    expect(fixed).toEqual([]);
    expect(rules.find((rule) => rule.selectorText === '.links')?.style.getPropertyValue('flex-wrap')).toBe('wrap');
  });

  // WCAG 2.4.7: keyboard users can see which link has focus.
  it('outlines a focused link', () => {
    document.body.innerHTML = render('home');
    const link = document.querySelector('a')!;
    link.focus();
    // jsdom keeps the cascaded shorthand whole, as it holds a var().
    const outline = getComputedStyle(link).outline.split(' ');
    expect(outline).toContainEqual(expect.stringMatching(/^(?:solid|dashed|dotted|double)$/));
    expect(outline).toContainEqual(expect.stringMatching(/^[1-9][\d.]*px$/));
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
