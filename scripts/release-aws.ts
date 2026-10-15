// The bucket and the distribution, through the AWS CLI that GitHub's Ubuntu runners include, so the jobs that hold the
// deploy role install nothing. Every command names us-east-1, where the bucket is (ADR 0002).
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Cdn, Store } from './release-lib.ts';

/**
 * Runs the AWS CLI and resolves with its output. When it fails, rejects with a one-line message and, when AWS answered
 * with an error, its code.
 */
export type Aws = (args: string[]) => Promise<string>;

/** AWS's error code and message, from the JSON the CLI prints for a service error with --cli-error-format json. */
function serviceError(stderr: string): { code: string; message: string } | undefined {
  try {
    const reply = JSON.parse(stderr.slice(stderr.indexOf('{'), stderr.lastIndexOf('}') + 1)) as unknown;
    if (typeof reply === 'object' && reply !== null && typeof (reply as { Code?: unknown }).Code === 'string') {
      const { Code: code, Message: message } = reply as { Code: string; Message?: unknown };
      return { code, message: typeof message === 'string' ? message.replace(/\s+/g, ' ') : '' };
    }
  } catch {
    // Not JSON: the CLI prints other failures, such as an unknown option, as text.
  }
  return undefined;
}

export const runAws: Aws = (args) =>
  new Promise((resolve, reject) => {
    // AWS's error codes, unlike the CLI's wording of them, do not change with the CLI. The option needs CLI 2.34 or later.
    const command = [...args, '--region', 'us-east-1', '--cli-error-format', 'json'];
    execFile('aws', command, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      const where = `aws ${args.slice(0, 2).join(' ')}`;
      const reply = serviceError(stderr);
      const text = stderr.trim().split('\n').filter(Boolean).at(-1) ?? error.message;
      reject(reply ? Object.assign(new Error(`${where}: ${reply.code}: ${reply.message}`), { code: reply.code }) : new Error(`${where}: ${text}`));
    });
  });

/** The AWS CLI's version, for the release report. */
export function awsVersion(): Promise<string> {
  return new Promise((resolve) => {
    execFile('aws', ['--version'], (error, stdout) => resolve(error ? 'unknown' : stdout.trim()));
  });
}

// S3 answers 404 for a missing key because the role may list the bucket; without that it would answer 403. head-object
// gets a bare 404 (a HEAD reply has no body to name an error in), and get-object NoSuchKey.
const isMissing = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === '404' || code === 'NoSuchKey';
};

/** Runs action with a new temporary directory, and removes it afterwards. */
async function inScratch<T>(action: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'zachverse-release-'));
  try {
    return await action(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function s3Store(bucket: string, aws: Aws = runAws): Store {
  return {
    async head(key) {
      try {
        const args = ['s3api', 'head-object', '--bucket', bucket, '--key', key, '--checksum-mode', 'ENABLED'];
        const head = JSON.parse(await aws([...args, '--output', 'json'])) as {
          ChecksumSHA256?: string;
          ContentType?: string;
          CacheControl?: string;
        };
        // A whole-object SHA-256 in base64, present when the object was uploaded with one, as write uploads.
        const sha256 = head.ChecksumSHA256 && Buffer.from(head.ChecksumSHA256, 'base64').toString('hex');
        return { sha256: sha256 || undefined, contentType: head.ContentType, cacheControl: head.CacheControl };
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    },

    read: (key) =>
      inScratch(async (dir) => {
        const file = join(dir, 'object');
        try {
          await aws(['s3api', 'get-object', '--bucket', bucket, '--key', key, file]);
        } catch (error) {
          if (isMissing(error)) return undefined;
          throw error;
        }
        return readFileSync(file);
      }),

    async list() {
      // The CLI reads every page of the listing before it applies the query; an empty bucket has no Contents.
      const args = ['s3api', 'list-objects-v2', '--bucket', bucket, '--query', 'Contents[].Key'];
      return (JSON.parse(await aws([...args, '--output', 'json'])) as string[] | null) ?? [];
    },

    async remove(key) {
      await aws(['s3api', 'delete-object', '--bucket', bucket, '--key', key]);
    },

    write: (key, body, { sha256, contentType, cacheControl }) =>
      inScratch(async (dir) => {
        const file = join(dir, 'body');
        writeFileSync(file, body);
        // S3 checks the upload against this checksum and refuses it if they differ.
        const checksum = Buffer.from(sha256, 'hex').toString('base64');
        await aws([
          's3api',
          'put-object',
          '--bucket',
          bucket,
          '--key',
          key,
          '--body',
          file,
          '--content-type',
          contentType,
          '--cache-control',
          cacheControl,
          '--checksum-sha256',
          checksum,
        ]);
      }),
  };
}

export function cloudfrontCdn(distributionId: string, aws: Aws = runAws): Cdn {
  return {
    async invalidate(paths, reference) {
      // A repeated caller reference with the same paths returns the earlier invalidation instead of creating one.
      const batch = JSON.stringify({ Paths: { Quantity: paths.length, Items: paths }, CallerReference: reference });
      const args = ['cloudfront', 'create-invalidation', '--distribution-id', distributionId, '--invalidation-batch', batch];
      const { Invalidation } = JSON.parse(await aws([...args, '--output', 'json'])) as { Invalidation: { Id: string } };
      // The CLI's waiter polls every 20 seconds and gives up, failing, after 10 minutes.
      await aws(['cloudfront', 'wait', 'invalidation-completed', '--distribution-id', distributionId, '--id', Invalidation.Id]);
    },
  };
}
