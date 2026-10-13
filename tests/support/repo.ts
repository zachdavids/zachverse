import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

// The repository policy suite reads the repo and runs its tools through these helpers. Coverage measures this
// file, so the 100% gate fails if that suite stops running.
export const root = new URL('../../', import.meta.url);
const rootPath = fileURLToPath(root);

// Reads by file system path. As a URL, "%41" in a name would read as "A", and "#" or "?" would end the name.
export const read = (path: string) => readFileSync(join(rootPath, path), 'utf8');
export const readJson = <T>(path: string) => JSON.parse(read(path)) as T;

// Runs a command in cwd (the repo root unless given) and returns its output; an exit status outside statuses fails
// with its error.
function run(command: string, args: string[], statuses = [0], env = process.env, cwd = rootPath) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  expect(result.error, command).toBeUndefined();
  expect(statuses, `${command} ${args.join(' ')} exited ${result.status}: ${result.stderr.trim()}`).toContain(
    result.status,
  );
  return result.stdout;
}

// git's output lines.
export const git = (args: string[], statuses?: number[]) => run('git', args, statuses).split(/\r?\n/).filter(Boolean);

// The files of the repo, or of the repository at dir, that match these git pathspecs, including new ones git does not
// ignore, but not tracked files deleted from the working tree, or a nested repository such as a git worktree, which
// git lists as a directory. -z lists names as they are; otherwise git quotes any name with non-ASCII characters, such
// as "caf\303\251.ts", and the quoted form names no file.
export function files(pathspecs: string[], dir = rootPath) {
  const args = ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...pathspecs];
  return run('git', args, [0], process.env, dir)
    .split('\0')
    .filter((file) => file !== '' && statSync(join(dir, file), { throwIfNoEntry: false })?.isFile());
}

// The root package's tsc, which also reads infra's tsconfig without infra's packages installed.
export const tsc = (args: string[]) =>
  run(process.execPath, [join(rootPath, 'node_modules/typescript/bin/tsc'), ...args]);

// The test files Vitest runs in a package ('' or 'infra/'), relative to the repo root. The root package's Vitest
// also reads infra's config without infra's packages installed, as in CI's web job. It gets none of the VITEST
// variables this worker has, such as VITEST_POOL_ID, so it runs as a fresh Vitest would.
export function vitestFiles(dir: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('VITEST')));
  const args = ['list', '--filesOnly', '--json', '--root', join(rootPath, dir)];
  const output = run(process.execPath, [join(rootPath, 'node_modules/vitest/vitest.mjs'), ...args], [0], env);
  return (JSON.parse(output) as { file: string }[]).map(({ file }) => relative(rootPath, file).split(sep).join('/'));
}
