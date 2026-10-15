import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { batchDirectoryViolations, dnsBatchViolations } from './support/dns-batch';

const DNS_DIR = path.join(__dirname, '..', 'dns');
const VALIDATION_NAME = '_0123456789abcdef0123456789abcdef.zachdavids.com';
const WWW_VALIDATION_NAME = '_0123456789abcdef0123456789abcdef.www.zachdavids.com';
const validation = {
  Action: 'UPSERT',
  ResourceRecordSet: {
    Name: `${VALIDATION_NAME}.`,
    Type: 'CNAME',
    TTL: 300,
    ResourceRecords: [{ Value: '_fedcba9876543210fedcba9876543210.xlfgrmvvlj.acm-validations.aws.' }],
  },
};
const KEEP_VALIDATION = 'ACM validation records may not be deleted: ACM renews a certificate for these names only while they resolve';
// The site certificate's validation records (name, value) as 2026-10-13-acm-validation.json commits them. Spelled out
// here, so that changing that batch fails a test.
const SITE_CERTIFICATE_RECORDS: [string, string][] = [
  ['_b40f1ffc2ab3868060f332c640e2a09d.zachdavids.com', '_5f63bd73e2b7c7642a7cd21db702f0c0.wzccmgtwzk.acm-validations.aws'],
  ['_895a096eaa6d6a29533d586c1c17504c.www.zachdavids.com', '_80eb6249f8a344f353cb6d193b5f9bd7.wzccmgtwzk.acm-validations.aws'],
];

describe('committed DNS change batches', () => {
  it('only touch website routing or ACM validation records', () => {
    expect(batchDirectoryViolations(DNS_DIR)).toEqual([]);
  });

  it("include the site certificate's validation batch, which passes, and no batch could undo it", () => {
    const batch = JSON.parse(readFileSync(path.join(DNS_DIR, '2026-10-13-acm-validation.json'), 'utf8'));
    expect(dnsBatchViolations(batch)).toEqual([]);
    const reverse = { Changes: batch.Changes.map((change: object) => ({ ...change, Action: 'DELETE' })) };
    expect(dnsBatchViolations(reverse)).toEqual([
      `change 0 (DELETE CNAME _b40f1ffc2ab3868060f332c640e2a09d.zachdavids.com): ${KEEP_VALIDATION}`,
      `change 1 (DELETE CNAME _895a096eaa6d6a29533d586c1c17504c.www.zachdavids.com): ${KEEP_VALIDATION}`,
    ]);
  });
});

describe('batchDirectoryViolations', () => {
  const deleteMx = {
    Action: 'DELETE',
    ResourceRecordSet: { Name: 'zachdavids.com.', Type: 'MX', TTL: 1800, ResourceRecords: [{ Value: '1 aspmx.l.google.com' }] },
  };
  const MX = 'change 0 (DELETE MX zachdavids.com): MX is not a website routing record type';
  /** Holds the checked directory and, beside it, targets for links. */
  let root: string;
  let dir: string;
  const write = (file: string, content: string) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'zachverse-dns-'));
    dir = path.join(root, 'dns');
    mkdirSync(dir);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
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
    // Dot-names too, which globs (Node's fs.globSync included) skip by default.
    write('.rollback.json', JSON.stringify({ Changes: [deleteMx] }));
    write('.archive/rollback.json', JSON.stringify({ Changes: [deleteMx] }));
    expect(batchDirectoryViolations(dir)).toEqual([
      `.archive/rollback.json: ${MX}`,
      `.rollback.json: ${MX}`,
      `forward.JSON: ${MX}`,
      'nested/README.md: not readable as JSON',
      `nested/reverse.json: ${MX}`,
      'notes.txt: not readable as JSON',
    ]);
  });

  // Alone in the directory, since a case-insensitive file system would take it for README.md.
  it('exempts only README.md spelled exactly so', () => {
    write('readme.md', JSON.stringify({ Changes: [deleteMx] }));
    expect(batchDirectoryViolations(dir)).toEqual([`readme.md: ${MX}`]);
  });

  it('flags a linked folder and checks the batches in it', () => {
    const outside = path.join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'rollback.json'), JSON.stringify({ Changes: [deleteMx] }));
    // A junction needs no extra privileges on Windows; other systems ignore the type and make a plain symlink.
    symlinkSync(outside, path.join(dir, 'linked'), 'junction');
    expect(batchDirectoryViolations(dir)).toEqual(['linked: not readable as JSON', `linked/rollback.json: ${MX}`]);
  });

  it('checks what a file symlink points at, and flags a dangling one', (ctx) => {
    const target = path.join(root, 'rollback.json');
    writeFileSync(target, JSON.stringify({ Changes: [deleteMx] }));
    try {
      symlinkSync(target, path.join(dir, 'link.json'), 'file');
      symlinkSync(path.join(root, 'missing.json'), path.join(dir, 'dangling.json'), 'file');
    } catch (error) {
      // Windows allows file symlinks only in Developer Mode or when elevated; CI on Linux always runs this.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') ctx.skip('file symlinks are not permitted here');
      throw error;
    }
    expect(batchDirectoryViolations(dir)).toEqual(['dangling.json: not readable as JSON', `link.json: ${MX}`]);
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
    const wwwAlias = withRecordSet(apexAlias, { Name: 'www.zachdavids.com.' });
    expect(dnsBatchViolations({ Changes: [validation, apexAlias, wwwAlias, deleteWwwCname] })).toEqual([]);
  });

  // Spelled out here rather than read from dns-batch.ts, so widening or narrowing a rule fails a test.
  const RECORD_TYPES = ['A', 'AAAA', 'CAA', 'CNAME', 'DS', 'HTTPS', 'MX', 'NAPTR', 'NS', 'PTR', 'SOA', 'SPF', 'SRV', 'SSHFP', 'SVCB', 'TLSA', 'TXT'];
  const ROUTING_RECORDS = ['zachdavids.com A', 'zachdavids.com AAAA', 'www.zachdavids.com A', 'www.zachdavids.com AAAA', 'www.zachdavids.com CNAME'];
  const websiteRecords = ['zachdavids.com', 'www.zachdavids.com'].flatMap((name) => RECORD_TYPES.map((type) => `${name} ${type}`));
  /** A change to the named record; values are not checked at the website names, only alias targets. */
  const upsert = (record: string) => {
    const [name, type] = record.split(' ');
    return { Action: 'UPSERT', ResourceRecordSet: { Name: `${name}.`, Type: type, TTL: 300, ResourceRecords: [{ Value: 'example' }] } };
  };

  it.each(ROUTING_RECORDS)('accepts the website routing record %s', (record) => {
    expect(dnsBatchViolations({ Changes: [upsert(record)] })).toEqual([]);
  });

  it.each(websiteRecords.filter((record) => !ROUTING_RECORDS.includes(record)))('rejects any other record at a website name: %s', (record) => {
    const [name, type] = record.split(' ');
    expect(dnsBatchViolations({ Changes: [upsert(record)] })).toEqual([
      `change 0 (UPSERT ${type} ${name}): ${type} is not a website routing record type`,
    ]);
  });

  it.each(['zachdavids.com', 'www.zachdavids.com'].flatMap((name) => ['A', 'AAAA'].map((type) => [type, name])))(
    'rejects an alias of type %s at %s that does not target CloudFront',
    (type, name) => {
      const targets = [
        { HostedZoneId: 'Z35SXDOTRQ7X7K', DNSName: 'dualstack.web-1234567890.us-east-1.elb.amazonaws.com.' },
        { HostedZoneId: 'Z2FDTNDATAQYW2', DNSName: 'd1.cloudfront.net.evil.example.' },
      ];
      const changes = targets.map((target) => withRecordSet(apexAliasTo(target), { Name: `${name}.`, Type: type }));
      expect(dnsBatchViolations({ Changes: changes })).toEqual(
        [0, 1].map((i) => `change ${i} (UPSERT ${type} ${name}): aliases must target a CloudFront distribution`),
      );
    },
  );

  it.each(['A', 'AAAA', 'NS', 'TXT'].flatMap((type) => [VALIDATION_NAME, WWW_VALIDATION_NAME].map((name) => [type, name])))(
    'rejects a record of type %s at the validation name %s',
    (type, name) => {
      expect(dnsBatchViolations({ Changes: [withRecordSet(validation, { Name: `${name}.`, Type: type })] })).toEqual([
        `change 0 (UPSERT ${type} ${name}): ACM validation records must be CNAME`,
      ]);
    },
  );

  // ACM renews a certificate only while its validation records resolve, so no batch may delete one, with no exception.
  it.each([
    ['on the apex', `${VALIDATION_NAME}.`],
    ['on www', `${WWW_VALIDATION_NAME}.`],
    ['named in upper case without the trailing dot', VALIDATION_NAME.toUpperCase()],
  ])('rejects deleting an ACM validation record %s', (_case, name) => {
    const change = withRecordSet({ ...validation, Action: 'DELETE' }, { Name: name });
    expect(dnsBatchViolations({ Changes: [change] })).toEqual([
      `change 0 (DELETE CNAME ${name.toLowerCase().replace(/\.$/, '')}): ${KEEP_VALIDATION}`,
    ]);
  });

  // ACM renews the site certificate only while its validation names resolve to the values ACM gave them.
  it.each(SITE_CERTIFICATE_RECORDS.flatMap(([name, value]) => ['CREATE', 'UPSERT'].map((action) => [action, name, value])))(
    "rejects %s of the site certificate's validation record %s with another value",
    (action, name, value) => {
      const change = withRecordSet({ ...validation, Action: action }, { Name: `${name}.` });
      const violation = `change 0 (${action} CNAME ${name}): the site certificate validates through this record, so its value must stay ${value}`;
      expect(dnsBatchViolations({ Changes: [change] })).toEqual([violation]);
      // The whole value is compared, not only its token.
      const otherDomain = withRecordSet(change, { ResourceRecords: [{ Value: value.replace('.wzccmgtwzk.', '.xlfgrmvvlj.') }] });
      expect(dnsBatchViolations({ Changes: [otherDomain] })).toEqual([violation]);
      // Its own value passes, in any case and without the trailing dot.
      const own = withRecordSet(change, { ResourceRecords: [{ Value: value.toUpperCase() }] });
      expect(dnsBatchViolations({ Changes: [own] })).toEqual([]);
    },
  );

  it('rejects deleting an ACM validation record even next to its replacement', () => {
    const replacement = withRecordSet(validation, {
      ResourceRecords: [{ Value: '_0123456789abcdef0123456789abcdef.xlfgrmvvlj.acm-validations.aws.' }],
    });
    expect(dnsBatchViolations({ Changes: [{ ...validation, Action: 'DELETE' }, replacement] })).toEqual([
      `change 0 (DELETE CNAME ${VALIDATION_NAME}): ${KEEP_VALIDATION}`,
    ]);
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
    // The certificate covers only the apex and www, and ACM's validation labels are 32 hex digits.
    ['a validation name for another host', withRecordSet(validation, { Name: '_0123456789abcdef0123456789abcdef.mail.zachdavids.com.' }),
      'change 1 (UPSERT CNAME _0123456789abcdef0123456789abcdef.mail.zachdavids.com): only website routing and ACM validation records may change'],
    ['a validation name with 31 hex digits', withRecordSet(validation, { Name: '_123456789abcdef0123456789abcdef.zachdavids.com.' }),
      'change 1 (UPSERT CNAME _123456789abcdef0123456789abcdef.zachdavids.com): only website routing and ACM validation records may change'],
    ['a validation name with 33 hex digits', withRecordSet(validation, { Name: '_0123456789abcdef0123456789abcdef0.zachdavids.com.' }),
      'change 1 (UPSERT CNAME _0123456789abcdef0123456789abcdef0.zachdavids.com): only website routing and ACM validation records may change'],
    ['a validation name with a letter that is not hex', withRecordSet(validation, { Name: '_0123456789abcdef0123456789abcdeg.zachdavids.com.' }),
      'change 1 (UPSERT CNAME _0123456789abcdef0123456789abcdeg.zachdavids.com): only website routing and ACM validation records may change'],
    ['a validation target with 31 hex digits',
      withRecordSet(validation, { ResourceRecords: [{ Value: '_edcba9876543210fedcba9876543210.xlfgrmvvlj.acm-validations.aws.' }] }),
      `change 1 (UPSERT CNAME ${VALIDATION_NAME}): value is not an ACM validation target`],
    ['a validation target with 33 hex digits',
      withRecordSet(validation, { ResourceRecords: [{ Value: '_fedcba9876543210fedcba9876543210f.xlfgrmvvlj.acm-validations.aws.' }] }),
      `change 1 (UPSERT CNAME ${VALIDATION_NAME}): value is not an ACM validation target`],
    ['a validation target with a letter that is not hex',
      withRecordSet(validation, { ResourceRecords: [{ Value: '_fedcba9876543210fedcba987654321g.xlfgrmvvlj.acm-validations.aws.' }] }),
      `change 1 (UPSERT CNAME ${VALIDATION_NAME}): value is not an ACM validation target`],
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
