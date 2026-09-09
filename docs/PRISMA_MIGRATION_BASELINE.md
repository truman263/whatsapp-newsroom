# Prisma migration baseline

## Repair

A fresh PostgreSQL replay exposed an invalid lexical order in the original migration history. Prisma ran `20260830104636_round_1_2_simbidzebasa_contract_alignment` before `20260830120000_round_1_domain_foundation`, so the alignment migration attempted to alter `Reporter` and `Story` before those tables existed.

The active history is therefore squashed into `00000000000000_round_1_2_baseline`. Its SQL is the byte-for-byte legacy foundation SQL followed immediately by the byte-for-byte Round 1.2 alignment SQL. This is migration-history repair, not schema expansion. `prisma/schema.prisma` is unchanged, and no live database was accessed.

## Provenance

The original sources remain under `prisma/migration-history-legacy/` as historical evidence.

| Legacy migration | SHA-256 of `migration.sql` |
| --- | --- |
| `20260830120000_round_1_domain_foundation` | `0484b6d0d44ef16d2d404cc0ca7bfd2fd1458021aafb0e8012ad742d4ccea32b` |
| `20260830104636_round_1_2_simbidzebasa_contract_alignment` | `857e23b8b4a3fb4ddb5f35706f0bc2319b843aa617176c2ce7a6fb61cffd7b09` |

New baseline SHA-256:

`ba4a1ddb2d58a32244ea9deffe5afaa3d7efde036ad928c670ad7c92d2a9790a`

## Deployment model

Fresh databases execute the baseline normally with `prisma migrate deploy`.

Databases that already contain the approved legacy schema must not execute the baseline SQL. After verifying their schema and successful legacy migration records, operators must mark `00000000000000_round_1_2_baseline` as applied using the approved Prisma 6 baseline-resolution procedure before running future deployments. Existing historical migration records are retained.

Production remains NO-GO. Adoption requires supervisor approval, a read-only database audit, and a backup/recovery checkpoint before any baseline resolution is attempted.
