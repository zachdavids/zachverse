// Post-build check: the generated HTML must contain the substantive page
// content (not an empty client-rendered shell) and the head both pages share,
// and use only root-relative or absolute URLs (or fragments); every
// root-relative file it references must exist, and every /assets/ file it
// references must be a build output with a content hash in its name.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { profile, site } from '../src/content.ts';
import { escapeHtml } from './prerender-lib.ts';

// The file CloudFront serves for a path, as infra/functions/viewer-request.js maps it.
function servedFile(path: string): string {
  if (path.startsWith('/.well-known/')) return path;
  if (path.endsWith('/')) return `${path}index.html`;
  return path.lastIndexOf('.') < path.lastIndexOf('/') ? `${path}/index.html` : path;
}

// S3 serves objects, so a directory at a served path is as good as missing.
const isFile = (url: URL) => existsSync(url) && statSync(url).isFile();

// Returns one message per problem found in rootDir's dist/. rootDir is a
// directory URL ending in "/".
export function checkDist(rootDir: URL): string[] {
  const dist = new URL('dist/', rootDir);
  const publicDir = new URL('public/', rootDir);
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
    // The capture group is not optional, so every match has m[1].
    const urls = [...html.matchAll(/\s(?:src|href)="([^"]*)"/g)].map((m) => m[1]!);
    // CloudFront serves /404.html at every missing path, so on /a/b/c a relative
    // URL would resolve under /a/b/. Fragments and absolute URLs are fine.
    const relative = urls.filter((url) => !/^(?:\/|#|[a-z][a-z\d+.-]*:)/i.test(url));
    for (const url of relative) {
      failures.push(`dist/${file} references ${url}, a relative URL that breaks on nested paths; start it with /`);
    }
    // Root-relative paths, without any query or fragment; //host is another host.
    const paths = urls.filter((url) => /^\/(?!\/)/.test(url)).map((url) => url.split(/[?#]/)[0]!);
    for (const path of paths) {
      if (!isFile(new URL(`.${servedFile(path)}`, dist))) failures.push(`dist/${file} references missing ${path}`);
    }
    const assets = paths.filter((path) => path.startsWith('/assets/'));
    if (!assets.some((a) => a.endsWith('.js'))) failures.push(`dist/${file} references no JavaScript bundle`);
    if (!assets.some((a) => a.endsWith('.css'))) failures.push(`dist/${file} references no stylesheet`);
    for (const asset of assets) {
      // Vite copies public/ as is, so a name from there can only look hashed.
      if (existsSync(new URL(`.${asset}`, publicDir))) failures.push(`${asset} is copied unhashed from public/`);
      else if (!/-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(asset)) failures.push(`${asset} has no content hash in its name`);
    }
  }

  expectIncludes('robots.txt', read('robots.txt'), [`Sitemap: ${site.origin}/sitemap.xml`]);
  expectIncludes('sitemap.xml', read('sitemap.xml'), [`<loc>${site.origin}/</loc>`]);

  return failures;
}
