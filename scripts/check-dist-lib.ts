// Post-build check: the generated HTML must contain the substantive page
// content (not an empty client-rendered shell), and every referenced asset
// must exist with a content hash in its name.
import { existsSync, readFileSync } from 'node:fs';
import { profile, site } from '../src/content.ts';

// Returns one message per problem found in `dist`, a directory URL ending in "/".
export function checkDist(dist: URL): string[] {
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

  const index = read('index.html');
  expectIncludes('index.html', index, [
    `<title>${site.title}</title>`,
    'data-page="home"',
    `>${profile.name}</h1>`,
    // Tag-delimited: the template's meta description repeats both phrases.
    `>${profile.role}</p>`,
    `>${profile.status}</p>`,
    `<link rel="canonical" href="${site.origin}/" />`,
    ...profile.links.map((link) => `href="${link.href}"`),
  ]);

  const notFound = read('404.html');
  expectIncludes('404.html', notFound, [
    `<title>${site.notFoundTitle}</title>`,
    'data-page="not-found"',
    '<meta name="robots" content="noindex" />',
    '>Page not found</h1>',
  ]);

  for (const [file, html] of [['index.html', index], ['404.html', notFound]] as const) {
    if (html.includes('<!--app-')) failures.push(`dist/${file} still contains a prerender marker`);
    // The capture group is not optional, so every match has m[1].
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]!);
    if (!assets.some((a) => a.endsWith('.js'))) failures.push(`dist/${file} references no JavaScript bundle`);
    if (!assets.some((a) => a.endsWith('.css'))) failures.push(`dist/${file} references no stylesheet`);
    for (const asset of assets) {
      if (!existsSync(new URL(`.${asset}`, dist))) failures.push(`dist/${file} references missing ${asset}`);
      if (!/-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(asset)) failures.push(`${asset} has no content hash in its name`);
    }
  }

  expectIncludes('robots.txt', read('robots.txt'), [`Sitemap: ${site.origin}/sitemap.xml`]);
  expectIncludes('sitemap.xml', read('sitemap.xml'), [`<loc>${site.origin}/</loc>`]);

  return failures;
}
