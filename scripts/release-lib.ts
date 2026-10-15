// Release mechanics (ADR 0006). The deploy and restore workflows run these with the deploy role, which can read and
// write the bucket's objects but cannot delete one, so a release never removes a file an earlier page may still load.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

/** Where the copy of each release and the release history live. The bucket policy keeps CloudFront from serving them. */
export const RECORDS = '_releases/';
const HISTORY = `${RECORDS}history.json`;

/** For assets: their names carry a content hash, so a name never gets other content. */
export const IMMUTABLE = 'public, max-age=31536000, immutable';
/**
 * For every other file, which keeps its name from release to release: browsers revalidate it on each use, and CloudFront
 * keeps it no longer than the CachingOptimized policy's 1-second minimum TTL.
 */
export const REVALIDATE = 'no-cache';

// One entry per extension the site uses or is likely to; any other fails, so no file goes out with a guessed type.
const CONTENT_TYPES = new Map([
  ['html', 'text/html; charset=utf-8'],
  ['js', 'text/javascript; charset=utf-8'],
  ['mjs', 'text/javascript; charset=utf-8'],
  ['css', 'text/css; charset=utf-8'],
  ['json', 'application/json'],
  ['webmanifest', 'application/manifest+json'],
  ['txt', 'text/plain; charset=utf-8'],
  ['xml', 'application/xml'],
  ['svg', 'image/svg+xml'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['avif', 'image/avif'],
  ['ico', 'image/x-icon'],
  ['woff', 'font/woff'],
  ['woff2', 'font/woff2'],
  ['glb', 'model/gltf-binary'],
  ['gltf', 'model/gltf+json'],
]);

// Path segments CloudFront invalidates as written: invalidation paths need other characters encoded, and "~" never
// works (https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/invalidation-specifying-objects.html).
const PLAIN_PATH = /^[\w.-]+(?:\/[\w.-]+)*$/;
// The content hash Vite puts in an asset's name: a hyphen and 8 characters before the extension. A word of 8 letters
// passes too, so tests/repo-policy.test.ts keeps public/, which Vite copies unhashed, from holding an assets/ directory.
const HASHED_NAME = /-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/;
const COMMIT = /^[0-9a-f]{40}$/;

export interface SiteFile {
  /** Relative to the site root, joined with "/"; also the object's key. */
  path: string;
  sha256: string;
  contentType: string;
  cacheControl: string;
  body: Buffer;
}

/** A saved copy's file list, written after the files, so a manifest means a complete copy. */
interface Manifest {
  release: string;
  files: { path: string; sha256: string; size: number; contentType: string; cacheControl: string }[];
}

export interface Entry {
  action: 'publish' | 'restore';
  /** The commit whose build is the release. */
  release: string;
  /** The workflow run, as "<run ID>-<attempt>". */
  run: string;
  started: string;
  /** Set once every file is written and the invalidation has completed. */
  published?: string;
  /** Set once the smoke test has passed. */
  verified?: string;
}

/** The bucket. Objects are written whole (PutObject), so one is never seen half-written. */
export interface Store {
  head(key: string): Promise<{ sha256?: string; contentType?: string; cacheControl?: string } | undefined>;
  read(key: string): Promise<Buffer | undefined>;
  write(key: string, body: Buffer, headers: { sha256: string; contentType: string; cacheControl: string }): Promise<void>;
}

export interface Cdn {
  /** Invalidates the paths and waits for the invalidation to complete. */
  invalidate(paths: string[], reference: string): Promise<void>;
}

export interface Repository {
  /** How head relates to base in the repository's history, as GitHub's compare API reports it. */
  compare(base: string, head: string): Promise<'ahead' | 'behind' | 'identical' | 'diverged'>;
}

export interface Context {
  store: Store;
  cdn: Cdn;
  run: string;
  now: () => string;
  log: (message: string) => void;
}

export interface Outcome {
  release: string;
  uploaded: string[];
  /** Assets whose names held other bytes or headers; their paths are invalidated too. */
  replaced: string[];
  kept: string[];
  invalidated: string[];
}

export function sha256(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

export function isAsset(path: string): boolean {
  return path.startsWith('assets/');
}

const isIndex = (path: string) => /(?:^|\/)index\.html$/.test(path);

/** One file of a release, with the headers it is served with. Throws for a file no release may hold. */
export function describeFile(path: string, body: Buffer): SiteFile {
  // A "." or ".." segment would name another object than its path suggests, and another file when restored to disk.
  if (!PLAIN_PATH.test(path) || path.split('/').some((segment) => /^\.\.?$/.test(segment))) {
    throw new Error(`${JSON.stringify(path)}: a file's path may hold only letters, digits, "_", "-", "." and "/".`);
  }
  if (path.startsWith(RECORDS)) throw new Error(`${path} would overwrite the release records under ${RECORDS}.`);
  if (isAsset(path) && !HASHED_NAME.test(path)) {
    throw new Error(`${path} has no content hash in its name, so it cannot be cached as immutable.`);
  }
  const contentType = CONTENT_TYPES.get(/\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? '');
  if (contentType === undefined) throw new Error(`${path} has no content type; add its extension to CONTENT_TYPES.`);
  return { path, sha256: sha256(body), contentType, cacheControl: isAsset(path) ? IMMUTABLE : REVALIDATE, body };
}

/** Every file under dir, hidden ones included, in path order. */
export function siteFiles(dir: string): SiteFile[] {
  const paths = readdirSync(dir, { encoding: 'utf8', recursive: true })
    .filter((file) => statSync(join(dir, file)).isFile())
    .map((file) => file.split(sep).join('/'))
    .sort();
  if (paths.length === 0) throw new Error(`${dir} has no files to release.`);
  return paths.map((path) => describeFile(path, readFileSync(join(dir, path))));
}

/**
 * The paths to invalidate for a release's pages: each file's own path and, since the viewer-request function serves
 * index.html for a directory path, the paths viewers request it by. Assets need none: a new release names its own.
 */
export function invalidationPaths(files: { path: string }[]): string[] {
  const paths = new Set<string>();
  for (const { path } of files) {
    if (isAsset(path)) continue;
    paths.add(`/${path}`);
    if (isIndex(path)) {
      const dir = path.slice(0, -'index.html'.length);
      paths.add(`/${dir}`);
      if (dir !== '') paths.add(`/${dir.slice(0, -1)}`);
    }
  }
  return [...paths].sort();
}

/** Pages in the order they go out: other files first, then HTML, then each index.html, so a page's references exist. */
function pageOrder(files: SiteFile[]): SiteFile[] {
  const rank = (path: string) => (isIndex(path) ? 2 : path.endsWith('.html') ? 1 : 0);
  return files.filter((file) => !isAsset(file.path)).sort((a, b) => rank(a.path) - rank(b.path));
}

function requireCommit(release: string): void {
  if (!COMMIT.test(release)) throw new Error(`A release is named by its full commit SHA; got ${JSON.stringify(release)}.`);
}

function json(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

async function writeFile(store: Store, key: string, { body, sha256: hash, contentType, cacheControl }: SiteFile) {
  await store.write(key, body, { sha256: hash, contentType, cacheControl });
}

async function writeJson(store: Store, key: string, value: unknown): Promise<void> {
  const body = json(value);
  await store.write(key, body, { sha256: sha256(body), contentType: 'application/json', cacheControl: REVALIDATE });
}

async function readJson(store: Store, key: string): Promise<unknown> {
  const body = await store.read(key);
  if (body === undefined) return undefined;
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    throw new Error(`${key} is not JSON. Restore its previous version (the bucket is versioned) before releasing again.`);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown) => typeof value === 'string' && value !== '';
const isOptionalText = (value: unknown) => value === undefined || isText(value);

function isEntry(value: unknown): value is Entry {
  return (
    isRecord(value) &&
    (value.action === 'publish' || value.action === 'restore') &&
    typeof value.release === 'string' &&
    COMMIT.test(value.release) &&
    isText(value.run) &&
    isText(value.started) &&
    isOptionalText(value.published) &&
    isOptionalText(value.verified)
  );
}

export async function readHistory(store: Store): Promise<Entry[]> {
  const history = await readJson(store, HISTORY);
  if (history === undefined) return [];
  if (!isRecord(history) || !Array.isArray(history.entries) || !history.entries.every(isEntry)) {
    throw new Error(`${HISTORY} is not a release history. Restore its previous version before releasing again.`);
  }
  return history.entries as Entry[];
}

async function writeHistory(store: Store, entries: Entry[]): Promise<void> {
  await writeJson(store, HISTORY, { entries });
}

async function readManifest(store: Store, release: string): Promise<Manifest | undefined> {
  const key = `${RECORDS}${release}/manifest.json`;
  const manifest = await readJson(store, key);
  if (manifest === undefined) return undefined;
  const isFile = (file: unknown) =>
    isRecord(file) &&
    typeof file.path === 'string' &&
    typeof file.sha256 === 'string' &&
    typeof file.size === 'number' &&
    typeof file.contentType === 'string' &&
    typeof file.cacheControl === 'string';
  if (!isRecord(manifest) || manifest.release !== release || !Array.isArray(manifest.files) || !manifest.files.every(isFile)) {
    throw new Error(`${key} is not the manifest of release ${release}.`);
  }
  return manifest as unknown as Manifest;
}

/**
 * Refuses a release older than the newest one published, which is how GitHub can run deploys out of order or re-run an
 * old one (ADR 0005). Publishing the same commit again is a retry, allowed only while it is the current release, so
 * re-running the deploy of a release that a restore replaced does not put it back. A newer commit still publishes over
 * a restore, whether pushed or re-run; going back is the Restore workflow's job.
 */
export async function checkOrder(entries: Entry[], release: string, repository: Repository): Promise<void> {
  const current = entries.at(-1);
  const newest = entries.findLast((entry) => entry.action === 'publish');
  if (current === undefined || newest === undefined) return;
  const relation = await repository.compare(newest.release, release);
  if (relation === 'ahead') return;
  if (relation === 'identical' && current.release === release) return;
  const reason =
    relation === 'identical'
      ? `run ${newest.run} published it, and run ${current.run} has since restored ${current.release}`
      : relation === 'behind'
        ? `it is older than ${newest.release}, which run ${newest.run} published`
        : `it and ${newest.release}, which run ${newest.run} published, have diverged`;
  throw new Error(
    `Not publishing ${release}: ${reason}. Nothing was changed. Publish a newer commit, or go back to a verified release with the Restore workflow.`,
  );
}

/**
 * Uploads each asset the bucket lacks, or holds with other bytes or headers. A replaced one, as after a change to the
 * header table, may still be cached as immutable, so its path is invalidated with the pages'.
 */
async function uploadAssets(files: SiteFile[], { store }: Context) {
  const uploaded: string[] = [];
  const replaced: string[] = [];
  const kept: string[] = [];
  for (const file of files.filter(({ path }) => isAsset(path))) {
    const head = await store.head(file.path);
    if (head?.sha256 === file.sha256 && head.contentType === file.contentType && head.cacheControl === file.cacheControl) {
      kept.push(file.path);
      continue;
    }
    (head === undefined ? uploaded : replaced).push(file.path);
    await writeFile(store, file.path, file);
  }
  return { uploaded, replaced, kept };
}

function manifestOf(release: string, files: SiteFile[]): Manifest {
  return {
    release,
    files: files.map(({ path, sha256: hash, contentType, cacheControl, body }) => ({
      path,
      sha256: hash,
      size: body.length,
      contentType,
      cacheControl,
    })),
  };
}

/** Whether the release already has a saved copy; one with other files than this build fails, before any write. */
async function hasCopy(files: SiteFile[], release: string, { store }: Context): Promise<boolean> {
  const saved = await readManifest(store, release);
  if (saved === undefined) return false;
  if (!isDeepStrictEqual(saved, manifestOf(release, files))) {
    throw new Error(`The saved copy of ${release} has other files than this build. Nothing was published.`);
  }
  return true;
}

/** Saves a copy of the release under _releases/<commit>/, so it can be restored however long ago it was replaced. */
async function saveCopy(files: SiteFile[], release: string, { store }: Context): Promise<void> {
  for (const file of files) await writeFile(store, `${RECORDS}${release}/site/${file.path}`, file);
  await writeJson(store, `${RECORDS}${release}/manifest.json`, manifestOf(release, files));
}

/** Records the release as started, writes its pages, waits for the invalidation, and records it as published. */
async function publishPages(
  files: SiteFile[],
  replaced: string[],
  entries: Entry[],
  { action, release }: Pick<Entry, 'action' | 'release'>,
  { store, cdn, run, now }: Context,
): Promise<string[]> {
  const entry: Entry = { action, release, run, started: now() };
  entries.push(entry);
  await writeHistory(store, entries);
  for (const file of pageOrder(files)) await writeFile(store, file.path, file);
  const paths = [...invalidationPaths(files), ...replaced.map((path) => `/${path}`)].sort();
  await cdn.invalidate(paths, `${run}-${action}-${release}`);
  entry.published = now();
  await writeHistory(store, entries);
  return paths;
}

/** Publishes the built site in dir as the release of commit release. */
export async function publish(dir: string, release: string, repository: Repository, context: Context): Promise<Outcome> {
  requireCommit(release);
  const files = siteFiles(dir);
  const entries = await readHistory(context.store);
  await checkOrder(entries, release, repository);
  const saved = await hasCopy(files, release, context);
  const assets = await uploadAssets(files, context);
  if (saved) context.log(`The copy of ${release} is already saved.`);
  else await saveCopy(files, release, context);
  const invalidated = await publishPages(files, assets.replaced, entries, { action: 'publish', release }, context);
  return { release, ...assets, invalidated };
}

/**
 * The release to restore: named by its full commit SHA, which is fixed when the run starts, so a re-run, or a run that
 * waited behind another, restores the same release; and it must have passed its smoke test.
 */
function chooseRelease(entries: Entry[], requested: string): string {
  if (entries.length === 0) throw new Error('No release has been published yet, so there is none to restore.');
  const verified = [
    ...new Set(
      entries
        .filter((entry) => entry.verified !== undefined)
        .map((entry) => entry.release)
        .reverse(),
    ),
  ];
  if (COMMIT.test(requested) && verified.includes(requested)) return requested;
  const choices = verified.length === 0 ? 'none yet' : verified.slice(0, 5).join(', ');
  throw new Error(
    `Restore takes the full commit SHA of a release that passed its smoke test; got ${JSON.stringify(requested)}. ` +
      `Verified releases, newest first: ${choices}.`,
  );
}

/**
 * Publishes the saved copy of a verified release again, after checking each file against its manifest, and writes the
 * files to outDir for the smoke test.
 */
export async function restore(requested: string, outDir: string, context: Context): Promise<Outcome> {
  const { store } = context;
  const entries = await readHistory(store);
  const release = chooseRelease(entries, requested);
  const manifest = await readManifest(store, release);
  if (manifest === undefined) throw new Error(`${release} has no saved copy under ${RECORDS}${release}/.`);
  const files: SiteFile[] = [];
  for (const saved of manifest.files) {
    const body = await store.read(`${RECORDS}${release}/site/${saved.path}`);
    if (body === undefined) throw new Error(`The saved copy of ${release} is missing ${saved.path}. Nothing was restored.`);
    const file = describeFile(saved.path, body);
    if (file.sha256 !== saved.sha256) {
      throw new Error(`The saved copy of ${release} has a changed ${saved.path}. Nothing was restored.`);
    }
    files.push(file);
  }
  for (const file of files) {
    const target = join(outDir, ...file.path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.body);
  }
  const assets = await uploadAssets(files, context);
  const invalidated = await publishPages(files, assets.replaced, entries, { action: 'restore', release }, context);
  return { release, ...assets, invalidated };
}

/** Records the current release as verified; only the run that published it may, after its smoke test passed. */
export async function recordVerified({ store, run, now }: Context): Promise<Entry> {
  const entries = await readHistory(store);
  const current = entries.at(-1);
  if (current?.run !== run || current.published === undefined) {
    throw new Error(`Run ${run} did not publish the current release, so nothing was recorded as verified.`);
  }
  current.verified = now();
  await writeHistory(store, entries);
  return current;
}
