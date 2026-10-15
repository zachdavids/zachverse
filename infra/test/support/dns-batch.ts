// Validates Route 53 change batches (the JSON passed to
// `aws route53 change-resource-record-sets --change-batch`) kept in infra/dns/.
// Website batches may only touch website routing and ACM validation records,
// may never delete a validation record, and may give the site certificate's
// validation records no value but the one committed.
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { ACM_VALIDATION_NAME } from '../../lib/guardrails/checks';
import type { Json } from '../../lib/guardrails/template';

const ACM_VALIDATION_VALUE = /^_[0-9a-f]{32}\.[a-z0-9]+\.acm-validations\.aws$/;
// Validation records stay while a certificate for these names is in use, which no batch can show, so no DELETE passes.
const KEEP_VALIDATION = 'ACM validation records may not be deleted: ACM renews a certificate for these names only while they resolve';
// A Map, so a record named "constructor" or "__proto__" cannot reach Object.prototype.
const WEBSITE_RECORDS = new Map([
  ['zachdavids.com', ['A', 'AAAA']],
  ['www.zachdavids.com', ['A', 'AAAA', 'CNAME']],
]);
/** Alias hosted zone ID that CloudFront distributions always use. */
const CLOUDFRONT_ALIAS_ZONE = 'Z2FDTNDATAQYW2';

const normalize = (name: string) => name.toLowerCase().replace(/\.$/, '');

/**
 * The site certificate's validation records, as its committed batch creates them: each name with its value, both
 * normalized. While the certificate is in use no other value is right for these names, and ACM renews it only while
 * they resolve.
 */
const SITE_CERTIFICATE_VALIDATION = new Map<string, string>(
  JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'dns', '2026-10-13-acm-validation.json'), 'utf8'))
    .Changes.map(({ ResourceRecordSet: rrs }: Json) => [normalize(rrs.Name), normalize(rrs.ResourceRecords[0].Value)]),
);

export function dnsBatchViolations(batch: Json): string[] {
  const out: string[] = [];
  const changes: Json[] = batch?.Changes ?? [];
  if (!Array.isArray(changes) || changes.length === 0) return ['batch has no Changes'];

  changes.forEach((change, i) => {
    const rrs = change?.ResourceRecordSet ?? {};
    const name = normalize(String(rrs.Name ?? ''));
    const where = `change ${i} (${change?.Action} ${rrs.Type} ${name})`;
    if (!['CREATE', 'UPSERT', 'DELETE'].includes(change?.Action)) out.push(`${where}: unknown action`);

    if (ACM_VALIDATION_NAME.test(name)) {
      if (change?.Action === 'DELETE') out.push(`${where}: ${KEEP_VALIDATION}`);
      if (rrs.Type !== 'CNAME') out.push(`${where}: ACM validation records must be CNAME`);
      const records: Json[] = Array.isArray(rrs.ResourceRecords) ? rrs.ResourceRecords : [];
      // An alias (or no value at all) would skip the value check below.
      if (records.length === 0) out.push(`${where}: ACM validation records need a value, not an alias`);
      const committed = SITE_CERTIFICATE_VALIDATION.get(name);
      for (const record of records) {
        const value = normalize(String(record?.Value));
        if (!ACM_VALIDATION_VALUE.test(value)) {
          out.push(`${where}: value is not an ACM validation target`);
        } else if (committed !== undefined && value !== committed) {
          out.push(`${where}: the site certificate validates through this record, so its value must stay ${committed}`);
        }
      }
      return;
    }

    const allowedTypes = WEBSITE_RECORDS.get(name);
    if (!allowedTypes) {
      out.push(`${where}: only website routing and ACM validation records may change`);
      return;
    }
    if (!allowedTypes.includes(rrs.Type)) {
      out.push(`${where}: ${rrs.Type} is not a website routing record type`);
      return;
    }
    const alias = rrs.AliasTarget;
    if (alias && (alias.HostedZoneId !== CLOUDFRONT_ALIAS_ZONE || !/\.cloudfront\.net\.?$/.test(alias.DNSName ?? ''))) {
      out.push(`${where}: aliases must target a CloudFront distribution`);
    }
  });
  return out;
}

/** A zone's record sets, keyed by "<name> <type>", the name in lower case without its final dot. */
export type Zone = ReadonlyMap<string, Json>;

const recordKey = (rrs: Json) => `${normalize(String(rrs.Name))} ${rrs.Type}`;

/** A record set as Route 53 compares one a DELETE names: values in any order, names and targets in any case. */
function comparable(rrs: Json): string {
  const values = (rrs.ResourceRecords ?? []).map((record: Json) => String(record.Value).toLowerCase().replace(/\.$/, ''));
  const alias = rrs.AliasTarget && {
    zone: rrs.AliasTarget.HostedZoneId,
    name: normalize(String(rrs.AliasTarget.DNSName)),
    health: rrs.AliasTarget.EvaluateTargetHealth,
  };
  return JSON.stringify({ key: recordKey(rrs), ttl: rrs.TTL, values: values.sort(), alias });
}

/**
 * The zone after Route 53 applies `batch` to it, which it does all or nothing: a CREATE of a record set that exists
 * fails, a DELETE must name a record set exactly (its TTL and values, or its alias target), an UPSERT replaces one, and a
 * name with a CNAME may hold nothing else. Throws, naming the change, where Route 53 would refuse the batch.
 */
export function applyBatch(zone: Zone, batch: Json): Zone {
  const next = new Map(zone);
  (batch.Changes as Json[]).forEach((change, i) => {
    const rrs = change.ResourceRecordSet;
    const key = recordKey(rrs);
    const where = `change ${i} (${change.Action} ${key})`;
    const current = next.get(key);
    if (change.Action === 'CREATE' && current !== undefined) throw new Error(`${where}: it already exists`);
    if (change.Action === 'DELETE') {
      if (current === undefined || comparable(current) !== comparable(rrs)) {
        throw new Error(`${where}: it does not match the zone`);
      }
      next.delete(key);
    } else {
      next.set(key, rrs);
    }
  });
  for (const key of next.keys()) {
    const [name, type] = key.split(' ');
    if (type === 'CNAME' && [...next.keys()].some((other) => other !== key && other.startsWith(`${name} `))) {
      throw new Error(`${name} would hold a CNAME beside other records`);
    }
  }
  return next;
}

/** The zone a list of record sets makes. */
export const zoneOf = (records: Json[]): Zone => new Map(records.map((rrs) => [recordKey(rrs), rrs]));

/**
 * Checks every file under `dir` except its README as a change batch, whatever its
 * name or folder: the AWS CLI applies any file it is given, so none may skip review.
 * That includes dot-names, which globs skip by default, and links, read through.
 */
export function batchDirectoryViolations(dir: string): string[] {
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .filter((file) => file !== 'README.md')
    .sort();
  return files.flatMap((file) => {
    let batch: Json;
    try {
      batch = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      return [`${file}: not readable as JSON`];
    }
    return dnsBatchViolations(batch).map((v) => `${file}: ${v}`);
  });
}
