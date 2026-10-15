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

/**
 * Route 53's documented limit on a batch's Comment (ChangeBatch in its API reference), which neither the CLI nor the
 * SDKs check. The Comment must also be printable ASCII: the CLI reads a file:// batch in the system's encoding, so any
 * other character could reach Route 53 as more than one.
 */
const COMMENT = /^[\x20-\x7e]{0,256}$/;

export function dnsBatchViolations(batch: Json): string[] {
  const out: string[] = [];
  for (const key of Object.keys(batch ?? {})) {
    if (key !== 'Comment' && key !== 'Changes') out.push(`batch has ${key}, which is neither Comment nor Changes`);
  }
  if (batch?.Comment !== undefined && !(typeof batch.Comment === 'string' && COMMENT.test(batch.Comment))) {
    out.push('batch Comment must be printable ASCII, at most 256 characters, or Route 53 refuses the batch');
  }
  const changes: Json[] = batch?.Changes ?? [];
  if (!Array.isArray(changes) || changes.length === 0) return [...out, 'batch has no Changes'];

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
 * Every file under `dir` except its README, whatever its name or folder: the AWS CLI applies any file it is given, so
 * each is a batch, and none may skip review. That includes dot-names, which globs skip by default, and links.
 */
function batchFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .filter((file) => file !== 'README.md')
    .sort();
}

/** Checks every batch under `dir` (batchFiles) with dnsBatchViolations, reading links through. */
export function batchDirectoryViolations(dir: string): string[] {
  return batchFiles(dir).flatMap((file) => {
    let batch: Json;
    try {
      batch = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      return [`${file}: not readable as JSON`];
    }
    return dnsBatchViolations(batch).map((v) => `${file}: ${v}`);
  });
}

const isWebsiteChange = (change: Json) => WEBSITE_RECORDS.has(normalize(String(change?.ResourceRecordSet?.Name ?? '')));
// A change, and the change that undoes it, as Route 53 compares record sets.
const asNamed = (change: Json) => `${change?.Action} ${comparable(change?.ResourceRecordSet ?? {})}`;
const asUndone = (change: Json) => `${change.Action === 'CREATE' ? 'DELETE' : 'CREATE'} ${comparable(change.ResourceRecordSet)}`;

/**
 * Pairs every batch under `dir` that changes a website routing record with its reverse batch, by name: X.json with
 * X.reverse.json, so every batch is a top-level .json file named in lower case. A reverse batch must undo exactly its
 * forward batch's website changes, each CREATE deleted and each DELETE created again, and change nothing else. Only
 * exact DELETE and CREATE make that possible, so neither uses UPSERT at a website name. A batch that changes only
 * validation records needs no reverse. Unreadable files are left to batchDirectoryViolations.
 */
export function batchPairingViolations(dir: string): string[] {
  const out: string[] = [];
  const batches = new Map<string, Json[]>();
  for (const file of batchFiles(dir)) {
    if (!/^[a-z0-9][a-z0-9.-]*\.json$/.test(file)) {
      out.push(`${file}: a batch must be a top-level .json file named in lower case, to pair with its reverse by name`);
      continue;
    }
    try {
      const changes = JSON.parse(readFileSync(path.join(dir, file), 'utf8'))?.Changes;
      batches.set(file, Array.isArray(changes) ? changes : []);
    } catch {
      // batchDirectoryViolations reports it.
    }
  }
  for (const [file, changes] of batches) {
    const website = changes.filter(isWebsiteChange);
    for (const change of website) {
      if (change?.Action === 'UPSERT') out.push(`${file}: ${asNamed(change)}: a website routing change must be an exact DELETE or a CREATE, never UPSERT`);
    }
    if (file.endsWith('.reverse.json')) {
      const forwardFile = file.replace(/\.reverse\.json$/, '.json');
      const forward = batches.get(forwardFile);
      if (forward === undefined) {
        out.push(`${file}: a reverse batch needs its forward batch, ${forwardFile}`);
      } else if (JSON.stringify(forward.filter(isWebsiteChange).map(asUndone).sort()) !== JSON.stringify(changes.map(asNamed).sort())) {
        out.push(`${file}: must undo exactly the website changes in ${forwardFile}, and change nothing else`);
      }
    } else if (website.length > 0 && !batches.has(file.replace(/\.json$/, '.reverse.json'))) {
      out.push(`${file}: a website routing batch needs a reverse batch, ${file.replace(/\.json$/, '.reverse.json')}`);
    }
  }
  return out;
}
