# Dev test data (craft-os-dev only)

This file records the test data added by hand on the dev project
(`egznnbjmicebbhwasloy`). None of it is a schema change, so none of it is a
migration. Never run any of this on production.

Passwords are not in the repo. Ask the owner for them.

## Branches

| Branch  | How it got there |
|---------|------------------|
| Cheras  | already on dev |
| Puchong | already on dev |
| Demo    | already on dev (POS pilot) |
| Kepong  | `supabase/migration-2026-10-12-branch-kepong.sql`, applied to dev on 2026-10-26 (it was already in the repo but had not been run on dev). Note: on dev only Kepong has geofence coordinates; Cheras and Puchong have none there. |

## Test logins (`@craftale.test`)

| Login | Rank / system_role | Branch |
|-------|--------------------|--------|
| test.manager.cheras     | manager / manager       | Cheras (manager: sees all branches) |
| test.supervisor.cheras  | supervisor / supervisor | Cheras (HQ) |
| test.staff.cheras       | junior / staff          | Cheras |
| test.supervisor.puchong | supervisor / supervisor | Puchong |
| test.staff.puchong      | junior / staff          | Puchong |
| test.supervisor.kepong  | supervisor / supervisor | Kepong |
| test.staff.kepong       | junior / staff          | Kepong |

Auth users were created with the Auth admin API (email confirmed,
`user_metadata = {name, test_account: true, email_verified: true}`). The staff
row uses the same id as the auth user. The Kepong rows were added with:

```sql
insert into staff (id, name, email, rank, system_role, branch, branch_id, status, is_active, level, xp, onboarding_completed)
select v.id, v.name, v.email, v.rank, v.role, 'Kepong', b.id, 'active', true, 1, 0, true
  from (values
    ('<auth user id>'::uuid, 'Test Supervisor Kepong', 'test.supervisor.kepong@craftale.test', 'supervisor', 'supervisor'),
    ('<auth user id>'::uuid, 'Test Staff Kepong',      'test.staff.kepong@craftale.test',      'junior',     'staff')
  ) v(id, name, email, rank, role)
  cross join (select id from branches where name = 'Kepong') b
on conflict (id) do nothing;
```

All procurement test items, suppliers and orders are prefixed `[TEST]`.
