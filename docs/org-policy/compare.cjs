// Compares effective SCP deny decisions before and after the proposed change,
// per account, Region, and action. Run: node docs/org-policy/compare.cjs
const fs = require('fs');
const path = require('path');

const WEBSITE = '426499248998';
const IDENTITY = '796429457615';
const read = (file) => JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8'));

const original = read('backup-2026-10-12/p-ie47xwqg.content.json');
const proposedRoot = read('proposed/p-ie47xwqg.json');
const regionFloor = read('proposed/region-floor.json');
const website = read('proposed/website-us-east-1.json');

const toRe = (p) => new RegExp('^' + p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
const matches = (patterns, action) => [].concat(patterns).some((p) => toRe(p).test(action));

function conditionHolds(condition, ctx) {
  for (const [op, pairs] of Object.entries(condition || {})) {
    for (const [key, value] of Object.entries(pairs)) {
      const listed = [].concat(value).includes(ctx[key]);
      if (op === 'StringEquals' && !listed) return false;
      if (op === 'StringNotEquals' && listed) return false;
      if (op !== 'StringEquals' && op !== 'StringNotEquals') throw new Error(`unsupported operator ${op}`);
    }
  }
  return true;
}

const denied = (docs, action, ctx) =>
  docs.some((doc) =>
    doc.Statement.some(
      (s) =>
        s.Effect === 'Deny' &&
        (s.Action ? matches(s.Action, action) : !matches(s.NotAction, action)) &&
        conditionHolds(s.Condition, ctx),
    ),
  );

const probes = [
  ...new Set([
    ...original.Statement.flatMap((s) => [].concat(s.NotAction)).map((a) => a.replaceAll('*', 'Probe')),
    'cloudformation:CreateStack', 's3:PutObject', 's3:CreateBucket', 's3:ListAllMyBuckets', 'ssm:GetParameter',
    'ecr:CreateRepository', 'pricingplanmanager:CreateSubscription', 'lambda:CreateFunction', 'ec2:RunInstances',
    'dynamodb:CreateTable', 'iam:CreateRole', 'cloudfront:CreateDistribution', 'bedrock:InvokeModel',
  ]),
];
const regions = ['us-east-1', 'us-east-2', 'us-west-2', 'eu-west-1', 'unspecified'];
const after = (account) => (account === WEBSITE ? [proposedRoot, regionFloor, website] : [proposedRoot, regionFloor]);

let tightened = 0;
for (const [name, account] of [['Website', WEBSITE], ['Identity Delegated Admin', IDENTITY]]) {
  const changes = [];
  for (const region of regions) {
    for (const action of probes) {
      const ctx = { 'aws:RequestedRegion': region, 'aws:PrincipalAccount': account };
      const was = denied([original], action, ctx);
      const now = denied(after(account), action, ctx);
      if (was !== now) changes.push(`${region} ${action}: ${was ? 'deny' : 'allow'} -> ${now ? 'deny' : 'allow'}`);
      if (!was && now) tightened++;
    }
  }
  console.log(`${name} (${account}): ${changes.length} changed decision(s)`);
  for (const change of changes) console.log(`  ${change}`);
}
for (const [file, doc] of Object.entries({ 'p-ie47xwqg': proposedRoot, 'region-floor': regionFloor, 'website-us-east-1': website })) {
  const size = JSON.stringify(doc).length;
  console.log(`${file}: ${size} chars${size > 5120 ? ' (exceeds 5120 limit)' : ''}`);
}
if (tightened) console.log(`WARNING: ${tightened} decision(s) became stricter`);
