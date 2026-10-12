import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { resolveConfig } from 'vite';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { site } from '../src/content.ts';
import { files, git, read, readJson, root, tsc } from './support/repo.ts';

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
  'runs-on'?: unknown;
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
// The parts of a Vitest config these checks read.
type VitestConfig = {
  test?: {
    include?: string[];
    passWithNoTests?: boolean;
    coverage?: { include?: string[]; exclude?: string[]; thresholds?: unknown };
  };
};

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

// Every key and string value in a parsed workflow value, at any depth. Expressions are read from these rather than
// from JSON text, which escapes a tab or newline before a name as \t or \n and so hides the name from \b.
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)]);
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

// A package's tsconfig files: solution files, and the projects tsc checks. A solution file ("files": [] plus
// "references") checks nothing itself; it lets editors find the projects.
function tsconfigs(dir: string) {
  const configs = readdirSync(new URL(dir, root)).filter((file) => /^tsconfig\b.*\.json$/.test(file));
  const solutions = configs.filter((file) => {
    const { files: roots, references, ...rest } = readJson<Record<string, unknown>>(`${dir}${file}`);
    return isDeepStrictEqual(roots, []) && references !== undefined && Object.keys(rest).length === 0;
  });
  return { solutions, projects: configs.filter((file) => !solutions.includes(file)) };
}

// Without --config, Vitest loads the first of these it finds in a package.
const vitestConfigFiles = ['vitest.config', 'vite.config'].flatMap((name) =>
  ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'].map((extension) => name + extension),
);

// The test settings of the config Vitest loads in a package. A computed specifier keeps tsc from checking
// infra's config against the root package's dependencies.
async function vitestSettings(dir: string) {
  const file = vitestConfigFiles.find((name) => existsSync(new URL(dir + name, root)));
  const { default: config } = (await import(new URL(`${dir}${file}`, root).href)) as { default: VitestConfig };
  return config.test ?? {};
}

// Whether an engines range accepts a Node version. Parts the version leaves out are unbounded, so .nvmrc's "24"
// stands for the newest 24.x release, which a fresh install of that line gets.
// As in npm, a partial bound stands for its whole line: >24 means >=25.0.0, and <=24.11 means <24.12.0.
function accepts(range: string, version: string) {
  const target = [0, 1, 2].map((i) => Number(version.replace(/^v/, '').split('.')[i] ?? Infinity));
  const compare = (other: number[]) =>
    Math.sign(target.map((part, i) => part - other[i]!).find((diff) => diff !== 0) ?? 0);
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
      // A YAML alias reuses its anchor's object, whose one uses: line the scan already sees.
      const declared = new Set(
        Object.values(workflow.jobs).flatMap((job): (Job | Step)[] => [job, ...(job.steps ?? [])]),
      );
      expect(found.map(({ ref }) => ref), file).toEqual([...declared].flatMap(({ uses }) => uses ?? []));
      return found.map(({ ref, comment }) => `${ref} ${comment}`.trim());
    });
    expect(lines).not.toHaveLength(0);
    expect(lines.filter((line) => !pinned.test(line))).toEqual([]);

    // Copies of a pin agree: a commit keeps one version label and a label one commit. Whether a label names its
    // commit's release cannot be checked offline; compare it with the upstream tag whenever a pin changes.
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

  it('grant the token only contents: read, and an OIDC token only to production deploys', () => {
    for (const { file, workflow } of workflows) expect(workflow.permissions, file).toEqual({ contents: 'read' });
    for (const { where, workflow, job } of jobs) {
      const grants =
        typeof job.permissions === 'string'
          ? [job.permissions]
          : Object.entries(job.permissions ?? {}).map(([scope, access]) => `${scope}: ${access}`);
      // A job's permissions replace the workflow's, so read-all or any other read scope would widen its token.
      const allowed = ['contents: read', ...(deploysToProduction(workflow, job) ? ['id-token: write'] : [])];
      expect(grants.filter((grant) => !allowed.includes(grant) && !grant.endsWith(': none')), where).toEqual([]);
    }
  });

  it('run every job on a GitHub-hosted Ubuntu runner', () => {
    // A self-hosted or CodeBuild runner can hold an AWS role and lends it to every job it runs, PR code included.
    const hosted = /^ubuntu-(?:slim|(?:latest|\d+\.\d+)(?:-arm)?)$/;
    const others = jobs.filter(({ job }) => typeof job['runs-on'] !== 'string' || !hosted.test(job['runs-on']));
    expect(others.map(({ where, job }) => `${where}: ${JSON.stringify(job['runs-on'])}`)).toEqual([]);
  });

  it('obtain AWS credentials only in production deploys, never from secrets, variables, or access keys', () => {
    const configured = steps.filter(
      ({ workflow, job, step }) =>
        actionName(step.uses) === 'aws-actions/configure-aws-credentials' && !deploysToProduction(workflow, job),
    );
    expect(configured.map(({ where }) => where)).toEqual([]);
    for (const { file, text, workflow } of workflows) {
      // Every ${{ }} expression, plus "secrets:" keys such as "secrets: inherit".
      const references = [
        ...strings(workflow).flatMap(expressions),
        ...(JSON.stringify(workflow).match(/"secrets":[^,}]*/g) ?? []),
      ];
      expect(references.filter((reference) => /\bsecrets\b/i.test(reference)), file).toEqual([]);
      expect(text.match(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g) ?? [], file).toEqual([]);
    }
    // Variables are stored as plain text; only a production deploy may read one, such as its role ARN.
    const outsideDeploys = [
      ...workflows.map(({ file, workflow }) => ({ where: file, settings: { ...workflow, jobs: {} } })),
      ...jobs
        .filter(({ workflow, job }) => !deploysToProduction(workflow, job))
        .map(({ where, job }) => ({ where, settings: job })),
    ];
    const readingVariables = outsideDeploys.filter(({ settings }) =>
      strings(settings)
        .flatMap(expressions)
        .some((expression) => /\bvars\b/i.test(expression)),
    );
    expect(readingVariables.map(({ where }) => where)).toEqual([]);
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
      // A "!" pattern drops the branches it matches from those before it, so [main, "!m*"] never runs for main.
      expect([branches ?? []].flat().filter((branch) => branch.startsWith('!')), event).toEqual([]);
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
      const { solutions, projects } = tsconfigs(dir);
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

  it('typechecks every TypeScript file strictly', () => {
    // strict only sets these flags' defaults (tsc --all lists each as "true, unless strict is false"), so a project
    // can still turn one off.
    const strictFamily = [
      'noImplicitAny',
      'noImplicitThis',
      'strictBindCallApply',
      'strictBuiltinIteratorReturn',
      'strictFunctionTypes',
      'strictNullChecks',
      'strictPropertyInitialization',
      'useUnknownInCatchVariables',
    ];
    for (const dir of ['', 'infra/']) {
      const checked = tsconfigs(dir).projects.flatMap((project) => {
        // --showConfig resolves each project's root files and the options it sets, including inherited ones.
        const config = JSON.parse(tsc(['-p', `${dir}${project}`, '--showConfig'])) as {
          compilerOptions: Record<string, unknown>;
          files: string[];
        };
        // noCheck turns type checking off while the tsc command stays the same; "noCheck": false is the default.
        const { strict, noEmit, noCheck } = config.compilerOptions;
        expect({ strict, noEmit, noCheck: noCheck === true }, `${dir}${project}`).toEqual({
          strict: true,
          noEmit: true,
          noCheck: false,
        });
        expect(strictFamily.filter((flag) => config.compilerOptions[flag] === false), `${dir}${project}`).toEqual([]);
        return config.files.map((file) => posix.join(dir, file));
      });
      // Vitest, Vite, and Node only strip types, so a file that no project includes is never type-checked.
      const sources = files(['ts', 'tsx', 'mts', 'cts'].map((extension) => `${dir}*.${extension}`)).filter(
        (file) => dir !== '' || !file.startsWith('infra/'),
      );
      // An empty list would pass, as when git takes pathspecs literally (GIT_LITERAL_PATHSPECS=1).
      expect(sources, dir).not.toHaveLength(0);
      expect(sources.filter((file) => !checked.includes(file)), `${dir}tsconfig*.json`).toEqual([]);
    }
  });

  it("typechecks the web package without reading infra's files", () => {
    // Imports in infra's files resolve to infra/node_modules where it is installed, but to the root's packages in
    // CI's web job, so the same typecheck could pass locally and fail in CI.
    const infra = fileURLToPath(new URL('infra/', root));
    const inInfra = (file: string) => !relative(infra, file).startsWith('..') && !isAbsolute(relative(infra, file));
    for (const project of tsconfigs('').projects) {
      const program = tsc(['-p', project, '--listFilesOnly']).split(/\r?\n/).filter(Boolean);
      expect(program.filter(inInfra), project).toEqual([]);
    }
  });

  it('builds, prerenders, and checks the site with fixed commands', () => {
    const { scripts } = readJson<{ scripts: Record<string, string | undefined> }>('package.json');
    // CI runs both by name, so another body, or "|| true", would leave the prerendered pages unchecked.
    expect(scripts.build).toBe(
      'vite build && vite build --ssr src/entry-server.tsx --outDir dist-ssr && node scripts/prerender.ts',
    );
    expect(scripts['check:dist']).toBe('node scripts/check-dist.ts');
  });

  it('lets the Vite config set no client output name without a content hash', async () => {
    // check:dist cannot tell a dropped [hash] from a name ending in a long word, such as three-renderer.js, and Vite's
    // own names all have one. Resolving the config as vite build does also covers a config function, client-only
    // environment options, and the deprecated rollupOptions; web workers take their names from the worker options.
    const config = await resolveConfig({ root: fileURLToPath(root), logLevel: 'silent' }, 'build', 'production');
    const outputs = [config.environments.client!.build.rolldownOptions.output, config.worker.rolldownOptions.output];
    const names = outputs.flat().flatMap((output) =>
      (['entryFileNames', 'chunkFileNames', 'assetFileNames'] as const).map((option) => [option, output?.[option]] as const),
    );
    // A function can return any name, so only a pattern with [hash] passes.
    const hashed = (name: unknown) => typeof name === 'string' && /\[hash(?::\d+)?\]/.test(name);
    expect(names.filter(([, name]) => name !== undefined && !hashed(name))).toEqual([]);
  });

  it('runs every test file in each package', async () => {
    // Other settings, such as exclude, changed, dir, or projects, can leave test files unrun.
    const allowed = ['include', 'environment', 'testTimeout', 'passWithNoTests', 'coverage'];
    for (const [dir, tests, required] of [
      ['', 'tests/', ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts', 'tests/**/*.test.ts']],
      ['infra/', 'test/', ['test/**/*.test.ts']],
    ] as const) {
      const settings = await vitestSettings(dir);
      expect(Object.keys(settings).filter((key) => !allowed.includes(key)), dir).toEqual([]);
      // More test files may run, but none may drop out; a "!" glob drops the files it matches.
      expect(settings.include, dir).toEqual(expect.arrayContaining([...required]));
      expect(settings.include?.filter((glob) => glob.startsWith('!')), dir).toEqual([]);
      // On CI's clean checkout, changed selects no tests and turns passWithNoTests on unless it is set to false.
      expect(settings.passWithNoTests, dir).toBe(false);
      // Coverage does not notice a suite that stops running, such as one renamed to *.spec.ts. Only script files
      // count, so an OS or editor file there, such as .DS_Store, does not.
      const unrun = readdirSync(new URL(dir + tests, root), { withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name))
        .map(({ name }) => tests + name)
        .filter((file) => !settings.include?.some((glob) => posix.matchesGlob(file, glob)));
      expect(unrun, dir).toEqual([]);
    }
    // These suites run the template checks on the synthesized stacks; the 100% gate passes without them.
    for (const suite of ['guardrails', 'environment']) {
      expect(existsSync(new URL(`infra/test/${suite}.test.ts`, root)), suite).toBe(true);
    }
  });

  it("requires 100% coverage of each package's source", async () => {
    const web = (await vitestSettings('')).coverage;
    const infra = (await vitestSettings('infra/')).coverage;
    // Any other key, such as a per-glob threshold, could lower the bar for some files.
    expect(web?.thresholds).toEqual({ 100: true });
    expect(infra?.thresholds).toEqual({ 100: true });
    // More files may be measured, but none may drop out. tests/support is this suite's own code, so measuring it
    // also fails the gate if this suite stops running.
    expect(web?.include).toEqual(
      expect.arrayContaining([
        'src/**/*.{ts,tsx}',
        'scripts/**/*.ts',
        'src/**/*.{mts,cts,js,jsx,mjs,cjs}',
        'scripts/**/*.{tsx,mts,cts,js,jsx,mjs,cjs}',
        'tests/support/**/*.ts',
      ]),
    );
    expect(web?.exclude).toEqual(['**/*.test.{ts,tsx}']);
    expect(infra?.include).toEqual(
      expect.arrayContaining(['lib/**/*.ts', 'bin/**/*.ts', 'functions/**/*.js', 'test/support/**/*.ts']),
    );
    expect(infra?.exclude).toBeUndefined();
    // A "!" glob drops the files it matches, and other options, such as changed, can measure fewer files.
    const allowed = ['provider', 'include', 'exclude', 'reporter', 'thresholds'];
    for (const [dir, coverage] of [['', web], ['infra/', infra]] as const) {
      expect(coverage?.include?.filter((glob) => glob.startsWith('!')), dir).toEqual([]);
      expect(Object.keys(coverage ?? {}).filter((key) => !allowed.includes(key)), dir).toEqual([]);
    }
  });

  it('lets no source file opt out of type checking or coverage', () => {
    // Coverage-ignore hints (istanbul, c8, v8, or node:coverage, then "ignore") pass untested code at 100%, even
    // inside a string; the ts-nocheck pragma skips a file's type check (its name is split so this file passes).
    const optOut = new RegExp(String.raw`(?:istanbul|[cv]8|node:coverage)\s+ignore\b|@ts-${'no'}check`, 'i');
    const sources = files(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'].map((extension) => `*.${extension}`));
    // The scan must reach both packages' sources: an empty list would pass, as when git takes pathspecs literally.
    expect(sources).toEqual(expect.arrayContaining(['src/content.ts', 'infra/functions/viewer-request.js']));
    expect(sources.filter((file) => optOut.test(read(file)))).toEqual([]);
  });
});

describe('Dependabot', () => {
  it('updates every pinned GitHub Action on main', () => {
    type Update = { 'package-ecosystem': string; directory?: string; directories?: string[]; [key: string]: unknown };
    const config = parse(read('.github/dependabot.yml')) as { version: number; updates: Update[] };
    expect(config.version).toBe(2);
    const actions = config.updates.filter((update) => update['package-ecosystem'] === 'github-actions');
    // "/" is where Dependabot finds .github/workflows.
    expect(actions.flatMap((update) => [update.directory, ...(update.directories ?? [])])).toContain('/');
    // SHA-pinned actions get no Dependabot alerts, so these PRs are how their fixes arrive. allow, ignore,
    // exclude-paths, and target-branch can each keep some updates off main; these options only time and shape PRs.
    const shaping = [
      'package-ecosystem',
      'directory',
      'directories',
      'schedule',
      'cooldown',
      'open-pull-requests-limit',
      'groups',
      'commit-message',
      'labels',
      'assignees',
    ];
    for (const update of actions) {
      expect(Object.keys(update).filter((key) => !shaping.includes(key))).toEqual([]);
      // A limit of 0 turns version updates off; the default is 5.
      expect(update['open-pull-requests-limit'] ?? 5).toBeGreaterThan(0);
    }
  });
});

describe('Node version', () => {
  it('shares one engines range that accepts the newest release of the .nvmrc line and the Node running', () => {
    const [web, infra] = ['package.json', 'infra/package.json'].map(
      (path) => readJson<{ engines?: { node?: string } }>(path).engines?.node,
    );
    expect(web).toEqual(expect.any(String));
    expect(infra).toBe(web);
    const nvmrc = read('.nvmrc').trim();
    expect(nvmrc).toMatch(/^v?\d+(?:\.\d+){0,2}$/);
    expect(accepts(web!, nvmrc), `${nvmrc} vs ${web}`).toBe(true);
    // CI's setup-node takes the newest matching release cached on the runner, which can trail the newest release.
    expect(accepts(web!, process.version), `${process.version} vs ${web}`).toBe(true);
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
      // The install path names the package. A name field marks an npm: alias, which neither package uses, and
      // trusting one would let an entry fetch another package's tarball.
      const tarball = (key: string, version?: string) => {
        const name = key.split('node_modules/').pop()!;
        return `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`;
      };
      const misplaced = fetched.filter(([key, entry]) => entry.resolved !== tarball(key, entry.version));
      const unhashed = fetched.filter(([, entry]) => !entry.integrity?.startsWith('sha512-'));
      expect(misplaced.map(([key, entry]) => `${key} ${entry.resolved}`)).toEqual([]);
      expect(unhashed.map(([key]) => key)).toEqual([]);
    },
  );

  it('have no npm-shrinkwrap.json beside them, which npm would install from instead', () => {
    for (const dir of ['', 'infra/']) expect(existsSync(new URL(`${dir}npm-shrinkwrap.json`, root)), dir).toBe(false);
  });
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
    // Each line reads "<source>:<line>:<pattern>\t<path>". Any of the repo's own .gitignore files may decide, but
    // not .git/info/exclude or a developer's global excludes.
    const rules = new Map(output.map((line) => line.split('\t').reverse() as [string, string]));
    const sources = git(['ls-files', '--', '.gitignore', ':(glob)**/.gitignore']);
    for (const path of paths) {
      const [, source = '', pattern = ''] = /^(.*?):\d+:(.*)$/.exec(rules.get(path) ?? '') ?? [];
      expect(sources.includes(source) && !pattern.startsWith('!'), `${path}: ${rules.get(path)}`).toBe(true);
    }
  });

  it('tracks no file that it ignores', () => {
    // A rule does not untrack a file committed before it or with git add -f.
    // Only the repo's own .gitignore files count, not a developer's global excludes.
    expect(git(['ls-files', '--cached', '--ignored', '--exclude-per-directory=.gitignore'])).toEqual([]);
  });
});

describe('crawler files', () => {
  it('robots.txt lets every crawler fetch the whole site and points at the sitemap on the site origin', () => {
    // Pinned whole: Google also obeys misspelled keys, missing colons, and a Googlebot-only group.
    const sitemap = new URL('/sitemap.xml', site.origin).href;
    expect(read('public/robots.txt')).toBe(`User-agent: *\nAllow: /\n\nSitemap: ${sitemap}\n`);
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
