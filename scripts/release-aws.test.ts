import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Aws, awsVersion, cloudfrontCdn, runAws, s3Store } from './release-aws.ts';

const execFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile }));

afterEach(() => {
  execFile.mockReset();
});

// How runAws rejects for a missing key, which S3 reports when the caller may list the bucket: head-object's code is a
// bare 404, and get-object's NoSuchKey (what CLI 2.37 prints for both, with --cli-error-format json).
const missing = (operation: string, code: string) =>
  Object.assign(new Error(`aws s3api ${operation}: ${code}: Not Found`), { code });

describe('runAws', () => {
  type Callback = (error: Error | null, stdout: string, stderr: string) => void;

  it('runs the AWS CLI in us-east-1 and resolves with its output', async () => {
    execFile.mockImplementation((_file: string, _args: string[], _options: object, callback: Callback) =>
      callback(null, '{"ok":true}', ''),
    );
    await expect(runAws(['s3api', 'head-object', '--key', 'x'])).resolves.toBe('{"ok":true}');
    expect(execFile).toHaveBeenCalledExactlyOnceWith(
      'aws',
      ['s3api', 'head-object', '--key', 'x', '--region', 'us-east-1', '--cli-error-format', 'json'],
      { maxBuffer: 16 * 1024 * 1024 },
      expect.any(Function),
    );
  });

  it("rejects with AWS's error code and message on one line, from the CLI's JSON error", async () => {
    // As CLI 2.37 prints a service error with --cli-error-format json, indented over several lines.
    const json = (code: string, message: unknown) => `{\n    "Code": "${code}",\n    "Message": ${JSON.stringify(message)}\n}\n`;
    for (const [stderr, message, code] of [
      [json('404', 'Not Found'), 'aws s3api head-object: 404: Not Found', '404'],
      [json('AccessDenied', 'Access\nDenied'), 'aws s3api head-object: AccessDenied: Access Denied', 'AccessDenied'],
      [`\n${json('Throttling', null)}`, 'aws s3api head-object: Throttling: ', 'Throttling'],
    ]) {
      execFile.mockImplementationOnce((_file: string, _args: string[], _options: object, callback: Callback) =>
        callback(new Error('exit 254'), '', stderr!),
      );
      const error = await runAws(['s3api', 'head-object']).catch((rejection: unknown) => rejection);
      expect(error).toEqual(expect.objectContaining({ message, code }));
    }
  });

  it("rejects with the last line of the CLI's text, or the process error when the CLI printed none", async () => {
    // Failures before AWS answers, such as an unknown option, stay text, after a usage message.
    execFile.mockImplementationOnce((_file: string, _args: string[], _options: object, callback: Callback) =>
      callback(new Error('exit 252'), '', '\nusage: aws [options]\n\naws: [ERROR]: Unknown options: --cli-error-format\n'),
    );
    const unknown = await runAws(['s3api', 'put-object']).catch((rejection: unknown) => rejection);
    expect(unknown).toEqual(expect.objectContaining({ message: 'aws s3api put-object: aws: [ERROR]: Unknown options: --cli-error-format' }));
    expect((unknown as { code?: unknown }).code).toBeUndefined();
    // Braces that are not AWS's error JSON stay text too.
    for (const stderr of ['{not json}\n', '{"Message": "no code"}\n']) {
      execFile.mockImplementationOnce((_file: string, _args: string[], _options: object, callback: Callback) =>
        callback(new Error('exit 255'), '', stderr),
      );
      await expect(runAws(['s3api', 'put-object'])).rejects.toThrow(`aws s3api put-object: ${stderr.trim()}`);
    }
    execFile.mockImplementationOnce((_file: string, _args: string[], _options: object, callback: Callback) =>
      callback(new Error('spawn aws ENOENT'), '', ''),
    );
    await expect(runAws(['cloudfront', 'wait'])).rejects.toThrow('aws cloudfront wait: spawn aws ENOENT');
  });
});

describe('awsVersion', () => {
  it("reports the CLI's version line, or unknown when the CLI does not run", async () => {
    execFile.mockImplementationOnce((_file: string, _args: string[], callback: (error: Error | null, stdout: string) => void) =>
      callback(null, 'aws-cli/2.37.13 Python/3.13.11 Linux/6.8.0 exe/x86_64.ubuntu.24\n'),
    );
    expect(await awsVersion()).toBe('aws-cli/2.37.13 Python/3.13.11 Linux/6.8.0 exe/x86_64.ubuntu.24');
    expect(execFile.mock.calls[0]?.slice(0, 2)).toEqual(['aws', ['--version']]);
    execFile.mockImplementationOnce((_file: string, _args: string[], callback: (error: Error | null, stdout: string) => void) =>
      callback(new Error('spawn aws ENOENT'), ''),
    );
    expect(await awsVersion()).toBe('unknown');
  });
});

describe('s3Store', () => {
  it('heads an object with its SHA-256 checksum, as hex, and its headers', async () => {
    const aws = vi.fn<Aws>().mockResolvedValue(
      JSON.stringify({
        ChecksumSHA256: Buffer.from('ab'.repeat(32), 'hex').toString('base64'),
        ContentType: 'text/html; charset=utf-8',
        CacheControl: 'no-cache',
      }),
    );
    expect(await s3Store('bucket', aws).head('index.html')).toEqual({
      sha256: 'ab'.repeat(32),
      contentType: 'text/html; charset=utf-8',
      cacheControl: 'no-cache',
    });
    expect(aws).toHaveBeenCalledExactlyOnceWith([
      's3api',
      'head-object',
      '--bucket',
      'bucket',
      '--key',
      'index.html',
      '--checksum-mode',
      'ENABLED',
      '--output',
      'json',
    ]);
  });

  it('heads an object stored without a SHA-256 checksum, and a missing one as undefined', async () => {
    const aws = vi
      .fn<Aws>()
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce('{"ChecksumSHA256": ""}')
      .mockRejectedValueOnce(missing('HeadObject', '404'));
    const store = s3Store('bucket', aws);
    expect(await store.head('a')).toEqual({ sha256: undefined, contentType: undefined, cacheControl: undefined });
    expect((await store.head('b'))?.sha256).toBeUndefined();
    expect(await store.head('c')).toBeUndefined();
  });

  it('reads an object through a temporary file, which it removes, and a missing one as undefined', async () => {
    let file = '';
    const aws = vi.fn<Aws>(async (args) => {
      file = args.at(-1)!;
      writeFileSync(file, 'body');
      return '{}';
    });
    expect((await s3Store('bucket', aws).read('robots.txt'))?.toString()).toBe('body');
    expect(aws.mock.calls[0]?.[0].slice(0, -1)).toEqual(['s3api', 'get-object', '--bucket', 'bucket', '--key', 'robots.txt']);
    expect(existsSync(dirname(file))).toBe(false);

    const absent = vi.fn<Aws>().mockRejectedValue(missing('GetObject', 'NoSuchKey'));
    expect(await s3Store('bucket', absent).read('x')).toBeUndefined();
  });

  it('writes an object with its headers and a checksum S3 checks, through a temporary file it removes', async () => {
    let body = '';
    let file = '';
    const aws = vi.fn<Aws>(async (args) => {
      file = args[args.indexOf('--body') + 1]!;
      body = readFileSync(file, 'utf8');
      return '{}';
    });
    await s3Store('bucket', aws).write('index.html', Buffer.from('<p>'), {
      sha256: 'ab'.repeat(32),
      contentType: 'text/html; charset=utf-8',
      cacheControl: 'no-cache',
    });
    expect(body).toBe('<p>');
    expect(aws).toHaveBeenCalledExactlyOnceWith([
      's3api',
      'put-object',
      '--bucket',
      'bucket',
      '--key',
      'index.html',
      '--body',
      file,
      '--content-type',
      'text/html; charset=utf-8',
      '--cache-control',
      'no-cache',
      '--checksum-sha256',
      Buffer.from('ab'.repeat(32), 'hex').toString('base64'),
    ]);
    expect(existsSync(dirname(file))).toBe(false);
  });

  it('passes on every other error, still removing its temporary files', async () => {
    // As runAws rejects for a service error: head-object gets a bare status (a HEAD reply has no body to name an error
    // in), get-object a named code. Reading any of these as "missing" would make a denied or throttled read of the
    // history look like no history at all.
    const shaped = (code: string) => Object.assign(new Error(`aws s3api op: ${code}: denied`), { code });
    for (const code of ['403', '500', '503']) {
      const error = shaped(code);
      await expect(s3Store('bucket', vi.fn<Aws>().mockRejectedValue(error)).head('x')).rejects.toBe(error);
    }
    for (const code of ['AccessDenied', 'SlowDown', 'InternalError', 'ExpiredToken']) {
      const error = shaped(code);
      await expect(s3Store('bucket', vi.fn<Aws>().mockRejectedValue(error)).read('x')).rejects.toBe(error);
    }
    let file = '';
    const failing = vi.fn<Aws>(async (args) => {
      file = args.find((arg) => arg.includes('zachverse-release-')) ?? '';
      // A failure before AWS answers, such as no network, has no code.
      throw new Error('aws s3api put-object: Could not connect to the endpoint URL');
    });
    const store = s3Store('bucket', failing);
    await expect(store.head('x')).rejects.toThrow('Could not connect');
    await expect(store.read('x')).rejects.toThrow('Could not connect');
    expect(existsSync(dirname(file))).toBe(false);
    await expect(store.write('x', Buffer.from(''), { sha256: '00', contentType: 't', cacheControl: 'c' })).rejects.toThrow(
      'Could not connect',
    );
    expect(existsSync(dirname(file))).toBe(false);
    await expect(s3Store('bucket', vi.fn<Aws>().mockRejectedValue('not an Error')).head('x')).rejects.toBe('not an Error');
  });
});

describe('s3Store listing and deleting', () => {
  it('lists every key in the bucket, and none in an empty one', async () => {
    const aws = vi.fn<Aws>().mockResolvedValueOnce('["index.html", "assets/a-AbCd1234.js"]').mockResolvedValueOnce('null');
    const store = s3Store('bucket', aws);
    expect(await store.list()).toEqual(['index.html', 'assets/a-AbCd1234.js']);
    expect(await store.list()).toEqual([]);
    expect(aws.mock.calls[0]?.[0]).toEqual([
      's3api',
      'list-objects-v2',
      '--bucket',
      'bucket',
      '--query',
      'Contents[].Key',
      '--output',
      'json',
    ]);
  });

  it('deletes an object by its key', async () => {
    const aws = vi.fn<Aws>().mockResolvedValue('{}');
    await s3Store('bucket', aws).remove('about/index.html');
    expect(aws).toHaveBeenCalledExactlyOnceWith(['s3api', 'delete-object', '--bucket', 'bucket', '--key', 'about/index.html']);
  });
});

describe('cloudfrontCdn', () => {
  it('creates an invalidation for the paths and waits for it to complete', async () => {
    const aws = vi.fn<Aws>().mockResolvedValueOnce('{"Invalidation": {"Id": "I123"}}').mockResolvedValueOnce('');
    await cloudfrontCdn('E3R8NEUOW8Z97U', aws).invalidate(['/', '/index.html'], '7-1-publish-abc');
    expect(aws.mock.calls).toEqual([
      [
        [
          'cloudfront',
          'create-invalidation',
          '--distribution-id',
          'E3R8NEUOW8Z97U',
          '--invalidation-batch',
          '{"Paths":{"Quantity":2,"Items":["/","/index.html"]},"CallerReference":"7-1-publish-abc"}',
          '--output',
          'json',
        ],
      ],
      [['cloudfront', 'wait', 'invalidation-completed', '--distribution-id', 'E3R8NEUOW8Z97U', '--id', 'I123']],
    ]);
  });
});
