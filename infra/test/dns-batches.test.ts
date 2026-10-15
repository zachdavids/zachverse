import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyBatch, batchDirectoryViolations, batchPairingViolations, dnsBatchViolations, zoneOf } from './support/dns-batch';

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

  it('pair every website routing batch with a reverse batch that undoes exactly its website changes', () => {
    expect(batchPairingViolations(DNS_DIR)).toEqual([]);
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

describe('batchPairingViolations', () => {
  let dir: string;
  const write = (file: string, changes: unknown[]) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), JSON.stringify({ Changes: changes }));
  };
  const record = (TTL: number) => ({ Name: 'zachdavids.com.', Type: 'A', TTL, ResourceRecords: [{ Value: '192.0.2.1' }] });
  const lower = [
    { Action: 'DELETE', ResourceRecordSet: record(1800) },
    { Action: 'CREATE', ResourceRecordSet: record(300) },
  ];
  // Spelled differently, as Route 53 still matches it: the name in capitals, without its final dot.
  const raise = [
    { Action: 'DELETE', ResourceRecordSet: { ...record(300), Name: 'ZachDavids.com' } },
    { Action: 'CREATE', ResourceRecordSet: record(1800) },
  ];

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'zachverse-dns-pairs-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts a routing batch whose reverse undoes it, in an order Route 53 applies, and a validation batch without one', () => {
    write('a.json', lower);
    write('a.reverse.json', raise);
    write('v.json', [validation]);
    writeFileSync(path.join(dir, 'README.md'), '# Batches\n');
    expect(batchPairingViolations(dir)).toEqual([]);
  });

  it('refuses a routing batch without its reverse, and a reverse without its routing batch', () => {
    write('a.json', lower);
    write('b.reverse.json', raise);
    expect(batchPairingViolations(dir)).toEqual([
      'a.json: a website routing batch needs a reverse batch, a.reverse.json',
      'b.reverse.json: a reverse batch needs its forward batch, b.json',
    ]);
  });

  it('refuses a reverse that does not undo exactly its forward batch, or does more', () => {
    const MISMATCH = 'a.reverse.json: must undo exactly the website changes in a.json, and change nothing else';
    write('a.json', lower);
    for (const reverse of [lower, raise.slice(1), [...raise, { ...validation, Action: 'CREATE' }], [raise[0]!, { Action: 'CREATE', ResourceRecordSet: record(60) }]]) {
      write('a.reverse.json', reverse);
      expect(batchPairingViolations(dir)).toEqual([MISMATCH]);
    }
  });

  it('refuses a pair that does not apply in its order, as Route 53 applies a batch change by change', () => {
    write('a.json', lower);
    write('a.reverse.json', [...raise].reverse());
    // Two of www's types: the CNAME can come back only once the alias beside it is gone.
    const wwwCname = { Name: 'www.zachdavids.com.', Type: 'CNAME', TTL: 300, ResourceRecords: [{ Value: 'zachdavids.com' }] };
    const wwwAlias = { Name: 'www.zachdavids.com.', Type: 'A', AliasTarget: { HostedZoneId: 'Z2FDTNDATAQYW2', DNSName: 'd1.cloudfront.net.', EvaluateTargetHealth: false } };
    write('w.json', [
      { Action: 'DELETE', ResourceRecordSet: wwwCname },
      { Action: 'CREATE', ResourceRecordSet: wwwAlias },
    ]);
    write('w.reverse.json', [
      { Action: 'CREATE', ResourceRecordSet: wwwCname },
      { Action: 'DELETE', ResourceRecordSet: wwwAlias },
    ]);
    expect(batchPairingViolations(dir)).toEqual([
      'a.reverse.json: with a.json, does not apply in its order: change 0 (CREATE zachdavids.com A): it already exists',
      'w.reverse.json: with w.json, does not apply in its order: change 0 (CREATE www.zachdavids.com CNAME): www.zachdavids.com would hold a CNAME beside other records',
    ]);
    write('w.reverse.json', [
      { Action: 'DELETE', ResourceRecordSet: wwwAlias },
      { Action: 'CREATE', ResourceRecordSet: wwwCname },
    ]);
    expect(batchPairingViolations(dir)).toEqual([
      'a.reverse.json: with a.json, does not apply in its order: change 0 (CREATE zachdavids.com A): it already exists',
    ]);
  });

  it('refuses UPSERT at a website name, whose earlier state no reverse could know', () => {
    write('a.json', [{ Action: 'UPSERT', ResourceRecordSet: record(300) }]);
    write('a.reverse.json', [{ Action: 'DELETE', ResourceRecordSet: record(300) }]);
    expect(batchPairingViolations(dir)).toEqual([
      expect.stringMatching(/^a\.json: UPSERT .*: a website routing change must be an exact DELETE or a CREATE, never UPSERT$/),
      'a.reverse.json: must undo exactly the website changes in a.json, and change nothing else',
    ]);
  });

  it('refuses a batch that could not pair by name: in a folder, in capitals, hidden, or with another character', () => {
    const names = ['.hidden.json', 'A.JSON', 'a b.json', 'a_b.json', 'm9/retire.json', 'notes.txt'];
    for (const file of names) write(file, lower);
    expect(batchPairingViolations(dir)).toEqual(names.map((file) => `${file}: a batch must be a top-level file named with lower-case letters, digits, '.', and '-' only, starting with a letter or digit and ending in .json, to pair with its reverse by name`));
  });

  it('leaves an unreadable or malformed batch to batchDirectoryViolations, and still compares a reverse', () => {
    writeFileSync(path.join(dir, 'broken.json'), '{');
    writeFileSync(path.join(dir, 'null.json'), 'null');
    write('odd.json', [null, {}, { Action: 'DELETE' }]);
    expect(batchPairingViolations(dir)).toEqual([]);
    write('a.json', lower);
    write('a.reverse.json', [null, {}]);
    expect(batchPairingViolations(dir)).toEqual(['a.reverse.json: must undo exactly the website changes in a.json, and change nothing else']);
    // Malformed values that agree with each other: the pairing check passes them, and the directory check names them.
    const odd = [
      { Name: 'zachdavids.com.', Type: 'A', TTL: 300, ResourceRecords: [null] },
      { Name: 'zachdavids.com.', Type: 'AAAA', TTL: 300, ResourceRecords: 'x' },
    ];
    write('a.json', odd.map((ResourceRecordSet) => ({ Action: 'DELETE', ResourceRecordSet })));
    write('a.reverse.json', odd.map((ResourceRecordSet) => ({ Action: 'CREATE', ResourceRecordSet })));
    rmSync(path.join(dir, 'odd.json'));
    expect(batchPairingViolations(dir)).toEqual([]);
    const SHAPE = 'a website record is either an alias, with no TTL or values, or a TTL with a list of string values';
    expect(batchDirectoryViolations(dir)).toEqual([
      `a.json: change 0 (DELETE A zachdavids.com): ${SHAPE}`,
      `a.json: change 1 (DELETE AAAA zachdavids.com): ${SHAPE}`,
      `a.reverse.json: change 0 (CREATE A zachdavids.com): ${SHAPE}`,
      `a.reverse.json: change 1 (CREATE AAAA zachdavids.com): ${SHAPE}`,
      'broken.json: not readable as JSON',
      'null.json: batch has no Changes',
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

  it('accepts a Comment of up to 256 printable ASCII characters, the most Route 53 takes, and refuses any other', () => {
    const batch = (envelope: object) => ({ Changes: [validation], ...envelope });
    const LIMIT = 'batch Comment must be printable ASCII, at most 256 characters, or Route 53 refuses the batch';
    expect(dnsBatchViolations(batch({ Comment: 'x'.repeat(256) }))).toEqual([]);
    expect(dnsBatchViolations(batch({ Comment: '' }))).toEqual([]);
    for (const Comment of ['x'.repeat(257), 'Milestone 8 \u2014 step 1', 'two\nlines', 42, null]) {
      expect(dnsBatchViolations(batch({ Comment })), String(Comment)).toEqual([LIMIT]);
    }
  });

  it('refuses a batch with a key besides Comment and Changes', () => {
    expect(dnsBatchViolations({ Comment: 'x', Changes: [validation], Changs: [] })).toEqual([
      'batch has Changs, which is neither Comment nor Changes',
    ]);
  });

  it('refuses any field but those of a simple record, at website and validation names', () => {
    const NOT_SIMPLE = 'is not a field of a simple record, the only kind these batches write';
    const weighted = withRecordSet(upsert('www.zachdavids.com A'), { SetIdentifier: 'blue', Weight: 1, HealthCheckId: 'abc' });
    expect(dnsBatchViolations({ Changes: [weighted] })).toEqual(
      ['SetIdentifier', 'Weight', 'HealthCheckId'].map((field) => `change 0 (UPSERT A www.zachdavids.com): ${field} ${NOT_SIMPLE}`),
    );
    const aliasWithExtra = apexAliasTo({ HostedZoneId: 'Z2FDTNDATAQYW2', DNSName: 'd111111abcdef8.cloudfront.net.', Region: 'us-east-1' });
    expect(dnsBatchViolations({ Changes: [aliasWithExtra] })).toEqual([`change 0 (UPSERT A zachdavids.com): AliasTarget.Region ${NOT_SIMPLE}`]);
    expect(dnsBatchViolations({ Changes: [withRecordSet(validation, { Failover: 'PRIMARY' })] })).toEqual([
      `change 0 (UPSERT CNAME ${VALIDATION_NAME}): Failover ${NOT_SIMPLE}`,
    ]);
  });

  it('refuses a website record that is neither an alias alone nor a TTL with a list of string values', () => {
    const SHAPE = 'a website record is either an alias, with no TTL or values, or a TTL with a list of string values';
    const value = upsert('zachdavids.com A');
    const changes = [
      withRecordSet(apexAlias, { TTL: 300 }),
      withRecordSet(apexAlias, { ResourceRecords: [{ Value: 'x' }] }),
      withRecordSet(value, { TTL: undefined }),
      ...[[], [null], 'x', [{ Value: 5 }], [{ Value: 'x', Weight: 1 }]].map((ResourceRecords) => withRecordSet(value, { ResourceRecords })),
    ];
    for (const change of changes) {
      expect(dnsBatchViolations({ Changes: [change] }), JSON.stringify(change)).toEqual([`change 0 (UPSERT A zachdavids.com): ${SHAPE}`]);
    }
  });

  it("refuses a website record at the retired Droplet's addresses, however spelled, but lets a batch delete one", () => {
    const RETIRED = "is the retired DigitalOcean Droplet's address (ADR 0009), which DigitalOcean may have given to someone else";
    const at = (action: string, type: string, value: string) => ({
      Action: action,
      ResourceRecordSet: { Name: 'zachdavids.com.', Type: type, TTL: 300, ResourceRecords: [{ Value: value }] },
    });
    for (const [action, type, value] of [
      ['CREATE', 'A', '159.203.37.93'],
      ['UPSERT', 'A', ' 159.203.37.93 '],
      ['CREATE', 'AAAA', '2604:a880:cad:d0::46:6001'],
      ['UPSERT', 'AAAA', '2604:A880:CAD:D0:0:0:46:6001'],
    ] as const) {
      expect(dnsBatchViolations({ Changes: [at(action, type, value)] }), value).toEqual([
        `change 0 (${action} ${type} zachdavids.com): ${value} ${RETIRED}`,
      ]);
    }
    // Deleting a stale pointer at the Droplet is how it would be removed.
    expect(dnsBatchViolations({ Changes: [at('DELETE', 'A', '159.203.37.93')] })).toEqual([]);
    // Other addresses, and a value that isn't an IPv6 address at all, are not the Droplet's.
    for (const [type, value] of [['A', '192.0.2.1'], ['AAAA', '2001:db8::1'], ['AAAA', 'zz::1']]) {
      expect(dnsBatchViolations({ Changes: [at('UPSERT', type!, value!)] }), value).toEqual([]);
    }
  });

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

describe('applyBatch', () => {
  const a = { Name: 'zachdavids.com.', Type: 'A', TTL: 300, ResourceRecords: [{ Value: '192.0.2.1' }, { Value: '192.0.2.2' }] };
  const zone = zoneOf([a]);

  it('creates, upserts, and deletes, matching a deletion in any case and value order', () => {
    const cname = { Name: 'www.zachdavids.com.', Type: 'CNAME', TTL: 300, ResourceRecords: [{ Value: 'zachdavids.com' }] };
    const created = applyBatch(zone, { Changes: [{ Action: 'CREATE', ResourceRecordSet: cname }] });
    expect([...created.keys()]).toEqual(['zachdavids.com A', 'www.zachdavids.com CNAME']);
    const upserted = applyBatch(created, { Changes: [{ Action: 'UPSERT', ResourceRecordSet: { ...a, TTL: 60 } }] });
    expect(upserted.get('zachdavids.com A')?.TTL).toBe(60);
    const reordered = { ...a, Name: 'ZachDavids.com', ResourceRecords: [...a.ResourceRecords].reverse() };
    expect([...applyBatch(zone, { Changes: [{ Action: 'DELETE', ResourceRecordSet: reordered }] }).keys()]).toEqual([]);
  });

  it('checks the CNAME rule after each change, as Route 53 does, not only at the end', () => {
    const wwwA = { Name: 'www.zachdavids.com.', Type: 'A', TTL: 300, ResourceRecords: [{ Value: '192.0.2.1' }] };
    const wwwCname = { Name: 'www.zachdavids.com.', Type: 'CNAME', TTL: 300, ResourceRecords: [{ Value: 'zachdavids.com' }] };
    const start = zoneOf([wwwA]);
    const create = { Action: 'CREATE', ResourceRecordSet: wwwCname };
    const remove = { Action: 'DELETE', ResourceRecordSet: wwwA };
    expect(() => applyBatch(start, { Changes: [create, remove] })).toThrow(
      'change 0 (CREATE www.zachdavids.com CNAME): www.zachdavids.com would hold a CNAME beside other records',
    );
    expect([...applyBatch(start, { Changes: [remove, create] }).keys()]).toEqual(['www.zachdavids.com CNAME']);
  });

  it('refuses a creation of what exists, a deletion that does not match, and a CNAME beside other records', () => {
    expect(() => applyBatch(zone, { Changes: [{ Action: 'CREATE', ResourceRecordSet: a }] })).toThrow(
      'change 0 (CREATE zachdavids.com A): it already exists',
    );
    for (const differing of [{ ...a, TTL: 60 }, { ...a, ResourceRecords: [{ Value: '192.0.2.1' }] }, { ...a, Type: 'AAAA' }]) {
      expect(() => applyBatch(zone, { Changes: [{ Action: 'DELETE', ResourceRecordSet: differing }] })).toThrow(
        'it does not match the zone',
      );
    }
    const apexCname = { Name: 'zachdavids.com.', Type: 'CNAME', TTL: 300, ResourceRecords: [{ Value: 'example.com' }] };
    expect(() => applyBatch(zone, { Changes: [{ Action: 'CREATE', ResourceRecordSet: apexCname }] })).toThrow(
      'zachdavids.com would hold a CNAME beside other records',
    );
    // An alias is matched by its target.
    const alias = { Name: 'zachdavids.com.', Type: 'A', AliasTarget: { HostedZoneId: 'Z2FDTNDATAQYW2', DNSName: 'd1.cloudfront.net.', EvaluateTargetHealth: false } };
    const aliased = zoneOf([alias]);
    const other = { ...alias, AliasTarget: { ...alias.AliasTarget, DNSName: 'd2.cloudfront.net.' } };
    expect(() => applyBatch(aliased, { Changes: [{ Action: 'DELETE', ResourceRecordSet: other }] })).toThrow(
      'it does not match the zone',
    );
    const upperCase = { ...alias, AliasTarget: { ...alias.AliasTarget, DNSName: 'D1.CloudFront.net' } };
    expect(applyBatch(aliased, { Changes: [{ Action: 'DELETE', ResourceRecordSet: upperCase }] }).size).toBe(0);
  });
});
