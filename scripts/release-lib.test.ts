import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type Cdn,
  checkOrder,
  type Context,
  describeFile,
  encodingFor,
  type Entry,
  IMMUTABLE,
  invalidationPaths,
  publish,
  readHistory,
  recordVerified,
  type Repository,
  restore,
  rollBack,
  REVALIDATE,
  servedPath,
  sha256,
  siteFiles,
  type Store,
} from './release-lib.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'release-lib-test-'));
  dirs.push(dir);
  return dir;
}

// A built site: two pages, two plain files, and two hashed assets.
function site(files: Record<string, string> = {}): string {
  const dir = tempDir();
  const all = {
    'index.html': '<!doctype html><title>Home</title><script src="/assets/index-AbCd1234.js"></script>',
    '404.html': '<!doctype html><title>Not found</title>',
    'robots.txt': 'User-agent: *\n',
    'favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'assets/index-AbCd1234.js': 'console.log(1);',
    'assets/index-EfGh5678.css': 'body{}',
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

interface StoredObject {
  body: Buffer;
  sha256: string;
  contentType: string;
  cacheControl: string;
}

// The bucket and the distribution in memory; every write, deletion, and invalidation is logged in order.
function fakes(
  initial: Map<string, StoredObject> = new Map(),
  relation: Awaited<ReturnType<Repository['compare']>> = 'ahead',
) {
  const objects = new Map(initial);
  const log: string[] = [];
  const messages: string[] = [];
  const compared: string[] = [];
  const store: Store = {
    async head(key) {
      const object = objects.get(key);
      return object && { sha256: object.sha256, contentType: object.contentType, cacheControl: object.cacheControl };
    },
    async read(key) {
      return objects.get(key)?.body;
    },
    async write(key, body, headers) {
      log.push(`write ${key}`);
      objects.set(key, { body, ...headers });
    },
    async list() {
      return [...objects.keys()];
    },
    async remove(key) {
      log.push(`remove ${key}`);
      objects.delete(key);
    },
  };
  const cdn: Cdn = {
    async invalidate(paths, reference) {
      log.push(`invalidate ${paths.join(' ')} (${reference})`);
    },
  };
  const repository: Repository = {
    async compare(base, head) {
      compared.push(`${base}...${head}`);
      return relation;
    },
  };
  let tick = 0;
  const context: Context = {
    store,
    cdn,
    run: '100-1',
    now: () => `2026-10-15T00:00:0${tick++}Z`,
    log: (message) => messages.push(message),
  };
  return { objects, log, messages, compared, store, repository, context };
}

const json = (value: unknown) => {
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  return { body, sha256: sha256(body), contentType: 'application/json', cacheControl: REVALIDATE };
};
const history = (entries: Entry[]) => ['_releases/history.json', json({ entries })] as const;
const historyOf = (objects: Map<string, StoredObject>) =>
  JSON.parse(objects.get('_releases/history.json')!.body.toString()) as { entries: Entry[] };
const entry = (release: string, extra: Partial<Entry> = {}): Entry => ({
  action: 'publish',
  release,
  run: '90-1',
  started: 'then',
  published: 'then',
  ...extra,
});

describe('describeFile', () => {
  it('gives hashed assets immutable caching and every other file revalidation, with a content type', () => {
    expect(describeFile('assets/index-AbCd1234.js', Buffer.from('x'))).toEqual({
      path: 'assets/index-AbCd1234.js',
      sha256: sha256(Buffer.from('x')),
      contentType: 'text/javascript; charset=utf-8',
      cacheControl: IMMUTABLE,
      body: Buffer.from('x'),
    });
    expect(describeFile('index.html', Buffer.from('<p>'))).toMatchObject({
      contentType: 'text/html; charset=utf-8',
      cacheControl: 'no-cache',
    });
    expect(describeFile('.well-known/security.txt', Buffer.from(''))).toMatchObject({ contentType: 'text/plain; charset=utf-8' });
    // Extensions match in any case.
    expect(describeFile('Logo.PNG', Buffer.from('')).contentType).toBe('image/png');
    expect(IMMUTABLE).toBe('public, max-age=31536000, immutable');
  });

  it('rejects a path CloudFront would need encoded, or with a dot segment', () => {
    for (const path of ['a b.html', 'café.html', 'x~1.txt', 'a%2Fb.txt', '/index.html', 'a//b.txt', '../x.txt', 'a/./b.txt']) {
      expect(() => describeFile(path, Buffer.from('')), path).toThrow(/a file's path may hold only/);
    }
  });

  it('rejects a file under the release records, an unhashed asset, and an unknown or missing extension', () => {
    expect(() => describeFile('_releases/history.json', Buffer.from(''))).toThrow(
      '_releases/history.json would overwrite the release records under _releases/.',
    );
    for (const path of ['assets/logo.svg', 'assets/index-AbCd12345.js', 'assets/index-AbCd123.js']) {
      expect(() => describeFile(path, Buffer.from('')), path).toThrow(
        `${path} has no content hash in its name, so it cannot be cached as immutable.`,
      );
    }
    expect(() => describeFile('notes.md', Buffer.from(''))).toThrow('notes.md has no content type');
    expect(() => describeFile('LICENSE', Buffer.from(''))).toThrow('LICENSE has no content type');
    // An inherited property is no content type.
    expect(() => describeFile('x.constructor', Buffer.from(''))).toThrow('x.constructor has no content type');
  });
});

describe('siteFiles', () => {
  it('lists every file under the directory, hidden ones included, in path order', () => {
    const dir = site({ '.well-known/security.txt': 'Contact: x' });
    expect(siteFiles(dir).map(({ path }) => path)).toEqual([
      '.well-known/security.txt',
      '404.html',
      'assets/index-AbCd1234.js',
      'assets/index-EfGh5678.css',
      'favicon.svg',
      'index.html',
      'robots.txt',
    ]);
    expect(siteFiles(dir).find(({ path }) => path === 'robots.txt')?.body.toString()).toBe('User-agent: *\n');
  });

  it('fails for a directory with no files', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'empty'));
    expect(() => siteFiles(dir)).toThrow(`${dir} has no files to release.`);
  });
});

describe('invalidationPaths', () => {
  it("lists each page's path, and the directory paths an index.html is requested by, but no asset", () => {
    expect(
      invalidationPaths([
        { path: 'index.html' },
        { path: '404.html' },
        { path: 'about/index.html' },
        { path: 'robots.txt' },
        { path: 'assets/index-AbCd1234.js' },
      ]),
    ).toEqual(['/', '/404.html', '/about', '/about/', '/about/index.html', '/index.html', '/robots.txt']);
  });
});

describe('checkOrder', () => {
  const repositoryAnswering = (relation: Awaited<ReturnType<Repository['compare']>>) => fakes(new Map(), relation);

  it('lets the first release through without asking GitHub', async () => {
    const { repository, compared } = repositoryAnswering('behind');
    await checkOrder([], A, repository);
    expect(compared).toEqual([]);
  });

  it('holds deploys after a restore even with no publish before it, as in a history edited by hand', async () => {
    const { repository, compared } = repositoryAnswering('ahead');
    await expect(checkOrder([entry(A, { action: 'restore' })], B, repository)).rejects.toThrow(
      `Not publishing ${B}: deploys are held, since run 90-1 restored ${A}.`,
    );
    expect(compared).toEqual([]);
  });

  it('lets a release newer than the newest one published through, compared with that one', async () => {
    const { repository, compared } = repositoryAnswering('ahead');
    await checkOrder([entry(A), entry(B, { run: '91-1' }), entry(A, { action: 'rollback', run: '92-1' })], C, repository);
    // Over a restore, only when the run asks to resume.
    await checkOrder([entry(A), entry(B, { run: '91-1' }), entry(A, { action: 'restore', run: '92-1' })], C, repository, true);
    expect(compared).toEqual([`${B}...${C}`, `${B}...${C}`]);
  });

  it('lets the release a run rolled back be published again, however many of its attempts rolled back', async () => {
    // As after re-running the failed jobs of a run whose first rollback never finished.
    const twice = [
      entry(A, { run: '10-1', verified: 'then' }),
      entry(B, { run: '20-1' }),
      entry(A, { action: 'rollback', run: '20-1', published: undefined }),
      entry(A, { action: 'rollback', run: '20-2', verified: 'then' }),
    ];
    await checkOrder(twice, B, repositoryAnswering('identical').repository);
  });

  it('lets the current release be published again, as a retry', async () => {
    await checkOrder([entry(A), entry(B)], B, repositoryAnswering('identical').repository);
  });

  it('refuses an older release, one on another line of history, and a release a restore has replaced', async () => {
    await expect(checkOrder([entry(B, { run: '91-1' })], A, repositoryAnswering('behind').repository)).rejects.toThrow(
      `Not publishing ${A}: it is older than ${B}, which run 91-1 published. Nothing was changed. Publish a newer commit, or go back to a verified release with the Restore workflow.`,
    );
    await expect(checkOrder([entry(B, { run: '91-1' })], A, repositoryAnswering('diverged').repository)).rejects.toThrow(
      `Not publishing ${A}: it and ${B}, which run 91-1 published, have diverged.`,
    );
    // A re-run of the deploy that a restore replaced meets the hold.
    const restored = [entry(A), entry(B, { run: '91-1' }), entry(A, { action: 'restore', run: '92-1' })];
    await expect(checkOrder(restored, B, repositoryAnswering('identical').repository)).rejects.toThrow(
      `Not publishing ${B}: deploys are held, since run 92-1 restored ${A}.`,
    );
    // The same release again, when the site has since gone back to another one some other way.
    const goneBack = [entry(B, { run: '91-1' }), entry(A, { action: 'rollback', run: '92-1' }), entry(C, { action: 'rollback', run: '93-1' })];
    await expect(checkOrder(goneBack, B, repositoryAnswering('identical').repository)).rejects.toThrow(
      `Not publishing ${B}: run 91-1 published it, and the site has since gone back to ${C}.`,
    );
  });
});

describe('publish', () => {
  it('writes a page below the root before the home page, which links to it', async () => {
    const { log, repository, context } = fakes();
    await publish(site({ 'about/index.html': '<!doctype html><title>About</title>' }), A, repository, context);
    const pages = log.filter((line) => /^write (?!_releases\/|assets\/)/.test(line));
    expect(pages).toEqual([
      'write favicon.svg',
      'write robots.txt',
      'write 404.html',
      'write about/index.html',
      'write index.html',
    ]);
  });

  it('uploads assets, then a copy of the release, then the pages with index.html last, then invalidates them', async () => {
    const { objects, log, compared, repository, context } = fakes();
    const outcome = await publish(site(), A, repository, context);

    expect(log).toEqual([
      'write assets/index-AbCd1234.js',
      'write assets/index-EfGh5678.css',
      `write _releases/${A}/site/404.html`,
      `write _releases/${A}/site/assets/index-AbCd1234.js`,
      `write _releases/${A}/site/assets/index-EfGh5678.css`,
      `write _releases/${A}/site/favicon.svg`,
      `write _releases/${A}/site/index.html`,
      `write _releases/${A}/site/robots.txt`,
      `write _releases/${A}/manifest.json`,
      'write _releases/history.json',
      'write favicon.svg',
      'write robots.txt',
      'write 404.html',
      'write index.html',
      `invalidate / /404.html /favicon.svg /index.html /robots.txt (100-1-publish-${A})`,
      'write _releases/history.json',
    ]);
    expect(outcome).toEqual({
      release: A,
      uploaded: ['assets/index-AbCd1234.js', 'assets/index-EfGh5678.css'],
      replaced: [],
      kept: [],
      removed: [],
      invalidated: ['/', '/404.html', '/favicon.svg', '/index.html', '/robots.txt'],
    });
    // The first release is compared with nothing.
    expect(compared).toEqual([]);
    expect(historyOf(objects)).toEqual({
      format: 1,
      entries: [
        { action: 'publish', release: A, run: '100-1', started: '2026-10-15T00:00:00Z', published: '2026-10-15T00:00:01Z' },
      ],
    });
    expect(objects.get('index.html')).toMatchObject({ contentType: 'text/html; charset=utf-8', cacheControl: 'no-cache' });
    expect(objects.get('assets/index-AbCd1234.js')).toMatchObject({ cacheControl: IMMUTABLE });
    const manifest = JSON.parse(objects.get(`_releases/${A}/manifest.json`)!.body.toString());
    expect(manifest.release).toBe(A);
    expect(manifest.files[0]).toEqual({
      path: '404.html',
      sha256: sha256(Buffer.from('<!doctype html><title>Not found</title>')),
      size: 39,
      contentType: 'text/html; charset=utf-8',
      cacheControl: 'no-cache',
    });
  });

  it('keeps assets already in place, and replaces and invalidates one whose checksum or headers differ', async () => {
    const dir = site();
    const files = new Map(siteFiles(dir).map((file) => [file.path, file]));
    const stored = (path: string, change: Partial<StoredObject> = {}) => {
      const { body, sha256: hash, contentType, cacheControl } = files.get(path)!;
      return [path, { body, sha256: hash, contentType, cacheControl, ...change }] as const;
    };
    for (const change of [{ sha256: 'f'.repeat(64) }, { contentType: 'text/plain' }, { cacheControl: 'no-cache' }]) {
      const { log, repository, context } = fakes(
        new Map([stored('assets/index-AbCd1234.js'), stored('assets/index-EfGh5678.css', change)]),
      );
      const { uploaded, replaced, kept, invalidated } = await publish(dir, A, repository, context);
      expect({ uploaded, replaced, kept }).toEqual({
        uploaded: [],
        replaced: ['assets/index-EfGh5678.css'],
        kept: ['assets/index-AbCd1234.js'],
      });
      expect(log.filter((line) => line.startsWith('write assets/'))).toEqual(['write assets/index-EfGh5678.css']);
      // CloudFront may hold the old object as immutable, so its path is invalidated with the pages'.
      expect(invalidated).toEqual(['/', '/404.html', '/assets/index-EfGh5678.css', '/favicon.svg', '/index.html', '/robots.txt']);
    }
  });

  it('publishes a newer release over an older one, keeping the older assets', async () => {
    const first = fakes();
    await publish(site(), A, first.repository, first.context);
    const { objects, compared, repository, context } = fakes(first.objects);
    const outcome = await publish(site({ 'assets/index-New12345.js': 'new' }), B, repository, context);
    expect(compared).toEqual([`${A}...${B}`]);
    expect(outcome).toMatchObject({
      uploaded: ['assets/index-New12345.js'],
      replaced: [],
      kept: ['assets/index-AbCd1234.js', 'assets/index-EfGh5678.css'],
    });
    expect(objects.get('assets/index-New12345.js')?.body.toString()).toBe('new');
    expect(historyOf(objects).entries.map(({ release }) => release)).toEqual([A, B]);
  });

  it('publishes the current release again from its saved copy, as a retry', async () => {
    const first = fakes();
    await publish(site(), A, first.repository, first.context);
    const { log, messages, repository, context } = fakes(first.objects, 'identical');
    await publish(site(), A, repository, context);
    expect(messages).toEqual([`The copy of ${A} is already saved.`]);
    expect(log.filter((line) => line.startsWith('write _releases/a'))).toEqual([]);
  });

  it('changes nothing for a stale release, an unnamed one, or one whose saved copy has other files', async () => {
    const first = fakes();
    await publish(site(), A, first.repository, first.context);

    const stale = fakes(first.objects, 'behind');
    await expect(publish(site(), B, stale.repository, stale.context)).rejects.toThrow(`Not publishing ${B}`);
    expect(stale.log).toEqual([]);

    const unnamed = fakes(first.objects);
    await expect(publish(site(), 'main', unnamed.repository, unnamed.context)).rejects.toThrow(
      'A release is named by its full commit SHA; got "main".',
    );

    // A copy with other files is found before any asset is written.
    const rebuilt = fakes(first.objects, 'identical');
    await expect(
      publish(site({ 'robots.txt': 'other', 'assets/index-New12345.js': 'new' }), A, rebuilt.repository, rebuilt.context),
    ).rejects.toThrow(`The saved copy of ${A} has other files than this build. Nothing was published.`);
    expect(rebuilt.log).toEqual([]);
  });

  it('fails on a history or manifest that is not what it should be, before changing anything', async () => {
    const malformed = [
      Buffer.from('{'),
      Buffer.from('[]'),
      Buffer.from('{"entries": {}}'),
      json({ format: 0, entries: [] }).body,
      json({ format: '1', entries: [] }).body,
      json({ format: 1.5, entries: [] }).body,
      json({ entries: [{ ...entry(A), action: 7 }] }).body,
      ...[
        { release: 'main' },
        { run: '' },
        { started: 5 },
        { published: '' },
        { verified: null },
      ].map((change) => json({ entries: [{ ...entry(A), ...change }] }).body),
    ];
    for (const body of malformed) {
      const { log, repository, context } = fakes(new Map([['_releases/history.json', { ...json({}), body }]]));
      await expect(publish(site(), B, repository, context), body.toString()).rejects.toThrow(
        /^_releases\/history\.json is not (?:JSON|a release history)\. Restore its previous version/,
      );
      expect(log).toEqual([]);
    }

    // A history that newer release code wrote is not broken: putting back an older version would lose its newest entries.
    for (const [record, what] of [
      [{ format: 2, entries: [] }, 'format 2'],
      [{ entries: [{ ...entry(A), action: 'deploy' }] }, 'an entry of the kind "deploy"'],
    ] as const) {
      const { log, repository, context } = fakes(new Map([history([]), ['_releases/history.json', json(record)]]));
      await expect(publish(site(), B, repository, context)).rejects.toThrow(
        `_releases/history.json has ${what}, which newer release code wrote and this commit's does not know. Nothing was changed. Do not put back an older version of the history: run release code that knows it.`,
      );
      expect(log).toEqual([]);
    }

    for (const manifest of [[], { release: B, files: [] }, { release: A, files: [{ path: 'index.html' }] }]) {
      const { log, repository, context } = fakes(new Map([[`_releases/${A}/manifest.json`, json(manifest)]]));
      await expect(publish(site(), A, repository, context)).rejects.toThrow(
        `_releases/${A}/manifest.json is not the manifest of release ${A}.`,
      );
      expect(log).toEqual([]);
    }
  });
});

describe('restore', () => {
  // A bucket where A and B were published and verified, and C published but not verified.
  async function released() {
    let objects = new Map<string, StoredObject>();
    for (const [release, robots] of [
      [A, 'A'],
      [B, 'B'],
      [C, 'C'],
    ] as const) {
      const step = fakes(objects);
      await publish(site({ 'robots.txt': robots }), release, step.repository, step.context);
      if (release !== C) await recordVerified(step.context);
      objects = step.objects;
    }
    return objects;
  }

  it('restores a verified release from its copy, and writes its files for the smoke test', async () => {
    const { objects, log, context } = fakes(await released());
    const out = tempDir();
    const outcome = await restore(B, out, { ...context, run: '200-1' });

    expect(outcome).toEqual({
      release: B,
      uploaded: [],
      replaced: [],
      kept: ['assets/index-AbCd1234.js', 'assets/index-EfGh5678.css'],
      removed: [],
      invalidated: ['/', '/404.html', '/favicon.svg', '/index.html', '/robots.txt'],
    });
    expect(objects.get('robots.txt')?.body.toString()).toBe('B');
    expect(readFileSync(join(out, 'robots.txt'), 'utf8')).toBe('B');
    expect(readFileSync(join(out, 'assets', 'index-AbCd1234.js'), 'utf8')).toBe('console.log(1);');
    expect(log).toEqual([
      'write _releases/history.json',
      'write favicon.svg',
      'write robots.txt',
      'write 404.html',
      'write index.html',
      `invalidate / /404.html /favicon.svg /index.html /robots.txt (200-1-restore-${B})`,
      'write _releases/history.json',
    ]);
    expect(historyOf(objects).entries.at(-1)).toEqual({
      action: 'restore',
      release: B,
      run: '200-1',
      started: '2026-10-15T00:00:00Z',
      published: '2026-10-15T00:00:01Z',
    });
  });

  it('restores the same release when the run is re-run after failing partway, or after a newer release went out', async () => {
    const { objects, context } = fakes(await released());
    // The first attempt wrote its history entry and pages, then failed before the release was verified.
    await restore(A, tempDir(), { ...context, run: '300-1' });
    expect((await restore(A, tempDir(), { ...context, run: '300-2' })).release).toBe(A);
    expect(objects.get('robots.txt')?.body.toString()).toBe('A');
    // A newer release published in between does not change which one the run restores.
    const later = fakes(objects);
    await publish(site({ 'robots.txt': 'D' }), 'd'.repeat(40), later.repository, later.context, true);
    const { objects: after, context: rerun } = fakes(later.objects);
    expect((await restore(A, tempDir(), { ...rerun, run: '300-3' })).release).toBe(A);
    expect(after.get('robots.txt')?.body.toString()).toBe('A');
  });

  it('restores a named verified release, putting back any asset that has gone missing', async () => {
    const before = await released();
    before.delete('assets/index-AbCd1234.js');
    const { objects, context } = fakes(before);
    const { release, uploaded } = await restore(A, tempDir(), context);
    expect({ release, uploaded }).toEqual({ release: A, uploaded: ['assets/index-AbCd1234.js'] });
    expect(objects.get('robots.txt')?.body.toString()).toBe('A');
    expect(objects.get('assets/index-AbCd1234.js')?.body.toString()).toBe('console.log(1);');
  });

  it('refuses anything but the full commit SHA of a verified release, and lists the verified ones, newest first', async () => {
    const { log, context } = fakes(await released());
    const listing = `Verified releases, newest first: ${B}, ${A}.`;
    for (const requested of [C, 'previous', 'b'.repeat(39), B.toUpperCase(), '']) {
      await expect(restore(requested, tempDir(), context), requested).rejects.toThrow(
        `Restore takes the full commit SHA of a release that passed its smoke test; got ${JSON.stringify(requested)}. ${listing}`,
      );
    }
    expect(log).toEqual([]);

    const unverified = fakes();
    await publish(site(), A, unverified.repository, unverified.context);
    await expect(restore(A, tempDir(), fakes(unverified.objects).context)).rejects.toThrow(
      'Verified releases, newest first: none yet.',
    );
    await expect(restore(A, tempDir(), fakes().context)).rejects.toThrow(
      'No release has been published yet, so there is none to restore.',
    );
  });

  it('lists at most five verified releases, each once', async () => {
    const releases = ['1', '2', '3', '4', '5', '6'].map((digit) => digit.repeat(40));
    const entries = [...releases, releases[0]!].map((release) => entry(release, { verified: 'then' }));
    const { context } = fakes(new Map([history(entries)]));
    await expect(restore('previous', tempDir(), context)).rejects.toThrow(
      `Verified releases, newest first: ${[releases[0], releases[5], releases[4], releases[3], releases[2]].join(', ')}.`,
    );
  });

  it('restores nothing from a copy that is missing, incomplete, or changed', async () => {
    for (const [damage, message] of [
      [(objects: Map<string, StoredObject>) => objects.delete(`_releases/${B}/manifest.json`), `${B} has no saved copy`],
      [
        (objects: Map<string, StoredObject>) => objects.delete(`_releases/${B}/site/index.html`),
        `The saved copy of ${B} is missing index.html. Nothing was restored.`,
      ],
      [
        (objects: Map<string, StoredObject>) =>
          objects.set(`_releases/${B}/site/favicon.svg`, { ...objects.get(`_releases/${B}/site/favicon.svg`)!, body: Buffer.from('x') }),
        `The saved copy of ${B} has a changed favicon.svg. Nothing was restored.`,
      ],
    ] as const) {
      const objects = await released();
      damage(objects);
      const { log, context } = fakes(objects);
      await expect(restore(B, tempDir(), context)).rejects.toThrow(message);
      expect(log).toEqual([]);
    }
  });
});

describe('rollBack', () => {
  // A bucket where A was published and verified, and run 100-1 then published B, which is not verified.
  async function failedB() {
    const first = fakes();
    await publish(site({ 'robots.txt': 'A' }), A, first.repository, first.context);
    await recordVerified(first.context);
    const second = fakes(first.objects);
    await publish(site({ 'robots.txt': 'B' }), B, second.repository, second.context);
    return second.objects;
  }

  it("rolls back to the last verified release after this run's release failed its smoke test", async () => {
    const { objects, log, context } = fakes(await failedB());
    const out = tempDir();
    const outcome = await rollBack(out, context);

    expect(outcome).toEqual({
      release: A,
      uploaded: [],
      replaced: [],
      kept: ['assets/index-AbCd1234.js', 'assets/index-EfGh5678.css'],
      removed: [],
      invalidated: ['/', '/404.html', '/favicon.svg', '/index.html', '/robots.txt'],
    });
    expect(objects.get('robots.txt')?.body.toString()).toBe('A');
    expect(readFileSync(join(out, 'robots.txt'), 'utf8')).toBe('A');
    expect(log).toEqual([
      'write _releases/history.json',
      'write favicon.svg',
      'write robots.txt',
      'write 404.html',
      'write index.html',
      `invalidate / /404.html /favicon.svg /index.html /robots.txt (100-1-rollback-${A})`,
      'write _releases/history.json',
    ]);
    expect(historyOf(objects).entries.map(({ action, release, run }) => `${action} ${release[0]} ${run}`)).toEqual([
      'publish a 100-1',
      'publish b 100-1',
      'rollback a 100-1',
    ]);
    // The rolled-back release passes its own smoke test before the workflow records it as verified.
    expect((await recordVerified(context)).action).toBe('rollback');
  });

  it('rolls back after a publish that stopped partway, before its invalidation finished', async () => {
    const first = fakes();
    await publish(site({ 'robots.txt': 'A' }), A, first.repository, first.context);
    await recordVerified(first.context);
    const second = fakes(first.objects);
    const failing = { ...second.context, cdn: { invalidate: async () => Promise.reject(new Error('waiter timed out')) } };
    await expect(publish(site({ 'robots.txt': 'B' }), B, second.repository, failing)).rejects.toThrow('waiter timed out');
    expect(second.objects.get('robots.txt')?.body.toString()).toBe('B');

    const { objects, context } = fakes(second.objects);
    expect((await rollBack(tempDir(), context))?.release).toBe(A);
    expect(objects.get('robots.txt')?.body.toString()).toBe('A');
  });

  it('changes nothing, and names the current release, when it is not one this run started and left unverified', async () => {
    const verified = fakes();
    await publish(site(), A, verified.repository, verified.context);
    await recordVerified(verified.context);
    for (const [objects, run, current] of [
      [new Map<string, StoredObject>(), '100-1', 'none yet'], // nothing published
      // another run's release, as when this run's publish was refused
      [await failedB(), '101-1', `${B} (publish by run 100-1, not verified)`],
      [verified.objects, '100-2', `${A} (publish by run 100-1, verified)`], // this run's release, verified
    ] as const) {
      const { log, messages, context } = fakes(objects);
      expect(await rollBack(tempDir(), { ...context, run })).toBeUndefined();
      expect(log).toEqual([]);
      expect(messages).toEqual([
        `Nothing to roll back: the current release is ${current}, not one run ${run} started and left unverified.`,
      ]);
    }
  });

  it('rolls back in a later attempt of the run that published the release, as after re-running the failed jobs', async () => {
    const { objects, log, context } = fakes(await failedB());
    expect((await rollBack(tempDir(), { ...context, run: '100-2' }))?.release).toBe(A);
    expect(objects.get('robots.txt')?.body.toString()).toBe('A');
    // The attempt keeps its own invalidation reference.
    expect(log.filter((line) => line.startsWith('invalidate'))).toEqual([
      `invalidate / /404.html /favicon.svg /index.html /robots.txt (100-2-rollback-${A})`,
    ]);
  });

  it('changes nothing when no earlier release passed its checks or was restored', async () => {
    const first = fakes();
    await publish(site(), A, first.repository, first.context);
    const { log, messages, context } = fakes(first.objects);
    expect(await rollBack(tempDir(), context)).toBeUndefined();
    expect(log).toEqual([]);
    expect(messages).toEqual([`No release before ${A} passed its checks or was restored, so there is none to roll back to.`]);
  });

  it('rolls back to a restore whose own checks failed, not past it to the release it restored away from', async () => {
    const timedOut = { invalidate: async () => Promise.reject(new Error('waiter timed out')) };
    // Whether the restore finished publishing or stopped partway, it is not verified.
    for (const restoreCdn of [undefined, timedOut]) {
      const first = fakes();
      await publish(site({ 'robots.txt': 'A' }), A, first.repository, first.context);
      await recordVerified(first.context);
      const second = fakes(first.objects);
      const b = { ...second.context, run: '200-1' };
      await publish(site({ 'robots.txt': 'B' }), B, second.repository, b);
      await recordVerified(b);
      const third = fakes(second.objects);
      const restoring = restore(A, tempDir(), { ...third.context, run: '300-1', cdn: restoreCdn ?? third.context.cdn });
      if (restoreCdn) await expect(restoring).rejects.toThrow('waiter timed out');
      else await restoring;
      // A run started by hand to resume publishes C, which fails its checks.
      const fourth = fakes(third.objects);
      await publish(site({ 'robots.txt': 'C' }), C, fourth.repository, { ...fourth.context, run: '400-1' }, true);
      const { objects, context } = fakes(fourth.objects);
      expect((await rollBack(tempDir(), { ...context, run: '400-1' }))?.release).toBe(A);
      expect(objects.get('robots.txt')?.body.toString()).toBe('A');
    }
  });

  it('rolls back past an earlier failed release to the last verified one', async () => {
    const afterB = fakes(await failedB());
    await rollBack(tempDir(), afterB.context);
    await recordVerified(afterB.context);
    const third = fakes(afterB.objects);
    await publish(site({ 'robots.txt': 'C' }), C, third.repository, { ...third.context, run: '102-1' });
    const { objects, context } = fakes(third.objects);
    expect((await rollBack(tempDir(), { ...context, run: '102-1' }))?.release).toBe(A);
    expect(objects.get('robots.txt')?.body.toString()).toBe('A');
  });

  it('lets the release it rolled back from be published again, as a retry, unless someone has restored since', async () => {
    const afterB = fakes(await failedB(), 'identical');
    await rollBack(tempDir(), afterB.context);
    await recordVerified(afterB.context);
    const entries = historyOf(afterB.objects).entries;
    await checkOrder(entries, B, afterB.repository);
    const restored = [...entries, entry(A, { action: 'restore', run: '103-1', verified: 'then' })];
    await expect(checkOrder(restored, B, afterB.repository)).rejects.toThrow(`Not publishing ${B}`);
  });
});

describe('replaced assets', () => {
  const CSS = 'assets/index-EfGh5678.css';
  const timedOut = { invalidate: async () => Promise.reject(new Error('waiter timed out')) };
  const pendingOf = (objects: Map<string, StoredObject>) =>
    JSON.parse(objects.get('_releases/pending-invalidation.json')!.body.toString()) as { assets: string[] };

  // A published and verified; then the CSS is found with other headers, as after a change to the header table.
  async function verifiedAWithOldHeaders() {
    const first = fakes();
    await publish(site({ 'robots.txt': 'A' }), A, first.repository, first.context);
    await recordVerified(first.context);
    first.objects.set(CSS, { ...first.objects.get(CSS)!, contentType: 'text/plain' });
    return first.objects;
  }

  it('records a replaced asset as pending before overwriting it, and clears it once its invalidation completes', async () => {
    const { objects, log, repository, context } = fakes(await verifiedAWithOldHeaders());
    const { replaced, invalidated } = await publish(site({ 'robots.txt': 'B' }), B, repository, context);
    expect(replaced).toEqual([CSS]);
    expect(invalidated).toContain(`/${CSS}`);
    const order = log.filter((line) => /^(write _releases\/pending|write assets\/|invalidate)/.test(line));
    expect(order).toEqual([
      'write _releases/pending-invalidation.json',
      `write ${CSS}`,
      expect.stringMatching(/^invalidate .*\/assets\/index-EfGh5678\.css/),
      'write _releases/pending-invalidation.json',
    ]);
    expect(pendingOf(objects)).toEqual({ assets: [] });
  });

  it('invalidates it in the rollback, and in a re-run, after the run that replaced it failed before invalidating', async () => {
    for (const next of ['rollback', 're-run'] as const) {
      const failed = fakes(await verifiedAWithOldHeaders());
      await expect(
        publish(site({ 'robots.txt': 'B' }), B, failed.repository, { ...failed.context, cdn: timedOut }),
      ).rejects.toThrow('waiter timed out');
      expect(pendingOf(failed.objects)).toEqual({ assets: [CSS] });

      const { objects, repository, context } = fakes(failed.objects);
      const outcome =
        next === 'rollback'
          ? await rollBack(tempDir(), context)
          : await publish(site({ 'robots.txt': 'B' }), B, repository, { ...context, run: '100-2' });
      // The CSS now has the right headers, so it is kept, but its path is still invalidated.
      expect(outcome?.kept).toContain(CSS);
      expect(outcome?.invalidated).toContain(`/${CSS}`);
      expect(pendingOf(objects)).toEqual({ assets: [] });
    }
  });

  it('refuses, before any write, a pending record that is not a list of plain asset paths', async () => {
    for (const record of [{ assets: ['index.html'] }, { assets: ['assets/*'] }, { assets: 'assets/x.css' }, []]) {
      const { log, objects, repository, context } = fakes(await verifiedAWithOldHeaders());
      objects.set('_releases/pending-invalidation.json', json(record));
      await expect(publish(site(), B, repository, context)).rejects.toThrow(
        '_releases/pending-invalidation.json is not a list of assets to invalidate. Nothing was changed. Check it, and fix it by hand.',
      );
      expect(log).toEqual([]);
    }
  });
});

describe('removing pages', () => {
  it('deletes the pages the bucket holds that the release does not, after writing its own, and invalidates them', async () => {
    const first = fakes();
    await publish(site({ 'about/index.html': 'about', 'old.txt': 'old' }), A, first.repository, first.context);
    const { objects, log, repository, context } = fakes(first.objects);
    const outcome = await publish(site(), B, repository, context);

    expect(outcome.removed).toEqual(['about/index.html', 'old.txt']);
    expect(log.slice(-5)).toEqual([
      'write index.html',
      'remove about/index.html',
      'remove old.txt',
      `invalidate / /404.html /about /about/ /about/index.html /favicon.svg /index.html /old.txt /robots.txt (100-1-publish-${B})`,
      'write _releases/history.json',
    ]);
    expect(objects.has('about/index.html')).toBe(false);
    // Assets an earlier page may still load, and the release records, stay.
    expect(objects.has('assets/index-AbCd1234.js')).toBe(true);
    expect(objects.has(`_releases/${A}/site/about/index.html`)).toBe(true);
  });

  it('never deletes an asset or a release record, even one no release lists', async () => {
    const first = fakes();
    await publish(site(), A, first.repository, first.context);
    const stray = first.objects.get('robots.txt')!;
    first.objects.set('assets/old-ZzZz9999.js', stray);
    first.objects.set('_releases/probe-2026-10-15.txt', stray);
    const { log, repository, context } = fakes(first.objects);
    expect((await publish(site(), B, repository, context)).removed).toEqual([]);
    expect(log.filter((line) => line.startsWith('remove'))).toEqual([]);
  });

  it('fails before any write when the bucket holds a key no release would write, a dot segment included', async () => {
    const first = fakes();
    await publish(site(), A, first.repository, first.context);
    for (const key of ['notes/a b.txt', 'notes/../x.txt']) first.objects.set(key, first.objects.get('robots.txt')!);
    // An asset gone missing, which the publish would otherwise upload first.
    first.objects.delete('assets/index-AbCd1234.js');
    const { log, repository, context } = fakes(first.objects);
    await expect(publish(site(), B, repository, context)).rejects.toThrow(
      'Nothing was changed: the bucket holds notes/../x.txt, notes/a b.txt, which no release would write. Check, and remove by hand what does not belong.',
    );
    expect(log).toEqual([]);
  });

  it('restoring an earlier release deletes the pages a later one added', async () => {
    const first = fakes();
    await publish(site(), A, first.repository, first.context);
    await recordVerified(first.context);
    const second = fakes(first.objects);
    await publish(site({ 'about/index.html': 'about' }), B, second.repository, second.context);
    const { objects, context } = fakes(second.objects);
    expect((await restore(A, tempDir(), context)).removed).toEqual(['about/index.html']);
    expect(objects.has('about/index.html')).toBe(false);
  });
});

describe('holding deploys after a restore', () => {
  // A and B published and verified, then A restored by run 300-1.
  async function restoredA() {
    const first = fakes();
    await publish(site({ 'robots.txt': 'A' }), A, first.repository, first.context);
    await recordVerified(first.context);
    const second = fakes(first.objects);
    await publish(site({ 'robots.txt': 'B' }), B, second.repository, second.context);
    await recordVerified(second.context);
    const third = fakes(second.objects);
    await restore(A, tempDir(), { ...third.context, run: '300-1' });
    return third.objects;
  }

  it('publishes nothing over a restore someone ran, however new the commit', async () => {
    const { log, repository, context } = fakes(await restoredA());
    await expect(publish(site({ 'robots.txt': 'C' }), C, repository, context)).rejects.toThrow(
      `Not publishing ${C}: deploys are held, since run 300-1 restored ${A}. Nothing was changed. To publish over the restore, run the Deploy workflow on main by hand with "Publish over a restore" checked.`,
    );
    expect(log).toEqual([]);
  });

  it('publishes over the restore when a run asks to resume, a newer commit or the one restored over', async () => {
    const newer = fakes(await restoredA());
    await publish(site({ 'robots.txt': 'C' }), C, newer.repository, newer.context, true);
    expect(newer.objects.get('robots.txt')?.body.toString()).toBe('C');

    const same = fakes(await restoredA(), 'identical');
    await publish(site({ 'robots.txt': 'B' }), B, same.repository, same.context, true);
    expect(same.objects.get('robots.txt')?.body.toString()).toBe('B');
    // Once published over, deploys are no longer held.
    const next = fakes(same.objects);
    await publish(site({ 'robots.txt': 'C' }), C, next.repository, next.context);
    expect(next.objects.get('robots.txt')?.body.toString()).toBe('C');
  });

  it('still refuses an older commit, even when resuming', async () => {
    const { repository, context } = fakes(await restoredA(), 'behind');
    await expect(publish(site(), A, repository, context, true)).rejects.toThrow(`Not publishing ${A}: it is older than ${B}`);
  });

  it('holds nothing after an automatic rollback, so a fix goes out as usual', async () => {
    const first = fakes();
    await publish(site({ 'robots.txt': 'A' }), A, first.repository, first.context);
    await recordVerified(first.context);
    const second = fakes(first.objects);
    await publish(site({ 'robots.txt': 'B' }), B, second.repository, second.context);
    await rollBack(tempDir(), second.context);
    const fix = fakes(second.objects);
    await publish(site({ 'robots.txt': 'C' }), C, fix.repository, fix.context);
    expect(fix.objects.get('robots.txt')?.body.toString()).toBe('C');
  });
});

describe('refusing before any write, in a restore and a rollback', () => {
  const ODD = 'Nothing was changed: the bucket holds notes/a b.txt, which no release would write.';
  const PENDING = '_releases/pending-invalidation.json is not a list of assets to invalidate. Nothing was changed.';

  // A verified, and B published by run 100-1 but not verified; an asset gone missing, which either would put back first.
  async function bucket(change: (objects: Map<string, StoredObject>) => void) {
    const first = fakes();
    await publish(site({ 'robots.txt': 'A' }), A, first.repository, first.context);
    await recordVerified(first.context);
    const second = fakes(first.objects);
    await publish(site({ 'robots.txt': 'B' }), B, second.repository, second.context);
    second.objects.delete('assets/index-AbCd1234.js');
    change(second.objects);
    return second.objects;
  }
  const oddKey = (objects: Map<string, StoredObject>) => objects.set('notes/a b.txt', objects.get('robots.txt')!);
  const badPending = (objects: Map<string, StoredObject>) => objects.set('_releases/pending-invalidation.json', json({ assets: ['/*'] }));

  for (const [problem, change, message] of [
    ['an odd key', oddKey, ODD],
    ['a malformed pending record', badPending, PENDING],
  ] as const) {
    it(`restores nothing, and writes no file, when the bucket holds ${problem}`, async () => {
      const { log, context } = fakes(await bucket(change));
      const out = tempDir();
      await expect(restore(A, out, { ...context, run: '300-1' })).rejects.toThrow(message);
      expect(log).toEqual([]);
      expect(readdirSync(out)).toEqual([]);
    });

    it(`rolls back nothing, and writes no file, when the bucket holds ${problem}`, async () => {
      const { log, context } = fakes(await bucket(change));
      const out = tempDir();
      await expect(rollBack(out, context)).rejects.toThrow(message);
      expect(log).toEqual([]);
      expect(readdirSync(out)).toEqual([]);
    });
  }
});

describe('recordVerified', () => {
  it('records the release this run published as verified', async () => {
    const { objects, repository, context } = fakes();
    await publish(site(), A, repository, context);
    expect(await recordVerified(context)).toMatchObject({ release: A, run: '100-1', verified: '2026-10-15T00:00:02Z' });
    expect(historyOf(objects).entries[0]?.verified).toBe('2026-10-15T00:00:02Z');
  });

  it('records the release in a later attempt of the run that published it, as after re-running the failed jobs', async () => {
    const { objects, repository, context } = fakes();
    await publish(site(), A, repository, context);
    expect(await recordVerified({ ...context, run: '100-2' })).toMatchObject({ release: A, run: '100-1' });
    expect(historyOf(objects).entries[0]?.verified).toBeDefined();
  });

  it('records nothing, naming the current release, when this run did not finish publishing it', async () => {
    for (const [entries, current] of [
      [[], 'none yet'],
      [[entry(A, { run: '99-1' })], `${A} (publish by run 99-1, not verified)`],
      [[entry(A, { run: '100-1', published: undefined })], `${A} (publish by run 100-1, unfinished)`],
    ] as const) {
      const { log, context } = fakes(new Map([history([...entries])]));
      await expect(recordVerified(context)).rejects.toThrow(
        `Nothing was recorded as verified: the current release is ${current}, and only one that run 100-1 finished publishing can be.`,
      );
      expect(log).toEqual([]);
    }
  });
});

describe('readHistory', () => {
  it('reads an empty history from a bucket without one', async () => {
    expect(await readHistory(fakes().store)).toEqual([]);
  });

  it('keeps a field it does not know inside an entry through every rewrite, as the format rule relies on', async () => {
    const extra = (objects: Map<string, StoredObject>) => historyOf(objects).entries.map((e) => (e as Entry & { note?: string }).note);
    const first = fakes();
    await publish(site({ 'robots.txt': 'A' }), A, first.repository, first.context);
    await recordVerified(first.context);
    // Newer code added a note to the first entry.
    const noted = historyOf(first.objects);
    (noted.entries[0] as Entry & { note?: string }).note = 'kept';
    first.objects.set('_releases/history.json', json(noted));
    const second = fakes(first.objects);
    await publish(site({ 'robots.txt': 'B' }), B, second.repository, second.context);
    await rollBack(tempDir(), second.context);
    await recordVerified(second.context);
    const third = fakes(second.objects);
    await restore(A, tempDir(), { ...third.context, run: '300-1' });
    expect(extra(third.objects)[0]).toBe('kept');
  });

  it('reads a history from before the format marker as format 1', async () => {
    const { store } = fakes(new Map([['_releases/history.json', json({ entries: [entry(A)] })]]));
    expect(await readHistory(store)).toEqual([entry(A)]);
  });
});

describe('encodingFor', () => {
  const file = (contentType: string, length: number) => ({ contentType, body: Buffer.alloc(length) });

  it('prefers Brotli, then gzip, for a type CloudFront compresses, at the sizes it compresses', () => {
    expect(encodingFor(file('text/html; charset=utf-8', 1000), 'gzip, deflate, br, zstd')).toBe('br');
    expect(encodingFor(file('text/javascript; charset=utf-8', 5000), 'gzip;q=1.0, identity')).toBe('gzip');
    expect(encodingFor(file('image/svg+xml', 10_000_000), 'BR')).toBe('br');
    for (const type of ['text/css; charset=utf-8', 'text/plain; charset=utf-8', 'application/json', 'application/xml']) {
      expect(encodingFor(file(type, 2000), 'gzip'), type).toBe('gzip');
    }
  });

  it('sends no encoding the browser did not ask for', () => {
    expect(encodingFor(file('text/css; charset=utf-8', 2000), 'identity')).toBeNull();
    expect(encodingFor(file('text/css; charset=utf-8', 2000), 'zstd, deflate')).toBeNull();
    expect(encodingFor(file('text/css; charset=utf-8', 2000))).toBeNull();
  });

  it('leaves a file outside 1,000 to 10,000,000 bytes, or of a type CloudFront does not compress, as it is', () => {
    expect(encodingFor(file('text/html; charset=utf-8', 999), 'br')).toBeNull();
    expect(encodingFor(file('text/html; charset=utf-8', 10_000_001), 'br')).toBeNull();
    for (const type of ['image/png', 'font/woff2', 'application/manifest+json', 'model/gltf+json', 'text/htmlx']) {
      expect(encodingFor(file(type, 5000), 'br, gzip'), type).toBeNull();
    }
  });
});

describe('servedPath', () => {
  // tests/path-mapping.test.ts runs infra/functions/viewer-request.js against this copy, path by path.
  it('gives a directory path its index.html, and a path whose last segment has a dot that file', () => {
    expect(servedPath('/')).toBe('index.html');
    expect(servedPath('/resume/')).toBe('resume/index.html');
    expect(servedPath('/resume')).toBe('resume/index.html');
    expect(servedPath('/assets/index-AbCd1234.js')).toBe('assets/index-AbCd1234.js');
    expect(servedPath('/v1.2/notes')).toBe('v1.2/notes/index.html');
  });
});
