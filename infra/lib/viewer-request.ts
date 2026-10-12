import { readFileSync } from 'node:fs';
import * as path from 'node:path';

export const VIEWER_REQUEST_SOURCE = path.join(__dirname, '..', 'functions', 'viewer-request.js');

/** Returns the viewer-request function source with the site's hostnames filled in. */
export function viewerRequestCode(hosts: { domainName: string; wwwDomainName: string }, file = VIEWER_REQUEST_SOURCE): string {
  const source = readFileSync(file, 'utf8');
  for (const placeholder of ['__APEX_HOST__', '__WWW_HOST__']) {
    if (source.split(placeholder).length !== 2) {
      throw new Error(`${file} must contain ${placeholder} exactly once`);
    }
  }
  return source
    .replace('__APEX_HOST__', hosts.domainName.toLowerCase())
    .replace('__WWW_HOST__', hosts.wwwDomainName.toLowerCase());
}
