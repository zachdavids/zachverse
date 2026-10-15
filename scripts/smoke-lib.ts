// The release smoke test (ADR 0006): what viewers get through CloudFront, at the distribution's own hostname and, with
// connections made through it, at both custom hostnames, compared with the release's own files.
import { RECORDS, type SiteFile, sha256, siteFiles } from './release-lib.ts';

export interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/** Fetches url without following redirects; via, if given, is the host to connect to in place of url's. */
export type Get = (url: string, via?: string) => Promise<Reply>;

export interface Target {
  /** The site's origin, such as https://zachdavids.com. */
  origin: string;
  /** The distribution's own hostname, such as d111111abcdef8.cloudfront.net. */
  cloudfront: string;
  bucket: string;
  /** A path segment no release has, different on each run, for the missing-page checks. */
  probe: string;
}

export interface Result {
  passed: string[];
  failures: string[];
}

const header = (reply: Reply, name: string) => [reply.headers[name]].flat()[0];

function status(reply: Reply, expected: number, what: string): string[] {
  return reply.status === expected ? [] : [`${what}: status ${reply.status}, not ${expected}`];
}

// Problems with a reply that should be file, as published.
function served(reply: Reply, file: SiteFile, what = `/${file.path}`): string[] {
  if (reply.status !== 200) return status(reply, 200, what);
  const problems = sha256(reply.body) === file.sha256 ? [] : [`${what}: the body is not the release's /${file.path}`];
  for (const [name, expected] of [
    ['content-type', file.contentType],
    ['cache-control', file.cacheControl],
  ] as const) {
    const actual = header(reply, name);
    if (actual !== expected) problems.push(`${what}: ${name} is ${JSON.stringify(actual)}, not ${JSON.stringify(expected)}`);
  }
  return problems;
}

function redirected(reply: Reply, location: string): string[] {
  const actual = header(reply, 'location');
  return reply.status === 301 && actual === location
    ? []
    : [`status ${reply.status} to ${JSON.stringify(actual)}, not 301 to ${location}`];
}

/**
 * Problems with a home page as prerendered: no looser than what check:dist requires of every build (a title, markup
 * inside the home page's root element, text that ends a heading, no prerender marker left), so a release that passed
 * its build cannot fail here, but a client-rendered shell does; and the release it names.
 */
export function prerendered(body: Buffer): string[] {
  const html = body.toString('utf8');
  const markers: [string, RegExp][] = [
    ['a title', /<title>[^<]*\S[^<]*<\/title>/],
    ['prerendered markup', /\sdata-page="home"[^>]*>\s*<[a-z]/i],
    ['a heading', />[^<]*\S[^<]*<\/h1>/],
    ['the release it belongs to', /<meta name="zachverse-release" content="[0-9a-f]{40}" \/>/],
  ];
  const problems = markers.filter(([, pattern]) => !pattern.test(html)).map(([what]) => `the home page has no ${what}`);
  return html.includes('<!--app-') ? [...problems, 'the home page still has a prerender marker'] : problems;
}

/** The root-relative URLs a page loads or links to, and the release file each one gets, as the viewer-request function maps paths. */
function references(page: SiteFile): { url: string; path: string }[] {
  const urls = [...page.body.toString('utf8').matchAll(/\s(?:src|href)="(\/(?!\/)[^"?#]*)/g)].map((match) => match[1]!);
  return [...new Set(urls)].map((url) => {
    const path = url.slice(1);
    const name = path.slice(path.lastIndexOf('/') + 1);
    return { url, path: name === '' ? `${path}index.html` : name.includes('.') ? path : `${path}/index.html` };
  });
}

/** get, retried twice after a request that fails outright, such as a reset connection or a timeout, but not after a reply. */
export function retrying(get: Get, sleep: (ms: number) => Promise<unknown>): Get {
  return async (url, via) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await get(url, via);
      } catch (error) {
        if (attempt === 3) throw error;
        await sleep(2000 * attempt);
      }
    }
  };
}

/** Runs every check against the release whose files are in dir, and lists the ones that passed and what failed. */
export async function smokeTest(dir: string, target: Target, get: Get): Promise<Result> {
  const files = siteFiles(dir);
  const byPath = new Map(files.map((file) => [file.path, file]));
  const home = byPath.get('index.html');
  const notFound = byPath.get('404.html');
  if (home === undefined || notFound === undefined) throw new Error(`${dir} has no index.html or no 404.html.`);
  const apex = new URL(target.origin).host;
  const www = `www.${apex}`;
  const { cloudfront, bucket, probe } = target;
  // Through the distribution, whatever DNS says the custom hostnames are.
  const viaCloudFront = (url: string) => get(url, cloudfront);
  const isNotFoundPage = (reply: Reply) => sha256(reply.body) === notFound.sha256;

  const checks: [string, () => Promise<string[]>][] = [
    [`https://${cloudfront}/ serves the home page`, async () => served(await get(`https://${cloudfront}/`), home, '/')],
    [
      `https://${apex}/ serves the prerendered home page`,
      async () => {
        const reply = await viaCloudFront(`https://${apex}/`);
        return [...served(reply, home, '/'), ...prerendered(reply.body)];
      },
    ],
    [
      `https://${apex} serves every file of the release, with its content type and caching`,
      async () => {
        const problems: string[] = [];
        for (const file of files) problems.push(...served(await viaCloudFront(`https://${apex}/${file.path}`), file));
        return problems;
      },
    ],
    [
      "every page's scripts, styles, icons, and page links load",
      async () => {
        const problems: string[] = [];
        for (const page of files.filter(({ path }) => path.endsWith('.html'))) {
          for (const { url, path } of references(page)) {
            const file = byPath.get(path);
            if (file === undefined) problems.push(`/${page.path} refers to ${url}, which the release does not have`);
            else problems.push(...served(await viaCloudFront(`https://${apex}${url}`), file, url));
          }
        }
        return problems;
      },
    ],
    [`http://${apex}/ redirects to HTTPS`, async () => redirected(await viaCloudFront(`http://${apex}/`), `https://${apex}/`)],
    [`http://${www}/ redirects to HTTPS`, async () => redirected(await viaCloudFront(`http://${www}/`), `https://${www}/`)],
    [
      `https://${www}/ redirects to the apex, keeping the path and query`,
      async () =>
        redirected(
          await viaCloudFront(`https://${www}/${probe}/page?from=smoke-test`),
          `https://${apex}/${probe}/page?from=smoke-test`,
        ),
    ],
    [
      'a missing page gets the 404 page, with status 404',
      async () => {
        const reply = await viaCloudFront(`https://${apex}/${probe}/`);
        return [...status(reply, 404, `/${probe}/`), ...(isNotFoundPage(reply) ? [] : ['the body is not the 404 page'])];
      },
    ],
    [
      'a missing asset gets status 404',
      async () => status(await viaCloudFront(`https://${apex}/assets/${probe}.js`), 404, `/assets/${probe}.js`),
    ],
    [
      "a release record gets S3's 403, not the 404 page",
      async () => {
        const reply = await viaCloudFront(`https://${apex}/${RECORDS}history.json`);
        return [
          ...status(reply, 403, `/${RECORDS}history.json`),
          ...(isNotFoundPage(reply) ? ['the body is the 404 page'] : []),
        ];
      },
    ],
    [
      'the bucket refuses unauthenticated requests made to it directly',
      async () => {
        const endpoint = `https://${bucket}.s3.us-east-1.amazonaws.com`;
        return [
          ...status(await get(`${endpoint}/index.html`), 403, `${endpoint}/index.html`),
          ...status(await get(`${endpoint}/`), 403, `${endpoint}/`),
        ];
      },
    ],
  ];

  const passed: string[] = [];
  const failures: string[] = [];
  for (const [name, check] of checks) {
    let problems: string[];
    try {
      problems = await check();
    } catch (error) {
      problems = [error instanceof Error ? error.message : String(error)];
    }
    if (problems.length === 0) passed.push(name);
    else failures.push(...problems.map((problem) => `${name}: ${problem}`));
  }
  return { passed, failures };
}
