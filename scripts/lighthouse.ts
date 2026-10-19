// Entry for the Lighthouse check: node scripts/lighthouse.ts <dir> serves the build in <dir> as CloudFront serves the
// bucket, measures each page that has an address with Lighthouse, as a phone and then as a desktop, and fails on any
// result outside the limits in lighthouse-lib.ts. CI's web job runs it; the deploy workflow doesn't, since lab scores
// vary from run to run, and CI on the pull request gates the merge.
// It loads Lighthouse and Playwright, packages, so it never runs in a job that holds the deploy role.
import { appendFileSync } from 'node:fs';
import { type AddressInfo, createServer } from 'node:net';
import lighthouse, { desktopConfig } from 'lighthouse';
import { type Browser, chromium } from 'playwright';
import { pages } from '../src/content/index.ts';
import { serve } from './browser-check-lib.ts';
import { CATEGORIES, type FormFactor, lighthouseCheck, report, type Run } from './lighthouse-lib.ts';

// With no config, Lighthouse emulates a phone on a slow 4G connection, with the CPU slowed 4 times; its desktop config
// emulates a desktop on a faster connection, without slowing the CPU. Both simulate the throttling.
const FORM_FACTORS: [FormFactor, typeof desktopConfig | undefined][] = [
  ['mobile', undefined],
  ['desktop', desktopConfig],
];

// A port nothing listens on, for Chromium's DevTools endpoint, which Lighthouse connects to: the system picks one,
// and it is let go for Chromium to take.
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

// serve() compresses a file the first time a browser asks for it, and answers no other request until it is done: for
// the script, about 200 ms. Lighthouse's simulation charges every request the median of the server's response times,
// so the first run would measure the local server as well as the page, painting about 400 ms later as a phone than a
// run with the files already compressed. Loading each page once first, until its network goes quiet, compresses every
// file a run loads. The page has a browser context of its own, and Lighthouse clears the browser's cache before each
// run, so only the server's compressed copies carry over.
async function warmServer(browser: Browser, urls: string[]): Promise<void> {
  const page = await browser.newPage();
  try {
    for (const url of urls) await page.goto(url, { waitUntil: 'networkidle' });
  } finally {
    await page.close();
  }
}

async function main(args: string[]): Promise<string[]> {
  if (args.length !== 1) throw new Error('Usage: node scripts/lighthouse.ts <dir>');
  const dir = args[0]!;
  // The 404 page has no address: every missing one serves it.
  const paths = pages.flatMap(({ path }) => (path === null ? [] : [path]));
  const server = await serve(dir);
  try {
    const port = await freePort();
    // Lighthouse opens a tab of its own in this browser for each run, and closes it after.
    const browser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
    try {
      await warmServer(browser, paths.map((path) => `${server.origin}${path}`));
      const runs: Run[] = [];
      // One run at a time: runs side by side would share the machine's CPU, and each would measure the others' work.
      for (const path of paths) {
        for (const [formFactor, config] of FORM_FACTORS) {
          const url = `${server.origin}${path}`;
          const flags = { port, logLevel: 'error' as const, onlyCategories: CATEGORIES.map(({ id }) => id) };
          // A run that fails is reported with the others, by its page and form factor, as a check that throws is in
          // the browser check, and the runs after it still go ahead.
          try {
            const result = await lighthouse(url, flags, config);
            if (result === undefined) throw new Error('Lighthouse returned no result');
            runs.push({ path, formFactor, lhr: result.lhr });
          } catch (error) {
            runs.push({ path, formFactor, error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
      const { passed, failures } = lighthouseCheck(runs);
      const lines = [
        `### Lighthouse lab results (${dir})`,
        '',
        ...report(runs),
        '',
        ...passed.map((run) => `- Passed: ${run}`),
        ...failures.map((failure) => `- **Failed:** ${failure}`),
      ];
      console.log(lines.join('\n'));
      // Added to the run's summary page as well.
      const summary = process.env.GITHUB_STEP_SUMMARY;
      if (summary) appendFileSync(summary, `${lines.join('\n')}\n\n`);
      return failures;
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
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
