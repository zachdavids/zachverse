// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { pageIds, type PageId } from './App.tsx';
import { render } from './entry-server.tsx';

// jsdom parses CSS but does no layout, so these pin the rules the responsive,
// keyboard-friendly placeholder depends on rather than measuring a page.
let rules: CSSStyleRule[] = [];

// A path, not a URL: node:fs rejects jsdom's URL objects.
const css = readFileSync(join(import.meta.dirname, 'styles.css'), 'utf8');

// The <html> element index.html gives every page, whose attributes rules may be scoped by.
const html = new DOMParser().parseFromString(
  readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8'),
  'text/html',
).documentElement;

// The tokens of CSS `text` that brackets and separators are counted over: an
// unquoted url(), a comment, a quoted string or an escaped character is one token,
// so what it holds counts for nothing, and any other character is a token of its
// own. As in CSS, a string also ends at a line break (an escaped one, CRLF too,
// continues it), and /* in a url() opens no comment.
function tokens(text: string): string[] {
  const token =
    /(?<![\w\u0080-\uffff#@-])url\((?![ \t\n\r\f]*["'])(?:\\[\s\S]|[^)\\])*\)|\/\*[\s\S]*?\*\/|"(?:\\(?:\r\n|[\s\S])|[^"\\\n\r\f])*"?|'(?:\\(?:\r\n|[\s\S])|[^'\\\n\r\f])*'?|\\[\s\S]|[\s\S]/gi;
  return text.match(token) ?? [];
}

// Throws, naming the rule, if a style rule in `text` holds a block other than a
// custom property's value: a nested rule or an at-rule such as @media. It reads
// the text because jsdom drops some nested rules, such as a:focus-visible { ... }
// when a semicolon and a declaration follow it. As in CSS, nothing inside a
// function or a () or [] block opens, closes or ends a rule. It misses a statement
// such as @layer x;, which holds no block (styleRules rejects it). Its tokens only
// approximate CSS's, so an unusual spelling can still hide a nested rule from it,
// such as a url( that follows or holds an escape (x\ url(, u\72l().
function rejectNesting(text: string) {
  // The prelude of each open block, or undefined for an at-rule's.
  const blocks: (string | undefined)[] = [];
  // What closes each bracket open inside a function or a () or [] block.
  const closers: string[] = [];
  let prelude = '';
  for (const token of tokens(text)) {
    if (closers.length > 0 || token === '(' || token === '[') {
      // Closers match by kind, as in CSS: in x({)}), the ) inside {} closes nothing.
      if (token === closers.at(-1)) closers.pop();
      else if (token === '(') closers.push(')');
      else if (token === '[') closers.push(']');
      else if (token === '{') closers.push('}');
      if (!token.startsWith('/*')) prelude += token;
    } else if (token === '{') {
      const selector = blocks.at(-1);
      // A custom property's value may be a {} block, which nests nothing. With no
      // colon after the name, --x, a { ... } is a nested rule for --x and a elements.
      if (selector !== undefined && !/^--[^\s:]*\s*:/.test(prelude.trim())) {
        throw new Error(`${selector} nests rules, which these checks do not read`);
      }
      blocks.push(prelude.trim().startsWith('@') ? undefined : prelude.trim());
      prelude = '';
    } else if (token === '}' || token === ';') {
      if (token === '}') blocks.pop();
      prelude = '';
    } else if (!token.startsWith('/*')) {
      prelude += token;
    }
  }
}

// The style rules a screen can apply, in source order: those inside @media and
// other at-rules count, as a 320 px screen may match one, but print-only ones do
// not. Throws, naming the rule, if one of them holds a rule or statement jsdom
// kept, which no check reads.
function styleRules(list: CSSRuleList): CSSStyleRule[] {
  return Array.from(list).flatMap((rule) => {
    if (rule instanceof CSSStyleRule) {
      if (rule.cssRules.length > 0) throw new Error(`${rule.selectorText} nests rules, which these checks do not read`);
      return [rule];
    }
    const media = rule instanceof CSSMediaRule ? Array.from(rule.media) : [];
    if (media.length > 0 && media.every((query) => /^(?:only )?print\b/.test(query))) return [];
    return 'cssRules' in rule ? styleRules(rule.cssRules as CSSRuleList) : [];
  });
}

// Makes `text` the document's only stylesheet. A style rule that nests rules fails
// the load, as no check resolves & against a parent's selector: rejectNesting finds
// the nested rules jsdom drops, and styleRules the nesting it keeps.
function load(text: string) {
  rejectNesting(text);
  const style = document.createElement('style');
  style.textContent = text;
  document.head.replaceChildren(style);
  rules = styleRules(style.sheet!.cssRules);
}

// Renders `page` inside a #root like index.html's, under its <html> attributes,
// so rules scoped by #root, data-page, body > div, :lang(en) or html[lang] match
// as they do on the site.
function show(page: PageId) {
  for (const { name, value } of Array.from(html.attributes)) document.documentElement.setAttribute(name, value);
  document.body.innerHTML = `<div id="root" data-page="${page}">${render(page)}</div>`;
}

// Each declaration of one of `properties` whose value `fails`, as `selector { property: value }`.
function declarations(properties: string[], fails: (value: string) => boolean): string[] {
  return rules.flatMap((rule) =>
    properties
      .map((property) => [property, rule.style.getPropertyValue(property)] as const)
      .filter(([, value]) => fails(value))
      .map(([property, value]) => `${rule.selectorText} { ${property}: ${value} }`),
  );
}

// Each width, min-width or logical equivalent that its container does not set:
// anything but auto, a percentage of at most 100, min() with such a percentage as
// one of its arguments, or one less a non-negative length, and for a minimum, a
// zero length, which widens nothing.
function fixedWidths(): string[] {
  // More than 100% overflows the container at any width.
  const percentage = String.raw`(?:100|\d{1,2}(?:\.\d+)?)%`;
  // min()'s other arguments may nest parentheses one level deep, as var(--max, 40rem) does.
  const argument = String.raw`(?:[^(),]|\([^()]*\))+`;
  const setByContainer = new RegExp(
    String.raw`^(?:|auto|${percentage}|min\((?:${argument},\s*)*${percentage}(?:,\s*${argument})*\)|calc\(${percentage} - \d+(?:\.\d+)?[a-z]*\))$`,
  );
  // jsdom writes min-width: 0 as 0px, but keeps 0rem as written.
  const zero = /^0*\.?0+[a-z]*$/;
  return [
    ...declarations(['width', 'inline-size'], (value) => !setByContainer.test(value)),
    ...declarations(['min-width', 'min-inline-size'], (value) => !setByContainer.test(value) && !zero.test(value)),
  ];
}

// Each declaration that keeps text on one line, in any rule: white-space nowrap or
// pre, or a nowrap text-wrap or text-wrap-mode. jsdom keeps all three, and a value
// of several keywords as written, so nowrap counts in any case. A value set
// through var() goes unread.
function unwrappedText(): string[] {
  return declarations(['white-space', 'text-wrap', 'text-wrap-mode'], (value) => /^pre$|\bnowrap\b/i.test(value));
}

// What decides whether the contact links wrap, from each rule for them: a display
// other than flex or inline-flex, under which flex-wrap does nothing, and each
// flex-wrap set, flex-flow included. jsdom keeps that shorthand whole and as
// written, so its wrap keyword is read here, or nowrap where it names none: a
// shorthand resets what it leaves out.
function linksWrap(): string[] {
  show('home');
  const links = document.querySelector('.links')!;
  const values = rules
    .filter((rule) => links.matches(rule.selectorText))
    .flatMap((rule) => {
      const display = rule.style.getPropertyValue('display');
      const flow = rule.style.getPropertyValue('flex-flow').toLowerCase();
      const wrap = flow.split(/\s+/).find((word) => /^(?:nowrap|wrap|wrap-reverse)$/.test(word));
      return [
        /^(?:|flex|inline-flex)$/.test(display) ? '' : `display: ${display}`,
        rule.style.getPropertyValue('flex-wrap'),
        flow && (wrap ?? 'nowrap'),
      ];
    })
    .filter((value) => value !== '');
  return [...new Set(values)];
}

// The outline longhands a declaration sets, each with its value. all and the
// outline shorthand set all three: all to its own value, such as unset, and the
// shorthand to its parts, where a part it leaves out is undefined here and takes
// its initial value: none, medium or currentcolor.
function outlineLonghands(property: string, value: string): [string, string | undefined][] {
  if (property === 'all') {
    return ['outline-style', 'outline-width', 'outline-color'].map((longhand): [string, string] => [longhand, value]);
  }
  if (property !== 'outline') return /^outline-(?:style|width|color)$/.test(property) ? [[property, value]] : [];
  // Split at spaces outside parentheses, so var(--accent) or rgb(0 0 0) stays whole.
  const parts = value.match(/[^\s(]+(?:\([^)]*\))?/g) ?? [];
  const style = parts.find((part) =>
    /^(?:none|auto|solid|dashed|dotted|double|groove|ridge|inset|outset)$/i.test(part),
  );
  // Whole keywords only: mediumblue is a color.
  const width = parts.find((part) => /^(?:(?:thin|medium|thick)$|\.?\d|(?:calc|min|max|clamp)\()/i.test(part));
  // A width this misses, such as var(--w), leaves two parts, so a hiding color goes first.
  const rest = parts.filter((part) => part !== style && part !== width);
  const colorHides = (part: string) => hiding.some(([longhand, pattern]) => longhand === 'outline-color' && pattern.test(part));
  return [
    ['outline-style', style],
    ['outline-width', width],
    ['outline-color', rest.find((part) => colorHides(part)) ?? rest[0]],
  ];
}

// What hides an outline, by longhand: a style other than a visible line style,
// including none set at all, a zero width, or a transparent or zero-alpha color.
// jsdom writes math in outline-width as calc() where it can work it out, as
// calc(0px) for min(0px, 2px), but keeps the shorthand as written. No other math,
// color-mix() or var() is worked out: --accent: transparent goes unseen. A
// shorthand part with nested parentheses, such as calc(min(1px, 2px)), is misread,
// and math that comes to a negative width, such as calc(-1px), goes unread, though
// browsers clamp it to zero.
const hiding: [string, RegExp][] = [
  ['outline-style', /^(?!(?:solid|dashed|dotted|double|groove|ridge|inset|outset)$)/i],
  ['outline-width', /^(?:0*\.?0+[a-z]*|calc\(0*\.?0+[a-z]*\))$/i],
  [
    'outline-color',
    /^(?:transparent|#[\da-f]{3}0|#[\da-f]{6}00|[a-z-]+\((?:[^,()]*,){3}\s*0*\.?0+%?\s*\)|[a-z-]+\([^()]*\/\s*0*\.?0+%?\s*\))$/i,
  ],
];

// The selectors in a list, split at its commas outside parentheses, so that
// :is(nav, li) a stays whole. A string is one token, so a[title="x,y"] does too.
function selectorList(text: string): string[] {
  const selectors: string[] = [];
  let selector = '';
  let depth = 0;
  for (const token of tokens(text)) {
    if (token === ',' && depth === 0) {
      selectors.push(selector);
      selector = '';
      continue;
    }
    if (token === '(') depth++;
    if (token === ')') depth--;
    selector += token;
  }
  return [...selectors, selector];
}

// What keeps the focused `link`'s outline from showing: no visible line style, a
// zero width or a transparent color. Each longhand is read from the declaration
// that wins the cascade among the rules a screen can apply to the link, as if
// every feature query matched and no rule were in a layer. jsdom skips feature
// queries and keeps the outline shorthand whole, so each rule is copied with a
// custom property per longhand it sets, holding the declaration's number, and
// jsdom cascades those by specificity, then order. An !important declaration
// that a later one for the same property in the same rule overrides goes unread:
// jsdom drops it, though browsers apply it.
function hiddenOutline(link: HTMLElement): string[] {
  link.focus();
  const numbered: [property: string, value?: string][] = [];
  const copies = rules
    .filter((rule) => link.matches(rule.selectorText))
    .map((rule) => {
      const longhands = Array.from(rule.style).flatMap((property) => {
        // jsdom ranks !important declarations by order alone, so they go unflagged into properties of their own.
        const tier = rule.style.getPropertyPriority(property) ? 'important' : 'normal';
        return outlineLonghands(property, rule.style.getPropertyValue(property)).map(([longhand, value]) => {
          numbered.push([property, value]);
          return `--${tier}-${longhand}: ${numbered.length - 1}`;
        });
      });
      // jsdom ranks a selector list by its most specific selector, matching or not, and
      // skips a list with a pseudo-element, so a copy keeps the selectors that match.
      const selectors = selectorList(rule.selectorText).filter((selector) => link.matches(selector));
      return `${selectors.join(',')} { ${longhands.join('; ')} }`;
    });
  const style = document.createElement('style');
  style.textContent = copies.join('\n');
  document.head.append(style);
  const computed = getComputedStyle(link);
  const hidden = hiding.flatMap(([longhand, hides]) => {
    // An important declaration beats every normal one.
    const winner =
      computed.getPropertyValue(`--important-${longhand}`) || computed.getPropertyValue(`--normal-${longhand}`);
    const [property, value] = numbered[parseInt(winner)] ?? [];
    // Only a missing style hides: a width left out is medium, a color currentcolor.
    if (!hides.test(value ?? '')) return [];
    return [value === undefined ? 'no visible line style' : `${property}: ${value}`];
  });
  style.remove();
  // Leaves nothing focused: when focus came from another element, jsdom's
  // :focus-visible stops matching after the first check.
  link.blur();
  return hidden;
}

// What hides the focus outline of any link on any page, each listed once.
function hiddenOutlines(): string[] {
  const hidden = pageIds.flatMap((page) => {
    show(page);
    return Array.from(document.querySelectorAll('a')).flatMap(hiddenOutline);
  });
  return [...new Set(hidden)];
}

// The bottom margins each rule sets on the last element in the `page` card:
// margin-bottom, margin-block-end, and the end of margin-block, which jsdom keeps whole.
function bottomMargins(page: PageId): string[] {
  show(page);
  const last = document.querySelector('.card')!.lastElementChild!;
  return rules
    .filter((rule) => last.matches(rule.selectorText))
    .flatMap((rule) => [
      rule.style.getPropertyValue('margin-bottom'),
      rule.style.getPropertyValue('margin-block-end'),
      rule.style.getPropertyValue('margin-block').split(/\s+/).at(-1)!,
    ])
    .filter((margin) => margin !== '');
}

beforeEach(() => load(css));

describe('styles.css', () => {
  it.each(pageIds)('has rules for every class the %s page renders', (page) => {
    const styled = new Set(rules.flatMap((rule) => rule.selectorText.match(/(?<=\.)[\w-]+/g) ?? []));
    show(page);
    const classes = Array.from(document.body.querySelectorAll('[class]'), (element) => [...element.classList]).flat();
    expect(classes).not.toHaveLength(0);
    expect(classes.filter((name) => !styled.has(name))).toEqual([]);
  });

  // WCAG 1.4.10: at 320 CSS px the page reflows instead of scrolling sideways.
  // With no layout to measure, this checks the widths, text kept on one line, and
  // that the contact links form a flex box that wraps. Other causes, such as wide
  // fixed padding, go unseen.
  it('sets no fixed width, and lets text and the contact links wrap', () => {
    expect(fixedWidths()).toEqual([]);
    expect(unwrappedText()).toEqual([]);
    expect(linksWrap()).toEqual(['wrap']);
  });

  // WCAG 2.4.7: keyboard users can see which link has focus.
  it('outlines every focused link', () => {
    expect(hiddenOutlines()).toEqual([]);
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
    const margins = bottomMargins(page);
    expect(margins).not.toHaveLength(0);
    expect(margins.filter((margin) => parseFloat(margin) !== 0)).toEqual([]);
  });
});

// Each check reads what the rules do rather than how they are written, but only
// what jsdom keeps: a declaration it drops, such as width: MIN(500%, 99rem), goes
// unread, as do the spellings each helper names and a layout break through any
// other property, such as wide fixed padding. A nested rule fails the load,
// unless an unusual spelling hides it (see rejectNesting).
describe('the styles.css checks', () => {
  it.each([
    ['a nested rule', '.card { & a:focus-visible { outline: none; } }', '.card'],
    ['a nested pseudo-class', 'a { &:focus-visible { outline: none; } }', 'a'],
    ['a nested rule with no &', 'nav { .links { flex-wrap: nowrap; } }', 'nav'],
    ['declarations after a nested rule', '.links { & li { margin: 0; } flex-wrap: nowrap; }', '.links'],
    ['a nested @media', '.links { @media (max-width: 30rem) { flex-wrap: nowrap; } }', '.links'],
    ['a rule nesting inside @media', '@media screen { .card { & a { outline: none; } } }', '.card'],
    ['a rule nesting after a statement', '@layer base; .card { & a { outline: none; } }', '.card'],
    // jsdom drops these nested rules, leaving .card with none.
    ['a nested rule a semicolon follows', '.card { a:focus-visible { outline: none; }; color: red; }', '.card'],
    [
      'a nested rule between comments',
      '/* a */ .card { a:focus-visible { outline: none; }; color: red; } /* b */',
      '.card',
    ],
    // A string left open ends at the line break, so a later quote does not close it.
    [
      'a nested rule after an unclosed string',
      '.card { content: "x\n a:focus-visible { outline: none; } }\n.y { content: "z"; }',
      '.card',
    ],
    [
      'a dropped nested rule after an unclosed string',
      '.card { quotes: "x\n; a:focus-visible { outline: none; }; color: red; }\n.y::after { content: ""; }',
      '.card',
    ],
    // An unquoted url() runs to its ), so /* or } in it neither opens a comment nor closes the rule.
    [
      'a nested rule after url(/*)',
      '.card { background: url(/*); a:focus-visible { outline: none; }; color: red; } /* x */',
      '.card',
    ],
    [
      'a nested rule after url(})',
      '.card { background: url(}); a:focus-visible { outline: none; }; color: red; }',
      '.card',
    ],
    // A url() token ends at its first unescaped ), whatever the case of its name.
    [
      'a nested rule after url() and a later )',
      '.card { background: url(}); a:focus-visible { outline: none; }; color: var(--x); }',
      '.card',
    ],
    [
      'a nested rule after URL(/*)',
      '.card { background: URL(/*); a:focus-visible { outline: none; }; color: red; } /* x */',
      '.card',
    ],
    [
      'a nested rule after url(\\)/*)',
      '.card { background: url(\\)/*); a:focus-visible { outline: none; }; color: red; } /* x */',
      '.card',
    ],
    // Only url( after something that cannot end a name, and before no quote, is a url() token.
    [
      'a nested rule after x-url(a")")',
      '.card { background: x-url(a")"); a:focus-visible { outline: none; }; content: "x"; }',
      '.card',
    ],
    [
      'a nested rule after #url(a")")',
      '.card { background: #url(a")"); a:focus-visible { outline: none; }; content: "x"; }',
      '.card',
    ],
    [
      'a nested rule after \u00e9url(a")")',
      '.card { background: \u00e9url(a")"); a:focus-visible { outline: none; }; content: "x"; }',
      '.card',
    ],
    // A no-break space is no CSS whitespace, so url( before one and a quote is a url() token.
    [
      'a nested rule after url(\u00a0")',
      '.card { background: url(\u00a0"); a:focus-visible { outline: none; }; x: "; color: red; }',
      '.card',
    ],
    // A single-quoted string ends at a carriage return, and a form feed ends none of the text after it.
    [
      'a nested rule after an unclosed single quote',
      ".card { quotes: 'x\r; a:focus-visible { outline: none; }; color: red; }\f.y { content: ''; }",
      '.card',
    ],
    // Nothing in a function or a () or [] block ends the rule, and its brackets close by kind.
    [
      'a nested rule after } in var()',
      '.card { color: var(--x, }); a:focus-visible { outline: none; }; color: red; }',
      '.card',
    ],
    [
      'a nested rule after } in brackets',
      '.card { grid-template-areas: [}]; a:focus-visible { outline: none; }; color: red; }',
      '.card',
    ],
    [
      'a nested rule after x({)})',
      '.card { background: x({)}); a:focus-visible { outline: none; }; color: red; }',
      '.card',
    ],
    [
      'a nested rule after x(]})',
      '.card { background: x(]}); a:focus-visible { outline: none; }; color: red; }',
      '.card',
    ],
    // The text check misses a statement, which holds no block, but jsdom keeps it.
    ['a nested statement', '.links { @layer x; flex-wrap: nowrap; }', '.links'],
  ])('reject %s', (_, text, selector) => {
    expect(() => load(text)).toThrow(new Error(`${selector} nests rules, which these checks do not read`));
  });

  it.each([
    ['a comment', '.card { /* .links { } */ padding: 0; }'],
    ['a comment before an at-rule', '/* narrow screens */ @media (max-width: 30rem) { .card { padding: 0; } }'],
    ['a string', '.card::after { content: "{"; }'],
    ['a string in single quotes', ".card::after { content: '{'; }"],
    ['a string with an escaped quote', '.card::after { content: "\\"{"; }'],
    ['a string in single quotes with an escaped quote', ".card::after { content: '\\'{'; }"],
    ['an escape', '.x\\{ { padding: 0; }'],
    ['an unquoted url()', '.card { background: url(data:image/svg+xml,<svg><style>a{fill:red}</style></svg>); }'],
    ['an unquoted url() holding /*', '.card { background: url(/{/*); } /* a */ .x { padding: 0; }'],
    ['a quoted url()', '.card { background: url( "){" ); }'],
    ['a string an escaped CRLF continues', '.card::after { content: "a\\\r\n{"; }'],
  ])('accept a brace in %s, which nests nothing', (_, text) => {
    expect(() => load(text)).not.toThrow();
  });

  // jsdom logs a parse error for each, so these read the text alone to keep the
  // test log clean. jsdom keeps the nested list, so styleRules rejects it as well.
  it('take a {} block as a custom property value only after its name and a colon', () => {
    expect(() => rejectNesting('.card { color: red; --x: { a: b }; }')).not.toThrow();
    expect(() => rejectNesting('.card { --x : { a: b }; }')).not.toThrow();
    expect(() => rejectNesting('.card { --x, a:focus-visible { outline: none; } }')).toThrow(
      new Error('.card nests rules, which these checks do not read'),
    );
  });

  it.each([
    'width: min(100%, 40rem)',
    'width: min(40rem, 100%)',
    'width: calc(100% - 0px)',
    'width: calc(100% - 2.5rem)',
    'inline-size: min(100%, 40rem)',
    // min()'s other arguments may nest parentheses one level deep.
    'width: min(100%, var(--max, 40rem))',
    'width: min(var(--max), 100%)',
    'width: min(100%, max(20rem, 50vw))',
  ])('take %s as set by its container', (declaration) => {
    load(`#root { ${declaration}; }`);
    expect(fixedWidths()).toEqual([]);
  });

  // jsdom writes min-width: 0 as 0px, but keeps 0rem as written.
  it.each(['min-width: 0', 'min-width: 0rem', 'min-inline-size: 0'])('take %s as no minimum', (declaration) => {
    load(`#root { ${declaration}; }`);
    expect(fixedWidths()).toEqual([]);
  });

  it.each([
    'width: 40rem',
    'min-width: max(100%, 40rem)',
    'width: calc(100% + 2rem)',
    // Each of these comes to 40rem or more on a 320 px screen.
    'width: min(max(100%, 40rem), 50rem)',
    'width: min(max(40rem, 100%, 5rem), 50rem)',
    'width: min(100% + 40rem, 50rem)',
    'width: calc(100% - min(0px, -40rem))',
    // min() needs the percentage as an argument of its own.
    'width: min(max(100%, 40rem), var(--x))',
    // Each of these is wider than its container on a 320 px screen.
    'width: 200%',
    'width: min(500%, 99rem)',
    'width: calc(150% - 1rem)',
    'inline-size: 40rem',
    'min-inline-size: 60rem',
    // Only a minimum passes at zero, and only at zero.
    'min-width: 0.5rem',
    'width: 0px',
  ])('take %s as fixed', (declaration) => {
    load(`#root { ${declaration}; }`);
    expect(fixedWidths()).toEqual([`#root { ${declaration} }`]);
  });

  it.each(['white-space: pre-wrap', 'white-space: break-spaces', 'text-wrap: balance'])(
    'let text wrap under %s',
    (declaration) => {
      load(`.role { ${declaration}; }`);
      expect(unwrappedText()).toEqual([]);
    },
  );

  it.each([
    'white-space: nowrap',
    'white-space: pre',
    'white-space: preserve nowrap',
    'text-wrap: nowrap',
    'text-wrap-mode: nowrap',
    // jsdom keeps a value of several keywords as written.
    'white-space: collapse NOWRAP',
  ])('take %s as keeping text on one line', (declaration) => {
    load(`.role { ${declaration}; }`);
    expect(unwrappedText()).toEqual([`.role { ${declaration} }`]);
  });

  it.each([
    ['a second rule', '.links { display: flex; } .links { flex-wrap: wrap; }', ['wrap']],
    ['a later rule', '.links { flex-wrap: wrap; } .links { flex-wrap: nowrap; }', ['wrap', 'nowrap']],
    [
      '@media',
      '.links { flex-wrap: wrap; } @media (max-width: 30rem) { .links { flex-wrap: nowrap; } }',
      ['wrap', 'nowrap'],
    ],
    [
      '@supports',
      '.links { display: flex; flex-wrap: wrap; } @supports (display: flex) { .links { flex-wrap: nowrap; } }',
      ['wrap', 'nowrap'],
    ],
    [
      'a rule scoped by #root',
      '.links { display: flex; flex-wrap: wrap; } #root .links { flex-flow: row nowrap; }',
      ['wrap', 'nowrap'],
    ],
    [
      'a rule scoped by :lang(en)',
      '.links { display: flex; flex-wrap: wrap; } :lang(en) .links { flex-wrap: nowrap; }',
      ['wrap', 'nowrap'],
    ],
    ['a flex-flow that wraps', '.links { display: inline-flex; flex-flow: row wrap; }', ['wrap']],
    ['a flex-flow in capitals', '.links { flex-flow: ROW WRAP; }', ['wrap']],
    ['a flex-flow across lines', '.links { flex-flow: row\nwrap; }', ['wrap']],
    ['a later flex-flow', '.links { flex-wrap: wrap; } .links { flex-flow: row nowrap; }', ['wrap', 'nowrap']],
    // Minifiers drop the nowrap, which flex-flow sets when it names no wrap keyword.
    ['a flex-flow with no wrap keyword', '.links { flex-wrap: wrap; } .links { flex-flow: row; }', ['wrap', 'nowrap']],
    [
      'a grid',
      '.links { display: grid; grid-template-columns: repeat(3, 11rem); flex-wrap: wrap; }',
      ['display: grid', 'wrap'],
    ],
    [
      'a print-only rule',
      '.links { display: flex; flex-wrap: wrap; } @media print { .links { display: block; flex-wrap: nowrap; } }',
      ['wrap'],
    ],
    [
      '@media print, screen',
      '.links { display: flex; flex-wrap: wrap; } @media print, screen { .links { flex-wrap: nowrap; } }',
      ['wrap', 'nowrap'],
    ],
  ])('read how the contact links wrap from %s', (_, text, values) => {
    load(text);
    expect(linksWrap()).toEqual(values);
  });

  // jsdom keeps the shorthand's color as written.
  it.each(['transparent', 'TRANSPARENT', '#0000', '#3b5bdb00', 'rgba(59, 91, 219, 0)', 'rgb(59 91 219 / 0%)'])(
    'take an outline in %s as hidden',
    (color) => {
      load(`a:focus-visible { outline: 2px solid ${color}; }`);
      expect(hiddenOutlines()).toEqual([`outline: ${color}`]);
    },
  );

  it.each([
    ['the shorthand with a rem width', 'a:focus-visible { outline: 0.125rem solid var(--accent); }', []],
    [
      'longhands',
      'a:focus-visible { outline-width: 0.125rem; outline-style: solid; outline-color: var(--accent); }',
      [],
    ],
    ['a color with spaces', 'a:focus-visible { outline: 2px solid rgb(0 0 0); }', []],
    ['black, which shows', 'a:focus-visible { outline: 2px solid #000; }', []],
    // jsdom keeps the shorthand as written, but lowercases a longhand's keywords.
    ['a style in capitals', 'a:focus-visible { outline: 2px SOLID var(--accent); }', []],
    ['a zero width', 'a:focus-visible { outline: 0 solid var(--accent); }', ['outline: 0']],
    ['a zero width in capitals', 'a:focus-visible { outline: 0PX solid var(--accent); }', ['outline: 0PX']],
    // jsdom writes a math width it can work out as calc().
    ['a zero width in calc()', 'a:focus-visible { outline: calc(0px) solid var(--accent); }', ['outline: calc(0px)']],
    [
      'a zero width in min()',
      'a:focus-visible { outline: 2px solid var(--accent); } a:focus-visible { outline-width: min(0px, 2px); }',
      ['outline-width: calc(0px)'],
    ],
    ['a width in max()', 'a:focus-visible { outline: max(2px, 0.1em) solid var(--accent); }', []],
    // A width the shorthand names must not be taken for its color.
    ['a keyword width', 'a:focus-visible { outline: thin solid transparent; }', ['outline: transparent']],
    ['a keyword width in capitals', 'a:focus-visible { outline: THIN solid transparent; }', ['outline: transparent']],
    ['a width with no leading zero', 'a:focus-visible { outline: .1rem solid transparent; }', ['outline: transparent']],
    ['a color named like a width', 'a:focus-visible { outline: mediumblue solid 0; }', ['outline: 0']],
    ['a width set through var()', 'a:focus-visible { outline: var(--ring, 2px) solid transparent; }', ['outline: transparent']],
    ['a width in calc()', 'a:focus-visible { outline: calc(2px) solid transparent; }', ['outline: transparent']],
    [
      'a width in min() beside transparent',
      'a:focus-visible { outline: min(2px, 1vw) solid transparent; }',
      ['outline: transparent'],
    ],
    [
      'a width in max() beside transparent',
      'a:focus-visible { outline: max(2px, 0.1em) solid transparent; }',
      ['outline: transparent'],
    ],
    [
      'a width in clamp() beside transparent',
      'a:focus-visible { outline: clamp(1px, 0.2em, 4px) solid transparent; }',
      ['outline: transparent'],
    ],
    // The shorthand takes its parts in any order.
    ['a color first', 'a:focus-visible { outline: transparent 2px solid; }', ['outline: transparent']],
    ['a color in the middle', 'a:focus-visible { outline: solid transparent 2px; }', ['outline: transparent']],
    // The shorthand resets the style it leaves out to none.
    ['no line style', 'a:focus-visible { outline: 2px var(--accent); }', ['no visible line style']],
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
    [
      'a later transparent longhand',
      'a:focus-visible { outline: 2px solid var(--accent); } a:focus-visible { outline-color: transparent; }',
      ['outline-color: transparent'],
    ],
    // all sets every outline longhand.
    [
      'a later all: unset',
      'a:focus-visible { outline: 2px solid; } .links a:focus-visible { all: unset; }',
      ['all: unset'],
    ],
    ['an outline after all: unset', 'a:focus-visible { all: unset; outline: 2px solid; }', []],
    // Between a shorthand and a longhand, specificity decides, then source order.
    ['a less specific reset', 'a { outline-style: none; } a:focus-visible { outline: 2px solid; }', []],
    [
      'longhands after a reset',
      '.links a { outline: none; } a:focus-visible { outline-style: solid; outline-width: 2px; }',
      [],
    ],
    [
      'a more specific reset',
      '.links a:focus-visible { outline-style: none; } a:focus-visible { outline: 2px solid; }',
      ['outline-style: none'],
    ],
    // An important declaration beats every normal one; between two, specificity decides first.
    [
      'an important reset',
      'a:focus-visible { outline: 2px solid; } a { outline: none !important; }',
      ['outline: none'],
    ],
    [
      'a more specific important reset',
      '.links a:focus-visible { outline: none !important; } a:focus-visible { outline: 2px solid !important; }',
      ['outline: none'],
    ],
    // A selector list ranks by the most specific of its selectors that match.
    [
      'a selector list',
      '.card p a:focus-visible, a:focus-visible { outline: 2px solid; } .links a:focus-visible { outline-style: none; }',
      ['outline-style: none'],
    ],
    [
      'a selector list with a pseudo-element',
      'a:focus-visible { outline: 2px solid; } a:focus-visible, a::after { outline: none; }',
      ['outline: none'],
    ],
    [
      'a list inside :is()',
      'a:focus-visible { outline: 2px solid; } :is(nav, p) a:focus-visible { outline: none; }',
      ['outline: none'],
    ],
    // A list splits only at commas outside parentheses and strings.
    [
      'a list inside :is() holding :where()',
      'a:focus-visible { outline: 2px solid; } :is(nav, :where(p, li)) a:focus-visible { outline: none; }',
      ['outline: none'],
    ],
    [
      'a list inside :is() holding :not()',
      'a:focus-visible { outline: 2px solid; } a:is(.x, :not(.y)):focus-visible { outline: none; }',
      ['outline: none'],
    ],
    [
      'such a list beside a pseudo-element',
      'a:focus-visible { outline: 2px solid; } :is(nav, :where(p, li)) a:focus-visible, a::after { outline: none; }',
      ['outline: none'],
    ],
    ['such a list alone', ':is(nav, :where(p, li)) a:focus-visible { outline: 3px solid var(--accent); }', []],
    [
      'a comma inside an attribute string',
      'a:focus-visible { outline: 2px solid; } a[href]:focus-visible, a[title="x,y"] { outline: none; }',
      ['outline: none'],
    ],
    [
      'a list whose most specific selector does not match',
      'body a:focus-visible { outline: 2px solid; } :is(#x, :where(.y)) a, a:focus-visible { outline: none; }',
      [],
    ],
    [
      'a rule scoped by #root',
      'a:focus-visible { outline: 2px solid; } #root a:focus-visible { outline-color: transparent; }',
      ['outline-color: transparent'],
    ],
    [
      'a rule scoped by data-page',
      "a:focus-visible { outline: 2px solid; } [data-page='not-found'] a:focus-visible { outline: none; }",
      ['outline: none'],
    ],
    [
      'a rule scoped by :lang(en)',
      'a:focus-visible { outline: 2px solid; } :lang(en) a:focus-visible { outline: none; }',
      ['outline: none'],
    ],
    [
      'a rule scoped by html[lang]',
      'a:focus-visible { outline: 2px solid; } html[lang="en"] a:focus-visible { outline-style: none; }',
      ['outline-style: none'],
    ],
    [
      'a rule for later links',
      'a:focus-visible { outline: 2px solid; } li + li a:focus-visible { outline: none; }',
      ['outline: none'],
    ],
    [
      'a rule for the not-found link',
      'a:focus-visible { outline: 2px solid; } p > a:focus-visible { outline: none; }',
      ['outline: none'],
    ],
    [
      '@media screen',
      'a:focus-visible { outline: 2px solid; } @media screen { a:focus-visible { outline-style: none; } }',
      ['outline-style: none'],
    ],
    // A 320 px screen or forced-colors mode may match a feature query.
    [
      'a feature query',
      'a:focus-visible { outline: 2px solid; } @media (max-width: 30rem) { a:focus-visible { outline: none; } }',
      ['outline: none'],
    ],
    [
      'a longhand inside @media',
      'a:focus-visible { outline: 2px solid; } @media (forced-colors: active) { a { outline-style: dotted; } }',
      [],
    ],
    [
      'a print-only rule',
      'a:focus-visible { outline: 2px solid; } @media print { a:focus-visible { outline: none; } }',
      [],
    ],
    [
      '@media only print',
      'a:focus-visible { outline: 2px solid; } @media only print { a:focus-visible { outline: none; } }',
      [],
    ],
    // A screen matches a list that names print first.
    [
      '@media print, screen',
      'a:focus-visible { outline: 2px solid; } @media print, screen { a:focus-visible { outline: none; } }',
      ['outline: none'],
    ],
    // Browsers rank any author rule above their own focus ring.
    ['only a reset', 'a { outline: none; }', ['outline: none']],
  ])('find what hides a focus outline set by %s', (_, text, hidden) => {
    load(text);
    expect(hiddenOutlines()).toEqual(hidden);
  });

  it.each([
    ['margin-block-end: 0', [0]],
    ['margin-block: 1rem 0', [0]],
    ['margin-block: 0 1rem', [1]],
  ])('read the bottom margin from %s', (declaration, margins) => {
    load(`.card > :last-child { ${declaration}; }`);
    expect(bottomMargins('home').map(parseFloat)).toEqual(margins);
  });
});
