// Release mechanics (ADR 0006). The deploy and restore workflows run these with the deploy role, which can read and
// write the bucket's objects and delete pages, but not assets or release records, so a release never removes a file an
// earlier page may still load.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

/** Where the copy of each release and the release history live. The bucket policy keeps CloudFront from serving them. */
export const RECORDS = '_releases/';
const HISTORY = `${RECORDS}history.json`;
/** Replaced assets whose invalidation has not yet completed; see writeAssets. */
const PENDING = `${RECORDS}pending-invalidation.json`;

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
// A "." or ".." segment would name another object than its path suggests, and another file when restored to disk.
const isPlainPath = (path: string) => PLAIN_PATH.test(path) && !path.split('/').some((segment) => /^\.\.?$/.test(segment));
/** Where the hashed assets live; infra/lib/site-stack.ts keeps the deploy role from deleting anything under it. */
export const ASSETS = 'assets/';
// The content hash Vite puts in an asset's name: a hyphen and 8 characters before the extension. A word of 8 letters
// passes too, so tests/repo-policy.test.ts keeps public/, which Vite copies unhashed, from holding an assets/ directory.
// check:dist applies the same rule.
export const HASHED_NAME = /-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/;
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
  /** A rollback is a restore the deploy job made itself, after the release it published failed its smoke test. */
  action: 'publish' | 'restore' | 'rollback';
  /** The commit whose build is the release. */
  release: string;
  /**
   * The workflow run, as "<run ID>-<attempt>". The run ID says whose entry it is: a re-run of any of the run's jobs is
   * the same run. The attempt is kept for the record, and keeps each attempt's invalidation reference its own.
   */
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
  /** Every key in the bucket. */
  list(): Promise<string[]>;
  /** Deletes an object. The bucket is versioned, so this only hides it behind a delete marker; its versions stay. */
  remove(key: string): Promise<void>;
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
  /** Pages the bucket held that this release does not, deleted; their paths are invalidated too. */
  removed: string[];
  invalidated: string[];
}

export function sha256(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

export function isAsset(path: string): boolean {
  return path.startsWith(ASSETS);
}

const isIndex = (path: string) => /(?:^|\/)index\.html$/.test(path);

/** One file of a release, with the headers it is served with. Throws for a file no release may hold. */
export function describeFile(path: string, body: Buffer): SiteFile {
  if (!isPlainPath(path)) {
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
 * The release file a root-relative URL path gets, as infra/functions/viewer-request.js maps paths: a directory's
 * index.html, for a path ending in a slash or whose last segment has no dot. It leaves out the function's /.well-known/
 * exception, so such a path fails closed in the smoke test and the browser check's local server, which use it (ADR
 * 0006, "Limits"); tests/path-mapping.test.ts runs the real function against this copy.
 */
export function servedPath(url: string): string {
  const path = url.slice(1);
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name === '' ? `${path}index.html` : name.includes('.') ? path : `${path}/index.html`;
}

// The content types CloudFront compresses, of those CONTENT_TYPES gives files, and the sizes it compresses: 1,000 to
// 10,000,000 bytes (https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/ServingCompressedFiles.html,
// read 2026-10-18). The distribution's behavior compresses (infra/lib/site-stack.ts).
const COMPRESSED_TYPES = /^(?:text\/(?:html|javascript|css|plain)|application\/(?:json|xml)|image\/svg\+xml)(?:;|$)/;

/**
 * The encoding CloudFront would send file in to a browser that accepts the encodings named in acceptEncoding: Brotli
 * when the browser takes both it and gzip, as CloudFront prefers it, and none for a type or size it leaves alone.
 * check:dist measures the build by it, and the browser check's local server serves by it.
 */
export function encodingFor(file: Pick<SiteFile, 'contentType' | 'body'>, acceptEncoding = ''): 'br' | 'gzip' | null {
  const { length } = file.body;
  if (!COMPRESSED_TYPES.test(file.contentType) || length < 1000 || length > 10_000_000) return null;
  const accepted = acceptEncoding.toLowerCase().split(',').map((part) => part.split(';')[0]!.trim());
  if (accepted.includes('br')) return 'br';
  return accepted.includes('gzip') ? 'gzip' : null;
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

/**
 * Pages in the order they go out: other files first, then HTML, then each index.html, and the home page last, since it
 * links to every other page with an address (check:dist), so a page's references exist before it does.
 */
function pageOrder(files: SiteFile[]): SiteFile[] {
  const rank = (path: string) => (path === 'index.html' ? 3 : isIndex(path) ? 2 : path.endsWith('.html') ? 1 : 0);
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
    ACTIONS.has(value.action) &&
    typeof value.release === 'string' &&
    COMMIT.test(value.release) &&
    isText(value.run) &&
    isText(value.started) &&
    isOptionalText(value.published) &&
    isOptionalText(value.verified)
  );
}

/**
 * The history's format. Raise it for a new entry kind, a field that changes type, any new top-level field, or any field
 * older code must act on, so that older release code, as in a re-run of an old run or after a revert, refuses the
 * history rather than misreading it. Only an informational field inside entries needs no new format: older code ignores
 * it and writes it back unchanged, since it keeps each entry whole.
 */
const HISTORY_FORMAT = 1;
const ACTIONS: ReadonlySet<unknown> = new Set(['publish', 'restore', 'rollback']);

export async function readHistory(store: Store): Promise<Entry[]> {
  const history = await readJson(store, HISTORY);
  if (history === undefined) return [];
  const broken = () =>
    new Error(`${HISTORY} is not a release history. Restore its previous version before releasing again.`);
  if (!isRecord(history) || !Array.isArray(history.entries)) throw broken();
  // Histories from before the marker are format 1.
  const format = history.format ?? 1;
  if (!Number.isInteger(format) || (format as number) < 1) throw broken();
  const unknown = history.entries.find((entry) => isRecord(entry) && typeof entry.action === 'string' && !ACTIONS.has(entry.action));
  if ((format as number) > HISTORY_FORMAT || unknown !== undefined) {
    const what = unknown === undefined ? `format ${format}` : `an entry of the kind "${(unknown as Entry).action}"`;
    throw new Error(
      `${HISTORY} has ${what}, which newer release code wrote and this commit's does not know. Nothing was changed. Do not put back an older version of the history: run release code that knows it.`,
    );
  }
  if (!history.entries.every(isEntry)) throw broken();
  return history.entries as Entry[];
}

async function writeHistory(store: Store, entries: Entry[]): Promise<void> {
  await writeJson(store, HISTORY, { format: HISTORY_FORMAT, entries });
}

/** The run ID in "<run ID>-<attempt>": entries with the same one belong to the same workflow run. */
const runIdOf = (run: string) => run.split('-')[0];

/** The current release, as the messages name it. */
function describeEntry(entry: Entry | undefined): string {
  if (entry === undefined) return 'none yet';
  const state = entry.verified !== undefined ? 'verified' : entry.published !== undefined ? 'not verified' : 'unfinished';
  return `${entry.release} (${entry.action} by run ${entry.run}, ${state})`;
}

/** The asset paths a replacement left to invalidate. They become invalidation paths, so each must be a plain asset path. */
async function readPending(store: Store): Promise<string[]> {
  const record = await readJson(store, PENDING);
  if (record === undefined) return [];
  const isAssetPath = (path: unknown) => typeof path === 'string' && isAsset(path) && isPlainPath(path);
  if (!isRecord(record) || !Array.isArray(record.assets) || !record.assets.every(isAssetPath)) {
    throw new Error(`${PENDING} is not a list of assets to invalidate. Nothing was changed. Check it, and fix it by hand.`);
  }
  return record.assets as string[];
}

async function writePending(store: Store, assets: string[]): Promise<void> {
  await writeJson(store, PENDING, { assets });
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
 * old one (ADR 0005). Publishing the same commit again is a retry, allowed while it is the current release, or when the
 * current release is an automatic rollback from it, after its checks failed.
 *
 * A restore someone ran holds deploys: nothing is published over it, so the next push cannot quietly bring back what
 * was restored away, until a run started by hand asks to resume (release.ts honours that on a run's first attempt only).
 * That run may also publish the release the restore replaced again.
 */
export async function checkOrder(
  entries: Entry[],
  release: string,
  repository: Repository,
  resume = false,
): Promise<void> {
  const current = entries.at(-1);
  if (current?.action === 'restore' && !resume) {
    throw new Error(
      `Not publishing ${release}: deploys are held, since run ${current.run} restored ${current.release}. Nothing was changed. To publish over the restore, run the Deploy workflow on main by hand with "Publish over a restore" checked.`,
    );
  }
  const newest = entries.findLast((entry) => entry.action === 'publish');
  if (current === undefined || newest === undefined) return;
  const relation = await repository.compare(newest.release, release);
  if (relation === 'ahead') return;
  // The release a rollback replaced: the entry before the run's rollbacks, of which a re-run of its jobs may add more.
  const rolledBackFrom =
    current.action === 'rollback'
      ? entries.findLast((entry) => entry.action !== 'rollback' || runIdOf(entry.run) !== runIdOf(current.run))
      : undefined;
  if (relation === 'identical' && (resume || current.release === release || rolledBackFrom?.release === release)) return;
  const reason =
    relation === 'identical'
      ? `run ${newest.run} published it, and the site has since gone back to ${current.release}`
      : relation === 'behind'
        ? `it is older than ${newest.release}, which run ${newest.run} published`
        : `it and ${newest.release}, which run ${newest.run} published, have diverged`;
  throw new Error(
    `Not publishing ${release}: ${reason}. Nothing was changed. Publish a newer commit, or go back to a verified release with the Restore workflow.`,
  );
}

/**
 * Sorts the release's assets, without writing any: those the bucket lacks, to upload; those it holds with other bytes or
 * headers, as after a change to the header table, to replace; and the rest, to keep.
 */
async function planAssets(files: SiteFile[], { store }: Context) {
  const uploaded: string[] = [];
  const replaced: string[] = [];
  const kept: string[] = [];
  for (const file of files.filter(({ path }) => isAsset(path))) {
    const head = await store.head(file.path);
    const same =
      head?.sha256 === file.sha256 && head.contentType === file.contentType && head.cacheControl === file.cacheControl;
    (same ? kept : head === undefined ? uploaded : replaced).push(file.path);
  }
  return { uploaded, replaced, kept };
}

/**
 * Uploads and replaces the planned assets, and returns the asset paths to invalidate. A replaced asset may still be
 * cached as immutable, so before it is overwritten its path joins the pending record, which every publish, restore, and
 * rollback invalidates until an invalidation that includes it completes: a run that fails in between leaves it to the
 * next, which would otherwise find the new copy in place and never invalidate it.
 */
async function writeAssets(
  files: SiteFile[],
  { uploaded, replaced }: { uploaded: string[]; replaced: string[] },
  pending: string[],
  { store }: Context,
): Promise<string[]> {
  const toInvalidate = [...new Set([...pending, ...replaced])].sort();
  if (toInvalidate.length > pending.length) await writePending(store, toInvalidate);
  const writes = new Set([...uploaded, ...replaced]);
  for (const file of files) if (writes.has(file.path)) await writeFile(store, file.path, file);
  return toInvalidate;
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

/**
 * The pages the bucket holds that this release does not: every key but the release's own files, the assets, which
 * earlier pages may still load, and the release records. Throws, before any write, on a key no release would write,
 * which could be anything, and whose path, as one to invalidate, could even be a wildcard.
 */
async function stalePages(files: SiteFile[], store: Store): Promise<string[]> {
  const own = new Set(files.map(({ path }) => path));
  const stale = (await store.list()).filter((key) => !isAsset(key) && !key.startsWith(RECORDS) && !own.has(key)).sort();
  const odd = stale.filter((key) => !isPlainPath(key));
  if (odd.length > 0) {
    throw new Error(
      `Nothing was changed: the bucket holds ${odd.join(', ')}, which no release would write. Check, and remove by hand what does not belong.`,
    );
  }
  return stale;
}

/**
 * Records the release as started, writes its pages, deletes the stale ones, waits for the invalidation of them all and
 * of the assets to invalidate, clears the pending record, and records the release as published.
 */
async function publishPages(
  files: SiteFile[],
  assetsToInvalidate: string[],
  removed: string[],
  entries: Entry[],
  { action, release }: Pick<Entry, 'action' | 'release'>,
  { store, cdn, run, now }: Context,
): Promise<{ removed: string[]; invalidated: string[] }> {
  const entry: Entry = { action, release, run, started: now() };
  entries.push(entry);
  await writeHistory(store, entries);
  for (const file of pageOrder(files)) await writeFile(store, file.path, file);
  for (const key of removed) await store.remove(key);
  const pages = invalidationPaths([...files, ...removed.map((path) => ({ path }))]);
  const invalidated = [...pages, ...assetsToInvalidate.map((path) => `/${path}`)].sort();
  // The attempt is part of the reference: CloudFront answers a reused one with the earlier invalidation.
  await cdn.invalidate(invalidated, `${run}-${action}-${release}`);
  if (assetsToInvalidate.length > 0) await writePending(store, []);
  entry.published = now();
  await writeHistory(store, entries);
  return { removed, invalidated };
}

/**
 * Publishes the built site in dir as the release of commit release. resume is set by a run started by hand to publish
 * over a restore, which otherwise holds deploys.
 */
export async function publish(
  dir: string,
  release: string,
  repository: Repository,
  context: Context,
  resume = false,
): Promise<Outcome> {
  requireCommit(release);
  const files = siteFiles(dir);
  const { store } = context;
  const entries = await readHistory(store);
  // Everything that can refuse the release does so before the first write.
  await checkOrder(entries, release, repository, resume);
  const saved = await hasCopy(files, release, context);
  const pending = await readPending(store);
  const removed = await stalePages(files, store);
  const assets = await planAssets(files, context);
  const assetsToInvalidate = await writeAssets(files, assets, pending, context);
  if (saved) context.log(`The copy of ${release} is already saved.`);
  else await saveCopy(files, release, context);
  const action = 'publish';
  const pages = await publishPages(files, assetsToInvalidate, removed, entries, { action, release }, context);
  return { release, ...assets, ...pages };
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
  const entries = await readHistory(context.store);
  return republish(chooseRelease(entries, requested), 'restore', entries, outDir, context);
}

/**
 * After the release this run started fails to publish or fails its checks, publishes again, as restore does, the newest
 * release before it that passed its checks or that someone restored, and writes its files to outDir for the smoke test.
 * A restore counts even if its own checks failed: it names a release that had passed them, and rolling back past it
 * would put back the release it restored away from. Returns undefined, changing nothing, when the current release is
 * not one this run (any attempt of it) started and left unverified, as when it was refused or failed before writing a
 * page, or when there is no such earlier release.
 */
export async function rollBack(outDir: string, context: Context): Promise<Outcome | undefined> {
  const entries = await readHistory(context.store);
  const current = entries.at(-1);
  if (current === undefined || runIdOf(current.run) !== runIdOf(context.run) || current.verified !== undefined) {
    context.log(
      `Nothing to roll back: the current release is ${describeEntry(current)}, not one run ${context.run} started and left unverified.`,
    );
    return undefined;
  }
  const target = entries.slice(0, -1).findLast((entry) => entry.verified !== undefined || entry.action === 'restore');
  if (target === undefined) {
    context.log(`No release before ${current.release} passed its checks or was restored, so there is none to roll back to.`);
    return undefined;
  }
  return republish(target.release, 'rollback', entries, outDir, context);
}

async function republish(
  release: string,
  action: 'restore' | 'rollback',
  entries: Entry[],
  outDir: string,
  context: Context,
): Promise<Outcome> {
  const { store } = context;
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
  const pending = await readPending(store);
  const removed = await stalePages(files, store);
  const assets = await planAssets(files, context);
  for (const file of files) {
    const target = join(outDir, ...file.path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.body);
  }
  const assetsToInvalidate = await writeAssets(files, assets, pending, context);
  const pages = await publishPages(files, assetsToInvalidate, removed, entries, { action, release }, context);
  return { release, ...assets, ...pages };
}

/**
 * Records the current release as verified. Only the run that finished publishing it may, in any attempt: a re-run of
 * the failed jobs that passes the checks finishes what the earlier attempt started.
 */
export async function recordVerified({ store, run, now }: Context): Promise<Entry> {
  const entries = await readHistory(store);
  const current = entries.at(-1);
  if (current === undefined || runIdOf(current.run) !== runIdOf(run) || current.published === undefined) {
    throw new Error(
      `Nothing was recorded as verified: the current release is ${describeEntry(current)}, and only one that run ${run} finished publishing can be.`,
    );
  }
  current.verified = now();
  await writeHistory(store, entries);
  return current;
}
