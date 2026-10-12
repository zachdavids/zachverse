import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { site } from '../src/content.ts';

// jsdom ships no type declarations; these checks only need its window's DOMParser.
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new () => { window: typeof globalThis };
};

type Filter = { branches?: string[]; tags?: string[]; types?: string[]; [key: string]: unknown };
type Defaults = { run?: { shell?: string; 'working-directory'?: string } };
type Conditions = { if?: unknown; 'continue-on-error'?: unknown };
type Step = Conditions & {
  uses?: string;
  run?: string;
  shell?: string;
  with?: Record<string, unknown>;
  'working-directory'?: string;
};
type Job = Conditions & {
  uses?: string;
  needs?: unknown;
  environment?: string | { name?: string };
  steps?: Step[];
  permissions?: string | Record<string, string>;
  defaults?: Defaults;
};
type Workflow = {
  on?: string | string[] | Record<string, Filter | null>;
  permissions?: unknown;
  defaults?: Defaults;
  jobs: Record<string, Job>;
};

const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const readJson = <T>(path: string) => JSON.parse(read(path)) as T;

// Runs git at the repo root and returns its output lines; any other exit status fails with git's error.
function git(args: string[], statuses = [0]) {
  const result = spawnSync('git', args, { cwd: fileURLToPath(root), encoding: 'utf8' });
  expect(result.error, 'git').toBeUndefined();
  expect(statuses, `git ${args[0]} exited ${result.status}: ${result.stderr.trim()}`).toContain(result.status);
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

const workflows = readdirSync(new URL('.github/workflows/', root))
  .filter((file) => /\.ya?ml$/.test(file))
  .sort()
  .map((file) => {
    const text = read(`.github/workflows/${file}`);
    return { file, text, workflow: parse(text) as Workflow };
  });
const jobs = workflows.flatMap(({ file, workflow }) =>
  Object.entries(workflow.jobs).map(([id, job]) => ({ where: `${file} ${id}`, workflow, job })),
);
const steps = jobs.flatMap((context) => (context.job.steps ?? []).map((step) => ({ ...context, step })));
const ci = workflows.find(({ file }) => /^ci\.ya?ml$/.test(file))?.workflow;

// GitHub resolves action names case-insensitively.
const actionName = (uses = '') => uses.split('@')[0]!.toLowerCase();

// A block-style uses: line, capturing the (optionally quoted) ref and any trailing comment.
const usesLine = /^\s*(?:-\s+)?uses:\s*(['"]?)([^\s'"#]*)\1\s*(#.*)?$/;
// owner/repo[/path]@<full lowercase commit SHA> # v<version>
const pinned = /^([\w.-]+\/[\w.-]+(?:\/[\w./-]+)?)@([0-9a-f]{40}) #\s*(v\d\S*)/;

// The events a workflow runs on, each with its filter (null if none), whichever form "on" takes.
function triggers({ on }: Workflow): Record<string, Filter | null> {
  if (typeof on === 'string') return { [on]: null };
  if (Array.isArray(on)) return Object.fromEntries(on.map((event) => [event, null]));
  return on ?? {};
}

// The owner's rule for AWS access: only a job in the production environment, in a workflow that runs
// only on pushes to main or by hand, may request an OIDC token or configure AWS credentials.
function deploysToProduction(workflow: Workflow, job: Job) {
  const environment = typeof job.environment === 'string' ? job.environment : job.environment?.name;
  const mainOrManual = Object.entries(triggers(workflow)).every(([event, filter]) => {
    if (event === 'workflow_dispatch') return true;
    // A tags filter would also run it for tag pushes.
    const { branches, tags, 'tags-ignore': tagsIgnore } = filter ?? {};
    return event === 'push' && isDeepStrictEqual(branches, ['main']) && tags === undefined && tagsIgnore === undefined;
  });
  return environment === 'production' && mainOrManual;
}

// Each ${{ }} expression in the text. As in GitHub, a }} inside a single-quoted string does not end one.
function expressions(text: string) {
  const found: string[] = [];
  let start = text.indexOf('${{');
  while (start !== -1) {
    let end = start + 3;
    for (let quoted = false; end < text.length && (quoted || !text.startsWith('}}', end)); end++) {
      if (text[end] === "'") quoted = !quoted;
    }
    found.push(text.slice(start, end + 2));
    start = text.indexOf('${{', end + 2);
  }
  return found;
}

// A CI job's steps as action names or "<dir>: <command>" (no prefix at the repo root) plus any shell
// override, marked optional when they may be skipped or may fail without failing the job.
function plan(jobId: string) {
  const job = ci?.jobs[jobId];
  const defaults = { ...ci?.defaults?.run, ...job?.defaults?.run };
  const optional = (item: Conditions) => item.if !== undefined || (item['continue-on-error'] ?? false) !== false;
  return (job?.steps ?? []).map((step) => {
    const dir = posix.normalize(step['working-directory'] ?? defaults['working-directory'] ?? '.').replace(/\/$/, '');
    const shell = step.shell ?? defaults.shell;
    const prefix = dir === '.' ? '' : `${dir}: `;
    const suffix = shell === undefined ? '' : ` (shell: ${shell})`;
    const label = step.uses === undefined ? `${prefix}${step.run?.trim()}${suffix}` : actionName(step.uses);
    return optional(job!) || optional(step) ? `${label} (optional)` : label;
  });
}

// Other steps may be added, but these must stay separate, required, and in this order.
function expectRequiredSteps(jobId: string, required: string[]) {
  expect(ci?.jobs[jobId], `ci.yml job ${jobId}`).toBeDefined();
  // A job is skipped when one it needs is skipped or fails, and GitHub reports a skipped job as passing.
  expect(ci?.jobs[jobId]?.needs, `ci.yml job ${jobId} needs`).toBeUndefined();
  const all = plan(jobId);
  expect(
    all.filter((step) => required.includes(step.replace(/ \(optional\)$/, ''))),
    all.join(' | '),
  ).toEqual(required);
}

// setup-node installs the newest release matching .nvmrc, so its missing version parts are unbounded.
// As in npm, a partial bound stands for its whole line: >24 means >=25.0.0, and <=24.11 means <24.12.0.
function acceptsNewest(range: string, nvmrc: string) {
  const newest = [0, 1, 2].map((i) => Number(nvmrc.replace(/^v/, '').split('.')[i] ?? Infinity));
  const compare = (version: number[]) =>
    Math.sign(newest.map((part, i) => part - version[i]!).find((diff) => diff !== 0) ?? 0);
  return range
    .trim()
    .split(/\s+/)
    .every((comparator) => {
      const [, op = '=', bound] = /^(>=|<=|>|<|=)?(\d+(?:\.\d+){0,2})$/.exec(comparator) ?? [];
      if (bound === undefined) throw new Error(`Unsupported engines comparator: ${comparator}`);
      const given = bound.split('.').map(Number);
      // The first version the bound covers and the first one past it: 24.11 gives 24.11.0 and 24.12.0.
      const first = [0, 1, 2].map((i) => given[i] ?? 0);
      const past = first.map((part, i) => (i < given.length - 1 ? part : i === given.length - 1 ? part + 1 : 0));
      if (op === '>=') return compare(first) >= 0;
      if (op === '<') return compare(first) < 0;
      if (op === '>') return compare(past) >= 0;
      if (op === '<=') return compare(past) < 0;
      return compare(first) >= 0 && compare(past) < 0;
    });
}

describe('GitHub Actions workflows', () => {
  it('pin every action to a full commit SHA with a version comment', () => {
    const lines = workflows.flatMap(({ file, text, workflow }) => {
      const found = text.split(/\r?\n/).flatMap((line) => {
        const match = usesLine.exec(line);
        return match ? [{ ref: match[2]!, comment: match[3] ?? '' }] : [];
      });
      // The text scan must see exactly the uses: entries the YAML defines, or a comment could go unchecked.
      const declared = Object.values(workflow.jobs).flatMap((job) => [
        job.uses,
        ...(job.steps ?? []).map((step) => step.uses),
      ]);
      expect(found.map(({ ref }) => ref), file).toEqual(declared.filter((uses) => uses !== undefined));
      return found.map(({ ref, comment }) => `${ref} ${comment}`.trim());
    });
    expect(lines).not.toHaveLength(0);
    expect(lines.filter((line) => !pinned.test(line))).toEqual([]);

    // A commit keeps one version label and a label one commit, so the comment cannot drift from the SHA.
    const versions = new Map<string, string>();
    const commits = new Map<string, string>();
    for (const line of lines) {
      const [, name = '', sha = '', version = ''] = pinned.exec(line) ?? [];
      const action = name.toLowerCase();
      expect(versions.get(`${action}@${sha}`) ?? version, `${action}@${sha}`).toBe(version);
      expect(commits.get(`${action} ${version}`) ?? sha, `${action} ${version}`).toBe(sha);
      versions.set(`${action}@${sha}`, version);
      commits.set(`${action} ${version}`, sha);
    }
  });

  it('run only on push, pull_request, or workflow_dispatch', () => {
    for (const { file, workflow } of workflows) {
      const events = Object.keys(triggers(workflow));
      // An empty list would pass vacuously, e.g. if a YAML 1.1 parser read "on" as true.
      expect(events, file).not.toHaveLength(0);
      expect(
        events.filter((event) => !['push', 'pull_request', 'workflow_dispatch'].includes(event)),
        file,
      ).toEqual([]);
    }
  });

  it('grant the token read-only access, and an OIDC token only to production deploys', () => {
    for (const { file, workflow } of workflows) expect(workflow.permissions, file).toEqual({ contents: 'read' });
    for (const { where, workflow, job } of jobs) {
      const grants =
        typeof job.permissions === 'string'
          ? [job.permissions]
          : Object.entries(job.permissions ?? {}).map(([scope, access]) => `${scope}: ${access}`);
      const allowed = deploysToProduction(workflow, job) ? ['id-token: write'] : [];
      expect(grants.filter((grant) => /write/i.test(grant) && !allowed.includes(grant)), where).toEqual([]);
    }
  });

  it('obtain AWS credentials only in production deploys, never from secrets or access keys', () => {
    const configured = steps.filter(
      ({ workflow, job, step }) =>
        actionName(step.uses) === 'aws-actions/configure-aws-credentials' && !deploysToProduction(workflow, job),
    );
    expect(configured.map(({ where }) => where)).toEqual([]);
    for (const { file, text, workflow } of workflows) {
      // Every ${{ }} expression, plus "secrets:" keys such as "secrets: inherit".
      const json = JSON.stringify(workflow);
      const references = [...expressions(json), ...(json.match(/"secrets":[^,}]*/g) ?? [])];
      expect(references.filter((reference) => /\bsecrets\b/i.test(reference)), file).toEqual([]);
      expect(text.match(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g) ?? [], file).toEqual([]);
    }
  });

  it('check out without persisting the token', () => {
    const checkouts = steps.filter(({ step }) => actionName(step.uses) === 'actions/checkout');
    expect(checkouts).not.toHaveLength(0);
    for (const { where, step } of checkouts) {
      expect(String(step.with?.['persist-credentials']), where).toBe('false');
    }
  });

  it('install Node from .nvmrc', () => {
    const setups = steps.filter(({ step }) => actionName(step.uses) === 'actions/setup-node');
    expect(setups).not.toHaveLength(0);
    for (const { where, step } of setups) {
      expect(posix.normalize(String(step.with?.['node-version-file'])), where).toBe('.nvmrc');
      // setup-node prefers node-version over node-version-file.
      expect(step.with?.['node-version'], where).toBeUndefined();
    }
  });
});

describe('CI workflow', () => {
  it('runs on every pull request and every push to main', () => {
    const events = ci ? triggers(ci) : {};
    // GitHub runs pull_request for this activity unless "types" names other activity.
    const activity = ['opened', 'synchronize', 'reopened'];
    for (const event of ['pull_request', 'push']) {
      expect(Object.keys(events), event).toContain(event);
      const { branches, types = activity, ...narrowing } = events[event] ?? {};
      // A branches filter on pull_request skips stacked PRs, whose base is another PR's branch.
      if (event === 'pull_request') expect(branches, event).toBeUndefined();
      else expect([branches ?? 'main'].flat(), event).toContain('main');
      expect(types, event).toEqual(expect.arrayContaining(activity));
      // paths, paths-ignore, branches-ignore, or tags would skip CI for some changes to main.
      expect(narrowing, event).toEqual({});
    }
  });

  it('runs web install, typecheck, coverage, build, and dist checks as separate required steps in order', () => {
    expectRequiredSteps('web', [
      'actions/checkout',
      'actions/setup-node',
      'npm ci',
      'npm run typecheck',
      'npm run test:coverage',
      'npm run build',
      'npm run check:dist',
    ]);
  });

  it('runs infra install, typecheck, and coverage in infra as separate required steps in order', () => {
    expectRequiredSteps('infra', [
      'actions/checkout',
      'actions/setup-node',
      'infra: npm ci',
      'infra: npm run typecheck',
      'infra: npm run test:coverage',
    ]);
  });

  it('typechecks every TypeScript project with tsc and runs Vitest with coverage', () => {
    for (const dir of ['', 'infra/']) {
      const { scripts } = readJson<{ scripts: Record<string, string | undefined> }>(`${dir}package.json`);
      const configs = readdirSync(new URL(dir, root)).filter((file) => /^tsconfig\b.*\.json$/.test(file));
      // A solution file ("files": [] plus "references") checks nothing itself; it lets editors find the projects.
      const solutions = configs.filter((file) => {
        const { files, references, ...rest } = readJson<Record<string, unknown>>(`${dir}${file}`);
        return isDeepStrictEqual(files, []) && references !== undefined && Object.keys(rest).length === 0;
      });
      const projects = configs.filter((file) => !solutions.includes(file));
      for (const file of solutions) {
        const { references } = readJson<{ references: { path: string }[] }>(`${dir}${file}`);
        expect(references.map(({ path }) => posix.normalize(path)).sort(), `${dir}${file}`).toEqual(projects.sort());
      }
      // One plain tsc run per project, so none can be dropped and no flag or "|| true" can weaken one.
      expect(scripts.typecheck?.split(' && ').sort(), `${dir}package.json`).toEqual(
        projects.sort().map((project) => `tsc -p ${project}`),
      );
      // Further flags could turn coverage or its thresholds off.
      expect(scripts['test:coverage'], `${dir}package.json`).toBe('vitest run --coverage');
    }
  });

  it("requires 100% coverage of each package's source", async () => {
    const web = (await import('../vitest.config.ts')).default.test?.coverage;
    const infra = (await import('../infra/vitest.config.mts')).default.test?.coverage;
    // Any other key, such as a per-glob threshold, could lower the bar for some files.
    expect(web?.thresholds).toEqual({ 100: true });
    expect(infra?.thresholds).toEqual({ 100: true });
    // More files may be measured, but none may drop out.
    expect(web?.include).toEqual(expect.arrayContaining(['src/**/*.{ts,tsx}', 'scripts/**/*.ts']));
    expect(web?.exclude).toEqual(['**/*.test.{ts,tsx}']);
    expect(infra?.include).toEqual(
      expect.arrayContaining(['lib/**/*.ts', 'bin/**/*.ts', 'functions/**/*.js', 'test/support/**/*.ts']),
    );
    expect(infra?.exclude).toBeUndefined();
  });
});

describe('Dependabot', () => {
  it('updates the pinned GitHub Actions', () => {
    type Update = {
      'package-ecosystem': string;
      directory?: string;
      directories?: string[];
      'open-pull-requests-limit'?: number;
      ignore?: { 'dependency-name'?: string; versions?: unknown; 'update-types'?: unknown }[];
    };
    const config = parse(read('.github/dependabot.yml')) as { version: number; updates: Update[] };
    expect(config.version).toBe(2);
    const actions = config.updates.filter((update) => update['package-ecosystem'] === 'github-actions');
    // "/" is where Dependabot finds .github/workflows.
    expect(actions.flatMap((update) => [update.directory, ...(update.directories ?? [])])).toContain('/');
    for (const update of actions) {
      // A limit of 0 turns version updates off, and so does ignoring a dependency outright.
      expect(update['open-pull-requests-limit']).not.toBe(0);
      const outright = update.ignore?.filter((rule) => rule.versions === undefined && rule['update-types'] === undefined);
      expect(outright ?? []).toEqual([]);
    }
  });
});

describe('Node version', () => {
  it('shares one engines range that accepts the newest release of the .nvmrc line', () => {
    const [web, infra] = ['package.json', 'infra/package.json'].map(
      (path) => readJson<{ engines?: { node?: string } }>(path).engines?.node,
    );
    expect(web).toEqual(expect.any(String));
    expect(infra).toBe(web);
    const nvmrc = read('.nvmrc').trim();
    expect(nvmrc).toMatch(/^v?\d+(?:\.\d+){0,2}$/);
    expect(acceptsNewest(web!, nvmrc), `${nvmrc} vs ${web}`).toBe(true);
  });
});

describe('npm settings', () => {
  const packages = ['', 'infra/'];

  it('never run dependency install scripts, and npx never downloads a missing package', () => {
    // A nested package does not inherit the root .npmrc.
    for (const dir of packages) expect(read(`${dir}.npmrc`), `${dir}.npmrc`).toBe('ignore-scripts=true\nyes=false\n');
  });

  it('leave no lifecycle script that ignore-scripts would silently skip', () => {
    // npm runs these on install, and a pre/post hook around any script it runs; ignore-scripts skips them all.
    const lifecycle = ['install', 'prepare', 'prepublish', 'dependencies'];
    for (const dir of packages) {
      const { scripts = {} } = readJson<{ scripts?: Record<string, string> }>(`${dir}package.json`);
      const hooks = Object.keys(scripts).filter((name) => {
        const event = /^(?:pre|post)(.+)$/.exec(name)?.[1];
        return lifecycle.includes(name) || (event !== undefined && (event in scripts || lifecycle.includes(event)));
      });
      expect(hooks, `${dir}package.json`).toEqual([]);
    }
  });

  it('are not overridden in any workflow', () => {
    for (const { file, text } of workflows) {
      // --ignore-scripts=false, --no-ignore-scripts, npm_config_ignore_scripts, and npm rebuild would run them.
      expect(text.match(/ignore[-_]scripts|\bnpm\s+(?:rebuild|rb)\b/gi) ?? [], file).toEqual([]);
    }
  });
});

describe('lockfiles', () => {
  type Entry = {
    name?: string;
    version?: string;
    resolved?: string;
    integrity?: string;
    inBundle?: boolean;
    hasInstallScript?: boolean;
  };

  it.each([
    ['package-lock.json', ['node_modules/fsevents']],
    ['infra/package-lock.json', ['node_modules/esbuild', 'node_modules/fsevents']],
  ])('%s adds no package with an install script beyond the reviewed ones', (path, reviewed) => {
    // Install scripts never run here (see .npmrc), so a new package that needs one may not work as installed.
    const { packages } = readJson<{ packages: Record<string, Entry> }>(path);
    expect(Object.keys(packages).filter((key) => packages[key]!.hasInstallScript)).toEqual(reviewed);
  });

  it.each(['package-lock.json', 'infra/package-lock.json'])(
    '%s installs each package from its own npm registry tarball, with a sha512 hash',
    (path) => {
      const lock = readJson<{ lockfileVersion: number; packages: Record<string, Entry> }>(path);
      expect(lock.lockfileVersion).toBe(3);
      // "" is the project itself; bundled packages ship inside their parent's tarball.
      const fetched = Object.entries(lock.packages).filter(
        ([key, entry]) => key !== '' && !(entry.inBundle && entry.resolved === undefined),
      );
      expect(fetched).not.toHaveLength(0);
      // The install path names the package, unless an npm: alias records its real name.
      const tarball = (key: string, { name = key.split('node_modules/').pop()!, version }: Entry) =>
        `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`;
      const misplaced = fetched.filter(([key, entry]) => entry.resolved !== tarball(key, entry));
      const unhashed = fetched.filter(([, entry]) => !entry.integrity?.startsWith('sha512-'));
      expect(misplaced.map(([key, entry]) => `${key} ${entry.resolved}`)).toEqual([]);
      expect(unhashed.map(([key]) => key)).toEqual([]);
    },
  );
});

describe('.gitignore', () => {
  it('ignores build output, dependencies, coverage reports, and env files', () => {
    const paths = [
      'dist/index.html',
      'dist-ssr/entry-server.js',
      'infra/cdk.out/manifest.json',
      'node_modules/vite/package.json',
      'infra/node_modules/aws-cdk-lib/package.json',
      'coverage/index.html',
      'infra/coverage/index.html',
      '.env',
      '.env.local',
      'infra/.env',
    ];
    // --verbose names the deciding rule (a negation starts with !); --non-matching prints "::" for the rest.
    // Exit status 1 means no path matched, which the checks below report path by path.
    const output = git(['check-ignore', '--verbose', '--non-matching', '--no-index', ...paths], [0, 1]);
    // Each line reads "<source>:<line>:<pattern>\t<path>".
    const rules = new Map(output.map((line) => line.split('\t').reverse() as [string, string]));
    for (const path of paths) {
      expect(rules.get(path) ?? '', path).toMatch(/^\.gitignore:\d+:[^!]/);
    }
  });

  it('tracks no file that it ignores', () => {
    // A rule does not untrack a file committed before it or with git add -f.
    // Only the repo's own .gitignore files count, not a developer's global excludes.
    expect(git(['ls-files', '--cached', '--ignored', '--exclude-per-directory=.gitignore'])).toEqual([]);
  });
});

describe('crawler files', () => {
  it('robots.txt points at the sitemap on the site origin', () => {
    const sitemaps = read('public/robots.txt')
      .split(/\r?\n/)
      .flatMap((line) => /^\s*sitemap\s*:\s*(\S+)/i.exec(line)?.[1] ?? []);
    expect(sitemaps).toEqual([new URL('/sitemap.xml', site.origin).href]);
  });

  it('robots.txt lets crawlers in general fetch the site root', () => {
    // A group is a run of User-agent lines and the rules after it; "*" is for crawlers without a group of their own.
    let agents: string[] = [];
    let inRules = false;
    const blocking: string[] = [];
    for (const line of read('public/robots.txt').split(/\r?\n/)) {
      const [, field = '', value = ''] = /^\s*([\w-]+)\s*:\s*([^#\s]*)/.exec(line) ?? [];
      if (/^user-agent$/i.test(field)) {
        agents = inRules ? [value] : [...agents, value];
        inRules = false;
      } else if (/^(?:allow|disallow)$/i.test(field)) {
        inRules = true;
        // A rule's path matches as a prefix, where * matches anything and a final $ ends the match.
        const pattern = new RegExp(`^${value.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}`);
        if (/^disallow$/i.test(field) && value !== '' && agents.includes('*') && pattern.test('/')) blocking.push(line);
      }
    }
    expect(blocking).toEqual([]);
  });

  it('sitemap.xml is well-formed XML listing exactly the origin root', () => {
    const ns = 'http://www.sitemaps.org/schemas/sitemap/0.9';
    const { window } = new JSDOM();
    try {
      const sitemap = new window.DOMParser().parseFromString(read('public/sitemap.xml'), 'application/xml');
      expect(sitemap.querySelector('parsererror')?.textContent).toBeUndefined();
      expect([sitemap.documentElement.namespaceURI, sitemap.documentElement.localName]).toEqual([ns, 'urlset']);
      const urls = Array.from(sitemap.getElementsByTagNameNS(ns, 'url'), (url) =>
        url.getElementsByTagNameNS(ns, 'loc')[0]?.textContent?.trim(),
      );
      expect(urls).toEqual([new URL('/', site.origin).href]);
    } finally {
      window.close();
    }
  });
});
