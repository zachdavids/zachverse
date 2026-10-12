import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

// The repository policy suite reads the repo and runs its tools through these helpers. Coverage measures this
// file, so the 100% gate fails if that suite stops running.
export const root = new URL('../../', import.meta.url);
const rootPath = fileURLToPath(root);

// Reads by file system path. As a URL, "%41" in a name would read as "A", and "#" or "?" would end the name.
export const read = (path: string) => readFileSync(join(rootPath, path), 'utf8');
export const readJson = <T>(path: string) => JSON.parse(read(path)) as T;

// Runs a command at the repo root and returns its output; an exit status outside statuses fails with its error.
function run(command: string, args: string[], statuses = [0]) {
  const result = spawnSync(command, args, { cwd: rootPath, encoding: 'utf8' });
  expect(result.error, command).toBeUndefined();
  expect(statuses, `${command} ${args.join(' ')} exited ${result.status}: ${result.stderr.trim()}`).toContain(
    result.status,
  );
  return result.stdout;
}

// git's output lines.
export const git = (args: string[], statuses?: number[]) => run('git', args, statuses).split(/\r?\n/).filter(Boolean);

// The repo's files that match these git pathspecs, including new ones git does not ignore, but not tracked files
// deleted from the working tree. -z lists names as they are; otherwise git quotes any name with non-ASCII
// characters, such as "caf\303\251.ts", and the quoted form names no file.
export const files = (pathspecs: string[]) =>
  run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...pathspecs])
    .split('\0')
    .filter((file) => file !== '' && existsSync(join(rootPath, file)));

// The root package's tsc, which also reads infra's tsconfig without infra's packages installed.
export const tsc = (args: string[]) =>
  run(process.execPath, [join(rootPath, 'node_modules/typescript/bin/tsc'), ...args]);
