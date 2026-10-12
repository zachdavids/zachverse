// Validates Route 53 change batches (the JSON passed to
// `aws route53 change-resource-record-sets --change-batch`) kept in infra/dns/.
// Website batches may only touch website routing and ACM validation records.

type Json = any;

const ACM_VALIDATION_NAME = /^_[0-9a-f]{32}\.(?:www\.)?zachdavids\.com$/;
const ACM_VALIDATION_VALUE = /^_[0-9a-f]{32}\.[a-z0-9]+\.acm-validations\.aws$/;
const WEBSITE_RECORDS: Record<string, string[]> = {
  'zachdavids.com': ['A', 'AAAA'],
  'www.zachdavids.com': ['A', 'AAAA', 'CNAME'],
};
/** Alias hosted zone ID that CloudFront distributions always use. */
const CLOUDFRONT_ALIAS_ZONE = 'Z2FDTNDATAQYW2';

const normalize = (name: string) => name.toLowerCase().replace(/\.$/, '');

export function dnsBatchViolations(batch: Json): string[] {
  const out: string[] = [];
  const changes: Json[] = batch?.Changes ?? [];
  if (!Array.isArray(changes) || changes.length === 0) return ['batch has no Changes'];

  changes.forEach((change, i) => {
    const rrs = change.ResourceRecordSet ?? {};
    const name = normalize(String(rrs.Name ?? ''));
    const where = `change ${i} (${change.Action} ${rrs.Type} ${name})`;
    if (!['CREATE', 'UPSERT', 'DELETE'].includes(change.Action)) out.push(`${where}: unknown action`);

    if (ACM_VALIDATION_NAME.test(name)) {
      if (rrs.Type !== 'CNAME') out.push(`${where}: ACM validation records must be CNAME`);
      for (const record of rrs.ResourceRecords ?? []) {
        if (!ACM_VALIDATION_VALUE.test(normalize(String(record.Value)))) {
          out.push(`${where}: value is not an ACM validation target`);
        }
      }
      return;
    }

    const allowedTypes = WEBSITE_RECORDS[name];
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
