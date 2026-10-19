// Post-build check: the generated HTML must contain the substantive page
// content (not an empty client-rendered shell) and the head every page shares,
// with link previews and structured data on each page that has an address,
// and use only root-relative or absolute URLs (or fragments); every
// root-relative file it references must exist under the exact name S3 would
// look up for the path a browser requests, and every /assets/ file it
// references must be a build output with a content hash in its name. The
// build must also keep to its size budgets.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { type Page, type PageId, pages, profile, resume, site } from '../src/content/index.ts';
import { escapeHtml } from './prerender-lib.ts';
import { ASSETS, encodingFor, HASHED_NAME, isAsset, type SiteFile, siteFiles } from './release-lib.ts';
import { distributionRequests, SMOKE_REQUEST_BUDGET } from './smoke-lib.ts';

// The file CloudFront serves for a path, as infra/functions/viewer-request.js maps it.
export function servedFile(path: string): string {
  if (path.startsWith('/.well-known/')) return path;
  if (path.endsWith('/')) return `${path}index.html`;
  return path.lastIndexOf('.') < path.lastIndexOf('/') ? `${path}/index.html` : path;
}

// The path a browser requests for a root-relative reference: dot segments,
// %2E%2E too, resolve against the site root, where '..' stops at '/'.
// Undefined if the browser leaves the site, as it does for /\host/x (it reads
// a backslash as a slash), or finds no URL at all, as for /\a b/x.
const siteRoot = new URL('https://site.invalid/');
function requested(path: string): string | undefined {
  const url = URL.parse(path, siteRoot);
  return url?.origin === siteRoot.origin ? url.pathname : undefined;
}

// The key S3 looks up for a requested path: its served file's name, decoded.
// An undefined path, or one with a malformed escape, names no key. To fail
// closed, neither does one with an encoded slash or backslash: the build never
// emits one, and the CloudFront docs don't say whether S3 then reads it as a
// separator.
function keyOf(path: string | undefined): string | undefined {
  if (path === undefined || /%2f|%5c/i.test(path)) return undefined;
  try {
    return decodeURIComponent(servedFile(path).slice(1));
  } catch {
    return undefined;
  }
}

// The files under dir, by '/'-joined relative path. Lookups match these names
// exactly, as S3 matches keys, because the host may ignore case (NTFS does).
// Files only: S3 serves objects, so a directory at a served path is as good as
// missing. statSync follows symlinks, as Vite does when it copies public/, so
// a dangling link names no file. A dir that is missing or not a directory
// holds none.
function filesIn(dir: URL): Set<string> {
  if (statSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true) return new Set();
  const root = fileURLToPath(dir);
  const files = readdirSync(root, { encoding: 'utf8', recursive: true })
    .filter((file) => statSync(join(root, file), { throwIfNoEntry: false })?.isFile() === true)
    .map((file) => file.split(sep).join('/'));
  return new Set(files);
}

// The signature every PNG starts with. Its first chunk must be IHDR, whose data begins with the picture's width and
// height.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// The width and height a PNG's header gives, or undefined for a file that is not a PNG.
function pngSize(body: Buffer): { width: number; height: number } | undefined {
  if (body.length < 24 || !body.subarray(0, 8).equals(PNG_SIGNATURE) || body.toString('latin1', 12, 16) !== 'IHDR') {
    return undefined;
  }
  return { width: body.readUInt32BE(16), height: body.readUInt32BE(20) };
}

// What the check reads of a page's structured data. JSON.parse can return any value, so every field may be missing.
type ProfilePageData = { '@type'?: unknown; url?: unknown; mainEntity?: { name?: unknown } } | null;

// Each script of structured data on a page, with its text, wherever the type sits among the start tag's attributes:
// JSX writes them in the order its props are given.
const STRUCTURED_DATA = /<script\b[^>]*\stype="application\/ld\+json"[^>]*>(.*?)<\/script>/gs;

// The content of each robots meta tag on a page, whichever of its attributes comes first. Google reads the tag in any
// case, its rules from one tag's comma-separated list or from several tags, and none as noindex and nofollow
// (https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag, read 2026-10-18).
const ROBOTS = /<meta\b(?=[^>]*\sname="robots")[^>]*\scontent="([^"]*)"/gi;

// The tags a page may give only once, each by the attribute that says what it is: the canonical link and every
// link-preview tag. Given two of one, a crawler may read the wrong one: Open Graph prefers the first
// (https://ogp.me/, read 2026-10-18), so a wrong og:title placed before the right one wins.
const READ_ONCE = [
  'rel="canonical"',
  ...[
    'og:type',
    'og:site_name',
    'og:title',
    'og:description',
    'og:url',
    'og:image',
    'og:image:width',
    'og:image:height',
    'og:image:alt',
  ].map((property) => `property="${property}"`),
  'name="twitter:card"',
];

// Returns one message per problem found in rootDir's dist/. rootDir is a
// directory URL ending in "/". release is the commit the deploy build sets
// (RELEASE_COMMIT, ADR 0006), which each page must name; other builds name none.
export function checkDist(rootDir: URL, release?: string): string[] {
  const dist = new URL('dist/', rootDir);
  const distFiles = filesIn(dist);
  const publicFiles = filesIn(new URL('public/', rootDir));
  const failures: string[] = [];

  function read(file: string): string {
    const url = new URL(file, dist);
    if (!existsSync(url)) {
      failures.push(`missing dist/${file}`);
      return '';
    }
    return readFileSync(url, 'utf8');
  }

  function expectIncludes(file: string, html: string, needles: string[]): void {
    for (const needle of needles) {
      if (!html.includes(needle)) failures.push(`dist/${file} does not contain ${JSON.stringify(needle)}`);
    }
  }

  // No more than one of each tag in READ_ONCE; the needles require the right one.
  function expectOnce(file: string, html: string): void {
    for (const attribute of READ_ONCE) {
      if (html.split(attribute).length - 1 > 1) {
        failures.push(`dist/${file} has more than one tag with ${attribute}, and a crawler may read any of them`);
      }
    }
  }

  // The picture link previews show, found at the key a request for its path names, as a reference's file is.
  const imageKey = keyOf(requested(site.image.path));
  const hasImage = imageKey !== undefined && distFiles.has(imageKey);

  // What link previews (Open Graph, which X also reads) show of the page at url: its own address, title, and
  // description, and the site's picture, at the size site.image gives.
  function expectPreview(file: string, html: string, page: Page, url: string): void {
    expectIncludes(file, html, [
      `<meta property="og:url" content="${escapeHtml(url)}" />`,
      `<meta property="og:title" content="${escapeHtml(page.title)}" />`,
      `<meta property="og:description" content="${escapeHtml(page.description)}" />`,
      `<meta property="og:image" content="${escapeHtml(`${site.origin}${site.image.path}`)}" />`,
      `<meta property="og:image:width" content="${site.image.width}" />`,
      `<meta property="og:image:height" content="${site.image.height}" />`,
      '<meta name="twitter:card" content="summary_large_image" />',
    ]);
    // These need only a value.
    for (const property of ['og:type', 'og:site_name', 'og:image:alt']) {
      if (!new RegExp(`<meta property="${property}" content="[^"]*\\S[^"]*" />`).test(html)) {
        failures.push(`dist/${file} has no ${property}, or an empty one`);
      }
    }
    if (!hasImage) failures.push(`dist/${file} references missing ${site.image.path}`);
  }

  // The page's structured data: one script, whose JSON describes a ProfilePage at url about Zach. Its text holds no
  // "<", which could end the script early; the prerender writes each one as an escape that JSON reads back as "<".
  function expectStructuredData(file: string, html: string, url: string): void {
    const scripts = [...html.matchAll(STRUCTURED_DATA)];
    if (scripts.length !== 1) {
      failures.push(`dist/${file} does not carry exactly one application/ld+json script`);
      return;
    }
    // The capture group is not optional, so the match has [1].
    const json = scripts[0]![1]!;
    if (json.includes('<')) {
      failures.push(`dist/${file} has structured data holding a "<", which can end its script early`);
    }
    let data: ProfilePageData;
    try {
      data = JSON.parse(json) as ProfilePageData;
    } catch {
      failures.push(`dist/${file} has structured data that is not JSON`);
      return;
    }
    const fields: [string, unknown, string][] = [
      ['@type', data?.['@type'], 'ProfilePage'],
      ['url', data?.url, url],
      ['mainEntity.name', data?.mainEntity?.name, profile.name],
    ];
    for (const [field, value, expected] of fields) {
      if (value !== expected) {
        failures.push(
          `dist/${file} has structured data whose ${field} is ${JSON.stringify(value)}, ` +
            `not ${JSON.stringify(expected)}`,
        );
      }
    }
  }

  // A page with an address is one search engines should list: no robots tag on it may give the rule noindex, as a line
  // left in the template would on every page, or the rule none, which includes it.
  function expectIndexed(file: string, html: string): void {
    // The capture group is not optional, so every match has m[1].
    const rules = [...html.matchAll(ROBOTS)].flatMap((m) => m[1]!.split(','));
    if (rules.some((rule) => /^\s*(?:noindex|none)\s*$/i.test(rule))) {
      failures.push(`dist/${file} has a robots tag that keeps it out of search results`);
    }
  }

  // The 404 page has no address of its own: every missing address serves it. So it names no canonical URL, and gives
  // link previews and search engines nothing, which would each describe whatever address it is served at.
  function expectNoAddress(file: string, html: string): void {
    const tags = [
      ['rel="canonical"', 'a canonical URL'],
      ['property="og:', 'Open Graph tags'],
      ['type="application/ld+json"', 'structured data'],
    ] as const;
    for (const [needle, what] of tags) {
      if (html.includes(needle)) failures.push(`dist/${file} has ${what}, though every missing address serves it`);
    }
  }

  // Every page in the table, with its own title, description, and page id. A page with an address names its canonical
  // URL, lets search engines index it, and has link previews and structured data, with no tag in READ_ONCE twice; the
  // 404 page asks not to be indexed. React escapes the text and attribute values it renders, and the prerender escapes
  // the head's as React does, so the content needles are escaped too.
  const built = pages.map((page) => ({ page, file: page.file, html: read(page.file) }));
  for (const { page, file, html } of built) {
    expectIncludes(file, html, [
      `<title>${escapeHtml(page.title)}</title>`,
      `<meta name="description" content="${escapeHtml(page.description)}" />`,
      `data-page="${page.id}"`,
    ]);
    if (page.path === null) {
      expectIncludes(file, html, ['<meta name="robots" content="noindex" />']);
      expectNoAddress(file, html);
    } else {
      const url = `${site.origin}${page.path}`;
      expectIncludes(file, html, [`<link rel="canonical" href="${escapeHtml(url)}" />`]);
      expectIndexed(file, html);
      expectPreview(file, html, page, url);
      expectOnce(file, html);
      expectStructuredData(file, html, url);
    }
  }

  // The picture itself: a PNG of the size the pages give. Each page with an address reports it missing, above.
  if (hasImage) {
    const size = pngSize(readFileSync(join(fileURLToPath(dist), imageKey)));
    const { width, height } = site.image;
    if (size === undefined) {
      failures.push(`dist/${imageKey} is not a PNG`);
    } else if (size.width !== width || size.height !== height) {
      failures.push(
        `dist/${imageKey} is a ${size.width} x ${size.height} picture, not the ${width} x ${height} that ` +
          'og:image:width and og:image:height give',
      );
    }
  }

  // Each page's own markup. The home page links to every other page with an address, so a visitor can reach each
  // one; the résumé has modest needles, its heading and each role's title, not its whole markup.
  const markup: Record<PageId, string[]> = {
    home: [
      `>${escapeHtml(profile.name)}</h1>`,
      // Tag-delimited: the meta description repeats these phrases.
      `>${escapeHtml(profile.role)}</p>`,
      ...profile.summary.map((line) => `>${escapeHtml(line)}</p>`),
      ...profile.links.map((link) => `href="${escapeHtml(link.href)}"`),
      ...pages.flatMap((page) => (page.path === null || page.id === 'home' ? [] : [`href="${escapeHtml(page.path)}"`])),
    ],
    resume: ['>Résumé</h1>', ...resume.experience.map((role) => `>${escapeHtml(role.title)}</h3>`)],
    'not-found': ['>Page not found</h1>'],
  };
  for (const { page, file, html } of built) expectIncludes(file, html, markup[page.id]);

  for (const { file, html } of built) {
    // The template's head: standards mode, the language, the encoding the
    // titles' em dash needs, and the viewport the responsive layout needs.
    expectIncludes(file, html, [
      '<!doctype html>',
      '<html lang="en">',
      '<meta charset="UTF-8" />',
      '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    ]);
    if (html.includes('<!--app-')) failures.push(`dist/${file} still contains a prerender marker`);
    const releaseTags = html.match(/<meta name="zachverse-release"[^>]*>/g) ?? [];
    const releaseTag = `<meta name="zachverse-release" content="${release}" />`;
    if (release === undefined && releaseTags.length > 0) {
      failures.push(`dist/${file} names a release, but no RELEASE_COMMIT was given`);
    } else if (release !== undefined && (releaseTags.length !== 1 || releaseTags[0] !== releaseTag)) {
      failures.push(`dist/${file} does not name release ${release} exactly once`);
    }
    // The capture group is not optional, so every match has m[1].
    const urls = [...html.matchAll(/\s(?:src|href)="([^"]*)"/g)].map((m) => m[1]!);
    // CloudFront serves /404.html at every missing path, so on /a/b/c a relative
    // URL would resolve under /a/b/. Fragments and absolute URLs are fine.
    const relative = urls.filter((url) => !/^(?:\/|#|[a-z][a-z\d+.-]*:)/i.test(url));
    for (const url of relative) {
      failures.push(`dist/${file} references ${url}, a relative URL that breaks on nested paths; start it with /`);
    }
    // Root-relative references, without any query or fragment; //host is another host.
    const refs = urls.filter((url) => /^\/(?!\/)/.test(url)).map((url) => url.split(/[?#]/)[0]!);
    // The checks read the key for the path a browser requests; messages quote the reference.
    const assets: { ref: string; key: string }[] = [];
    for (const ref of refs) {
      const key = keyOf(requested(ref));
      if (key === undefined || !distFiles.has(key)) failures.push(`dist/${file} references missing ${ref}`);
      if (key !== undefined && isAsset(key)) assets.push({ ref, key });
    }
    if (!assets.some((a) => a.key.endsWith('.js'))) failures.push(`dist/${file} references no JavaScript bundle`);
    if (!assets.some((a) => a.key.endsWith('.css'))) failures.push(`dist/${file} references no stylesheet`);
    for (const { ref, key } of assets) {
      // Vite copies public/ as is, so a name from there can only look hashed.
      if (publicFiles.has(key)) failures.push(`${ref} is copied unhashed from public/`);
      else if (!HASHED_NAME.test(key)) failures.push(`${ref} has no content hash in its name`);
    }
  }

  expectIncludes('robots.txt', read('robots.txt'), [`Sitemap: ${site.origin}/sitemap.xml`]);
  expectIncludes(
    'sitemap.xml',
    read('sitemap.xml'),
    pages.flatMap((page) => (page.path === null ? [] : [`<loc>${site.origin}${page.path}</loc>`])),
  );

  return failures;
}

/** The bytes of each kind of file a build sends, as measureDist counts them and BUDGETS limits them. */
export interface Sizes {
  /** Every .js and .mjs file under assets/, where Vite writes the bundles. */
  javascript: number;
  /** Every stylesheet. */
  css: number;
  /** The largest page: a visitor downloads one at a time. */
  html: number;
  /** Every PNG, JPEG, GIF, WebP, AVIF, SVG, and icon file. */
  images: number;
  /**
   * Every WOFF, WOFF2, TrueType, and OpenType file. release-lib.ts gives the last two no content type, so a release
   * refuses them before they are measured.
   */
  fonts: number;
}

/**
 * The most a build may send of each kind of file, in bytes, as measureDist counts it (the Phase 2 plan: record the
 * compressed JavaScript, image, and font sizes, and set explicit budgets). releaseProblems fails a build over any.
 */
export const BUDGETS: Sizes = {
  // 100 KiB, for every script together.
  javascript: 102_400,
  // 10 KiB, for every stylesheet together.
  css: 10_240,
  // 30 KiB, for the largest page alone.
  html: 30_720,
  // 100 KiB, for every picture and icon together.
  images: 102_400,
  // None: the site uses system fonts, so a font file of even one byte fails.
  fonts: 0,
};

// Each kind of file, in the size report's order: its name there and in the failures, and the files it counts.
// Extensions match in any case, as release-lib.ts reads a file's type; under assets/, HASHED_NAME keeps them
// lower-case.
const KINDS: [keyof Sizes, string, RegExp][] = [
  ['javascript', 'JavaScript', /^assets\/.*\.m?js$/],
  ['css', 'CSS', /\.css$/i],
  ['html', 'largest page', /\.html$/i],
  ['images', 'images', /\.(?:png|jpe?g|gif|webp|avif|svg|ico)$/i],
  ['fonts', 'fonts', /\.(?:woff2?|ttf|otf)$/i],
];

// Each kind's size as a release's files reach a browser that accepts gzip. Gzip at Node's default level approximates
// what CloudFront sends, for the types and sizes it compresses (encodingFor); it sends every other file, such as a PNG
// or a WOFF2, which are compressed already, at its own size.
function sizesOf(files: SiteFile[]): Sizes {
  const sizes: Sizes = { javascript: 0, css: 0, html: 0, images: 0, fonts: 0 };
  for (const file of files) {
    const kind = KINDS.find(([, , pattern]) => pattern.test(file.path))?.[0];
    if (kind === undefined) continue;
    const size = encodingFor(file, 'gzip') === 'gzip' ? gzipSync(file.body).length : file.body.length;
    sizes[kind] = kind === 'html' ? Math.max(sizes.html, size) : sizes[kind] + size;
  }
  return sizes;
}

/**
 * Measures rootDir's dist/ by kind (Sizes), each file as CloudFront would send it to a browser that accepts gzip; a
 * browser that takes Brotli, as CloudFront prefers, gets a little less. Only a build a release can publish has sizes:
 * for any other this throws, as siteFiles does, and releaseProblems reports why.
 */
export function measureDist(rootDir: URL): Sizes {
  return sizesOf(siteFiles(fileURLToPath(new URL('dist/', rootDir))));
}

// A size in KiB, as the size report gives it: whole when it is, and otherwise to one decimal place.
function kib(size: number): string {
  const value = size / 1024;
  return `${Number.isInteger(value) ? value : value.toFixed(1)} KiB`;
}

// A size in bytes, as the failures give it: exact, so a size just over its budget never reads as equal to it, as
// 102,401 bytes would in KiB to one decimal place.
function bytes(size: number): string {
  return `${size.toLocaleString('en-US')} ${size === 1 ? 'byte' : 'bytes'}`;
}

/** One failure for each kind of file over its budget, naming its size and the budget in bytes. */
export function budgetProblems(sizes: Sizes): string[] {
  return KINDS.filter(([kind]) => sizes[kind] > BUDGETS[kind]).map(
    ([kind, name]) =>
      `dist/ is over a size budget (gzip where CloudFront compresses): ${name} ${bytes(sizes[kind])}, more than ` +
      `the budget of ${bytes(BUDGETS[kind])}`,
  );
}

/** The one-line size report check:dist prints for a build that passes: each kind's size and its budget, in KiB. */
export function sizeReport(sizes: Sizes): string {
  const measured = KINDS.map(([kind, name]) => `${name} ${kib(sizes[kind])} of ${kib(BUDGETS[kind])}`);
  return `sizes (gzip where CloudFront compresses): ${measured.join(', ')}`;
}

/**
 * Problems a release would have with rootDir's dist/ (ADR 0006). A release publishes every file by the rules in
 * release-lib.ts, so one it would refuse is reported here first. And only what is under assets/ is cached as immutable
 * and never deleted: any other file the build emits, other than a page and what Vite copies from public/, would go out
 * as a page and be deleted by the next release that lacks it, which a chunk an open page loads later must not be. The
 * files it would publish must also keep to the smoke test's request budget and to the size budgets (BUDGETS).
 */
export function releaseProblems(rootDir: URL): string[] {
  const dist = new URL('dist/', rootDir);
  const distFiles = filesIn(dist);
  // checkDist reports a missing build.
  if (distFiles.size === 0) return [];
  const publicFiles = filesIn(new URL('public/', rootDir));
  const failures: string[] = [];
  try {
    const files = siteFiles(fileURLToPath(dist));
    const requests = distributionRequests(files);
    if (requests > SMOKE_REQUEST_BUDGET) {
      failures.push(
        `dist/ would take the smoke test ${requests} requests through the distribution, more than its budget of ` +
          `${SMOKE_REQUEST_BUDGET}, half the web ACL's rate limit for one address (ADR 0007)`,
      );
    }
    failures.push(...budgetProblems(sizesOf(files)));
  } catch (error) {
    failures.push(`dist/ cannot be released: ${(error as Error).message}`);
  }
  for (const file of distFiles) {
    if (file.endsWith('.html') || publicFiles.has(file) || isAsset(file)) continue;
    failures.push(`dist/${file} is built outside ${ASSETS}, so a release would publish it as a page`);
  }
  return failures;
}
