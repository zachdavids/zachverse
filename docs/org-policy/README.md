# Organization policy change: us-east-1 for the Website account

**Applied 2026-10-12 (UTC)** from the management account `969788248923`, after approval. The new policies are `ZachverseRegionFloor` = `p-xwdm4cce` (root `r-58a9`) and `ZachverseWebsiteUsEast1` = `p-1mpgzmjr` (account `426499248998`), and `p-ie47xwqg` was updated in place. Each live policy was read back and matches its file in `proposed/` exactly.

This change unblocks the us-east-1 decision in ADR 0002. It allows the Website account (`426499248998`) to use CloudFormation, S3, SSM, ECR, and Pricing Plan Manager in us-east-1. Pricing Plan Manager's endpoint is global, so it is always evaluated as us-east-1.

Every other control is unchanged:

- The Identity Delegated Admin account (`796429457615`) and any future account keep the original restriction.
- The us-west-2 restriction, the Region floor, `ManagedAccountSecurityControlPolicy`, and the RCP are untouched.

## Files

| Path | Contents |
| --- | --- |
| `backup-2026-10-12/p-ie47xwqg.content.json` | Live `AdvancedModeRegionRestrictionSecurityControlPolicy` text, read 2026-10-12 UTC (SHA-256 `f844034c…0b78`) |
| `backup-2026-10-12/p-ie47xwqg.describe.json` | Full `describe-policy` output |
| `backup-2026-10-12/attachments.jsonl` | SCP and RCP attachments for the root `r-58a9`, the Website account, and the Identity account |
| `proposed/region-floor.json` | `RegionFloor` statement, verbatim, moved into its own policy to free space (the size limit is 5,120 characters) |
| `proposed/website-us-east-1.json` | The `UsEast1Partitional` list, with its 17 `s3` entries replaced by `s3:*`, plus `cloudformation:*`, `ecr:*`, `pricingplanmanager:*`, and `ssm:*`; attached to the Website account only |
| `proposed/p-ie47xwqg.json` | The original policy without `RegionFloor`. `UsEast1Partitional` gains `StringNotEquals aws:PrincipalAccount = 426499248998`; its action list is unchanged |
| `compare.cjs` | Prints the effective decision changes per account (expected: 6 for Website in us-east-1, 0 for Identity) |

## Apply (management account; each step leaves access no looser than the final state)

Run future changes under the management account's AWS Settings role session, never as root: sign in with `aws login --profile zachverse-management` and choose that role. Save each script to a file and run it with `sh` from the repository root: its `file://` paths are relative to the root, and its `exit` then ends the script rather than your shell. Each script stops at the first failed command (`set -eu`), refuses a root session, checks the live policy before changing it, and signs out when it ends, however it ends.

Since 2026-10-12 the live `p-ie47xwqg` holds `proposed/p-ie47xwqg.json`, so Apply's step 0 passes only after a Rollback. If AWS Settings has rewritten the policy, derive a new proposal from its new text rather than re-running Apply.

```sh
set -eu
P="--profile zachverse-management"
[ -f docs/org-policy/README.md ] || { echo "Run this from the repository root." >&2; exit 1; }
for f in proposed/region-floor.json proposed/website-us-east-1.json proposed/p-ie47xwqg.json backup-2026-10-12/p-ie47xwqg.content.json; do
  [ -f "docs/org-policy/$f" ] || { echo "Missing docs/org-policy/$f" >&2; exit 1; }
done
# Guard: stop unless this is a role session (never root) in the management account.
ARN=$(aws sts get-caller-identity $P --query Arn --output text | tr -d '\r')
case "$ARN" in arn:aws:sts::969788248923:assumed-role/*) ;; *) echo "Not a management-account role session ($ARN): sign in with the AWS Settings role." >&2; aws logout $P; exit 1 ;; esac
trap 'aws logout $P' EXIT
# The policy text as AWS holds it; command substitution drops the trailing newline, and tr a CR.
live() { aws organizations describe-policy $P --policy-id p-ie47xwqg --query Policy.Content --output text | tr -d '\r'; }
# 0. The live policy must still match the backup; a failed read matches nothing.
[ "$(live)" = "$(cat docs/org-policy/backup-2026-10-12/p-ie47xwqg.content.json)" ] || { echo "p-ie47xwqg differs from the backup: stop and review." >&2; exit 1; }
# 1. Region floor as its own root policy (duplicates the existing statement, so no effect yet).
F=$(aws organizations create-policy $P --type SERVICE_CONTROL_POLICY --name ZachverseRegionFloor \
  --description "RegionFloor statement moved verbatim from p-ie47xwqg" \
  --content file://docs/org-policy/proposed/region-floor.json --query Policy.PolicySummary.Id --output text | tr -d '\r')
case "$F" in p-?*) ;; *) echo "No policy ID for ZachverseRegionFloor" >&2; exit 1 ;; esac
aws organizations attach-policy $P --policy-id "$F" --target-id r-58a9
# 2. Website-only us-east-1 restriction (adds denies, so no effect yet).
W=$(aws organizations create-policy $P --type SERVICE_CONTROL_POLICY --name ZachverseWebsiteUsEast1 \
  --description "UsEast1Partitional for 426499248998 plus CloudFormation, S3, SSM, ECR, PricingPlanManager" \
  --content file://docs/org-policy/proposed/website-us-east-1.json --query Policy.PolicySummary.Id --output text | tr -d '\r')
case "$W" in p-?*) ;; *) echo "No policy ID for ZachverseWebsiteUsEast1" >&2; exit 1 ;; esac
aws organizations attach-policy $P --policy-id "$W" --target-id 426499248998
# 3. Exempt only the Website account from the root statement. This is the step that takes effect.
aws organizations update-policy $P --policy-id p-ie47xwqg --content file://docs/org-policy/proposed/p-ie47xwqg.json
echo "Applied: ZachverseRegionFloor $F, ZachverseWebsiteUsEast1 $W. Record both IDs for Rollback."
```

## Verify

SCPs and RCPs do not apply to the management account itself, so the policies' effects are verified from the Website account. Run these there (`--profile default`, temporary `AccountFullAccessRole` credentials):

- `aws cloudformation list-stacks --region us-east-1`
- `aws ssm get-parameter --name /cdk-bootstrap/hnb659fds/version --region us-east-1` (returns `ParameterNotFound` before bootstrap; in Git Bash, prefix it with `MSYS_NO_PATHCONV=1`, or Git Bash turns the name into a Windows path)
- `aws ecr describe-repositories --region us-east-1`
- `aws pricing-plan-manager list-subscriptions --region us-east-1`
- `iam:SimulatePrincipalPolicy` for the us-east-1 actions in ADR 0002

Then, from the management account, list the attachments and compare them with `attachments.jsonl`: the root gains `ZachverseRegionFloor`, `426499248998` gains `ZachverseWebsiteUsEast1`, and nothing else changes.

```sh
set -eu
P="--profile zachverse-management"
ARN=$(aws sts get-caller-identity $P --query Arn --output text | tr -d '\r')
case "$ARN" in arn:aws:sts::969788248923:assumed-role/*) ;; *) echo "Not a management-account role session ($ARN)." >&2; aws logout $P; exit 1 ;; esac
trap 'aws logout $P' EXIT
for target in r-58a9 426499248998 796429457615; do
  for type in SERVICE_CONTROL_POLICY RESOURCE_CONTROL_POLICY; do
    echo "$target $type: $(aws organizations list-policies-for-target $P --target-id "$target" --filter "$type" --query 'Policies[].Name' --output text)"
  done
done
```

## Rollback (management account)

The IDs are those of the 2026-10-12 apply; after a later Apply, use the IDs it printed. The script stops if `p-ie47xwqg` no longer holds the applied text (AWS Settings may have rewritten it, and restoring the backup would undo that), and removes nothing until the restored text reads back.

```sh
set -eu
P="--profile zachverse-management"
F=p-xwdm4cce W=p-1mpgzmjr
[ -f docs/org-policy/README.md ] || { echo "Run this from the repository root." >&2; exit 1; }
for f in proposed/p-ie47xwqg.json backup-2026-10-12/p-ie47xwqg.content.json; do
  [ -f "docs/org-policy/$f" ] || { echo "Missing docs/org-policy/$f" >&2; exit 1; }
done
# Guard: stop unless this is a role session (never root) in the management account.
ARN=$(aws sts get-caller-identity $P --query Arn --output text | tr -d '\r')
case "$ARN" in arn:aws:sts::969788248923:assumed-role/*) ;; *) echo "Not a management-account role session ($ARN): sign in with the AWS Settings role." >&2; aws logout $P; exit 1 ;; esac
trap 'aws logout $P' EXIT
live() { aws organizations describe-policy $P --policy-id p-ie47xwqg --query Policy.Content --output text | tr -d '\r'; }
[ "$(live)" = "$(cat docs/org-policy/proposed/p-ie47xwqg.json)" ] || { echo "p-ie47xwqg is not the applied text: stop and review." >&2; exit 1; }
# Restoring the original text first reinstates every original deny before anything is removed.
aws organizations update-policy $P --policy-id p-ie47xwqg --content file://docs/org-policy/backup-2026-10-12/p-ie47xwqg.content.json
[ "$(live)" = "$(cat docs/org-policy/backup-2026-10-12/p-ie47xwqg.content.json)" ] || { echo "The restore did not read back; nothing was removed." >&2; exit 1; }
aws organizations detach-policy $P --policy-id "$W" --target-id 426499248998
aws organizations delete-policy $P --policy-id "$W"
aws organizations detach-policy $P --policy-id "$F" --target-id r-58a9
aws organizations delete-policy $P --policy-id "$F"
echo "Rolled back: p-ie47xwqg restored; $W and $F removed."
```

## Caveat

AWS created `p-ie47xwqg` when advanced features were activated. It is customer-managed (`AwsManaged: false`), but AWS Settings may rewrite it later. If that happens, the Website account's us-east-1 access closes again; it never silently widens.
