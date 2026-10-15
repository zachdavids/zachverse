import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { resolveConfig } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { ASSETS, RECORDS } from '../scripts/release-lib.ts';
import { site } from '../src/content.ts';
import { files, git, read, readJson, root, tsc, vitestFiles } from './support/repo.ts';

// jsdom ships no type declarations; these checks only need its window's DOMParser.
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new () => { window: typeof globalThis };
};

type Filter = { branches?: string[]; tags?: string[]; types?: string[]; [key: string]: unknown };
type Defaults = { run?: { shell?: string; 'working-directory'?: string } };
type Conditions = { if?: unknown; 'continue-on-error'?: unknown };
// An empty "with:" or "env:" parses as null.
type Mapping = Record<string, unknown> | null;
// GitHub also takes an env written as one ${{ }} expression.
type Environment = Mapping | string;
type Step = Conditions & {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  shell?: string;
  with?: Mapping;
  env?: Environment;
  'working-directory'?: string;
};
type Job = Conditions & {
  uses?: string;
  needs?: unknown;
  'runs-on'?: unknown;
  environment?: string | { name?: string };
  // A call to a reusable workflow takes inputs.
  with?: Mapping;
  container?: string | { env?: Environment };
  env?: Environment;
  steps?: Step[];
  permissions?: string | Record<string, string>;
  defaults?: Defaults;
  concurrency?: unknown;
  outputs?: Record<string, string>;
};
type Workflow = {
  on?: string | string[] | Record<string, Filter | null>;
  permissions?: unknown;
  defaults?: Defaults;
  env?: Environment;
  concurrency?: unknown;
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
const deploy = workflows.find(({ file }) => /^deploy\.ya?ml$/.test(file))?.workflow;
const restoreWorkflow = workflows.find(({ file }) => /^restore\.ya?ml$/.test(file))?.workflow;

// The checks CI's web job runs, which the deploy workflow's build job runs too: these before it uploads the site, and
// the browser check after, since Playwright downloads Chromium checking nothing but its size (ADR 0006).
const WEB_CHECKS = [
  'actions/checkout',
  'actions/setup-node',
  'npm ci',
  'npm run typecheck',
  'npm run test:coverage',
  'npm run build',
  'npm run check:dist',
];
const BROWSER_CHECK = ['npx playwright install --with-deps --only-shell chromium', 'npm run check:browser'];
const WEB_STEPS = [...WEB_CHECKS, ...BROWSER_CHECK];

// The browser job's installs, retried: the release it checks is already live, and a failed install would roll it back.
const NPM_CI_RETRIED = [
  'for attempt in 1 2 3; do',
  '  npm ci && exit 0',
  '  echo "::warning::Installing packages failed (attempt $attempt of 3)."',
  '  if [ "$attempt" -lt 3 ]; then sleep 30; fi',
  'done',
  'exit 1',
].join('\n');
const INSTALL_RETRIED = [
  'for attempt in 1 2 3; do',
  '  npx playwright install --with-deps --only-shell chromium && exit 0',
  '  echo "::warning::Installing Chromium failed (attempt $attempt of 3)."',
  '  if [ "$attempt" -lt 3 ]; then sleep 30; fi',
  'done',
  'exit 1',
].join('\n');

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

// Where a job could get long-lived AWS keys rather than assume a role through OIDC: an AWS key name anywhere in its
// workflow's or its own settings, such as configure-aws-credentials' aws-access-key-id input, the AWS_ACCESS_KEY_ID
// variable the AWS CLI and SDKs read, or a run script's aws configure set or $GITHUB_ENV write. A production deploy
// may read variables, which could hold keys. Names match in any case, with _, - or nothing between their words, and
// any mention fails, so an OIDC job must not name them either. An env, with: or container written as one expression
// is reported too, since only GitHub sees what it sets. A script or action can still take keys under other names
// (aws configure import, a credentials file, docker/login-action's password for ECR), so review what a deploy does
// with each variable.
function keySettings(list: typeof jobs) {
  const keyName = /aws[_-]?(?:access[_-]?key[_-]?id|secret[_-]?access[_-]?key|session[_-]?token)/gi;
  return list.flatMap(({ where, workflow, job }) => {
    const container = typeof job.container === 'string' ? undefined : job.container?.env;
    const steps = job.steps ?? [];
    const found = [...strings({ ...workflow, jobs: {} }), ...strings(job)].flatMap((text) => text.match(keyName) ?? []);
    const settings: [string, unknown[]][] = [
      ['env', [workflow.env, job.env, container, ...steps.map((step) => step.env)]],
      ['with', steps.map((step) => step.with)],
      ['container', [job.container]],
    ];
    for (const [kind, values] of settings) {
      if (values.some((value) => typeof value === 'string' && value.includes('${{'))) found.push(`${kind} expression`);
    }
    // Each name is reported once per job.
    return [...new Set(found)].map((name) => `${where}: ${name}`);
  });
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

// The code a step runs, which GitHub writes expressions into before it runs: its run: script, or the script input of
// actions/github-script, which runs as JavaScript. Other actions that run an input as code are not recognized.
function script(step: Step) {
  const input = actionName(step.uses) === 'actions/github-script' ? step.with?.script : undefined;
  return step.run ?? (typeof input === 'string' ? input : undefined);
}

// A job's steps as action names or "<dir>: <command>" (no prefix at the repo root) plus any shell
// override, marked optional when they may be skipped or may fail without failing the job.
function plan(workflow: Workflow | undefined, jobId: string) {
  const job = workflow?.jobs[jobId];
  const defaults = { ...workflow?.defaults?.run, ...job?.defaults?.run };
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
function expectRequiredSteps(workflow: Workflow | undefined, file: string, jobId: string, required: string[]) {
  expect(workflow?.jobs[jobId], `${file} job ${jobId}`).toBeDefined();
  // A job is skipped when one it needs is skipped or fails, and GitHub reports a skipped job as passing.
  expect(workflow?.jobs[jobId]?.needs, `${file} job ${jobId} needs`).toBeUndefined();
  const all = plan(workflow, jobId);
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

// The paths that should run as tests but are missing from their package's Vitest list (infra/ files belong to infra,
// the rest to the root). These are names with .test or .spec in any case, followed by anything but a letter (so not
// .testing) or by nothing, such as a suite renamed to *.spec.ts, *.test.ts.disabled, *.test, *.test-disabled.txt, or
// *.test_disabled, except Vitest's .snap files; and script files directly in tests/ or infra/test/, but not an OS or
// editor file there, such as .DS_Store.
function unrunTests(paths: string[], listed: { root: string[]; infra: string[] }) {
  return paths.filter((path) => {
    const named =
      /\.(?:test|spec)(?![a-z])/i.test(posix.basename(path)) && !/(?:^|\/)__snapshots__\/[^/]+\.snap$/.test(path);
    const script = /^(?:tests|infra\/test)\/[^/]+$/.test(path) && /\.[cm]?[jt]sx?$/i.test(path);
    return (named || script) && !(path.startsWith('infra/') ? listed.infra : listed.root).includes(path);
  });
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

  it('obtain AWS credentials only in production deploys, never from secrets or key settings, and read variables only there', () => {
    const configured = steps.filter(
      ({ workflow, job, step }) =>
        actionName(step.uses) === 'aws-actions/configure-aws-credentials' && !deploysToProduction(workflow, job),
    );
    expect(configured.map(({ where }) => where)).toEqual([]);
    expect(keySettings(jobs)).toEqual([]);
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

  it('counts an AWS key setting in a job, its steps and its workflow, but not an OIDC role', () => {
    const configure = 'aws-actions/configure-aws-credentials@0123456789abcdef0123456789abcdef01234567';
    const key = '${{ vars.KEY }}';
    const workflow: Workflow = { jobs: {} };
    const ls = { run: 'aws s3 ls' };
    const list: typeof jobs = [
      // A role assumed through OIDC, other AWS settings, a container named only by its image, and an empty with: pass.
      {
        where: 'oidc',
        workflow: { env: { AWS_REGION: 'us-east-1' }, jobs: {} },
        job: {
          container: 'node:24',
          steps: [
            { uses: configure, with: { 'role-to-assume': key, 'aws-region': 'us-east-1' } },
            { uses: configure, with: null },
            { run: 'aws s3 sync dist s3://bucket' },
          ],
        },
      },
      // Key inputs to any action, in any case, with -, _ or nothing between the words.
      { where: 'inputs', workflow, job: { steps: [{ uses: configure, with: { 'aws-access-key-id': key } }] } },
      { where: 'inputs', workflow, job: { steps: [{ uses: configure, with: { 'AWS-Session-Token': key } }] } },
      {
        where: 'other action',
        workflow,
        job: { steps: [{ uses: 'example/s3-sync@v1', with: { aws_secret_access_key: key } }] },
      },
      { where: 'reusable workflow', workflow, job: { uses: './.github/workflows/sync.yml', with: { awsAccessKeyId: key } } },
      // Key variables set for the workflow, a job (shared by its steps), its container, or a step. A name the job
      // repeats is reported once.
      { where: 'workflow env', workflow: { env: { AWS_ACCESS_KEY_ID: key }, jobs: {} }, job: { steps: [ls] } },
      {
        where: 'job env',
        workflow,
        job: { env: { AWS_SECRET_ACCESS_KEY: key }, steps: [{ ...ls, env: { AWS_SECRET_ACCESS_KEY: key } }] },
      },
      { where: 'container env', workflow, job: { container: { env: { AWS_SESSION_TOKEN: key } }, steps: [ls] } },
      { where: 'step env', workflow, job: { steps: [{ ...ls, env: { PROD_AWS_ACCESS_KEY_ID: key } }] } },
      // Any other workflow setting, such as a dispatch input.
      {
        where: 'dispatch input',
        workflow: { on: { workflow_dispatch: { inputs: { 'aws-secret-access-key': { required: true } } } }, jobs: {} },
        job: { steps: [ls] },
      },
      // Run scripts that hand keys to the AWS CLI or to later steps; each name a script holds counts.
      {
        where: 'configure',
        workflow,
        job: {
          steps: [{ run: `aws configure set aws_access_key_id ${key} && aws configure set aws_secret_access_key ${key}` }],
        },
      },
      { where: 'GITHUB_ENV', workflow, job: { steps: [{ run: `echo "AWS_SESSION_TOKEN=${key}" >> "$GITHUB_ENV"` }] } },
      { where: 'export', workflow, job: { env: { DEPLOY: key }, steps: [{ run: 'export AWS_ACCESS_KEY_ID="$DEPLOY"' }] } },
      // An env written as one expression, at each level, and a with: or container written as one.
      { where: 'expression', workflow: { env: '${{ fromJSON(vars.ENV) }}', jobs: {} }, job: { steps: [ls] } },
      { where: 'expression', workflow, job: { env: '${{ fromJSON(vars.ENV) }}', steps: [ls] } },
      { where: 'expression', workflow, job: { container: { env: '${{ fromJSON(vars.ENV) }}' }, steps: [ls] } },
      { where: 'expression', workflow, job: { steps: [{ ...ls, env: '${{ fromJSON(vars.ENV) }}' }] } },
      // Step inputs are typed as a mapping, which is all the other checks read.
      {
        where: 'expression',
        workflow,
        job: { steps: [{ uses: configure, with: '${{ fromJSON(vars.IN) }}' as unknown as Mapping }] },
      },
      { where: 'expression', workflow, job: { container: '${{ fromJSON(vars.CONTAINER) }}', steps: [ls] } },
    ];
    expect(keySettings(list)).toEqual([
      'inputs: aws-access-key-id',
      'inputs: AWS-Session-Token',
      'other action: aws_secret_access_key',
      'reusable workflow: awsAccessKeyId',
      'workflow env: AWS_ACCESS_KEY_ID',
      'job env: AWS_SECRET_ACCESS_KEY',
      'container env: AWS_SESSION_TOKEN',
      'step env: AWS_ACCESS_KEY_ID',
      'dispatch input: aws-secret-access-key',
      'configure: aws_access_key_id',
      'configure: aws_secret_access_key',
      'GITHUB_ENV: AWS_SESSION_TOKEN',
      'export: AWS_ACCESS_KEY_ID',
      'expression: env expression',
      'expression: env expression',
      'expression: env expression',
      'expression: env expression',
      'expression: with expression',
      'expression: container expression',
    ]);
  });

  it('pass values to scripts through env, never as expressions inside a script', () => {
    // GitHub pastes an expression's value into the script before the shell or github-script reads it, so the value
    // could run as code.
    const pasted = steps.filter(({ step }) => script(step)?.includes('${{'));
    expect(pasted.map(({ where, step }) => `${where}: ${step.name ?? step.uses ?? step.run}`)).toEqual([]);
  });

  it("counts an expression in a run: script or github-script's script, but not one passed through env", () => {
    const githubScript = 'Actions/GitHub-Script@0123456789abcdef0123456789abcdef01234567';
    const message = '${{ github.event.head_commit.message }}';
    const list: Step[] = [
      { run: `echo "${message}"` },
      { uses: githubScript, with: { script: `core.info("${message}")` } },
      { run: 'echo "$MESSAGE"', env: { MESSAGE: message } },
      { uses: githubScript, env: { MESSAGE: message }, with: { script: 'core.info(process.env.MESSAGE)' } },
      // Other inputs are not code.
      { uses: 'actions/upload-artifact@0123456789abcdef0123456789abcdef01234567', with: { name: message } },
    ];
    expect(list.map((step) => script(step)?.includes('${{') ?? false)).toEqual([true, true, false, false, false]);
  });

  it('use only plain steps, each finished before the next starts', () => {
    // These checks read a job's steps as one list in which each step finishes before the next starts. A background:
    // step lets later steps start first, a cancel: step can stop one before it finishes, and parallel: nests steps
    // these checks never read. GitHub may add more, so any key not listed here fails until these checks model it.
    const modeled = [
      'id',
      'name',
      'if',
      'continue-on-error',
      'timeout-minutes',
      'uses',
      'with',
      'run',
      'shell',
      'working-directory',
      'env',
    ];
    const unmodeled = steps.flatMap(({ where, step }) => {
      // Each step either uses an action or runs a script.
      const kinds = ['uses', 'run'].filter((key) => key in step);
      return [
        ...Object.keys(step)
          .filter((key) => !modeled.includes(key))
          .map((key) => `${where}: ${key}`),
        ...(kinds.length === 1 ? [] : [`${where}: ${kinds.join(' and ') || 'neither uses nor run'}`]),
      ];
    });
    expect(unmodeled).toEqual([]);
  });

  it("check out the run's own commit without persisting the token", () => {
    const checkouts = steps.filter(({ step }) => actionName(step.uses) === 'actions/checkout');
    expect(checkouts).not.toHaveLength(0);
    // A ref or repository input would check out code other than the commit the run's checks report on.
    for (const { where, step } of checkouts) expect(step.with, where).toEqual({ 'persist-credentials': false });
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
    expectRequiredSteps(ci, 'ci.yml', 'web', WEB_STEPS);
  });

  it('runs infra install, typecheck, and coverage in infra as separate required steps in order', () => {
    expectRequiredSteps(ci, 'ci.yml', 'infra', [
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
      // The list must reach nested files: git matches none when it takes pathspecs literally
      // (GIT_LITERAL_PATHSPECS=1), and a * stops at / when it takes them as globs (GIT_GLOB_PATHSPECS=1).
      expect(sources, dir).toContain(dir === '' ? 'src/content.ts' : 'infra/lib/config.ts');
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
    expect(scripts['check:browser']).toBe('node scripts/browser-check.ts local dist');
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
    for (const [dir, required] of [
      ['', ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts', 'tests/**/*.test.ts']],
      ['infra/', ['test/**/*.test.ts']],
    ] as const) {
      const settings = await vitestSettings(dir);
      expect(Object.keys(settings).filter((key) => !allowed.includes(key)), dir).toEqual([]);
      // More test files may run, but none may drop out; a "!" glob drops the files it matches.
      expect(settings.include, dir).toEqual(expect.arrayContaining([...required]));
      expect(settings.include?.filter((glob) => glob.startsWith('!')), dir).toEqual([]);
      // On CI's clean checkout, changed selects no tests and turns passWithNoTests on unless it is set to false.
      expect(settings.passWithNoTests, dir).toBe(false);
    }
    // Coverage does not notice a suite that stops running, so Vitest itself lists the files it runs. Its globs match
    // case-sensitively on every OS, unlike path.matchesGlob on Windows and macOS.
    const listed = { root: vitestFiles(''), infra: vitestFiles('infra/') };
    const all = files([]);
    // An empty list would pass. The guard names no test file, so a renamed suite fails the next check, which names
    // it, rather than this one, which prints every file.
    expect(all).toEqual(expect.arrayContaining(['package.json', 'infra/package.json']));
    expect(unrunTests(all, listed)).toEqual([]);
    // These suites run the template checks on the synthesized stacks; the 100% gate passes without them. Vitest
    // lists names as stored, so a Guardrails.Test.ts that existsSync would find on NTFS or APFS does not count.
    expect(listed.infra).toEqual(
      expect.arrayContaining(['infra/test/guardrails.test.ts', 'infra/test/environment.test.ts']),
    );
  });

  it('counts a file named as a test, or a script directly in a test directory, as unrun unless Vitest lists it', () => {
    // An infra suite in the root package's list does not count, and a listed tests/x.test.ts does not cover its case
    // variant tests/x.Test.ts, which Vitest skips on every OS.
    const listed = {
      root: ['src/App.test.tsx', 'tests/x.test.ts', 'infra/test/checks.test.ts'],
      infra: ['infra/test/guardrails.test.ts'],
    };
    const paths = [
      ...listed.root,
      ...listed.infra,
      'tests/x.Test.ts',
      'src/App.Test.tsx',
      'src/App.spec.tsx',
      'infra/test/cdk-json.test.ts.disabled',
      'infra/test/cdk-json.test',
      'infra/test/cdk-json.test-disabled.txt',
      'infra/test/cdk-json.test_disabled',
      'src/App.test2.tsx',
      'src/render.testing.tsx',
      'tests/helper.ts',
      'infra/test/helper.TS',
      'tests/support/repo.ts',
      'tests/.DS_Store',
      'infra/test/.DS_Store',
      'src/__snapshots__/App.test.tsx.snap',
      'src/__snapshots__/x.test.ts',
    ];
    expect(unrunTests(paths, listed)).toEqual([
      'infra/test/checks.test.ts',
      'tests/x.Test.ts',
      'src/App.Test.tsx',
      'src/App.spec.tsx',
      'infra/test/cdk-json.test.ts.disabled',
      'infra/test/cdk-json.test',
      'infra/test/cdk-json.test-disabled.txt',
      'infra/test/cdk-json.test_disabled',
      'src/App.test2.tsx',
      'tests/helper.ts',
      'infra/test/helper.TS',
      'src/__snapshots__/x.test.ts',
    ]);
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

// The deploy build job's first step, and the restore job's: it stops any ref but main before anything else runs.
const MAIN_ONLY = /^if \[ "\$GITHUB_REF" != refs\/heads\/main \]; then\n {2}echo "::error::.*"\n {2}exit 1\nfi\n$/;

// A step's or job's env as a mapping; one written as an expression, which the workflow rules reject, reads as empty.
const envOf = (item?: { env?: Environment }) =>
  (item?.env && typeof item.env === 'object' ? item.env : {}) as Record<string, unknown>;

// A step as the action it uses, the node command it runs, or "run" for any other script.
const kind = (step: Step) =>
  step.uses !== undefined ? actionName(step.uses) : /^node \S/.test(step.run?.trim() ?? '') ? step.run!.trim() : 'run';

// Whether a concurrency setting could put a run in the deploy and restore group, deploy-refs/heads/main. GitHub compares
// group names without case, and an expression can evaluate to anything, so only a group that starts with a literal
// other than "deploy" stays out.
function mayJoinDeployGroup(concurrency: unknown): boolean {
  const group = typeof concurrency === 'string' ? concurrency : (concurrency as { group?: unknown } | null)?.group;
  return typeof group !== 'string' || !/^[a-z0-9_.]/i.test(group) || /^deploy/i.test(group);
}

// A job that runs the release scripts: it checks them out and installs Node, but no packages.
function expectReleaseTools(job: Job | undefined, where: string) {
  const list = job?.steps ?? [];
  const setups = list.filter((step) => actionName(step.uses) === 'actions/setup-node');
  expect(setups.map((step) => step.with), where).toEqual([{ 'node-version-file': '.nvmrc', 'package-manager-cache': false }]);
  expect(list.filter((step) => actionName(step.uses) === 'actions/checkout'), where).toHaveLength(1);
  expect(list.filter((step) => /\b(?:npm|npx|yarn|pnpm|corepack)\b/.test(step.run ?? '')).map(kind), where).toEqual([]);
}

// The smoke test reaches the custom hostnames through the distribution whose hostname the access check read.
function expectSmokeTestThroughDistribution(job: Job | undefined) {
  const list = job?.steps ?? [];
  const access = list.find((step) => step.name === "Check the deploy role's access (read-only)");
  expect(access?.id).toBe('access');
  expect(access?.run).toContain('echo "domain=$domain" >> "$GITHUB_OUTPUT"');
  const smokes = list.filter((step) => step.run?.trim().startsWith('node scripts/smoke.ts '));
  expect(smokes).not.toHaveLength(0);
  for (const smoke of smokes) expect(smoke.env).toEqual({ CLOUDFRONT_DOMAIN: '${{ steps.access.outputs.domain }}' });
}

// A job in the production environment that assumes the deploy role through OIDC, and nothing else, for a session long
// enough for the job's steps.
function expectDeployRole(job: Job | undefined, session: string, seconds: number) {
  expect(job?.environment).toBe('production');
  // contents: read for the checkout and the deploy job's comparison of commits; no other scope.
  expect(job?.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
  // Only the settings these checks read: a container would run every step in an image no pin covers, with the role's
  // credentials; services or a matrix would run more beside or in parallel; a shell could hide a failed step. Each
  // job's own tests pin its condition and outputs.
  const allowed = [
    'name',
    'needs',
    'if',
    'runs-on',
    'timeout-minutes',
    'environment',
    'permissions',
    'defaults',
    'outputs',
    'env',
    'steps',
  ];
  expect(Object.keys(job ?? {}).filter((key) => !allowed.includes(key))).toEqual([]);
  expect(job?.defaults).toEqual({ run: { shell: 'bash' } });
  const list = job?.steps ?? [];
  expect(list.filter((step) => step.shell !== undefined).map(kind)).toEqual([]);
  const configured = list.filter((step) => actionName(step.uses) === 'aws-actions/configure-aws-credentials');
  expect(configured.map((step) => step.with)).toEqual([
    {
      'role-to-assume': '${{ vars.AWS_SITE_DEPLOY_ROLE_ARN }}',
      'aws-region': 'us-east-1',
      'allowed-account-ids': '${{ vars.AWS_ACCOUNT_ID }}',
      'role-session-name': `${session}\${{ github.run_id }}-\${{ github.run_attempt }}`,
      'role-duration-seconds': seconds,
      'translate-env-variables': false,
    },
  ]);
}

describe('Deploy workflow', () => {
  const build = deploy?.jobs.build;
  const job = deploy?.jobs.deploy;
  const browser = deploy?.jobs.browser;
  const verify = deploy?.jobs.verify;
  // The positions of a job's steps that use an action.
  const positions = (list: Step[], action: string) =>
    list.flatMap((step, index) => (actionName(step.uses) === action ? [index] : []));
  // A job's steps that run only under a condition, or may fail without failing the job, with their conditions.
  const conditional = (list: Step[]) =>
    list.filter((step) => step.if !== undefined || step['continue-on-error'] !== undefined).map((step) => [step.name, step.if]);

  it('runs on pushes to main and by hand: build, deploy, a browser check, then verify or roll back', () => {
    // By hand, it can also publish over a restore, which otherwise holds deploys (ADR 0006).
    expect(deploy ? triggers(deploy) : undefined).toEqual({
      push: { branches: ['main'] },
      workflow_dispatch: {
        inputs: { resume: { description: expect.any(String), required: false, default: false, type: 'boolean' } },
      },
    });
    expect(Object.keys(deploy?.jobs ?? {})).toEqual(['build', 'deploy', 'browser', 'verify']);
    expect([job?.needs].flat()).toEqual(['build']);
    expect([browser?.needs].flat()).toEqual(['deploy']);
    expect([verify?.needs].flat()).toEqual(['deploy', 'browser']);
    // Only verify has a condition: it runs whenever the deploy job ran, so it can roll back what that job published,
    // even when the job timed out, which GitHub can report as cancelled; but not after the run was cancelled.
    expect(Object.entries(deploy?.jobs ?? {}).filter(([, each]) => each.if !== undefined)).toEqual([
      ['verify', expect.anything()],
    ]);
    expect(verify?.if).toBe("${{ !cancelled() && needs.deploy.result != 'skipped' }}");
    expect(Object.values(deploy?.jobs ?? {}).filter((each) => each['continue-on-error'] !== undefined)).toEqual([]);
  });

  it("leaves the deploy role to its deploy and verify jobs and the Restore workflow's restore job", () => {
    // The role's trust names the environment and main, not a workflow, and the rules for every workflow let any
    // production deploy request an OIDC token, so one in another workflow would skip these jobs' checks and order.
    expect(jobs.filter(({ workflow, job }) => deploysToProduction(workflow, job)).map(({ where }) => where)).toEqual([
      'deploy.yml deploy',
      'deploy.yml verify',
      'restore.yml restore',
    ]);
  });

  it('runs one deploy or restore at a time for main, never cancelling one in progress', () => {
    // A group on the deploy job alone would order deploys by when each build finished, so an earlier push could often
    // deploy last. At the workflow level only the order in which runs reach the group counts, which GitHub does not
    // promise is push order (ADR 0005), so publishing refuses an older release (ADR 0006). The Restore workflow joins
    // the same group, which is shared across workflows, so a restore and a deploy never publish at once.
    for (const each of [deploy, restoreWorkflow]) {
      expect(each?.concurrency).toEqual({ group: 'deploy-${{ github.ref }}', 'cancel-in-progress': false });
      expect(Object.values(each?.jobs ?? {}).filter((other) => other.concurrency !== undefined)).toEqual([]);
    }
  });

  it('lets no other workflow, and no job, join that group', () => {
    // Another run in the group could replace a waiting deploy or restore or, with cancel-in-progress, stop one partway
    // through publishing (ADR 0006, "Limits").
    const settings = [
      ...workflows
        .filter(({ file }) => !/^(?:deploy|restore)\.ya?ml$/.test(file))
        .map(({ file, workflow }) => ({ where: file, concurrency: workflow.concurrency })),
      ...jobs.map(({ where, job }) => ({ where, concurrency: job.concurrency })),
    ];
    expect(
      settings.filter(({ concurrency }) => concurrency !== undefined && mayJoinDeployGroup(concurrency)).map(({ where }) => where),
    ).toEqual([]);
    // CI keeps a group of its own.
    expect(mayJoinDeployGroup(ci?.concurrency)).toBe(false);
  });

  it('counts a group that names deploy in any case, or starts with an expression, as one that may join it', () => {
    const groups = [
      'deploy-${{ github.ref }}',
      { group: 'Deploy-${{ github.ref }}' },
      { group: 'DEPLOY' },
      { group: '${{ github.workflow }}-${{ github.ref }}' },
      { group: ' deploy' },
      { group: 5 },
      null,
      { group: 'ci-${{ github.ref }}' },
      'pages',
      { group: 'deployments-preview' },
    ];
    expect(groups.map(mayJoinDeployGroup)).toEqual([true, true, true, true, true, true, true, false, false, true]);
  });

  it('stops any ref but main, then builds and checks the site as CI does, and in a browser once it is uploaded', () => {
    // The production environment and the role's trust also refuse other refs; this stops them before the build.
    const [first] = build?.steps ?? [];
    expect(first?.run).toMatch(MAIN_ONLY);
    expectRequiredSteps(deploy, 'deploy.yml', 'build', [...WEB_CHECKS, 'actions/upload-artifact', ...BROWSER_CHECK]);
    expect(plan(deploy, 'build').filter((step) => step.endsWith(' (optional)'))).toEqual([]);
    // No environment, so no AWS access or variables, and no dependency cache.
    expect(build?.environment).toBeUndefined();
    const [setup] = positions(build?.steps ?? [], 'actions/setup-node').map((index) => build!.steps![index]);
    expect(setup?.with).toEqual({ 'node-version-file': '.nvmrc', 'package-manager-cache': false });
    // The pages name the commit they are built from, and the browser check and check:dist require them to (ADR 0006).
    const named = (build?.steps ?? []).filter((step) => envOf(step).RELEASE_COMMIT !== undefined);
    expect(named.map((step) => [step.run?.trim(), envOf(step).RELEASE_COMMIT])).toEqual([
      ['npm run build', '${{ github.sha }}'],
      ['npm run check:dist', '${{ github.sha }}'],
      ['npm run check:browser', '${{ github.sha }}'],
    ]);
  });

  it('uploads every file of the checked build right after the check, hidden ones included, with a digest of them all', () => {
    const list = build?.steps ?? [];
    const [upload] = positions(list, 'actions/upload-artifact');
    expect(list[upload!]?.with).toEqual({
      name: 'site',
      path: 'dist/',
      'if-no-files-found': 'error',
      'include-hidden-files': true,
      overwrite: true,
    });
    const record = list.findIndex((step) => step.id === 'digest');
    const checked = list.findIndex((step) => step.run?.trim() === 'npm run check:dist');
    expect(checked, 'npm run check:dist').toBeGreaterThanOrEqual(0);
    // Only the digest runs between the check and the upload: a step there could change dist/ after the check, and the
    // digest, taken after that step, would cover the change.
    expect([record, upload], plan(deploy, 'build').join(' | ')).toEqual([checked + 1, checked + 2]);
    expect(list[record]?.['working-directory']).toBe('dist');
    expect(build?.outputs).toEqual({ digest: '${{ steps.digest.outputs.digest }}' });
  });

  it("publishes only the uploaded files, checked against the build job's digest before AWS credentials exist", () => {
    const list = job?.steps ?? [];
    // Every step of this job can request its OIDC token, so it runs only these, in this order, and all of them.
    expect(list.map(kind)).toEqual([
      'run', // the variables check
      'actions/checkout',
      'actions/setup-node',
      'actions/download-artifact',
      'run', // the digest check
      'aws-actions/configure-aws-credentials',
      'run', // the access check
      'node scripts/release.ts publish site',
      'node scripts/smoke.ts site',
    ]);
    const [download] = positions(list, 'actions/download-artifact');
    const [configure] = positions(list, 'aws-actions/configure-aws-credentials');
    // download-artifact also fails when the archive's digest differs from the one recorded at upload.
    expect(list[download!]?.with).toEqual({ name: 'site', path: 'site' });
    const check = list.findIndex((step) => step['working-directory'] === 'site');
    expect(download! < check && check < configure!, `${download} < ${check} < ${configure}`).toBe(true);
    // The same command computes the digest in both jobs.
    const command = (step?: Step) => step?.run?.trim().split('\n')[0];
    expect(command(list[check])).toBe(command(build?.steps?.find((step) => step.id === 'digest')));
    expect(command(list[check])).toMatch(/^digest=\$\(find \. -type f /);
    expect(list[check]?.run).toMatch(/\nif \[ "\$digest" != "\$DIGEST" \]; then\n {2}echo "::error::.*"\n {2}exit 1\nfi\n$/);
    expect(envOf(job).DIGEST).toBe('${{ needs.build.outputs.digest }}');
    expect(conditional(list)).toEqual([]);
    expectReleaseTools(job, 'deploy.yml deploy');
    // The order check compares commits through GitHub's API with the job's read-only token; the smoke test connects
    // through the distribution whose hostname the access check read, which the browser job gets as an output.
    const publish = list.find((step) => step.run?.trim() === 'node scripts/release.ts publish site');
    expect(publish?.env).toEqual({ GITHUB_TOKEN: '${{ github.token }}', RESUME_DEPLOYS: '${{ inputs.resume }}' });
    expectSmokeTestThroughDistribution(job);
    expect(job?.outputs).toEqual({ domain: '${{ steps.access.outputs.domain }}' });
  });

  it('checks the live release in a browser in a job that has no environment, variables, or OIDC token', () => {
    // This job installs packages, Playwright and its browser among them, which no job that holds the role may do.
    expect(browser?.environment).toBeUndefined();
    expect(browser?.permissions).toBeUndefined();
    expect(browser?.env).toBeUndefined();
    expect((browser?.steps ?? []).map(kind)).toEqual([
      'actions/checkout',
      'actions/setup-node',
      'run', // npm ci, retried
      'run', // the browser, retried
      'node scripts/browser-check.ts live',
    ]);
    expect(plan(deploy, 'browser').slice(2, 4)).toEqual([NPM_CI_RETRIED, INSTALL_RETRIED]);
    expect(conditional(browser?.steps ?? [])).toEqual([]);
    // Nothing it produces reaches the role jobs but its result.
    expect(browser?.outputs).toBeUndefined();
    const [setup] = positions(browser?.steps ?? [], 'actions/setup-node').map((index) => browser!.steps![index]);
    expect(setup?.with).toEqual({ 'node-version-file': '.nvmrc', 'package-manager-cache': false });
    // It checks the site at its own hostname, connected to the distribution the deploy job published to, and the
    // release this run published.
    expect(browser?.steps?.at(-1)?.env).toEqual({
      CLOUDFRONT_DOMAIN: '${{ needs.deploy.outputs.domain }}',
      RELEASE_COMMIT: '${{ github.sha }}',
    });
  });

  it('records the release as verified only after both checks passed, and otherwise rolls back and fails', () => {
    const list = verify?.steps ?? [];
    expect(list.map(kind)).toEqual([
      'run', // the variables check
      'actions/checkout',
      'actions/setup-node',
      'aws-actions/configure-aws-credentials',
      'run', // the access check
      'node scripts/release.ts verified',
      'node scripts/release.ts rollback rolled-back',
      'node scripts/smoke.ts rolled-back',
      'node scripts/release.ts verified',
      'run', // the failure
    ]);
    // The checks before the role are the deploy job's own, so the two cannot drift apart.
    const deploySteps = job?.steps ?? [];
    for (const name of ["Check the environment's variables", "Check the deploy role's access (read-only)"]) {
      const run = (steps: Step[]) => steps.find((step) => step.name === name)?.run;
      expect(run(list), name).toBeDefined();
      expect(run(list), name).toBe(run(deploySteps));
    }
    // A rolled-back release counts as verified only when its own smoke test passed, and the run fails whenever the
    // release was not verified. Without a status function, GitHub adds success() to each condition, so a failed
    // rollback or smoke test stops the steps after it.
    expect(conditional(list)).toEqual([
      ['Record the release as verified', "needs.deploy.result == 'success' && needs.browser.result == 'success'"],
      ['Roll back to the last verified release', "needs.deploy.result != 'success' || needs.browser.result != 'success'"],
      ['Smoke-test the rolled-back release through CloudFront', "steps.rollback.outputs.release != ''"],
      ['Record the rolled-back release as verified', "steps.rollback_smoke.outcome == 'success'"],
      ['Fail the run, since the release was not verified', "needs.deploy.result != 'success' || needs.browser.result != 'success'"],
    ]);
    expect(list.map((step) => step.id).filter(Boolean)).toEqual(['access', 'rollback', 'rollback_smoke']);
    expect(list.at(-1)?.run).toMatch(/^echo "::error::.*"\nexit 1\n$/);
    expectReleaseTools(verify, 'deploy.yml verify');
    expectSmokeTestThroughDistribution(verify);
  });

  it('assumes only the deploy role, through OIDC, in the production environment', () => {
    expectDeployRole(job, 'zachverse-deploy-', 1800);
    expectDeployRole(verify, 'zachverse-verify-', 1800);
  });

  it('reads only the four production variables, and lets no step set a variable the AWS tools read', () => {
    for (const [file, each, jobId] of [
      ['deploy.yml', deploy, 'deploy'],
      ['deploy.yml', deploy, 'verify'],
      ['restore.yml', restoreWorkflow, 'restore'],
    ] as const) {
      const where = `${file} ${jobId}`;
      const read = strings(each)
        .flatMap(expressions)
        // GitHub reads context names in any case; a read such as vars['NAME'] or toJSON(vars) counts as "vars".
        .flatMap((expression) =>
          [...expression.matchAll(/\bvars\b(?:\s*\.\s*(\w+))?/gi)].map((match) => match[1] ?? match[0]),
        );
      expect([...new Set(read)].sort(), where).toEqual([
        'AWS_ACCOUNT_ID',
        'AWS_SITE_DEPLOY_ROLE_ARN',
        'CLOUDFRONT_DISTRIBUTION_ID',
        'SITE_BUCKET',
      ]);
      // The AWS CLI and SDKs read variables such as AWS_ACCOUNT_ID or AWS_ENDPOINT_URL_STS beside the role's
      // credentials, and the credentials action reads HTTP_PROXY, so scripts get the values under other names.
      const roleJob = each?.jobs[jobId];
      const names = [each?.env, roleJob?.env, ...(roleJob?.steps ?? []).map((step) => step.env)].flatMap((env) =>
        env && typeof env === 'object' ? Object.keys(env) : [],
      );
      expect(names, where).toEqual(expect.arrayContaining(['ACCOUNT_ID', 'ROLE_ARN', 'BUCKET', 'DISTRIBUTION_ID']));
      // Nor a NODE_ variable: NODE_OPTIONS can load code into the release scripts, and NODE_TLS_REJECT_UNAUTHORIZED or
      // NODE_EXTRA_CA_CERTS changes which certificates they and the smoke test trust.
      expect(names.filter((name) => /^(?:aws_\w+|(?:https?|no|all)_proxy|node_\w+)$/i.test(name)), where).toEqual([]);
      // Nor may a script set one, for itself or, through $GITHUB_ENV or $GITHUB_PATH, for later steps, or write the
      // AWS CLI's config, whose endpoint_url the SDKs also read.
      const setting = /\b(?:aws_\w+|(?:https?|no|all)_proxy|node_\w+)(?:=|<<)|\bGITHUB_(?:ENV|PATH)\b|\baws\s+configure\b/i;
      const setters = (roleJob?.steps ?? []).filter((step) => setting.test(step.run ?? ''));
      expect(setters.map((step) => step.name ?? step.run), where).toEqual([]);
    }
  });
});

describe('Jobs with the deploy role', () => {
  const roleJobs = [
    {
      where: 'deploy.yml deploy',
      workflow: deploy,
      job: deploy?.jobs.deploy,
      env: {
        ACCOUNT_ID: '${{ vars.AWS_ACCOUNT_ID }}',
        ROLE_ARN: '${{ vars.AWS_SITE_DEPLOY_ROLE_ARN }}',
        BUCKET: '${{ vars.SITE_BUCKET }}',
        DISTRIBUTION_ID: '${{ vars.CLOUDFRONT_DISTRIBUTION_ID }}',
        DIGEST: '${{ needs.build.outputs.digest }}',
      },
      reads: ['${{ needs.build.outputs.digest }}', '${{ inputs.resume }}'],
    },
    {
      where: 'deploy.yml verify',
      workflow: deploy,
      job: deploy?.jobs.verify,
      env: {
        ACCOUNT_ID: '${{ vars.AWS_ACCOUNT_ID }}',
        ROLE_ARN: '${{ vars.AWS_SITE_DEPLOY_ROLE_ARN }}',
        BUCKET: '${{ vars.SITE_BUCKET }}',
        DISTRIBUTION_ID: '${{ vars.CLOUDFRONT_DISTRIBUTION_ID }}',
      },
      reads: [],
    },
    {
      where: 'restore.yml restore',
      workflow: restoreWorkflow,
      job: restoreWorkflow?.jobs.restore,
      env: {
        ACCOUNT_ID: '${{ vars.AWS_ACCOUNT_ID }}',
        ROLE_ARN: '${{ vars.AWS_SITE_DEPLOY_ROLE_ARN }}',
        BUCKET: '${{ vars.SITE_BUCKET }}',
        DISTRIBUTION_ID: '${{ vars.CLOUDFRONT_DISTRIBUTION_ID }}',
        RELEASE: '${{ inputs.release }}',
      },
      reads: ['${{ inputs.release }}'],
    },
  ];

  it('set their variables once, at the job, and no step sets one again', () => {
    for (const { where, job, env } of roleJobs) {
      expect(job?.env, where).toEqual(env);
      const again = (job?.steps ?? []).flatMap((step) => Object.keys(envOf(step)).filter((name) => name in env));
      expect(again, where).toEqual([]);
    }
  });

  // A job that runs packages, such as the browser job, could put anything in an output, and an input or the event is
  // whatever someone typed or pushed. A job with the role takes only the build's digest, which it checks the download
  // against, and its own input. The workflow's env reaches every job, so it counts too.
  it("read no job's outputs but the build's digest, no input but their own, and other jobs only for their results", () => {
    for (const { where, workflow, job, reads } of roleJobs) {
      const unexpected = strings([workflow?.env, job])
        .flatMap(expressions)
        .map((expression) => {
          let rest = expression;
          for (const read of reads) rest = rest.split(read).join('');
          // GitHub reads context names in any case.
          return rest.replace(/\bneeds\.[\w-]+\.result\b/gi, '');
        })
        // github is allowed only for a property other than its event: not whole, as in toJSON(github), nor by index.
        .filter((rest) => /\b(?:needs|inputs)\b|\bgithub\b(?!\s*\.\s*(?!event\b)\w)/i.test(rest));
      expect(unexpected, where).toEqual([]);
    }
  });
});

describe('Browser downloads', () => {
  // Playwright downloads Chromium from wherever these say, checking nothing but its size, and a proxy sees every request.
  // Playwright reads PLAYWRIGHT_ settings, and npm passes npm_config_ and npm_package_config_ ones through to npx;
  // any npm_config_ setting can also load an npmrc that holds them.
  it('are never redirected: no workflow sets a Playwright, npm config, or proxy variable, and package.json sets no config', () => {
    const named = /playwright[-_]|^npm_config_|^(?:https?|all|no|ftp)_proxy$/i;
    const assigned = /(?:playwright[-_][\w-]*|npm_config_\w+|(?:https?|all|no|ftp)_proxy)\s*(?:=|<<)/i;
    for (const { file, workflow } of workflows) {
      const envs = [workflow.env, ...Object.values(workflow.jobs ?? {}).flatMap((job) => [job.env, ...(job.steps ?? []).map((step) => step.env)])];
      const names = envs.flatMap((env) => (env && typeof env === 'object' ? Object.keys(env) : []));
      expect(names.filter((name) => named.test(name)), file).toEqual([]);
      const scripts = Object.values(workflow.jobs ?? {}).flatMap((job) => (job.steps ?? []).map((step) => step.run ?? ''));
      expect(scripts.filter((run) => assigned.test(run)), file).toEqual([]);
    }
    expect(readJson<Record<string, unknown>>('package.json').config).toBeUndefined();
  });
});

describe('Restore workflow', () => {
  const test = restoreWorkflow?.jobs.test;
  const job = restoreWorkflow?.jobs.restore;

  it('runs only by hand, restoring the release its one input names, after a test job', () => {
    // No default: the release is a commit SHA the person running it gives, fixed for the run and its re-runs.
    expect(restoreWorkflow ? triggers(restoreWorkflow) : undefined).toEqual({
      workflow_dispatch: { inputs: { release: { description: expect.any(String), required: true, type: 'string' } } },
    });
    expect(Object.keys(restoreWorkflow?.jobs ?? {})).toEqual(['test', 'restore']);
    expect([job?.needs].flat()).toEqual(['test']);
    // The input reaches the script through env, and the script checks it.
    expect(envOf(job).RELEASE).toBe('${{ inputs.release }}');
  });

  it("stops any ref but main, then tests the commit whose scripts the restore job runs, without the role", () => {
    const [first] = test?.steps ?? [];
    expect(first?.run).toMatch(MAIN_ONLY);
    expectRequiredSteps(restoreWorkflow, 'restore.yml', 'test', [
      'actions/checkout',
      'actions/setup-node',
      'npm ci',
      'npm run typecheck',
      'npm run test:coverage',
    ]);
    expect(plan(restoreWorkflow, 'test').filter((step) => step.endsWith(' (optional)'))).toEqual([]);
    expect(test?.environment).toBeUndefined();
    expect(test?.permissions).toBeUndefined();
  });

  it("runs the deploy job's checks before it restores, smoke-tests, and records the release", () => {
    const list = job?.steps ?? [];
    expect(list.map(kind)).toEqual([
      'run', // the variables check
      'actions/checkout',
      'actions/setup-node',
      'aws-actions/configure-aws-credentials',
      'run', // the access check
      'node scripts/release.ts restore "$RELEASE" restored',
      'node scripts/smoke.ts restored',
      'node scripts/release.ts verified',
    ]);
    // The deploy job's own checks, so the two jobs cannot drift apart.
    const deploySteps = deploy?.jobs.deploy?.steps ?? [];
    for (const name of ["Check the environment's variables", "Check the deploy role's access (read-only)"]) {
      const run = (list: Step[]) => list.find((step) => step.name === name)?.run;
      expect(run(list), name).toBeDefined();
      expect(run(list), name).toBe(run(deploySteps));
    }
    expect(plan(restoreWorkflow, 'restore').filter((step) => step.endsWith(' (optional)'))).toEqual([]);
    expectReleaseTools(job, 'restore.yml restore');
    expectSmokeTestThroughDistribution(job);
  });

  it('assumes only the deploy role, through OIDC, in the production environment', () => {
    expectDeployRole(job, 'zachverse-restore-', 1800);
  });
});

describe('Release and smoke-test scripts', () => {
  it("publish nothing unhashed under assets/: public/ has no assets/ directory, whose files Vite copies as they are", () => {
    // Publishing caches every file under assets/ as immutable for a year, trusting the content hash in its name, and
    // Vite's own output names carry one (see "lets the Vite config set no client output name without a content hash").
    expect(readdirSync(new URL('public/', root)).filter((name) => name.toLowerCase() === 'assets')).toEqual([]);
  });

  it('keep the release records under the prefix the bucket policy keeps CloudFront from reading', () => {
    // infra/lib/site-stack.ts denies CloudFront that prefix; records anywhere else would be served as part of the site.
    expect(read('infra/lib/site-stack.ts')).toContain(`export const RELEASE_RECORDS = '${RECORDS}';`);
  });

  it("keep the assets under the prefix whose objects the deploy role's policy keeps it from deleting", () => {
    // A release deletes the pages it lacks but never an asset, which an earlier page may still load (ADR 0006).
    expect(read('infra/lib/site-stack.ts')).toContain(`this.bucket.arnForObjects('${ASSETS}*')`);
  });

  it('check the site at the hostnames the distribution serves', () => {
    // The smoke test and the browser check reach site.origin; infra/lib/config.ts gives the distribution its aliases.
    const host = new URL(site.origin).host;
    const config = read('infra/lib/config.ts');
    expect(config).toContain(`domainName: '${host}',`);
    expect(config).toContain(`wwwDomainName: 'www.${host}',`);
  });

  // The deploy and restore jobs run them with the deploy role and install no packages: an import of a package would
  // fail there, and installing one would run its code beside the role's credentials. tsconfig.release.json gives tsc
  // the two entry points, with Node's types and no DOM, and tsc follows every import it can see: re-exports, type-only
  // imports, and dynamic ones with a literal specifier.
  const roleScripts = () => {
    const repo = fileURLToPath(root);
    const loaded = tsc(['-p', 'tsconfig.release.json', '--listFilesOnly'])
      .split(/\r?\n/)
      .filter(Boolean)
      .map((file) => relative(repo, file).split(sep).join('/'));
    // Node's types, and TypeScript's standard-library declarations, which TypeScript 7 keeps in a platform package.
    const libs = /^node_modules\/(?:(?:@types\/node|undici-types)\/|(?:typescript|@typescript\/typescript-[\w-]+)\/lib\/lib\.[\w.]+\.d\.ts$)/;
    return {
      packages: loaded.filter((file) => file.startsWith('node_modules/') && !libs.test(file)),
      own: loaded.filter((file) => !file.startsWith('node_modules/')).sort(),
    };
  };

  it("import only Node's built-in modules and the repository's own files", () => {
    const { packages, own } = roleScripts();
    expect(packages).toEqual([]);
    expect(own).toEqual([
      'scripts/release-aws.ts',
      'scripts/release-github.ts',
      'scripts/release-lib.ts',
      'scripts/release.ts',
      'scripts/smoke-http.ts',
      'scripts/smoke-lib.ts',
      'scripts/smoke.ts',
      'src/content.ts',
    ]);
    // What tsc cannot follow: require, createRequire, and an import whose specifier is computed.
    const unfollowed = /\brequire\s*\(|\bcreateRequire\b|\bimport\s*\(\s*(?!['"])/;
    expect(own.filter((file) => unfollowed.test(read(file)))).toEqual([]);
  });

  it('load under plain Node where no package can be found, as the jobs with the role run them', () => {
    // Their tests import them under Vitest, beside the installed packages, so this is the first plain load short of a
    // job that holds the role.
    const dir = mkdtempSync(join(tmpdir(), 'role-scripts-'));
    try {
      // The package.json the jobs run them under, and nothing readable outside dir, so no package above it is found.
      for (const file of [...roleScripts().own, 'package.json']) cpSync(fileURLToPath(new URL(file, root)), join(dir, file));
      for (const entry of ['release', 'smoke']) {
        const env = { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' };
        const args = ['--permission', `--allow-fs-read=${dir}`, join(dir, 'scripts', `${entry}.ts`)];
        const result = spawnSync(process.execPath, args, { encoding: 'utf8', env });
        expect({ status: result.status, stderr: result.stderr.trim() }, entry).toEqual({
          status: 1,
          stderr: expect.stringMatching(new RegExp(`^::error::Usage: node scripts/${entry}\\.ts `)),
        });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe('credentials', () => {
  // An AWS access key ID; a 40-character secret access key after a name ending in "secret key" or "secret access key"
  // (in any case, its words joined by _, -, or nothing), which may be quoted (escaped quotes included, as in
  // JSON-encoded text) or end a subscript, then :, =, =>, a comma, whitespace, or an XML tag's >, and the key with or
  // without quotes; or a private key.
  const patterns = [
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
    /secret[_-]?(?:access[_-]?)?key\\?['"`]?\]?(?:\s*(?:[:=]>?|,)|\s|>)\s*\\?['"`]?[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/i,
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY[A-Z ]*-----/,
  ];
  // UTF-16 text, which Windows PowerShell 5.1 writes with > or Out-File, reads as UTF-8 with a NUL beside each ASCII
  // character.
  const leaks = (text: string) => patterns.some((pattern) => pattern.test(text.replaceAll('\0', '')));

  it('appear in no file in the repository', () => {
    // Untracked files count too, since git add -A would commit them. With no pathspec, git lists every file
    // whatever its pathspec settings, but an empty list would still pass.
    const scanned = files([]);
    expect(scanned).toEqual(
      expect.arrayContaining(['src/content.ts', 'infra/lib/config.ts', 'docs/progress.md', 'infra/dns/README.md']),
    );
    // Only file names are reported, so a failing run does not copy the credential into the CI log.
    expect(scanned.filter((file) => leaks(read(file)))).toEqual([]);
  });

  it('are recognized as they are usually written', () => {
    // AWS's documented example keys, assembled here so that this file holds none of them.
    const keyId = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
    const secret = ['wJalrXUtnFEMI', 'K7MDENG', 'bPxRfiCYEXAMPLEKEY'].join('/');
    const begin = (label: string) => `-----BEGIN ${label}-----`;
    const written = [
      `export const accessKeyId = '${keyId}';`,
      `aws_access_key_id = ${keyId.replace('AKIA', 'ASIA')}`,
      `[default]\naws_secret_access_key = ${secret}\n`,
      `export AWS_SECRET_ACCESS_KEY="${secret}"`,
      `export PROD_AWS_SECRET_ACCESS_KEY=${secret}`,
      `TF_VAR_aws_secret_access_key=${secret}`,
      `AWS_SECRET_KEY=${secret}`,
      `secret_key = "${secret}"`,
      `\`secret_key\` = '${secret}'`,
      `{"SecretAccessKey": "${secret}"}`,
      `{'aws_secret_access_key': '${secret}'}`,
      // JSON-encoded text: a JSON string holding JSON, and a notebook cell's source line.
      `"{\\"SecretAccessKey\\": \\"${secret}\\"}"`,
      `"aws_secret_access_key=\\"${secret}\\"\\n",`,
      `<SecretAccessKey>${secret}</SecretAccessKey>`,
      `credentials: { secretAccessKey: '${secret}' }`,
      `prodSecretAccessKey: '${secret}'`,
      `secretAccessKey: \`${secret}\``,
      `:secret_access_key => '${secret}'`,
      `          aws-secret-access-key: ${secret}`,
      `aws configure set aws_secret_access_key ${secret}`,
      `--secret-access-key ${secret}`,
      `setx "AWS_SECRET_ACCESS_KEY" "${secret}"`,
      `os.environ['AWS_SECRET_ACCESS_KEY'] = '${secret}'`,
      `ENV["AWS_SECRET_ACCESS_KEY"] = "${secret}"`,
      `os.environ.setdefault('AWS_SECRET_ACCESS_KEY', '${secret}')`,
      `System.setProperty("aws.secretKey", "${secret}")`,
      `<entry key="aws.secretKey">${secret}</entry>`,
      // A UTF-16 file's text, as read.
      Buffer.from(`aws_access_key_id = ${keyId}\r\n`, 'utf16le').toString('utf8'),
      `${begin('PRIVATE KEY')}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n`,
      begin('RSA PRIVATE KEY'),
      begin('EC PRIVATE KEY'),
      begin('ENCRYPTED PRIVATE KEY'),
      begin('OPENSSH PRIVATE KEY'),
      begin('PGP PRIVATE KEY BLOCK'),
    ];
    expect(written.filter((text) => !leaks(text))).toEqual([]);
    // Naming or referencing a credential, a public key or certificate, or a value longer than an AWS key, such as a
    // Rails secret_key_base, does not match.
    const harmless = [
      'aws_secret_access_key = <your secret access key>',
      'secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY',
      'aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}',
      "os.environ['AWS_SECRET_ACCESS_KEY'] = os.environ['PROD_SECRET']",
      'setenv("AWS_SECRET_ACCESS_KEY", secretFromVault)',
      keyId.slice(0, -1),
      `${keyId}X`,
      `secretAccessKey: '${secret}ABCD'`,
      `secret_key_base: ${'0123456789abcdef'.repeat(8)}`,
      begin('PUBLIC KEY'),
      begin('CERTIFICATE'),
    ];
    expect(harmless.filter(leaks)).toEqual([]);
  });

  it('are looked for in untracked files git does not ignore', () => {
    // files() lists what the scan reads. Here it lists a scratch repository holding a tracked, an untracked, and an
    // ignored file. Its git sees none of this process's GIT_ variables, such as the GIT_DIR a git hook sets, which
    // would point it at this repo instead.
    const dir = mkdtempSync(join(tmpdir(), 'repo-files-'));
    try {
      for (const name of Object.keys(process.env).filter((key) => key.startsWith('GIT_'))) vi.stubEnv(name, undefined);
      // Only the .gitignore may ignore a file here, not a developer's excludes: no template copies in an info/exclude,
      // and an excludes file of the repository's own, which does not exist, replaces a global or XDG one.
      git(['-C', dir, 'init', '-q', '--template=']);
      git(['-C', dir, 'config', 'core.excludesFile', join(dir, '.git', 'no-excludes')]);
      writeFileSync(join(dir, '.gitignore'), 'ignored.ts\n');
      for (const file of ['tracked.ts', 'untracked.ts', 'ignored.ts']) writeFileSync(join(dir, file), '');
      // Staging needs no git identity, which CI lacks.
      git(['-C', dir, 'add', 'tracked.ts']);
      expect(files([], dir).sort()).toEqual(['.gitignore', 'tracked.ts', 'untracked.ts']);
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
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
