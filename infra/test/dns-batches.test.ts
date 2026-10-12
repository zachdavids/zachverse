import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { batchDirectoryViolations, dnsBatchViolations } from './support/dns-batch';

const DNS_DIR = path.join(__dirname, '..', 'dns');
const VALIDATION_NAME = '_0123456789abcdef0123456789abcdef.zachdavids.com';
const validation = {
  Action: 'UPSERT',
  ResourceRecordSet: {
    Name: `${VALIDATION_NAME}.`,
    Type: 'CNAME',
    TTL: 300,
    ResourceRecords: [{ Value: '_fedcba9876543210fedcba9876543210.xlfgrmvvlj.acm-validations.aws.' }],
  },
};

describe('committed DNS change batches', () => {
  it('only touch website routing or ACM validation records', () => {
    expect(batchDirectoryViolations(DNS_DIR)).toEqual([]);
  });
});

describe('batchDirectoryViolations', () => {
  const deleteMx = {
    Action: 'DELETE',
    ResourceRecordSet: { Name: 'zachdavids.com.', Type: 'MX', TTL: 1800, ResourceRecords: [{ Value: '1 aspmx.l.google.com' }] },
  };
  const MX = 'change 0 (DELETE MX zachdavids.com): MX is not a website routing record type';
  let dir: string;
  const write = (file: string, content: string) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'zachverse-dns-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts the README and valid batches, including ones saved with CRLF line endings', () => {
    write('README.md', '# Website DNS change batches\n');
    write('validation.json', JSON.stringify({ Changes: [validation] }, null, 2).replace(/\n/g, '\r\n'));
    expect(batchDirectoryViolations(dir)).toEqual([]);
  });

  it('checks every other file as a batch, whatever its name or folder, so none can skip review', () => {
    write('README.md', '# Website DNS change batches\n');
    write('forward.JSON', JSON.stringify({ Changes: [deleteMx] }));
    write('nested/reverse.json', JSON.stringify({ Changes: [deleteMx] }));
    write('nested/README.md', '# Not the README\n');
    write('notes.txt', 'apply forward.JSON first');
    expect(batchDirectoryViolations(dir)).toEqual([
      `forward.JSON: ${MX}`,
      'nested/README.md: not readable as JSON',
      `nested/reverse.json: ${MX}`,
      'notes.txt: not readable as JSON',
    ]);
  });
});

describe('dnsBatchViolations', () => {
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
  const withRecordSet = (change: { Action: string; ResourceRecordSet: object }, recordSet: object) => ({
    ...change,
    ResourceRecordSet: { ...change.ResourceRecordSet, ...recordSet },
  });
  const apexAliasTo = (target: object) => withRecordSet(apexAlias, { AliasTarget: { EvaluateTargetHealth: false, ...target } });

  it('accepts ACM validation and website cutover changes', () => {
    expect(dnsBatchViolations({ Changes: [validation, apexAlias, deleteWwwCname] })).toEqual([]);
  });

  it('accepts IPv6 aliases and www validation records, with names and values in any case and without the trailing dot', () => {
    const changes = [
      withRecordSet(apexAlias, { Type: 'AAAA' }),
      withRecordSet(apexAlias, { Name: 'WWW.ZachDavids.com', Type: 'AAAA' }),
      {
        Action: 'CREATE',
        ResourceRecordSet: {
          Name: '_FEDCBA9876543210FEDCBA9876543210.www.zachdavids.com',
          Type: 'CNAME',
          TTL: 300,
          ResourceRecords: [{ Value: '_0123456789ABCDEF0123456789ABCDEF.XLFGRMVVLJ.acm-validations.aws' }],
        },
      },
    ];
    expect(dnsBatchViolations({ Changes: changes })).toEqual([]);
  });

  it.each([
    ['no batch at all', undefined],
    ['a batch without Changes', {}],
    ['an empty Changes list', { Changes: [] }],
    ['Changes that are not a list', { Changes: { Action: 'UPSERT' } }],
  ])('rejects %s', (_case, batch) => {
    expect(dnsBatchViolations(batch)).toEqual(['batch has no Changes']);
  });

  it.each([
    ['MX changes', { Action: 'DELETE', ResourceRecordSet: { Name: 'zachdavids.com.', Type: 'MX', TTL: 1800, ResourceRecords: [{ Value: '1 aspmx.l.google.com' }] } },
      'change 1 (DELETE MX zachdavids.com): MX is not a website routing record type'],
    ['SPF changes', { Action: 'UPSERT', ResourceRecordSet: { Name: 'zachdavids.com.', Type: 'TXT', TTL: 300, ResourceRecords: [{ Value: '"v=spf1 -all"' }] } },
      'change 1 (UPSERT TXT zachdavids.com): TXT is not a website routing record type'],
    ['DKIM changes', { Action: 'DELETE', ResourceRecordSet: { Name: 'google._domainkey.zachdavids.com.', Type: 'TXT', TTL: 3600, ResourceRecords: [{ Value: '"v=DKIM1"' }] } },
      'change 1 (DELETE TXT google._domainkey.zachdavids.com): only website routing and ACM validation records may change'],
    ['DMARC changes', { Action: 'UPSERT', ResourceRecordSet: { Name: '_dmarc.zachdavids.com.', Type: 'TXT', TTL: 300, ResourceRecords: [{ Value: '"v=DMARC1; p=none"' }] } },
      'change 1 (UPSERT TXT _dmarc.zachdavids.com): only website routing and ACM validation records may change'],
    ['NS changes', { Action: 'UPSERT', ResourceRecordSet: { Name: 'zachdavids.com.', Type: 'NS', TTL: 300, ResourceRecords: [{ Value: 'ns.example.' }] } },
      'change 1 (UPSERT NS zachdavids.com): NS is not a website routing record type'],
    ['a CNAME at the apex', withRecordSet(deleteWwwCname, { Name: 'zachdavids.com.' }),
      'change 1 (DELETE CNAME zachdavids.com): CNAME is not a website routing record type'],
    ['changes to an unrelated host', { Action: 'CREATE', ResourceRecordSet: { Name: 'mail.zachdavids.com.', Type: 'CNAME', TTL: 300, ResourceRecords: [{ Value: 'ghs.googlehosted.com' }] } },
      'change 1 (CREATE CNAME mail.zachdavids.com): only website routing and ACM validation records may change'],
    ['a non-CloudFront alias', apexAliasTo({ HostedZoneId: 'Z1BKCTXD74EZPE', DNSName: 's3-website.us-east-2.amazonaws.com.' }),
      'change 1 (UPSERT A zachdavids.com): aliases must target a CloudFront distribution'],
    ['a CloudFront domain in another alias zone', apexAliasTo({ HostedZoneId: 'Z1BKCTXD74EZPE', DNSName: 'd111111abcdef8.cloudfront.net.' }),
      'change 1 (UPSERT A zachdavids.com): aliases must target a CloudFront distribution'],
    ['the CloudFront alias zone with a non-CloudFront name', apexAliasTo({ HostedZoneId: 'Z2FDTNDATAQYW2', DNSName: 'd1.cloudfront.net.evil.example.' }),
      'change 1 (UPSERT A zachdavids.com): aliases must target a CloudFront distribution'],
    ['an alias without a DNS name', apexAliasTo({ HostedZoneId: 'Z2FDTNDATAQYW2' }),
      'change 1 (UPSERT A zachdavids.com): aliases must target a CloudFront distribution'],
    ['a validation-shaped name pointing elsewhere', withRecordSet(validation, { ResourceRecords: [{ Value: 'evil.example.' }] }),
      `change 1 (UPSERT CNAME ${VALIDATION_NAME}): value is not an ACM validation target`],
    ['a validation target suffixed with another domain',
      withRecordSet(validation, { ResourceRecords: [{ Value: '_fedcba9876543210fedcba9876543210.xlfgrmvvlj.acm-validations.aws.evil.example.' }] }),
      `change 1 (UPSERT CNAME ${VALIDATION_NAME}): value is not an ACM validation target`],
    ['a validation target prefixed with another label',
      withRecordSet(validation, { ResourceRecords: [{ Value: 'evil._fedcba9876543210fedcba9876543210.xlfgrmvvlj.acm-validations.aws.' }] }),
      `change 1 (UPSERT CNAME ${VALIDATION_NAME}): value is not an ACM validation target`],
    ['a record under a validation name', withRecordSet(validation, { Name: `mail.${VALIDATION_NAME}.` }),
      `change 1 (UPSERT CNAME mail.${VALIDATION_NAME}): only website routing and ACM validation records may change`],
    ['a validation name outside the zone', withRecordSet(validation, { Name: `${VALIDATION_NAME}.evil.example.` }),
      `change 1 (UPSERT CNAME ${VALIDATION_NAME}.evil.example): only website routing and ACM validation records may change`],
    ['a validation name with a non-CNAME type', withRecordSet(validation, { Type: 'TXT' }),
      `change 1 (UPSERT TXT ${VALIDATION_NAME}): ACM validation records must be CNAME`],
    ['a validation name used as an alias', {
      Action: 'UPSERT',
      ResourceRecordSet: {
        Name: `${VALIDATION_NAME}.`,
        Type: 'CNAME',
        AliasTarget: { HostedZoneId: 'Z03492543O0YEY0RDZZ0J', DNSName: 'mail.zachdavids.com.', EvaluateTargetHealth: false },
      },
    }, `change 1 (UPSERT CNAME ${VALIDATION_NAME}): ACM validation records need a value, not an alias`],
    ['a validation name with no values', withRecordSet(validation, { ResourceRecords: [] }),
      `change 1 (UPSERT CNAME ${VALIDATION_NAME}): ACM validation records need a value, not an alias`],
    ['validation values that are not a list',
      withRecordSet(validation, { ResourceRecords: { Value: '_fedcba9876543210fedcba9876543210.xlfgrmvvlj.acm-validations.aws.' } }),
      `change 1 (UPSERT CNAME ${VALIDATION_NAME}): ACM validation records need a value, not an alias`],
    ['an empty validation value', withRecordSet(validation, { ResourceRecords: [null] }),
      `change 1 (UPSERT CNAME ${VALIDATION_NAME}): value is not an ACM validation target`],
    ['an unknown change action', { ...apexAlias, Action: 'REPLACE' }, 'change 1 (REPLACE A zachdavids.com): unknown action'],
    ['a change without a record set', { Action: 'DELETE' },
      'change 1 (DELETE undefined ): only website routing and ACM validation records may change'],
  ])('rejects %s', (_case, change, expected) => {
    expect(dnsBatchViolations({ Changes: [validation, change] })).toEqual([expected]);
  });

  // Plain-object lookups would find Object.prototype members for these (lower-case) names, and then throw.
  it.each(['constructor', '__proto__'])('rejects a record named %s', (name) => {
    const change = withRecordSet(apexAlias, { Name: `${name}.` });
    expect(dnsBatchViolations({ Changes: [validation, change] })).toEqual([
      `change 1 (UPSERT A ${name}): only website routing and ACM validation records may change`,
    ]);
  });

  it('reports an empty change instead of throwing', () => {
    expect(dnsBatchViolations({ Changes: [validation, null] })).toEqual([
      'change 1 (undefined undefined ): unknown action',
      'change 1 (undefined undefined ): only website routing and ACM validation records may change',
    ]);
  });
});
