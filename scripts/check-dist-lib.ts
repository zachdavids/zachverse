// Post-build check: the generated HTML must contain the substantive page
// content (not an empty client-rendered shell) and the head both pages share,
// and use only root-relative or absolute URLs (or fragments); every
// root-relative file it references must exist under the exact name S3 would
// look up for the path a browser requests, and every /assets/ file it
// references must be a build output with a content hash in its name.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { profile, site } from '../src/content.ts';
import { escapeHtml } from './prerender-lib.ts';

// The file CloudFront serves for a path, as infra/functions/viewer-request.js maps it.
function servedFile(path: string): string {
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

  // React escapes the text and attribute values it renders, so the content needles are escaped too.
  const index = read('index.html');
  expectIncludes('index.html', index, [
    `<title>${site.title}</title>`,
    'data-page="home"',
    `>${escapeHtml(profile.name)}</h1>`,
    // Tag-delimited: the meta description repeats both phrases.
    `>${escapeHtml(profile.role)}</p>`,
    `>${escapeHtml(profile.status)}</p>`,
    `<link rel="canonical" href="${site.origin}/" />`,
    ...profile.links.map((link) => `href="${escapeHtml(link.href)}"`),
  ]);

  const notFound = read('404.html');
  expectIncludes('404.html', notFound, [
    `<title>${site.notFoundTitle}</title>`,
    'data-page="not-found"',
    '<meta name="robots" content="noindex" />',
    '>Page not found</h1>',
  ]);

  for (const [file, html] of [['index.html', index], ['404.html', notFound]] as const) {
    // The template's head: standards mode, the language, the encoding the
    // titles' em dash needs, the viewport the responsive layout needs, and the
    // description prerendering fills in from content.ts.
    expectIncludes(file, html, [
      '<!doctype html>',
      '<html lang="en">',
      '<meta charset="UTF-8" />',
      '<meta name="viewport" content="width=device-width, initial-scale=1" />',
      `<meta name="description" content="${escapeHtml(site.description)}" />`,
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
      if (key?.startsWith('assets/')) assets.push({ ref, key });
    }
    if (!assets.some((a) => a.key.endsWith('.js'))) failures.push(`dist/${file} references no JavaScript bundle`);
    if (!assets.some((a) => a.key.endsWith('.css'))) failures.push(`dist/${file} references no stylesheet`);
    for (const { ref, key } of assets) {
      // Vite copies public/ as is, so a name from there can only look hashed.
      if (publicFiles.has(key)) failures.push(`${ref} is copied unhashed from public/`);
      else if (!/-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(key)) failures.push(`${ref} has no content hash in its name`);
    }
  }

  expectIncludes('robots.txt', read('robots.txt'), [`Sitemap: ${site.origin}/sitemap.xml`]);
  expectIncludes('sitemap.xml', read('sitemap.xml'), [`<loc>${site.origin}/</loc>`]);

  return failures;
}
