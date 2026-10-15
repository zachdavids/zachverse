import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type Cdn,
  checkOrder,
  type Context,
  describeFile,
  type Entry,
  IMMUTABLE,
  invalidationPaths,
  publish,
  readHistory,
  recordVerified,
  type Repository,
  restore,
  REVALIDATE,
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

// The bucket and the distribution in memory; every write and invalidation is logged in order.
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
    await checkOrder([entry(A, { action: 'restore' })], B, repository);
    expect(compared).toEqual([]);
  });

  it('lets a release newer than the newest one published through, compared with that one', async () => {
    const { repository, compared } = repositoryAnswering('ahead');
    await checkOrder([entry(A), entry(B, { run: '91-1' }), entry(A, { action: 'restore', run: '92-1' })], C, repository);
    expect(compared).toEqual([`${B}...${C}`]);
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
    const restored = [entry(A), entry(B, { run: '91-1' }), entry(A, { action: 'restore', run: '92-1' })];
    await expect(checkOrder(restored, B, repositoryAnswering('identical').repository)).rejects.toThrow(
      `Not publishing ${B}: run 91-1 published it, and run 92-1 has since restored ${A}.`,
    );
  });
});

describe('publish', () => {
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
      invalidated: ['/', '/404.html', '/favicon.svg', '/index.html', '/robots.txt'],
    });
    // The first release is compared with nothing.
    expect(compared).toEqual([]);
    expect(historyOf(objects)).toEqual({
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
      ...[
        { action: 'deploy' },
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
    await publish(site({ 'robots.txt': 'D' }), 'd'.repeat(40), later.repository, later.context);
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

describe('recordVerified', () => {
  it('records the release this run published as verified', async () => {
    const { objects, repository, context } = fakes();
    await publish(site(), A, repository, context);
    expect(await recordVerified(context)).toMatchObject({ release: A, run: '100-1', verified: '2026-10-15T00:00:02Z' });
    expect(historyOf(objects).entries[0]?.verified).toBe('2026-10-15T00:00:02Z');
  });

  it('records nothing when this run did not publish the current release, or it did not finish', async () => {
    for (const entries of [[], [entry(A, { run: '99-1' })], [entry(A, { run: '100-1', published: undefined })]]) {
      const { log, context } = fakes(new Map([history(entries)]));
      await expect(recordVerified(context)).rejects.toThrow(
        'Run 100-1 did not publish the current release, so nothing was recorded as verified.',
      );
      expect(log).toEqual([]);
    }
  });
});

describe('readHistory', () => {
  it('reads an empty history from a bucket without one', async () => {
    expect(await readHistory(fakes().store)).toEqual([]);
  });
});
