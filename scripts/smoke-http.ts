// One HTTP request as `curl --connect-to` makes it: connected, if via is given, to that host (the distribution), while
// TLS and the Host header name the requested one, so the custom hostnames can be checked before DNS points at
// CloudFront. Redirects are returned rather than followed, so their Location can be checked.
import { lookup } from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import type { LookupFunction } from 'node:net';
import type { Reply } from './smoke-lib.ts';

export interface Transport {
  http: Pick<typeof http, 'request'>;
  https: Pick<typeof https, 'request'>;
}

export function request(url: string, via?: string, transport: Transport = { http, https }): Promise<Reply> {
  const target = new URL(url);
  const client = target.protocol === 'https:' ? transport.https : transport.http;
  // Resolves via instead of the requested host; the TLS server name and certificate check still use the requested one.
  const connectTo: LookupFunction | undefined =
    via === undefined ? undefined : (_hostname, options, callback) => lookup(via, options, callback);
  return new Promise((resolve, reject) => {
    const req = client.request(
      target,
      {
        // Required: the web ACL's Common Rule Set blocks a request without a User-Agent (ADR 0007).
        headers: { 'user-agent': 'zachverse-smoke-test' },
        lookup: connectTo,
        family: 4,
        timeout: 15_000,
        // A new connection for each request: a pooled one would go wherever its first request went, whatever via says.
        agent: false,
        // Explicit, so NODE_TLS_REJECT_UNAUTHORIZED=0 in the environment cannot turn the certificate check off.
        rejectUnauthorized: true,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`${url}: no response within 15 seconds`)));
    req.on('error', reject);
    req.end();
  });
}
