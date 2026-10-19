// Entry for the browser check (ADR 0006):
//   node scripts/browser-check.ts local <dir>  serves the build in <dir> as CloudFront serves the bucket, and checks it
//   node scripts/browser-check.ts live         checks the site at its own hostname, connected to the distribution
//                                              ($CLOUDFRONT_DOMAIN), as `curl --connect-to` would, whatever DNS says
// $RELEASE_COMMIT, if set, is the release every page must name; otherwise they must name none.
// It loads Playwright, a package, so it never runs in a job that holds the deploy role.
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { appendFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { pages, site } from '../src/content/index.ts';
import { browserCheck, open, serve } from './browser-check-lib.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

async function main(args: string[]): Promise<string[]> {
  const [mode, dir] = args;
  const release = process.env.RELEASE_COMMIT || null;
  let origin: string = site.origin;
  let launchArgs: string[] = [];
  let server: Awaited<ReturnType<typeof serve>> | undefined;
  if (mode === 'local' && dir !== undefined && args.length === 2) {
    server = await serve(dir);
    origin = server.origin;
  } else if (mode === 'live' && args.length === 1) {
    if (release === null) throw new Error('RELEASE_COMMIT is not set.');
    // Chromium resolves the site's hostnames to the distribution, while TLS and the Host header keep the site's names.
    const { address } = await lookup(required('CLOUDFRONT_DOMAIN'), { family: 4 });
    const host = new URL(site.origin).host;
    launchArgs = [`--host-resolver-rules=MAP ${host} ${address}, MAP www.${host} ${address}`];
  } else {
    throw new Error('Usage: node scripts/browser-check.ts local <dir> | live');
  }
  try {
    // Playwright hides headless Chromium's scrollbars. Shown, as Windows and Linux show them, they take their width
    // from the page's, so a layout 100vw wide scrolls sideways, as it would there.
    const browser = await chromium.launch({ args: launchArgs, ignoreDefaultArgs: ['--hide-scrollbars'] });
    try {
      // The pages name their canonical URLs at the site's own origin, wherever they are served from. CI keeps a
      // screenshot of each page at each width for the pull request's review, in BROWSER_CHECK_SCREENSHOTS.
      const target = {
        origin,
        canonicalOrigin: site.origin,
        release,
        probe: `browser-check-${randomUUID()}`,
        screenshots: process.env.BROWSER_CHECK_SCREENSHOTS || undefined,
      };
      const { passed, failures } = await browserCheck(target, pages, (url, width, options) =>
        open(browser, url, width, options),
      );
      const lines = [
        `### Browser check (${mode === 'live' ? `${site.origin}, through the distribution` : dir})`,
        '',
        ...passed.map((check) => `- Passed: ${check}`),
        ...failures.map((failure) => `- **Failed:** ${failure}`),
      ];
      console.log(lines.join('\n'));
      // Added to the run's summary page as well. GitHub reads it as Markdown, which would take a tag a problem names,
      // such as <a>, for HTML, so &, <, and > go in as entities there; the log and the annotations keep them as they
      // are.
      const summary = process.env.GITHUB_STEP_SUMMARY;
      const escaped = lines.join('\n').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      if (summary) appendFileSync(summary, `${escaped}\n\n`);
      return failures;
    } finally {
      await browser.close();
    }
  } finally {
    await server?.close();
  }
}

let failures: string[];
try {
  failures = await main(process.argv.slice(2));
} catch (error) {
  failures = [error instanceof Error ? error.message : String(error)];
}
// An ::error:: line shows on the run's summary page as well as in the log.
for (const failure of failures) console.error(`::error::${failure}`);
if (failures.length > 0) process.exit(1);
