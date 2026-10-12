import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { dnsBatchViolations } from './support/dns-batch';

const DNS_DIR = path.join(__dirname, '..', 'dns');
const batchFiles = readdirSync(DNS_DIR).filter((f) => f.endsWith('.json'));

describe('committed DNS change batches', () => {
  it('only touch website routing or ACM validation records', () => {
    for (const file of batchFiles) {
      const batch = JSON.parse(readFileSync(path.join(DNS_DIR, file), 'utf8'));
      expect(dnsBatchViolations(batch), file).toEqual([]);
    }
  });
});

describe('dnsBatchViolations', () => {
  const validation = {
    Action: 'UPSERT',
    ResourceRecordSet: {
      Name: '_0123456789abcdef0123456789abcdef.zachdavids.com.',
      Type: 'CNAME',
      TTL: 300,
      ResourceRecords: [{ Value: '_fedcba9876543210fedcba9876543210.xlfgrmvvlj.acm-validations.aws.' }],
    },
  };
  const apexAlias = {
    Action: 'UPSERT',
    ResourceRecordSet: {
      Name: 'zachdavids.com.',
      Type: 'A',
      AliasTarget: { HostedZoneId: 'Z2FDTNDATAQYW2', DNSName: 'd111111abcdef8.cloudfront.net.', EvaluateTargetHealth: false },
    },
  };
  const deleteWwwCname = {
    Action: 'DELETE',
    ResourceRecordSet: { Name: 'www.zachdavids.com.', Type: 'CNAME', TTL: 300, ResourceRecords: [{ Value: 'zachdavids.com' }] },
  };

  it('accepts ACM validation and website cutover changes', () => {
    expect(dnsBatchViolations({ Changes: [validation, apexAlias, deleteWwwCname] })).toEqual([]);
  });

  it.each([
    ['MX', { Action: 'DELETE', ResourceRecordSet: { Name: 'zachdavids.com.', Type: 'MX', TTL: 1800, ResourceRecords: [{ Value: '1 aspmx.l.google.com' }] } }],
    ['SPF', { Action: 'UPSERT', ResourceRecordSet: { Name: 'zachdavids.com.', Type: 'TXT', TTL: 300, ResourceRecords: [{ Value: '"v=spf1 -all"' }] } }],
    ['DKIM', { Action: 'DELETE', ResourceRecordSet: { Name: 'google._domainkey.zachdavids.com.', Type: 'TXT', TTL: 3600, ResourceRecords: [{ Value: '"v=DKIM1"' }] } }],
    ['DMARC', { Action: 'UPSERT', ResourceRecordSet: { Name: '_dmarc.zachdavids.com.', Type: 'TXT', TTL: 300, ResourceRecords: [{ Value: '"v=DMARC1; p=none"' }] } }],
    ['NS', { Action: 'UPSERT', ResourceRecordSet: { Name: 'zachdavids.com.', Type: 'NS', TTL: 300, ResourceRecords: [{ Value: 'ns.example.' }] } }],
    ['an unrelated host', { Action: 'CREATE', ResourceRecordSet: { Name: 'mail.zachdavids.com.', Type: 'CNAME', TTL: 300, ResourceRecords: [{ Value: 'ghs.googlehosted.com' }] } }],
    ['a non-CloudFront alias', { ...apexAlias, ResourceRecordSet: { ...apexAlias.ResourceRecordSet, AliasTarget: { HostedZoneId: 'Z1BKCTXD74EZPE', DNSName: 's3-website.us-east-2.amazonaws.com.' } } }],
    ['a validation-shaped name pointing elsewhere', { ...validation, ResourceRecordSet: { ...validation.ResourceRecordSet, ResourceRecords: [{ Value: 'evil.example.' }] } }],
  ])('rejects changes to %s', (_case, change) => {
    expect(dnsBatchViolations({ Changes: [validation, change] }).length).toBeGreaterThan(0);
  });
});
