import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { request, type Transport } from './smoke-http.ts';

// Answers every request with its Host header and path, and /redirect with a 301.
const server = http.createServer((req, res) => {
  res.writeHead(req.url === '/redirect' ? 301 : 200, { location: '/elsewhere', 'x-host': req.headers.host });
  res.end(`body of ${req.url}`);
});
let port = 0;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// A client whose request never reaches the network: it records its options and lets the test drive its events.
function fakeClient() {
  const req = Object.assign(new EventEmitter(), {
    end: vi.fn(),
    destroy: vi.fn((error: Error) => req.emit('error', error)),
  });
  const res = Object.assign(new EventEmitter(), { statusCode: undefined as number | undefined, headers: {} });
  const client = {
    request: vi.fn((_url: URL, _options: http.RequestOptions, callback: (res: unknown) => void) => {
      queueMicrotask(() => callback(res));
      return req;
    }),
  };
  return { req, res, client };
}

describe('request', () => {
  it("connects to via while naming the URL's host, and returns a redirect without following it", async () => {
    const reply = await request(`http://smoke.invalid:${port}/redirect`, 'localhost');
    expect(reply.status).toBe(301);
    expect(reply.headers.location).toBe('/elsewhere');
    expect(reply.headers['x-host']).toBe(`smoke.invalid:${port}`);
    expect(reply.body.toString()).toBe('body of /redirect');
  });

  it("connects to the URL's own host when no via is given", async () => {
    const reply = await request(`http://127.0.0.1:${port}/page`);
    expect({ status: reply.status, body: reply.body.toString() }).toEqual({ status: 200, body: 'body of /page' });
  });

  it('makes https URLs with the https client, an IPv4 connection, a user agent, and a 15-second timeout', async () => {
    const { res, client } = fakeClient();
    const unused = { request: vi.fn() };
    const transport = { http: unused, https: client } as unknown as Transport;
    const pending = request('https://example.com/a?b=c', 'd111111abcdef8.cloudfront.net', transport);
    await vi.waitFor(() => expect(client.request).toHaveBeenCalled());
    res.statusCode = 404;
    res.emit('data', Buffer.from('not '));
    res.emit('data', Buffer.from('found'));
    res.emit('end');
    expect(await pending).toEqual({ status: 404, headers: {}, body: Buffer.from('not found') });
    const [url, options] = client.request.mock.calls[0]!;
    expect(url.href).toBe('https://example.com/a?b=c');
    expect(options).toEqual({
      headers: { 'user-agent': 'zachverse-smoke-test' },
      lookup: expect.any(Function),
      family: 4,
      timeout: 15_000,
    });
    expect(unused.request).not.toHaveBeenCalled();
  });

  it('gives no lookup without via, and reports a missing status as 0', async () => {
    const { res, client } = fakeClient();
    const pending = request('http://example.com/', undefined, { http: client, https: client } as unknown as Transport);
    await vi.waitFor(() => expect(client.request).toHaveBeenCalled());
    res.emit('end');
    expect((await pending).status).toBe(0);
    expect(client.request.mock.calls[0]![1].lookup).toBeUndefined();
  });

  it('fails on a timeout, a request error, or a response error', async () => {
    const timedOut = fakeClient();
    const transport = (client: unknown) => ({ http: client, https: client }) as unknown as Transport;
    const late = request('http://example.com/slow', undefined, transport(timedOut.client));
    timedOut.req.emit('timeout');
    await expect(late).rejects.toThrow('http://example.com/slow: no response within 15 seconds');

    const refused = fakeClient();
    const failed = request('http://example.com/', undefined, transport(refused.client));
    refused.req.emit('error', new Error('connect ECONNREFUSED'));
    await expect(failed).rejects.toThrow('connect ECONNREFUSED');

    const broken = fakeClient();
    const cut = request('http://example.com/', undefined, transport(broken.client));
    await vi.waitFor(() => expect(broken.client.request).toHaveBeenCalled());
    await new Promise((resolve) => setImmediate(resolve));
    broken.res.emit('error', new Error('socket hang up'));
    await expect(cut).rejects.toThrow('socket hang up');
  });
});
