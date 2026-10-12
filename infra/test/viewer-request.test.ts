import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseAst } from 'vitest/node';
import { production } from '../lib/config';
import { VIEWER_REQUEST_SOURCE, viewerRequestCode } from '../lib/viewer-request';

type Querystring = Record<string, { value: string; multiValue?: { value: string }[] }>;
type Handler = (event: unknown) => any;

// cloudfront-js-2.0 is ES 5.1 plus the ES 6-12 features listed in functions-javascript-runtime-20.html (read
// 2026-10-12). Node's V8 has far more, so these tests narrow it to that list: runtimeContext deletes the built-ins
// the page does not list, so a test fails when the function calls one, and syntaxViolations rejects the syntax the
// page does not list. Neither shows where the runtime and V8 differ in a feature both have (its regular expressions
// are PCRE, for example), and built-ins are checked only on the paths the tests run.

// What each object keeps: the ES 5.1 built-ins, which the page says the runtime complies with, plus the newer ones
// it lists. Other string-keyed members are deleted. Members keyed by symbols stay, as do the well-known symbols on
// Symbol, which V8 will not delete. Listed globals that V8 lacks (atob, btoa, Buffer, TextEncoder, TextDecoder,
// InternalError, require) stay absent, so code using one fails here until it is added.
const RUNTIME_BUILT_INS: Record<string, string> = {
  globalThis:
    'globalThis NaN Infinity undefined eval parseInt parseFloat isNaN isFinite decodeURI decodeURIComponent encodeURI ' +
    'encodeURIComponent Object Function Array String Boolean Number Math Date RegExp JSON Error EvalError RangeError ' +
    'ReferenceError SyntaxError TypeError URIError Symbol Promise ArrayBuffer DataView Int8Array Uint8Array ' +
    'Uint8ClampedArray Int16Array Uint16Array Int32Array Uint32Array Float32Array Float64Array console',
  // The page lists is and setPrototypeOf under Object.prototype, but they are static methods.
  Object:
    'create defineProperties defineProperty freeze getOwnPropertyDescriptor getOwnPropertyDescriptors ' +
    'getOwnPropertyNames getPrototypeOf isExtensible isFrozen isSealed keys preventExtensions seal assign entries ' +
    'values is setPrototypeOf',
  'Object.prototype': 'hasOwnProperty isPrototypeOf propertyIsEnumerable toLocaleString toString valueOf',
  'Function.prototype': 'apply bind call toString',
  Array: 'isArray of',
  'Array.prototype':
    'concat every filter forEach indexOf join lastIndexOf map pop push reduce reduceRight reverse shift slice some ' +
    'sort splice toLocaleString toString unshift copyWithin fill find findIndex includes',
  String: 'fromCharCode fromCodePoint',
  'String.prototype':
    'charAt charCodeAt concat indexOf lastIndexOf localeCompare match replace search slice split substr substring ' +
    'toLocaleLowerCase toLocaleUpperCase toLowerCase toString toUpperCase trim valueOf codePointAt endsWith includes ' +
    'repeat startsWith padStart padEnd trimStart trimEnd replaceAll',
  'Boolean.prototype': 'toString valueOf',
  Number:
    'MAX_VALUE MIN_VALUE NaN NEGATIVE_INFINITY POSITIVE_INFINITY EPSILON MAX_SAFE_INTEGER MIN_SAFE_INTEGER isFinite ' +
    'isInteger isNaN isSafeInteger parseFloat parseInt',
  'Number.prototype': 'toExponential toFixed toLocaleString toPrecision toString valueOf',
  Math:
    'E LN10 LN2 LOG10E LOG2E PI SQRT1_2 SQRT2 abs acos acosh asin asinh atan atan2 atanh cbrt ceil clz32 cos cosh ' +
    'exp expm1 floor fround hypot imul log log1p log2 log10 max min pow random round sign sin sinh sqrt tan tanh trunc',
  Date: 'UTC now parse',
  'Date.prototype':
    'getDate getDay getFullYear getHours getMilliseconds getMinutes getMonth getSeconds getTime getTimezoneOffset ' +
    'getUTCDate getUTCDay getUTCFullYear getUTCHours getUTCMilliseconds getUTCMinutes getUTCMonth getUTCSeconds ' +
    'setDate setFullYear setHours setMilliseconds setMinutes setMonth setSeconds setTime setUTCDate setUTCFullYear ' +
    'setUTCHours setUTCMilliseconds setUTCMinutes setUTCMonth setUTCSeconds toDateString toISOString toJSON ' +
    'toLocaleDateString toLocaleString toLocaleTimeString toString toTimeString toUTCString valueOf',
  RegExp: '',
  'RegExp.prototype': 'exec test toString flags global ignoreCase multiline source sticky',
  Error: '',
  'Error.prototype': 'message name toString',
  JSON: 'parse stringify',
  Symbol: 'for keyFor',
  'Symbol.prototype': 'toString valueOf',
  Promise: 'all allSettled any race reject resolve',
  'Promise.prototype': 'catch finally then',
  ArrayBuffer: 'isView',
  'ArrayBuffer.prototype': 'byteLength slice',
  'DataView.prototype':
    'buffer byteLength byteOffset getFloat32 getFloat64 getInt16 getInt32 getInt8 getUint16 getUint32 getUint8 ' +
    'setFloat32 setFloat64 setInt16 setInt32 setInt8 setUint16 setUint32 setUint8',
  // %TypedArray%, the constructor that every typed array inherits from.
  'Object.getPrototypeOf(Int8Array)': 'from of',
  'Object.getPrototypeOf(Int8Array.prototype)':
    'buffer byteLength byteOffset length copyWithin every fill filter find findIndex forEach includes indexOf join ' +
    'lastIndexOf map reduce reduceRight reverse set slice some sort subarray toString',
  console: 'log',
};
// Every object keeps these: they describe functions and link constructors to prototypes.
const ALWAYS_KEPT = ['constructor', 'length', 'name', 'prototype'];

/** A V8 context with only RUNTIME_BUILT_INS, where eval and new Function throw, as they do on CloudFront. */
function runtimeContext(): vm.Context {
  const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
  // Find every object before deleting anything: some are found through others.
  const objects = Object.entries(RUNTIME_BUILT_INS).map(
    ([object, members]) => [vm.runInContext(object, context), new Set([...ALWAYS_KEPT, ...members.split(' ')])] as const,
  );
  for (const [object, kept] of objects) {
    for (const name of Object.getOwnPropertyNames(object)) {
      if (!kept.has(name)) Reflect.deleteProperty(object, name);
    }
  }
  return context;
}

// CloudFront Functions are plain scripts with a global `handler`. Top-level vars
// are properties of the context, so `globals` can set the hostnames that
// viewerRequestCode fills in at synth time.
function evaluate(code: string, filename: string, globals: Record<string, string> = {}): Handler {
  const context = runtimeContext();
  vm.runInContext(code, context, { filename });
  Object.assign(context, globals);
  for (const [name, value] of Object.entries(globals)) {
    if (vm.runInContext(name, context) !== value) {
      throw new Error(`${filename} must declare ${name} with a top-level var so these tests can set it`);
    }
  }
  // Parse each event inside the context: objects built out here would have Node's full prototypes.
  const handle = vm.runInContext('(function (event) { return handler(JSON.parse(event)); })', context);
  return (event) => handle(JSON.stringify(event));
}

// Node types for ES 5.1 syntax plus what the page adds: const and let, template literals, arrow functions, rest
// parameters, and async functions with await. Patterns (destructuring and default values), spread, optional
// chaining (ChainExpression), classes, for-of, and tagged templates are all missing, so they are violations.
const SUPPORTED_SYNTAX = new Set([
  'Program', 'ExpressionStatement', 'BlockStatement', 'EmptyStatement', 'VariableDeclaration', 'VariableDeclarator',
  'FunctionDeclaration', 'ReturnStatement', 'IfStatement', 'SwitchStatement', 'SwitchCase', 'ForStatement',
  'ForInStatement', 'WhileStatement', 'DoWhileStatement', 'BreakStatement', 'ContinueStatement', 'LabeledStatement',
  'ThrowStatement', 'TryStatement', 'CatchClause', 'Identifier', 'Literal', 'ThisExpression', 'ArrayExpression',
  'ObjectExpression', 'Property', 'FunctionExpression', 'ArrowFunctionExpression', 'RestElement', 'UnaryExpression',
  'UpdateExpression', 'BinaryExpression', 'LogicalExpression', 'AssignmentExpression', 'ConditionalExpression',
  'CallExpression', 'NewExpression', 'MemberExpression', 'SequenceExpression', 'ParenthesizedExpression',
  'TemplateLiteral', 'TemplateElement', 'AwaitExpression',
]);
// The ES 5.1 assignment operators. The page lists `**` but not `**=`, `&&=`, `||=`, or `??=`.
const ES5_ASSIGNMENT_OPERATORS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '>>>=', '&=', '^=', '|=']);

/** Syntax in `code` that the page does not list, with its line. Each unsupported node is reported once. */
function syntaxViolations(code: string): string[] {
  const violations: string[] = [];
  const visit = (node: any): void => {
    const unsupported = unsupportedSyntax(node);
    if (unsupported) {
      violations.push(`${unsupported} (line ${code.slice(0, node.start).split('\n').length})`);
      return;
    }
    for (const value of Object.values(node)) {
      for (const child of Array.isArray(value) ? value : [value]) {
        if (typeof child?.type === 'string') visit(child);
      }
    }
  };
  visit(parseAst(code, { lang: 'js', sourceType: 'script' }));
  return violations;
}

function unsupportedSyntax(node: any): string | undefined {
  if (!SUPPORTED_SYNTAX.has(node.type)) return node.type;
  switch (node.type) {
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      if (node.generator) return 'generator function';
      // The page: "async arguments and closures are not supported".
      return node.async && node.type !== 'FunctionDeclaration' ? 'async function expression' : undefined;
    case 'Property':
      if (node.shorthand) return 'shorthand property';
      if (node.method) return 'method definition';
      return node.computed ? 'computed property name' : undefined;
    case 'LogicalExpression':
      return node.operator === '??' ? '?? operator' : undefined;
    case 'AssignmentExpression':
      return ES5_ASSIGNMENT_OPERATORS.has(node.operator) ? undefined : `${node.operator} operator`;
    case 'Literal':
      if (typeof node.bigint === 'string') return 'BigInt literal';
      // The page lists the sticky flag besides the ES 5.1 ones.
      if (node.regex && /[^gimy]/.test(node.regex.flags)) return `regular expression flags ${node.regex.flags}`;
      return /^0[bo]/i.test(node.raw) ? 'binary or octal literal' : undefined;
    case 'CatchClause':
      return node.param === null ? 'catch without a binding' : undefined;
    default:
      return undefined;
  }
}

const HOSTS = { APEX_HOST: 'zachdavids.com', WWW_HOST: 'www.zachdavids.com' };

const handlers: [string, Handler][] = [
  // The unmodified file, run under its own path so V8 coverage attributes it.
  ['functions/viewer-request.js', evaluate(readFileSync(VIEWER_REQUEST_SOURCE, 'utf8'), VIEWER_REQUEST_SOURCE, HOSTS)],
  // What the stack deploys, in strict mode as cloudfront-js-2.0 runs it. Its offsets
  // differ from the file's, so it runs under a name coverage ignores.
  ['deployed code in strict mode', evaluate(`'use strict';${viewerRequestCode(production)}`, 'viewer-request.js (deployed)')],
];

/** A CloudFront viewer-request event; a null host omits the Host header. */
function viewerRequest(uri: string, host: string | null = 'zachdavids.com', querystring: Querystring = {}) {
  const headers: Record<string, { value: string }> = host === null ? {} : { host: { value: host } };
  return { version: '1.0', context: { eventType: 'viewer-request' }, request: { method: 'GET', uri, querystring, headers, cookies: {} } };
}

describe.each(handlers)('%s', (_name, handler) => {
  describe('www to apex redirect', () => {
    it('answers 301 with the apex location, cacheable for an hour', () => {
      expect(handler(viewerRequest('/notes/', 'www.zachdavids.com'))).toEqual({
        statusCode: 301,
        statusDescription: 'Moved Permanently',
        headers: {
          location: { value: 'https://zachdavids.com/notes/' },
          'cache-control': { value: 'max-age=3600' },
        },
      });
    });

    it('matches the www host case-insensitively', () => {
      expect(handler(viewerRequest('/', 'WWW.ZachDavids.com')).headers.location.value).toBe('https://zachdavids.com/');
    });

    it('keeps the requested path instead of mapping it to index.html', () => {
      expect(handler(viewerRequest('/about', 'www.zachdavids.com')).headers.location.value).toBe('https://zachdavids.com/about');
    });

    it('redirects well-known URIs too', () => {
      expect(handler(viewerRequest('/.well-known/security.txt', 'www.zachdavids.com')).headers.location.value).toBe(
        'https://zachdavids.com/.well-known/security.txt',
      );
    });

    it.each<[string, Querystring, string]>([
      ['no query string', {}, ''],
      ['a single value', { utm_source: { value: 'x' } }, '?utm_source=x'],
      ['an empty value as a bare name', { flag: { value: '' } }, '?flag'],
      ['every value of a repeated name', { tag: { value: 'a', multiValue: [{ value: 'a' }, { value: '' }, { value: 'b' }] } }, '?tag=a&tag&tag=b'],
      [
        'several names in order',
        { utm_source: { value: 'x' }, flag: { value: '' }, tag: { value: 'a', multiValue: [{ value: 'a' }, { value: 'b' }] } },
        '?utm_source=x&flag&tag=a&tag=b',
      ],
    ])('carries %s over to the location', (_case, querystring, search) => {
      const response = handler(viewerRequest('/notes/', 'www.zachdavids.com', querystring));
      expect(response.headers.location.value).toBe(`https://zachdavids.com/notes/${search}`);
    });

    // Assumes CloudFront passes the path and query through percent-encoded, as the
    // viewer sent them; re-encoding or decoding them would corrupt the redirect.
    it('copies an encoded path and query into the location verbatim', () => {
      const querystring = { q: { value: 'a%20b%26c%3Dd' }, 'k%5B0%5D': { value: '1' } };
      const response = handler(viewerRequest('/caf%C3%A9/50%25%20off', 'www.zachdavids.com', querystring));
      expect(response.headers.location.value).toBe('https://zachdavids.com/caf%C3%A9/50%25%20off?q=a%20b%26c%3Dd&k%5B0%5D=1');
    });
  });

  describe('requests for other hosts', () => {
    it('passes an apex request through with only its uri mapped', () => {
      expect(handler(viewerRequest('/about', 'zachdavids.com', { q: { value: '1' } }))).toEqual({
        method: 'GET',
        uri: '/about/index.html',
        querystring: { q: { value: '1' } },
        headers: { host: { value: 'zachdavids.com' } },
        cookies: {},
      });
    });

    it('does not redirect the CloudFront default hostname', () => {
      expect(handler(viewerRequest('/', 'd111111abcdef8.cloudfront.net')).uri).toBe('/index.html');
    });

    it('does not redirect a request without a Host header', () => {
      expect(handler(viewerRequest('/about', null)).uri).toBe('/about/index.html');
    });
  });

  describe('index.html mapping', () => {
    it.each([
      ['/', '/index.html'],
      ['/about/', '/about/index.html'],
      ['/v1.2/', '/v1.2/index.html'],
    ])('maps the directory %s to %s', (uri, expected) => {
      expect(handler(viewerRequest(uri)).uri).toBe(expected);
    });

    it.each([
      ['/about', '/about/index.html'],
      ['/v1.2/notes', '/v1.2/notes/index.html'],
    ])('maps the extensionless path %s to %s', (uri, expected) => {
      expect(handler(viewerRequest(uri)).uri).toBe(expected);
    });

    it.each(['/assets/index-mKM-b7Ju.js', '/404.html', '/robots.txt'])('leaves the file %s alone', (uri) => {
      expect(handler(viewerRequest(uri)).uri).toBe(uri);
    });

    it('treats any dotted last segment as a file, so a dotted slug needs a trailing slash', () => {
      expect(handler(viewerRequest('/notes/v1.2')).uri).toBe('/notes/v1.2');
    });

    // Only the last segment decides, so a dot in a directory name does not count.
    it.each(['/v1.2/app.js', '/docs/v1.2/guide.pdf', '/v1.2/notes/cover.png'])(
      'leaves the file %s in a dotted directory alone',
      (uri) => {
        expect(handler(viewerRequest(uri)).uri).toBe(uri);
      },
    );

    it.each(['/.well-known/', '/.well-known/security.txt', '/.well-known/apple-app-site-association'])(
      'leaves the well-known URI %s alone',
      (uri) => {
        expect(handler(viewerRequest(uri)).uri).toBe(uri);
      },
    );

    it('maps a .well-known directory below the root like any other path', () => {
      expect(handler(viewerRequest('/notes/.well-known/x')).uri).toBe('/notes/.well-known/x/index.html');
    });

    it('maps a path that only starts like /.well-known/', () => {
      expect(handler(viewerRequest('/.well-known-x/')).uri).toBe('/.well-known-x/index.html');
    });
  });
});

describe('deployed code', () => {
  it('leaves no placeholder unfilled', () => {
    expect(viewerRequestCode(production)).not.toMatch(/__[A-Z_]+__/);
  });

  it('stays within the 10 KB CloudFront Functions size limit', () => {
    expect(Buffer.byteLength(viewerRequestCode(production))).toBeLessThan(10 * 1024);
  });

  it('uses only syntax that cloudfront-js-2.0 supports', () => {
    expect(syntaxViolations(viewerRequestCode(production))).toEqual([]);
  });
});

describe('syntaxViolations', () => {
  it('accepts ES 5.1 and the syntax cloudfront-js-2.0 adds', () => {
    const code = [
      'const base = 2; let power = base ** 10;',
      'var label = `${base}-${power}`;',
      'var square = (x) => x * x;',
      'function count(first, ...rest) { return rest.length; }',
      'async function load() { return await Promise.resolve(1_000); }',
      'var o = { get x() { return 1; }, set x(v) {}, "y": 2, 3: [1, , 3] };',
      'outer: for (var key in o) { if (key) break outer; }',
      'var year = /(?<year>\\d{4})/gy;',
      'try { throw new Error("x"); } catch (e) {} finally {}',
    ].join('\n');
    expect(syntaxViolations(code)).toEqual([]);
  });

  it.each([
    ['const { request } = event;', 'ObjectPattern'],
    ['var [first] = list;', 'ArrayPattern'],
    ['function f(a = 1) {}', 'AssignmentPattern'],
    ['f(...args);', 'SpreadElement'],
    ['var host = request.headers.host?.value;', 'ChainExpression'],
    ['var host = a ?? b;', '?? operator'],
    ['a ||= b;', '||= operator'],
    ['a **= 2;', '**= operator'],
    ['for (var name of names) {}', 'ForOfStatement'],
    ['class Redirect {}', 'ClassDeclaration'],
    ['function* ids() {}', 'generator function'],
    ['var load = async () => 1;', 'async function expression'],
    ['var o = { uri };', 'shorthand property'],
    ['var o = { handler() {} };', 'method definition'],
    ['var o = { [name]: 1 };', 'computed property name'],
    ['tag`x`;', 'TaggedTemplateExpression'],
    ['var big = 10n;', 'BigInt literal'],
    ['var bits = 0b1010;', 'binary or octal literal'],
    ['var dotAll = /./s;', 'regular expression flags s'],
    ['try {} catch {}', 'catch without a binding'],
    ['debugger;', 'DebuggerStatement'],
  ])('rejects %s', (code, violation) => {
    expect(syntaxViolations(code)).toEqual([`${violation} (line 1)`]);
  });

  it('reports each violation with its line', () => {
    expect(syntaxViolations('var a = 1;\nvar b = a ?? 2;\n\nf(...a);')).toEqual(['?? operator (line 2)', 'SpreadElement (line 4)']);
  });
});

describe('runtimeContext', () => {
  const context = runtimeContext();

  it('keeps every built-in it lists', () => {
    const missing = Object.entries(RUNTIME_BUILT_INS).flatMap(([object, members]) => {
      const target = vm.runInContext(object, context);
      return members.split(' ').filter((name) => name && !(name in target)).map((name) => `${object}.${name}`);
    });
    expect(missing).toEqual([]);
  });

  it.each([
    "''.at", "''.matchAll", "''.normalize", '[].at', '[].flat', '[].flatMap', '[].findLast', '[].toSorted', 'Array.from',
    'Object.fromEntries', 'Object.hasOwn', 'String.raw', 'Promise.withResolvers', 'Map', 'Set', 'WeakMap', 'Proxy',
    'Reflect', 'BigInt', 'Intl', 'Iterator', 'escape', 'console.error',
  ])('removes %s, which V8 has but the runtime does not list', (expression) => {
    expect(vm.runInNewContext(`typeof ${expression}`)).not.toBe('undefined');
    expect(vm.runInContext(`typeof ${expression}`, context)).toBe('undefined');
  });

  it('refuses to evaluate strings as code, as the runtime does', () => {
    for (const code of ["eval('1')", "Function('return 1')"]) {
      expect(() => vm.runInContext(code, context)).toThrow('Code generation from strings disallowed for this context');
    }
  });

  it.each([
    [
      'String.prototype.at',
      ["uri.charAt(uri.length - 1) === '/'", "uri.at(-1) === '/'"],
      viewerRequest('/about/'),
      'uri.at is not a function',
    ],
    [
      'Array.prototype.flat on an array from the event',
      ['param.multiValue || [param]', 'param.multiValue ? param.multiValue.flat() : [param]'],
      viewerRequest('/', 'www.zachdavids.com', { tag: { value: 'a', multiValue: [{ value: 'a' }] } }),
      'param.multiValue.flat is not a function',
    ],
  ] as const)('fails a function that calls %s, though Node runs it', (_case, [from, to], event, message) => {
    const source = readFileSync(VIEWER_REQUEST_SOURCE, 'utf8');
    expect(source).toContain(from);
    const changed = source.replace(from, to);
    const node = vm.createContext();
    vm.runInContext(changed, node);
    Object.assign(node, HOSTS);
    expect(() => node.handler(event)).not.toThrow();
    expect(() => evaluate(changed, 'viewer-request.js (changed)', HOSTS)(event)).toThrow(message);
  });
});

describe('viewerRequestCode', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'viewer-request-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function functionFile(source: string): string {
    const file = path.join(dir, 'viewer-request.js');
    writeFileSync(file, source);
    return file;
  }

  it('fills in each placeholder with the lowercased hostname and changes nothing else', () => {
    const file = functionFile("// __APEX_HOST_ and __WWW_HOST are near misses\nvar APEX_HOST = '__APEX_HOST__';\n\nvar WWW_HOST = '__WWW_HOST__'; // kept\n");
    expect(viewerRequestCode({ domainName: 'Example.COM', wwwDomainName: 'WWW.Example.com' }, file)).toBe(
      "// __APEX_HOST_ and __WWW_HOST are near misses\nvar APEX_HOST = 'example.com';\n\nvar WWW_HOST = 'www.example.com'; // kept\n",
    );
  });

  it.each([
    ['__APEX_HOST__', 'missing', "var WWW_HOST = '__WWW_HOST__';\n"],
    ['__APEX_HOST__', 'repeated', "// __APEX_HOST__\nvar APEX_HOST = '__APEX_HOST__';\nvar WWW_HOST = '__WWW_HOST__';\n"],
    ['__WWW_HOST__', 'missing', "var APEX_HOST = '__APEX_HOST__';\n"],
    ['__WWW_HOST__', 'repeated', "// __WWW_HOST__\nvar APEX_HOST = '__APEX_HOST__';\nvar WWW_HOST = '__WWW_HOST__';\n"],
  ])('refuses a source with %s %s', (placeholder, _case, source) => {
    const file = functionFile(source);
    expect(() => viewerRequestCode(production, file)).toThrow(new Error(`${file} must contain ${placeholder} exactly once`));
  });
});
