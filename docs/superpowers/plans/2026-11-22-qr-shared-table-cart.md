# QR Guest Names and Shared Table Cart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guests who scan a table's QR code pick an avatar and a name, add items to one cart the whole table sees live, and send it together; the guest's name reaches the kitchen ticket, the POS bill and Split items.

**Architecture:** The cart moves from each phone's memory to a server table (`qr_cart_lines`) that anonymous clients reach only through token-checked `security definer` RPCs. After each write a phone sends an empty Realtime Broadcast ping on the table's channel; phones that hear it re-read the cart, and every phone re-reads every 15 s as a fallback. `qr_cart_send` turns the cart into one order through the existing `pos_insert_order`, which is re-created from its live text with five marked lines so order items and ticket lines carry the guest.

**Tech Stack:** React 19 + TypeScript + Vite, Tailwind classes already in the app, `@supabase/supabase-js` 2 (RPC + Realtime Broadcast), Postgres (plpgsql), vitest + @testing-library/react.

Spec: `docs/superpowers/specs/2026-11-22-qr-shared-table-cart-design.md`. Read it first.

## Global Constraints

- Work in the worktree `/Users/USER/Desktop/Craft_OS/.claude/worktrees/pos-demo`, branch `feature/pos-demo`. Never switch branches there.
- Database: **dev only** — project ref `egznnbjmicebbhwasloy`. Never run anything against prod (`yfsoesxzurzjdwstszru`).
- Run SQL files yourself through the Management API (do not hand SQL to the owner). Define this helper once per shell:

  ```bash
  runsql() { jq -Rs '{query: .}' "$1" | curl -sS -X POST "https://api.supabase.com/v1/projects/egznnbjmicebbhwasloy/database/query" -H "Authorization: Bearer $(cat ~/.supabase-access-token)" -H "Content-Type: application/json" --data-binary @-; echo; }
  ```

- All customer- and staff-facing copy is English, exactly as written in this plan.
- Limits, verbatim from the spec: 50 lines per table cart; quantity 1–20 per line; note 200 characters; name 20 characters; avatars `a1`…`a8`; stale after 2 hours; fallback read every 15 s.
- `place_table_order` stays as it is. `pos_insert_order`'s checks are not touched.
- Tests: `npx vitest run <file>` for one file, `npm test` for all, `npm run lint`, `npm run build`. All four must pass before a task's commit.
- Every commit message ends with the line `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/qr-broadcast-check.mjs` (new) | One-off check: may an anon client broadcast on dev? |
| `supabase/migration-2026-11-22-qr-table-cart.sql` (new) | Cart table, guest columns, cart RPCs, `pos_insert_order` and `qr_table_state` re-created |
| `supabase/migration-2026-11-22-qr-table-cart-verify.sql` (new) | Rolled-back self-check, ends in `VERIFY OK` |
| `src/qr/qrGuest.ts` (+ test) (new) | Who this phone is: avatars, name cleaning, storage |
| `src/qr/qrCart.ts` (+ test) (new) | Pure cart logic: parsing, grouping, availability, totals, toast text, channel name |
| `src/qr/qrCartApi.ts` (new) | The five RPC calls and the Broadcast signal |
| `src/qr/useTableCart.ts` (+ test) (new) | Hook: holds the cart, refreshes on ping / timer / visibility, write actions |
| `src/qr/GuestCard.tsx` (+ test) (new) | "Who's ordering?" card |
| `src/qr/SendSheet.tsx` (+ test) (new) | "Has everyone ordered?" sheet |
| `src/qr/QrApp.tsx` (rewritten) | Page wiring |
| `src/qr/qrState.ts` (+ test) (trimmed) | Keeps `tokenFromLocation` only |
| `src/features/pos/order/LineSheet.tsx` | Two optional props: `busy`, `error` |
| `src/features/pos/print/ticket.ts` (+ test) | Ticket line prints the guest |
| `src/features/pos/order/posApi.ts`, `BillColumn.tsx` | Bill line shows the guest |
| `src/features/pos/order/splitSelection.ts` (+ test), `SplitItemsScreen.tsx` (+ test) | Pick by guest chips |

---

### Task 1: Check that an anonymous client may broadcast on dev

**Files:**
- Create: `scripts/qr-broadcast-check.mjs`

**Interfaces:**
- Produces: a recorded answer (`BROADCAST OK` or `BROADCAST FAILED`) that Task 5 uses to set `CART_SWEEP_MS` (15000 when OK, 4000 when FAILED).

- [ ] **Step 1: Write the script**

```js
// scripts/qr-broadcast-check.mjs
// One-off: can two anon clients on the dev project exchange a Realtime Broadcast message?
// Run from the repo root: node scripts/qr-broadcast-check.mjs
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => {
    const i = l.indexOf('=')
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
  }),
)
if (!String(env.VITE_SUPABASE_URL).includes('egznnbjmicebbhwasloy')) {
  console.error('Refusing: .env.local does not point at the dev project')
  process.exit(2)
}
const make = () => createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
})
const listener = make()
const sender = make()
const topic = `qr-check-${Date.now()}`

const heard = new Promise((resolve) => {
  listener.channel(topic).on('broadcast', { event: 'changed' }, () => resolve(true)).subscribe((s) => {
    if (s !== 'SUBSCRIBED') return
    const ch = sender.channel(topic)
    ch.subscribe((s2) => { if (s2 === 'SUBSCRIBED') void ch.send({ type: 'broadcast', event: 'changed', payload: {} }) })
  })
})
const ok = await Promise.race([heard, new Promise((r) => setTimeout(() => r(false), 8000))])
console.log(ok ? 'BROADCAST OK' : 'BROADCAST FAILED')
process.exit(ok ? 0 : 1)
```

- [ ] **Step 2: Run it**

Run: `node scripts/qr-broadcast-check.mjs`
Expected: `BROADCAST OK` (exit 0). If it prints `BROADCAST FAILED`, run it once more; if it fails twice, that is the answer — carry on, Task 5 then uses 4000.

- [ ] **Step 3: Record the answer in the spec**

In `docs/superpowers/specs/2026-11-22-qr-shared-table-cart-design.md`, replace the bullet that starts `- **To verify first:**` with one of:

```markdown
  - **Verified 2026-11-22:** an `anon` client may broadcast on a public channel in the dev project
    (`scripts/qr-broadcast-check.mjs`). The fallback read stays at 15 s.
```

or, if it failed:

```markdown
  - **Checked 2026-11-22:** an `anon` client may NOT broadcast in the dev project
    (`scripts/qr-broadcast-check.mjs`), so the page reads every 4 s while in view.
```

- [ ] **Step 4: Commit**

```bash
git add scripts/qr-broadcast-check.mjs docs/superpowers/specs/2026-11-22-qr-shared-table-cart-design.md
git commit -m "chore(qr): check anon Realtime Broadcast on dev

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
```

---

### Task 2: Server — cart table, RPCs, guest on order items and tickets

**Files:**
- Create: `supabase/migration-2026-11-22-qr-table-cart.sql`
- Create: `supabase/migration-2026-11-22-qr-table-cart-verify.sql`
- Read only: `supabase/migration-2026-10-24-pos-slots-photos-fn.sql` (the source of `pos_insert_order`)

**Interfaces:**
- Produces (RPCs callable by `anon`; all raise plain-text errors):
  - `qr_cart_state(p_token text) returns jsonb` → `{ version: string, lines: [{ id, guestId, guestLabel, guestAvatar, productId, variantId, optionIds: string[], qty, note }] }`, or `null` for an unknown/inactive table.
  - `qr_cart_put(p_token text, p_guest jsonb, p_line jsonb, p_line_id uuid) returns uuid` — `p_guest` = `{id, name, avatar}`, `p_line` = `{productId, variantId, qty, note, optionIds}`.
  - `qr_cart_remove(p_token text, p_guest_id uuid, p_line_id uuid) returns void`
  - `qr_cart_rename(p_token text, p_guest jsonb) returns void`
  - `qr_cart_send(p_token text, p_pax integer, p_version text, p_skip uuid[], p_client_order_id uuid) returns jsonb` → `{status:'sent', orderId}` or `{status:'changed'}`.
  - `qr_table_state` items gain `guestLabel`, `guestAvatar` (nullable strings).
  - `order_items` gains `guest_id uuid`, `guest_label text`, `guest_avatar text`.
  - Ticket payload lines gain `"guest": "<label>"` only when the item has one.

- [ ] **Step 1: Confirm the file's `pos_insert_order` is the one live on dev**

```bash
cat > /tmp/live_fn.sql <<'EOF'
select md5(regexp_replace(prosrc, '\s+', '', 'g')) as live from pg_proc
 where oid = 'pos_insert_order(uuid,uuid,text,integer,text,uuid,jsonb,uuid,uuid)'::regprocedure;
EOF
runsql /tmp/live_fn.sql
python3 - <<'EOF'
import re, hashlib
src = open('supabase/migration-2026-10-24-pos-slots-photos-fn.sql').read()
start = src.index('create or replace function pos_insert_order(')
body = re.search(r'as \$\$(.*?)\$\$;', src[start:], re.S).group(1)
print('file', hashlib.md5(re.sub(r'\s+', '', body).encode()).hexdigest())
EOF
```

Expected: the `live` value equals the `file` value. If they differ, **stop**: a later change to `pos_insert_order` exists outside that file. Find it (`grep -rn "pos_insert_order" supabase/`), use that text as the source in Step 3 instead, and say so in the commit message.

- [ ] **Step 2: Write the migration, with a marker where `pos_insert_order` goes**

Create `supabase/migration-2026-11-22-qr-table-cart.sql`:

```sql
-- QR guest names and shared table cart (docs/superpowers/specs/2026-11-22-qr-shared-table-cart-design.md).
-- Run on craft-os-dev after the POS chain up to migration-2026-11-18-pos-reports.sql. Safe to re-run.
--   1 qr_cart_lines: one cart per table, written only through the functions below
--   2 order_items.guest_id / guest_label / guest_avatar
--   3 helpers (not callable by clients) and the five cart RPCs (anon)
--   4 pos_insert_order re-created: the live text with the lines marked "-- G" changed
--   5 qr_table_state re-created: each item says which guest ordered it

-- ── 1 ─────────────────────────────────────────────────────────────────────────
create table if not exists qr_cart_lines (
  id           uuid primary key default gen_random_uuid(),
  table_id     uuid not null references dining_tables(id) on delete cascade,
  guest_id     uuid not null,
  guest_name   text not null,
  guest_avatar text not null,
  product_id   uuid not null,
  variant_id   uuid not null,
  option_ids   uuid[] not null default '{}',
  qty          integer not null check (qty between 1 and 20),
  note         text,
  created_at   timestamptz not null default clock_timestamp(),
  updated_at   timestamptz not null default clock_timestamp()
);
create index if not exists qr_cart_lines_table on qr_cart_lines(table_id, created_at);
alter table qr_cart_lines enable row level security;   -- no policies: functions only
revoke all on qr_cart_lines from public, anon, authenticated;

-- ── 2 ─────────────────────────────────────────────────────────────────────────
alter table order_items add column if not exists guest_id     uuid;
alter table order_items add column if not exists guest_label  text;   -- 'Eric', 'Guest 2'; null = counter
alter table order_items add column if not exists guest_avatar text;   -- 'a1'…'a8'; shown on the QR page only

-- ── 3 helpers ─────────────────────────────────────────────────────────────────
-- The table a token names, for a write: unknown, switched off or paused is refused.
create or replace function qr_cart_table(p_token text) returns dining_tables
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v dining_tables;
begin
  select * into v from dining_tables where qr_token = p_token;
  if not found or not v.is_active then raise exception 'Invalid table code'; end if;
  if v.qr_paused then
    raise exception 'Ordering is paused for this table. Please order at the counter.';
  end if;
  return v;
end $$;
revoke all on function qr_cart_table(text) from public, anon, authenticated;

-- {id, name, avatar} as the client sent it → cleaned: a well-formed id, a name of 1–20 characters
-- ('Guest' when empty), one of the eight avatars.
create or replace function qr_cart_guest(p_guest jsonb) returns jsonb
language plpgsql immutable set search_path = public, pg_temp as $$
declare
  v_name   text;
  v_avatar text;
begin
  if p_guest is null or jsonb_typeof(p_guest) <> 'object'
     or jsonb_typeof(p_guest->'id') is distinct from 'string'
     or (p_guest->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'Invalid guest';
  end if;
  v_name := case when jsonb_typeof(p_guest->'name') = 'string' then p_guest->>'name' else '' end;
  v_name := btrim(left(btrim(regexp_replace(v_name, '[[:cntrl:]]', '', 'g')), 20));
  if v_name = '' then v_name := 'Guest'; end if;
  v_avatar := case when jsonb_typeof(p_guest->'avatar') = 'string' then p_guest->>'avatar' end;
  if v_avatar is null or v_avatar !~ '^a[1-8]$' then v_avatar := 'a1'; end if;
  return jsonb_build_object('id', lower(p_guest->>'id'), 'name', v_name, 'avatar', v_avatar);
end $$;
revoke all on function qr_cart_guest(jsonb) from public, anon, authenticated;

-- One cart writer per table at a time (transaction-scoped).
create or replace function qr_cart_lock(p_table_id uuid) returns void
language sql security definer set search_path = public, pg_temp as $$
  select pg_advisory_xact_lock(hashtextextended('qr_cart:' || p_table_id::text, 0));
$$;
revoke all on function qr_cart_lock(uuid) from public, anon, authenticated;

-- Stale lines go: older than 2 hours, or left by a party whose bill has been closed.
create or replace function qr_cart_purge(p_table_id uuid) returns void
language sql security definer set search_path = public, pg_temp as $$
  delete from qr_cart_lines l
   where l.table_id = p_table_id
     and (l.created_at < now() - interval '2 hours'
          or (not exists (select 1 from bills b where b.table_id = p_table_id and b.status = 'open')
              and l.created_at < (select max(b.closed_at) from bills b
                                   where b.table_id = p_table_id and b.status <> 'open')));
$$;
revoke all on function qr_cart_purge(uuid) from public, anon, authenticated;

-- What a sender must have seen: changes with every add, edit, removal and rename.
create or replace function qr_cart_version(p_table_id uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(md5(string_agg(l.id::text || ':' || extract(epoch from l.updated_at)::text, ','
                                 order by l.created_at, l.id)), 'empty')
    from qr_cart_lines l where l.table_id = p_table_id;
$$;
revoke all on function qr_cart_version(uuid) from public, anon, authenticated;

-- guest id → the label shown everywhere, unique on the table. A guest with lines on the table's
-- open bill keeps that label; the others take their name, or name + ' 2', ' 3' … when it is taken,
-- in the order of their first cart line.
create or replace function qr_cart_labels(p_table_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_bill  uuid;
  v_out   jsonb := '{}'::jsonb;
  v_taken text[] := '{}';
  r       record;
  v_label text;
  v_n     integer;
begin
  select id into v_bill from bills where table_id = p_table_id and status = 'open';
  if v_bill is not null then
    for r in select oi.guest_id, min(oi.guest_label) as label from order_items oi
              where oi.bill_id = v_bill and oi.guest_id is not null and oi.guest_label is not null
              group by oi.guest_id
    loop
      v_out := v_out || jsonb_build_object(r.guest_id::text, r.label);
      v_taken := v_taken || lower(r.label);
    end loop;
  end if;
  for r in select l.guest_id, (array_agg(l.guest_name order by l.updated_at desc, l.id))[1] as name
             from qr_cart_lines l where l.table_id = p_table_id
            group by l.guest_id order by min(l.created_at), l.guest_id
  loop
    if v_out ? r.guest_id::text then continue; end if;
    v_label := r.name;
    v_n := 1;
    while lower(v_label) = any (v_taken) loop
      v_n := v_n + 1;
      v_label := r.name || ' ' || v_n;
    end loop;
    v_out := v_out || jsonb_build_object(r.guest_id::text, v_label);
    v_taken := v_taken || lower(v_label);
  end loop;
  return v_out;
end $$;
revoke all on function qr_cart_labels(uuid) from public, anon, authenticated;

-- ── 3 the cart RPCs ───────────────────────────────────────────────────────────
-- Not STABLE: it deletes stale lines (PostgREST runs STABLE functions read-only).
create or replace function qr_cart_state(p_token text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_table  dining_tables;
  v_labels jsonb;
begin
  select * into v_table from dining_tables where qr_token = p_token and is_active;
  if not found then return null; end if;
  perform qr_cart_purge(v_table.id);
  v_labels := qr_cart_labels(v_table.id);
  return jsonb_build_object(
    'version', qr_cart_version(v_table.id),
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'guestId', l.guest_id, 'guestLabel', v_labels->>(l.guest_id::text),
               'guestAvatar', l.guest_avatar, 'productId', l.product_id, 'variantId', l.variant_id,
               'optionIds', to_jsonb(l.option_ids), 'qty', l.qty, 'note', l.note)
             order by l.created_at, l.id)
        from qr_cart_lines l where l.table_id = v_table.id), '[]'::jsonb));
end $$;
revoke all on function qr_cart_state(text) from public;
grant execute on function qr_cart_state(text) to anon, authenticated;

create or replace function qr_cart_put(p_token text, p_guest jsonb, p_line jsonb, p_line_id uuid) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_table dining_tables;
  v_g     jsonb;
  v_qty   numeric;
  v_opts  uuid[];
  v_note  text;
  v_id    uuid;
  c_uuid  constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  v_table := qr_cart_table(p_token);
  v_g := qr_cart_guest(p_guest);
  if p_line is null or jsonb_typeof(p_line) <> 'object'
     or jsonb_typeof(p_line->'productId') is distinct from 'string' or (p_line->>'productId') !~* c_uuid
     or jsonb_typeof(p_line->'variantId') is distinct from 'string' or (p_line->>'variantId') !~* c_uuid then
    raise exception 'Invalid item';
  end if;
  if not exists (select 1 from menu_variants v join menu_products p on p.id = v.product_id
                  where v.id = (p_line->>'variantId')::uuid and p.id = (p_line->>'productId')::uuid
                    and v.is_active and p.is_active and not p.is_addon) then
    raise exception 'Invalid item';
  end if;
  if jsonb_typeof(p_line->'qty') is distinct from 'number' then raise exception 'Invalid quantity'; end if;
  v_qty := (p_line->'qty')::numeric;
  if v_qty < 1 or v_qty > 20 or v_qty <> trunc(v_qty) then raise exception 'Invalid quantity'; end if;
  if p_line->'optionIds' is not null and jsonb_typeof(p_line->'optionIds') <> 'array' then
    raise exception 'Invalid add-ons';
  end if;
  if jsonb_array_length(coalesce(p_line->'optionIds', '[]'::jsonb)) > 30
     or exists (select 1 from jsonb_array_elements(coalesce(p_line->'optionIds', '[]'::jsonb)) e
                 where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~* c_uuid) then
    raise exception 'Invalid add-ons';
  end if;
  select coalesce(array_agg(x.v::uuid), '{}') into v_opts
    from jsonb_array_elements_text(coalesce(p_line->'optionIds', '[]'::jsonb)) as x(v);
  v_note := nullif(btrim(left(case when jsonb_typeof(p_line->'note') = 'string' then p_line->>'note' end, 200)), '');

  perform qr_cart_lock(v_table.id);
  perform qr_cart_purge(v_table.id);
  if p_line_id is null then
    if (select count(*) from qr_cart_lines where table_id = v_table.id) >= 50 then
      raise exception 'This table''s order is full. Please send it first.';
    end if;
    insert into qr_cart_lines(table_id, guest_id, guest_name, guest_avatar, product_id, variant_id, option_ids, qty, note)
    values (v_table.id, (v_g->>'id')::uuid, v_g->>'name', v_g->>'avatar',
            (p_line->>'productId')::uuid, (p_line->>'variantId')::uuid, v_opts, v_qty::integer, v_note)
    returning id into v_id;
  else
    if not exists (select 1 from qr_cart_lines where id = p_line_id and table_id = v_table.id) then
      raise exception 'That item is no longer in the order.';
    end if;
    update qr_cart_lines
       set product_id = (p_line->>'productId')::uuid, variant_id = (p_line->>'variantId')::uuid,
           option_ids = v_opts, qty = v_qty::integer, note = v_note, updated_at = clock_timestamp()
     where id = p_line_id and table_id = v_table.id and guest_id = (v_g->>'id')::uuid
    returning id into v_id;
    if v_id is null then raise exception 'You can only change your own items.'; end if;
  end if;
  -- one name and avatar per guest across their lines
  update qr_cart_lines set guest_name = v_g->>'name', guest_avatar = v_g->>'avatar', updated_at = clock_timestamp()
   where table_id = v_table.id and guest_id = (v_g->>'id')::uuid
     and (guest_name, guest_avatar) is distinct from (v_g->>'name', v_g->>'avatar');
  return v_id;
end $$;
revoke all on function qr_cart_put(text, jsonb, jsonb, uuid) from public;
grant execute on function qr_cart_put(text, jsonb, jsonb, uuid) to anon, authenticated;

create or replace function qr_cart_remove(p_token text, p_guest_id uuid, p_line_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_table dining_tables;
begin
  v_table := qr_cart_table(p_token);
  perform qr_cart_lock(v_table.id);
  delete from qr_cart_lines where id = p_line_id and table_id = v_table.id and guest_id = p_guest_id;
  if not found and exists (select 1 from qr_cart_lines where id = p_line_id and table_id = v_table.id) then
    raise exception 'You can only change your own items.';
  end if;
end $$;
revoke all on function qr_cart_remove(text, uuid, uuid) from public;
grant execute on function qr_cart_remove(text, uuid, uuid) to anon, authenticated;

create or replace function qr_cart_rename(p_token text, p_guest jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_table dining_tables;
  v_g     jsonb;
begin
  v_table := qr_cart_table(p_token);
  v_g := qr_cart_guest(p_guest);
  perform qr_cart_lock(v_table.id);
  update qr_cart_lines set guest_name = v_g->>'name', guest_avatar = v_g->>'avatar', updated_at = clock_timestamp()
   where table_id = v_table.id and guest_id = (v_g->>'id')::uuid
     and (guest_name, guest_avatar) is distinct from (v_g->>'name', v_g->>'avatar');
end $$;
revoke all on function qr_cart_rename(text, jsonb) from public;
grant execute on function qr_cart_rename(text, jsonb) to anon, authenticated;

-- The table's cart becomes one order. p_version is the cart the sender confirmed; p_skip the lines
-- their phone showed as unavailable. The checks before the lock are place_table_order's.
create or replace function qr_cart_send(p_token text, p_pax integer, p_version text, p_skip uuid[], p_client_order_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_table    dining_tables;
  v_existing uuid;
  v_recent   integer;
  v_labels   jsonb;
  v_items    jsonb;
  v_order    uuid;
begin
  select * into v_table from dining_tables where qr_token = p_token;
  if not found then raise exception 'Invalid table code'; end if;
  if p_client_order_id is null then raise exception 'Order id is missing'; end if;
  -- resend of an order that already went in: return it even if the table was paused since
  select id into v_existing from orders where client_order_id = p_client_order_id;
  if v_existing is not null then return jsonb_build_object('status', 'sent', 'orderId', v_existing); end if;
  if not v_table.is_active then raise exception 'Invalid table code'; end if;
  if v_table.qr_paused then
    raise exception 'Ordering is paused for this table. Please order at the counter.';
  end if;
  if coalesce((select s.qr_requires_open_bill from branch_pos_settings s where s.branch_id = v_table.branch_id), false)
     and not exists (select 1 from bills b where b.table_id = v_table.id and b.status = 'open') then
    raise exception 'Please ask our staff to open your table before ordering.';
  end if;

  perform qr_cart_lock(v_table.id);
  select id into v_existing from orders where client_order_id = p_client_order_id;   -- a resend that waited on the lock
  if v_existing is not null then return jsonb_build_object('status', 'sent', 'orderId', v_existing); end if;
  perform qr_cart_purge(v_table.id);
  if qr_cart_version(v_table.id) is distinct from p_version then
    return jsonb_build_object('status', 'changed');
  end if;
  select count(*) into v_recent
    from orders o join bills b on b.id = o.bill_id
   where b.table_id = v_table.id and o.source = 'qr' and o.placed_at > now() - interval '1 minute';
  if v_recent >= 5 then
    raise exception 'Too many orders from this table. Please wait a minute.';
  end if;

  v_labels := qr_cart_labels(v_table.id);
  select jsonb_agg(jsonb_build_object(
           'productId', l.product_id, 'variantId', l.variant_id, 'qty', l.qty, 'note', l.note,
           'optionIds', to_jsonb(l.option_ids), 'guestId', l.guest_id,
           'guestLabel', v_labels->>(l.guest_id::text), 'guestAvatar', l.guest_avatar)
         order by l.created_at, l.id)
    into v_items
    from qr_cart_lines l
   where l.table_id = v_table.id and not (l.id = any (coalesce(p_skip, '{}'::uuid[])));
  if v_items is null then raise exception 'Nothing to send.'; end if;

  v_order := pos_insert_order(v_table.branch_id, v_table.id, 'dine_in', p_pax, 'qr', null, v_items, p_client_order_id, null);
  delete from qr_cart_lines where table_id = v_table.id;
  return jsonb_build_object('status', 'sent', 'orderId', v_order);
end $$;
revoke all on function qr_cart_send(text, integer, text, uuid[], uuid) from public;
grant execute on function qr_cart_send(text, integer, text, uuid[], uuid) to anon, authenticated;

-- ── 4 pos_insert_order: migration-2026-10-24-pos-slots-photos-fn.sql's text, lines marked "-- G" changed ──
-- @@POS_INSERT_ORDER@@

-- ── 5 qr_table_state: migration-2026-10-30-pos-discounts.sql's text + guestLabel / guestAvatar ──
create or replace function qr_table_state(p_token text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'tableLabel', t.label,
    'billNo', b.bill_no,
    'pax', b.pax,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', oi.name_snapshot, 'qty', oi.qty, 'unitPriceSen', oi.unit_price_sen,
               'mods', (select coalesce(jsonb_agg(m->>'name' order by ord), '[]'::jsonb)
                          from jsonb_array_elements(oi.modifiers_snapshot) with ordinality as x(m, ord)),
               'note', oi.note, 'voided', oi.voided_at is not null, 'placedAt', o.placed_at,
               'guestLabel', oi.guest_label, 'guestAvatar', oi.guest_avatar)                                  -- G
             order by o.placed_at, oi.name_snapshot)
        from order_items oi join orders o on o.id = oi.order_id
       where oi.bill_id = b.id), '[]'::jsonb),
    'subtotalSen', coalesce((select (x.tot->>'subtotalSen')::integer - (x.tot->>'billDiscountSen')::integer
                               from (select pos_bill_totals(b.id) as tot) x), 0))
  from dining_tables t
  left join bills b on b.table_id = t.id and b.status = 'open'
  where t.qr_token = p_token and t.is_active
$$;
revoke all on function qr_table_state(text) from public;
grant execute on function qr_table_state(text) to anon, authenticated;

notify pgrst, 'reload schema';
select 'qr table cart applied' as result;
```

- [ ] **Step 3: Put `pos_insert_order` in, copied from its source with five exact edits**

```bash
python3 - <<'EOF'
SRC = 'supabase/migration-2026-10-24-pos-slots-photos-fn.sql'   # or the file Step 1 told you to use
DST = 'supabase/migration-2026-11-22-qr-table-cart.sql'
src = open(SRC).read()
REVOKE = "revoke all on function pos_insert_order(uuid, uuid, text, integer, text, uuid, jsonb, uuid, uuid) from public, anon, authenticated;"
start = src.index('create or replace function pos_insert_order(')
end = src.index(REVOKE, start) + len(REVOKE)
fn = src[start:end]
UUID = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
edits = [
  # 1: three more columns
  ("                            sst_rate_bp, modifiers_snapshot, print_route, qty, note, takeaway_fee_sen)\n",
   "                            sst_rate_bp, modifiers_snapshot, print_route, qty, note, takeaway_fee_sen,\n"
   "                            guest_id, guest_label, guest_avatar)                                    -- G\n"),
  # 2: their values — a QR line may name the guest who added it (qr_cart_send); the counter never does
  ("            case when p_order_type = 'takeaway' then v_prod.takeaway_fee_sen else 0 end);",
   "            case when p_order_type = 'takeaway' then v_prod.takeaway_fee_sen else 0 end,\n"
   "            case when p_source = 'qr' and (v_item->>'guestId') ~* '" + UUID + "'\n"
   "                 then (v_item->>'guestId')::uuid end,                                                -- G\n"
   "            case when p_source = 'qr' then nullif(left(btrim(coalesce(v_item->>'guestLabel', '')), 24), '') end,   -- G\n"
   "            case when p_source = 'qr' and (v_item->>'guestAvatar') ~ '^a[1-8]$' then v_item->>'guestAvatar' end);  -- G"),
  # 3: the ticket line says who, when someone did
  ("           'lines', jsonb_agg(jsonb_build_object('qty', l.qty, 'name', l.name, 'note', l.note, 'mods', l.mods)\n",
   "           'lines', jsonb_agg(jsonb_build_object('qty', l.qty, 'name', l.name, 'note', l.note, 'mods', l.mods)\n"
   "                              || case when l.guest is null then '{}'::jsonb else jsonb_build_object('guest', l.guest) end   -- G\n"),
  # 4: the item's own line carries the guest
  ("with ordinality as x(m, ord)), '[]'::jsonb) as mods\n        from order_items oi\n       where oi.order_id = v_order_id and oi.print_route is not null",
   "with ordinality as x(m, ord)), '[]'::jsonb) as mods,\n             oi.guest_label as guest                                                             -- G\n        from order_items oi\n       where oi.order_id = v_order_id and oi.print_route is not null"),
  # 5: so does an add-on's line on another route
  ("      select m->>'route', 2, m->>'name', oi.qty, 'for ' || oi.name_snapshot, '[]'::jsonb\n",
   "      select m->>'route', 2, m->>'name', oi.qty, 'for ' || oi.name_snapshot, '[]'::jsonb, oi.guest_label   -- G\n"),
]
for i, (old, new) in enumerate(edits, 1):
    assert fn.count(old) == 1, f'edit {i}: expected exactly one match, found {fn.count(old)}'
    fn = fn.replace(old, new)
dst = open(DST).read()
assert dst.count('-- @@POS_INSERT_ORDER@@') == 1
open(DST, 'w').write(dst.replace('-- @@POS_INSERT_ORDER@@', fn))
print('ok', fn.count('-- G'), 'marked lines')
EOF
```

Expected: `ok 7 marked lines`. If an assert fails, open the source function, find the line the edit targets (the comments above each edit say which), and correct the `old` string's whitespace to match the file exactly — never change the function's logic.

- [ ] **Step 4: Write the verify script**

Create `supabase/migration-2026-11-22-qr-table-cart-verify.sql`:

```sql
-- Self-check for the QR table cart. Run on craft-os-dev after migration-2026-11-22-qr-table-cart.sql.
-- Everything is rolled back. Success = a result row "VERIFY OK".
-- It borrows a real dev table that has no open bill and a product on its QR menu that needs no
-- choices, so it needs no seed of its own. Three guests: A "Mei", B "Mei" (bad avatar), C unnamed.
begin;

create function pg_temp.expect_error(p_sql text, p_message text, p_label text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm is distinct from p_message then
      raise exception 'FAIL %: got "%" (expected "%")', p_label, sqlerrm, p_message;
    end if;
    return;
  end;
  raise exception 'FAIL %: no error (expected "%")', p_label, p_message;
end $$;

create function pg_temp.ok(p_cond boolean, p_label text) returns void
language plpgsql as $$
begin
  if p_cond is not true then raise exception 'FAIL %', p_label; end if;
end $$;

do $$
declare
  v_table dining_tables;
  v_prod  jsonb;
  v_line  jsonb;
  v_tok   text;
  ga constant jsonb := '{"id":"aaaaaaaa-0000-4000-8000-000000000001","name":"  Mei  ","avatar":"a3"}';
  gb constant jsonb := '{"id":"aaaaaaaa-0000-4000-8000-000000000002","name":"Mei","avatar":"a9"}';
  gc constant jsonb := '{"id":"aaaaaaaa-0000-4000-8000-000000000003","name":"","avatar":"a5"}';
  gd constant jsonb := '{"id":"aaaaaaaa-0000-4000-8000-000000000004","name":"Ann","avatar":"a2"}';
  ida uuid; idb uuid; idc uuid; idx uuid;
  s jsonb; r jsonb; v_order uuid; v_coid uuid := gen_random_uuid(); v_version text;
begin
  -- ── A: schema and grants ──
  perform pg_temp.ok((select relrowsecurity from pg_class where oid = 'qr_cart_lines'::regclass), 'A1 RLS on');
  perform pg_temp.ok(not has_table_privilege('anon', 'qr_cart_lines', 'select'), 'A2 anon cannot read the table');
  perform pg_temp.ok(has_function_privilege('anon', 'qr_cart_state(text)', 'execute'), 'A3 anon runs qr_cart_state');
  perform pg_temp.ok(has_function_privilege('anon', 'qr_cart_send(text, integer, text, uuid[], uuid)', 'execute'), 'A4 anon runs qr_cart_send');
  perform pg_temp.ok(not has_function_privilege('anon', 'qr_cart_labels(uuid)', 'execute'), 'A5 helpers are closed');
  perform pg_temp.ok(not has_function_privilege('anon', 'pos_insert_order(uuid, uuid, text, integer, text, uuid, jsonb, uuid, uuid)', 'execute'), 'A6 pos_insert_order still closed');
  perform pg_temp.ok(has_column_privilege('authenticated', 'order_items', 'guest_label', 'select'), 'A7 staff read guest_label');

  -- ── setup: a free table whose QR menu has a product that needs no choices ──
  select t.* into v_table from dining_tables t
   where t.is_active
     and not exists (select 1 from bills b where b.table_id = t.id and b.status = 'open')
     and exists (select 1 from jsonb_array_elements(qr_menu(t.qr_token)->'categories') c,
                               jsonb_array_elements(c->'products') p
                  where not (p->>'soldOut')::boolean and jsonb_array_length(p->'variants') > 0
                    and not exists (select 1 from jsonb_array_elements(p->'groups') g where (g->>'min')::integer > 0))
   order by t.created_at limit 1;
  if not found then raise exception 'FAIL setup: dev has no free table with a simple product on its QR menu'; end if;
  v_tok := v_table.qr_token;
  update dining_tables set qr_paused = false where id = v_table.id;
  update branch_pos_settings set qr_requires_open_bill = false where branch_id = v_table.branch_id;
  delete from qr_cart_lines where table_id = v_table.id;
  select p into v_prod from jsonb_array_elements(qr_menu(v_tok)->'categories') c, jsonb_array_elements(c->'products') p
   where not (p->>'soldOut')::boolean and jsonb_array_length(p->'variants') > 0
     and not exists (select 1 from jsonb_array_elements(p->'groups') g where (g->>'min')::integer > 0)
   limit 1;
  v_line := jsonb_build_object('productId', v_prod->>'id', 'variantId', v_prod->'variants'->0->>'id',
                               'qty', 2, 'note', '  no ice  ', 'optionIds', '[]'::jsonb);

  -- ── B: adding, labels, cleaning ──
  perform pg_temp.ok((qr_cart_state(v_tok)->>'version') = 'empty', 'B1 empty cart');
  perform pg_temp.ok(qr_cart_state('nosuchtoken') is null, 'B2 unknown table reads null');
  ida := qr_cart_put(v_tok, ga, v_line, null);
  idb := qr_cart_put(v_tok, gb, v_line, null);
  idc := qr_cart_put(v_tok, gc, v_line, null);
  s := qr_cart_state(v_tok);
  perform pg_temp.ok(jsonb_array_length(s->'lines') = 3, 'B3 three lines');
  perform pg_temp.ok((select l->>'guestLabel' from jsonb_array_elements(s->'lines') l where l->>'id' = ida::text) = 'Mei', 'B4 A is Mei (trimmed)');
  perform pg_temp.ok((select l->>'guestLabel' from jsonb_array_elements(s->'lines') l where l->>'id' = idb::text) = 'Mei 2', 'B5 B is Mei 2');
  perform pg_temp.ok((select l->>'guestLabel' from jsonb_array_elements(s->'lines') l where l->>'id' = idc::text) = 'Guest', 'B6 C is Guest');
  perform pg_temp.ok((select l->>'guestAvatar' from jsonb_array_elements(s->'lines') l where l->>'id' = idb::text) = 'a1', 'B7 a bad avatar becomes a1');
  perform pg_temp.ok((select l->>'note' from jsonb_array_elements(s->'lines') l where l->>'id' = ida::text) = 'no ice', 'B8 note trimmed');
  perform pg_temp.ok((s->>'version') <> 'empty', 'B9 version set');

  -- ── C: only your own lines; bad input ──
  perform pg_temp.expect_error(format('select qr_cart_put(%L, %L::jsonb, %L::jsonb, %L)', v_tok, gb, v_line, ida),
    'You can only change your own items.', 'C1 edit another guest''s line');
  v_version := s->>'version';
  perform qr_cart_put(v_tok, ga, v_line || '{"qty":3}', ida);
  s := qr_cart_state(v_tok);
  perform pg_temp.ok((select (l->>'qty')::integer from jsonb_array_elements(s->'lines') l where l->>'id' = ida::text) = 3, 'C2 own edit lands');
  perform pg_temp.ok((s->>'version') <> v_version, 'C3 an edit changes the version');
  perform pg_temp.expect_error(format('select qr_cart_remove(%L, %L, %L)', v_tok, gb->>'id', ida),
    'You can only change your own items.', 'C4 remove another guest''s line');
  perform qr_cart_remove(v_tok, (ga->>'id')::uuid, gen_random_uuid());   -- C5 a line already gone: no error
  perform pg_temp.expect_error(format('select qr_cart_put(%L, %L::jsonb, %L::jsonb, %L)', v_tok, ga, v_line, gen_random_uuid()),
    'That item is no longer in the order.', 'C6 edit a line that is gone');
  perform pg_temp.expect_error(format('select qr_cart_put(%L, %L::jsonb, %L::jsonb, null)', v_tok, ga, v_line || '{"qty":21}'),
    'Invalid quantity', 'C7 qty 21');
  perform pg_temp.expect_error(format('select qr_cart_put(%L, %L::jsonb, %L::jsonb, null)', v_tok, ga, v_line || jsonb_build_object('productId', gen_random_uuid())),
    'Invalid item', 'C8 unknown product');
  perform pg_temp.expect_error(format('select qr_cart_put(%L, %L::jsonb, %L::jsonb, null)', v_tok, '{"id":"x"}', v_line),
    'Invalid guest', 'C9 bad guest');
  perform pg_temp.expect_error(format('select qr_cart_put(%L, %L::jsonb, %L::jsonb, null)', 'nosuchtoken', ga, v_line),
    'Invalid table code', 'C10 unknown table');

  -- ── D: rename ──
  perform qr_cart_rename(v_tok, ga || '{"name":"Ann","avatar":"a4"}');
  s := qr_cart_state(v_tok);
  perform pg_temp.ok((select l->>'guestLabel' from jsonb_array_elements(s->'lines') l where l->>'id' = ida::text) = 'Ann', 'D1 A renamed');
  perform pg_temp.ok((select l->>'guestAvatar' from jsonb_array_elements(s->'lines') l where l->>'id' = ida::text) = 'a4', 'D2 A avatar changed');
  perform pg_temp.ok((select l->>'guestLabel' from jsonb_array_elements(s->'lines') l where l->>'id' = idb::text) = 'Mei', 'D3 B is plain Mei now');

  -- ── E: the 50-line cap ──
  insert into qr_cart_lines(table_id, guest_id, guest_name, guest_avatar, product_id, variant_id, qty)
  select v_table.id, (gc->>'id')::uuid, 'Guest', 'a5', (v_prod->>'id')::uuid, (v_prod->'variants'->0->>'id')::uuid, 1
    from generate_series(1, 47);
  perform pg_temp.expect_error(format('select qr_cart_put(%L, %L::jsonb, %L::jsonb, null)', v_tok, ga, v_line),
    'This table''s order is full. Please send it first.', 'E1 line 51');
  delete from qr_cart_lines where table_id = v_table.id and id not in (ida, idb, idc);

  -- ── F: sending ──
  r := qr_cart_send(v_tok, 2, 'stale-version', '{}', v_coid);
  perform pg_temp.ok(r->>'status' = 'changed', 'F1 a stale version sends nothing');
  perform pg_temp.ok((select count(*) from qr_cart_lines where table_id = v_table.id) = 3, 'F2 the cart is untouched');
  v_version := qr_cart_state(v_tok)->>'version';
  r := qr_cart_send(v_tok, 2, v_version, array[idc], v_coid);
  perform pg_temp.ok(r->>'status' = 'sent', 'F3 sent');
  v_order := (r->>'orderId')::uuid;
  perform pg_temp.ok((select count(*) from qr_cart_lines where table_id = v_table.id) = 0, 'F4 the whole cart is cleared, the skipped line too');
  perform pg_temp.ok((select count(*) from order_items where order_id = v_order) = 2, 'F5 two items, the skipped one left out');
  perform pg_temp.ok((select array_agg(guest_label order by guest_label) from order_items where order_id = v_order) = array['Ann', 'Mei'], 'F6 labels on the items');
  perform pg_temp.ok((select guest_avatar from order_items where order_id = v_order and guest_label = 'Ann') = 'a4', 'F7 avatar on the item');
  perform pg_temp.ok((select guest_id from order_items where order_id = v_order and guest_label = 'Mei') = (gb->>'id')::uuid, 'F8 guest id on the item');
  perform pg_temp.ok(not exists (select 1 from print_jobs j, jsonb_array_elements(j.payload->'lines') l
                                  where j.order_id = v_order and j.kind = 'ticket' and not (l ? 'guest')), 'F9 every ticket line names its guest');
  r := qr_cart_send(v_tok, 2, 'whatever', '{}', v_coid);
  perform pg_temp.ok(r->>'status' = 'sent' and (r->>'orderId')::uuid = v_order, 'F10 a resend returns the same order');
  perform pg_temp.expect_error(format('select qr_cart_send(%L, null, %L, %L, %L)', v_tok, 'empty', '{}', gen_random_uuid()),
    'Nothing to send.', 'F11 an empty cart');

  -- ── G: labels hold for the rest of the bill ──
  idx := qr_cart_put(v_tok, ga || '{"name":"Zed"}', v_line, null);       -- A comes back under another name
  ida := qr_cart_put(v_tok, gd, v_line, null);                            -- a new guest called Ann
  s := qr_cart_state(v_tok);
  perform pg_temp.ok((select l->>'guestLabel' from jsonb_array_elements(s->'lines') l where l->>'id' = idx::text) = 'Ann', 'G1 A keeps the label on the bill');
  perform pg_temp.ok((select l->>'guestLabel' from jsonb_array_elements(s->'lines') l where l->>'id' = ida::text) = 'Ann 2', 'G2 the new Ann is Ann 2');

  -- ── H: what the guest's page reads back ──
  s := qr_table_state(v_tok);
  perform pg_temp.ok(exists (select 1 from jsonb_array_elements(s->'items') i where i->>'guestLabel' = 'Mei' and i->>'guestAvatar' = 'a1'), 'H1 qr_table_state carries guest label and avatar');

  -- ── I: the old call still works and names no guest ──
  v_order := place_table_order(v_tok, null, jsonb_build_array(v_line || '{"guestLabel":"Sneaky"}'), gen_random_uuid());
  perform pg_temp.ok((select guest_id is null and guest_avatar is null from order_items where order_id = v_order), 'I1 no guest id from the old call');
  perform pg_temp.ok(not exists (select 1 from print_jobs j, jsonb_array_elements(j.payload->'lines') l
                                  where j.order_id = v_order and j.kind = 'ticket' and (l ? 'guest') and l->>'guest' <> 'Sneaky'), 'I2 ticket lines unchanged in shape');

  -- ── J: stale lines ──
  update qr_cart_lines set created_at = now() - interval '3 hours' where id = idx;
  s := qr_cart_state(v_tok);
  perform pg_temp.ok(not exists (select 1 from jsonb_array_elements(s->'lines') l where l->>'id' = idx::text), 'J1 a line older than 2 hours is dropped');
  perform pg_temp.ok(exists (select 1 from jsonb_array_elements(s->'lines') l where l->>'id' = ida::text), 'J2 a fresh line stays');
  update qr_cart_lines set created_at = now() - interval '10 minutes' where id = ida;
  update bills set status = 'voided', closed_at = now() - interval '1 minute', void_reason = 'verify'
   where table_id = v_table.id and status = 'open';
  s := qr_cart_state(v_tok);
  perform pg_temp.ok(jsonb_array_length(s->'lines') = 0, 'J3 lines from before the bill closed are dropped');
end $$;

rollback;
select 'VERIFY OK' as result;
```

Note on I1/I2: the old `place_table_order` passes client JSON straight to `pos_insert_order`, so a hand-crafted `guestLabel` is stored (trimmed to 24 characters) — harmless, and I2 allows it. What must hold is that it never gets a guest id or avatar it did not send.

- [ ] **Step 5: Run the verify script before the migration — it must fail**

Run: `runsql supabase/migration-2026-11-22-qr-table-cart-verify.sql`
Expected: an error mentioning `qr_cart_lines` does not exist. (This proves the script tests something.)

- [ ] **Step 6: Apply the migration on dev**

Run: `runsql supabase/migration-2026-11-22-qr-table-cart.sql`
Expected: `[{"result":"qr table cart applied"}]`. On an error, fix the file and run again (it is safe to re-run).

- [ ] **Step 7: Run the verify script — it must pass**

Run: `runsql supabase/migration-2026-11-22-qr-table-cart-verify.sql`
Expected: `[{"result":"VERIFY OK"}]`.

If it prints `FAIL <label>`: the label names the check. Fix the migration (not the check), re-apply (Step 6), re-run.
If J3's `update bills` is refused by a constraint or trigger on `bills`, read the constraint named in the error, add the column it requires to that one `update` statement in the verify script, and re-run. Do not weaken any `pg_temp.ok` line.

- [ ] **Step 8: Run the older POS verify scripts that exercise `pos_insert_order` — same result as before**

```bash
for f in supabase/migration-2026-10-24-pos-slots-photos-verify.sql supabase/migration-2026-11-17-menu-picks-verify.sql supabase/migration-2026-11-16-pos-split-bill-verify.sql; do [ -f "$f" ] && { echo "== $f"; runsql "$f"; }; done
```

Expected: each existing file prints its `VERIFY OK` row. A file that does not exist is skipped. If one fails, check whether it also fails with this migration reverted in mind — read its error: an error inside `pos_insert_order` means Step 3 damaged the function; fix and re-apply.

- [ ] **Step 9: Commit**

```bash
git add supabase/migration-2026-11-22-qr-table-cart.sql supabase/migration-2026-11-22-qr-table-cart-verify.sql
git commit -m "feat(qr): table cart on the server — cart RPCs, guest on order items and tickets (dev)

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
```

---

### Task 3: `qrGuest` — who this phone is

**Files:**
- Create: `src/qr/qrGuest.ts`
- Test: `src/qr/qrGuest.test.ts`

**Interfaces:**
- Produces:
  - `interface Guest { id: string; name: string; avatar: string }`
  - `AVATARS: readonly { key: string; emoji: string }[]` (8 entries, keys `a1`…`a8`)
  - `DEFAULT_NAME = 'Guest'`, `NAME_MAX = 20`
  - `avatarEmoji(key: string | null | undefined): string` (`''` for an unknown key)
  - `cleanName(text: string): string`
  - `randomAvatar(rand?: () => number): string`
  - `newGuest(name: string, avatar: string, id?: string): Guest`
  - `type GuestStorage = Pick<Storage, 'getItem' | 'setItem'>`
  - `loadGuest(token: string, storage?: GuestStorage | null): Guest | null`
  - `saveGuest(token: string, guest: Guest, storage?: GuestStorage | null): void`

- [ ] **Step 1: Write the failing test**

```ts
// src/qr/qrGuest.test.ts
import { describe, expect, it } from 'vitest'
import { AVATARS, avatarEmoji, cleanName, loadGuest, newGuest, randomAvatar, saveGuest, type GuestStorage } from './qrGuest'

const fakeStorage = (): GuestStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v) } }
}
const ID = '11111111-2222-4333-8444-555555555555'

describe('cleanName', () => {
  it('trims, drops control characters and cuts at 20', () => {
    expect(cleanName('  Mei \n')).toBe('Mei')
    expect(cleanName('a'.repeat(30))).toBe('a'.repeat(20))
    expect(cleanName('Tab\there')).toBe('Tabhere')
  })
  it('an empty name is Guest', () => {
    expect(cleanName('')).toBe('Guest')
    expect(cleanName('   ')).toBe('Guest')
  })
})

describe('avatars', () => {
  it('has eight, keyed a1 to a8', () => {
    expect(AVATARS.map((a) => a.key)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'])
  })
  it('gives the emoji of a key, nothing for an unknown one', () => {
    expect(avatarEmoji('a1')).toBe(AVATARS[0].emoji)
    expect(avatarEmoji('zz')).toBe('')
    expect(avatarEmoji(null)).toBe('')
  })
  it('picks a random avatar from the list', () => {
    expect(randomAvatar(() => 0)).toBe('a1')
    expect(randomAvatar(() => 0.999)).toBe('a8')
  })
})

describe('loadGuest / saveGuest', () => {
  it('round-trips per table token', () => {
    const s = fakeStorage()
    saveGuest('tokA', newGuest('Mei', 'a3', ID), s)
    expect(loadGuest('tokA', s)).toEqual({ id: ID, name: 'Mei', avatar: 'a3' })
    expect(loadGuest('tokB', s)).toBeNull()
  })
  it('ignores a stored value that is not a guest', () => {
    const s = fakeStorage()
    s.data.set('qr-guest-tokA', '{"id":"nope","name":"x","avatar":"a1"}')
    expect(loadGuest('tokA', s)).toBeNull()
    s.data.set('qr-guest-tokA', 'not json')
    expect(loadGuest('tokA', s)).toBeNull()
  })
  it('keeps the guest for the visit when storage is unavailable or throws', () => {
    saveGuest('tokNoStore', newGuest('Ann', 'a2', ID), null)
    expect(loadGuest('tokNoStore', null)).toEqual({ id: ID, name: 'Ann', avatar: 'a2' })
    const broken: GuestStorage = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
    saveGuest('tokBroken', newGuest('Bo', 'a1', ID), broken)
    expect(loadGuest('tokBroken', broken)).toEqual({ id: ID, name: 'Bo', avatar: 'a1' })
  })
  it('newGuest cleans the name and falls back to a1 for an unknown avatar', () => {
    expect(newGuest('  ', 'zz', ID)).toEqual({ id: ID, name: 'Guest', avatar: 'a1' })
  })
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `npx vitest run src/qr/qrGuest.test.ts`
Expected: FAIL — cannot find module `./qrGuest`.

- [ ] **Step 3: Write the implementation**

```ts
// src/qr/qrGuest.ts
/** Who this phone is at a table (docs/superpowers/specs/2026-11-22-qr-shared-table-cart-design.md §3):
 *  a random id, a name and an avatar, kept per table code. No sign-in. */
export interface Guest { id: string; name: string; avatar: string }
export type GuestStorage = Pick<Storage, 'getItem' | 'setItem'>

export const AVATARS: readonly { key: string; emoji: string }[] = [
  { key: 'a1', emoji: '🙂' }, { key: 'a2', emoji: '😎' }, { key: 'a3', emoji: '🐱' }, { key: 'a4', emoji: '🐶' },
  { key: 'a5', emoji: '🦊' }, { key: 'a6', emoji: '🐼' }, { key: 'a7', emoji: '☕' }, { key: 'a8', emoji: '🌻' },
]
export const DEFAULT_NAME = 'Guest'
export const NAME_MAX = 20

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isAvatar = (key: unknown): key is string => typeof key === 'string' && AVATARS.some((a) => a.key === key)
const storageKey = (token: string) => `qr-guest-${token}`
/** the visit's guests when the browser gives no storage (private mode) */
const memory = new Map<string, Guest>()

export const avatarEmoji = (key: string | null | undefined): string => AVATARS.find((a) => a.key === key)?.emoji ?? ''

/** The name as the server will store it: no control characters, trimmed, at most 20, 'Guest' when empty. */
export function cleanName(text: string): string {
  // eslint-disable-next-line no-control-regex
  const t = text.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX).trim()
  return t === '' ? DEFAULT_NAME : t
}

export const randomAvatar = (rand: () => number = Math.random): string =>
  AVATARS[Math.min(AVATARS.length - 1, Math.floor(rand() * AVATARS.length))].key

export const newGuest = (name: string, avatar: string, id: string = crypto.randomUUID()): Guest =>
  ({ id, name: cleanName(name), avatar: isAvatar(avatar) ? avatar : 'a1' })

function browserStorage(): GuestStorage | null {
  try { return window.localStorage } catch { return null }
}

export function loadGuest(token: string, storage: GuestStorage | null = browserStorage()): Guest | null {
  try {
    const raw = storage?.getItem(storageKey(token))
    if (raw) {
      const g = JSON.parse(raw) as Partial<Guest> | null
      if (g && typeof g.id === 'string' && UUID.test(g.id) && typeof g.name === 'string' && isAvatar(g.avatar)) {
        return { id: g.id, name: cleanName(g.name), avatar: g.avatar }
      }
      return null
    }
  } catch { /* unreadable storage: fall through to the visit's memory */ }
  return memory.get(token) ?? null
}

export function saveGuest(token: string, guest: Guest, storage: GuestStorage | null = browserStorage()): void {
  memory.set(token, guest)
  try { storage?.setItem(storageKey(token), JSON.stringify(guest)) } catch { /* the visit's memory holds it */ }
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `npx vitest run src/qr/qrGuest.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
npm run lint && git add src/qr/qrGuest.ts src/qr/qrGuest.test.ts
git commit -m "feat(qr): guest identity — avatars, name cleaning, per-table storage

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
```

---

### Task 4: `qrCart` — pure cart logic

**Files:**
- Create: `src/qr/qrCart.ts`
- Test: `src/qr/qrCart.test.ts`

**Interfaces:**
- Consumes: `avatarEmoji` from `./qrGuest`; `findProduct`, `linePriceSen`, `OrderLine`, `PosMenu` from `../features/pos/order/cart`.
- Produces:
  - `interface CartLine extends OrderLine { id: string; guestId: string; guestLabel: string; guestAvatar: string }`
  - `interface CartState { version: string; lines: CartLine[] }`
  - `interface GuestGroup { guestId: string; label: string; avatar: string; isMe: boolean; lines: CartLine[] }`
  - `interface OrderedItem { name: string; qty: number; unitPriceSen: number; mods: string[]; note: string | null; voided: boolean; guestLabel?: string | null; guestAvatar?: string | null }`
  - `interface OrderedGroup { label: string | null; avatar: string | null; items: OrderedItem[] }`
  - `parseCart(data: unknown): CartState | null`
  - `lineAvailable(menu: PosMenu, line: OrderLine): boolean`
  - `groupCart(lines: CartLine[], myGuestId: string): { mine: CartLine[]; others: GuestGroup[] }`
  - `sendGroups(menu: PosMenu, lines: CartLine[], myGuestId: string): GuestGroup[]` (available lines only, me first)
  - `skipIds(menu: PosMenu, lines: CartLine[]): string[]`
  - `cartTotalSen(menu: PosMenu, lines: CartLine[]): number`
  - `additionsToast(before: CartState | null, after: CartState, myGuestId: string, menu: PosMenu): string | null`
  - `groupOrdered(items: OrderedItem[]): OrderedGroup[]` (guests in order of first item, the counter group — `label: null` — last)
  - `isNetworkError(message: string): boolean`
  - `cartChannel(token: string): Promise<string>`

- [ ] **Step 1: Write the failing test**

```ts
// src/qr/qrCart.test.ts
import { describe, expect, it } from 'vitest'
import type { PosMenu } from '../features/pos/order/cart'
import {
  additionsToast, cartChannel, cartTotalSen, groupCart, groupOrdered, isNetworkError, lineAvailable, parseCart,
  sendGroups, skipIds, type CartLine, type CartState, type OrderedItem,
} from './qrCart'

const menu: PosMenu = { categories: [{ name: 'Drinks', products: [
  { id: 'latte', name: 'Latte', description: null, soldOut: false,
    variants: [{ id: 'hot', name: 'Hot', priceSen: 900, isBase: true }],
    groups: [{ id: 'milk', name: 'Milk', min: 0, max: 1, options: [
      { id: 'oat', name: 'Oat', priceDeltaSen: 200, isDefault: false, available: true },
      { id: 'soy', name: 'Soy', priceDeltaSen: 0, isDefault: false, available: false },
    ] }] },
  { id: 'cake', name: 'Cake', description: null, soldOut: true,
    variants: [{ id: 'slice', name: 'Slice', priceSen: 1500, isBase: true }], groups: [] },
] }] }

const ME = 'me', MEI = 'mei', BO = 'bo'
const line = (id: string, guestId: string, over: Partial<CartLine> = {}): CartLine => ({
  id, guestId, guestLabel: guestId === ME ? 'Eric' : guestId === MEI ? 'Mei' : 'Bo', guestAvatar: guestId === ME ? 'a1' : 'a3',
  productId: 'latte', variantId: 'hot', qty: 1, note: null, optionIds: [], ...over,
})
const cart = (...lines: CartLine[]): CartState => ({ version: 'v', lines })

describe('parseCart', () => {
  it('reads the server reply', () => {
    const raw = { version: 'abc', lines: [{ id: 'l1', guestId: ME, guestLabel: 'Eric', guestAvatar: 'a1',
      productId: 'latte', variantId: 'hot', optionIds: ['oat'], qty: 2, note: null }] }
    expect(parseCart(raw)).toEqual({ version: 'abc', lines: [line('l1', ME, { optionIds: ['oat'], qty: 2 })] })
  })
  it('refuses anything else', () => {
    expect(parseCart(null)).toBeNull()
    expect(parseCart({ version: 1, lines: [] })).toBeNull()
    expect(parseCart({ version: 'v', lines: [{ id: 'l1' }] })).toBeNull()
  })
})

describe('lineAvailable', () => {
  it('needs the product on the menu, not sold out, its variant and options offered', () => {
    expect(lineAvailable(menu, line('a', ME))).toBe(true)
    expect(lineAvailable(menu, line('a', ME, { optionIds: ['oat'] }))).toBe(true)
    expect(lineAvailable(menu, line('a', ME, { optionIds: ['soy'] }))).toBe(false)     // option sold out
    expect(lineAvailable(menu, line('a', ME, { optionIds: ['gone'] }))).toBe(false)    // option removed
    expect(lineAvailable(menu, line('a', ME, { variantId: 'iced' }))).toBe(false)      // variant removed
    expect(lineAvailable(menu, line('a', ME, { productId: 'cake', variantId: 'slice' }))).toBe(false)   // sold out
    expect(lineAvailable(menu, line('a', ME, { productId: 'tea' }))).toBe(false)       // left the menu
  })
})

describe('grouping', () => {
  const lines = [line('1', MEI), line('2', ME), line('3', BO), line('4', MEI), line('5', ME, { productId: 'cake', variantId: 'slice' })]
  it('splits mine from the others, others in order of their first line', () => {
    const g = groupCart(lines, ME)
    expect(g.mine.map((l) => l.id)).toEqual(['2', '5'])
    expect(g.others.map((o) => [o.label, o.lines.map((l) => l.id)])).toEqual([['Mei', ['1', '4']], ['Bo', ['3']]])
    expect(g.others.every((o) => !o.isMe)).toBe(true)
  })
  it('the send sheet lists available lines only, me first', () => {
    const g = sendGroups(menu, lines, ME)
    expect(g.map((x) => [x.label, x.isMe, x.lines.map((l) => l.id)])).toEqual([['Eric', true, ['2']], ['Mei', false, ['1', '4']], ['Bo', false, ['3']]])
  })
  it('a guest whose every line is unavailable is not listed', () => {
    expect(sendGroups(menu, [line('5', ME, { productId: 'cake', variantId: 'slice' }), line('1', MEI)], ME).map((x) => x.label)).toEqual(['Mei'])
  })
  it('skipIds are the unavailable lines; the total leaves them out', () => {
    expect(skipIds(menu, lines)).toEqual(['5'])
    expect(cartTotalSen(menu, [line('1', MEI, { qty: 2, optionIds: ['oat'] }), line('5', ME, { productId: 'cake', variantId: 'slice' })])).toBe(2200)
  })
})

describe('additionsToast', () => {
  const before = cart(line('1', ME))
  it('says who added what', () => {
    expect(additionsToast(before, cart(line('1', ME), line('2', MEI, { qty: 2 })), ME, menu)).toBe('🐱 Mei added 2 × Latte')
  })
  it('collapses several additions by one guest', () => {
    expect(additionsToast(before, cart(line('1', ME), line('2', MEI), line('3', MEI, { qty: 2 })), ME, menu)).toBe('🐱 Mei added 3 items')
  })
  it('collapses additions by several guests', () => {
    expect(additionsToast(before, cart(line('1', ME), line('2', MEI), line('3', BO)), ME, menu)).toBe('Others at this table added 2 items')
  })
  it('is silent for my own additions, for removals and on the first read', () => {
    expect(additionsToast(before, cart(line('1', ME), line('2', ME)), ME, menu)).toBeNull()
    expect(additionsToast(cart(line('1', ME), line('2', MEI)), cart(line('1', ME)), ME, menu)).toBeNull()
    expect(additionsToast(null, cart(line('2', MEI)), ME, menu)).toBeNull()
  })
  it('names an item the menu no longer has as "an item"', () => {
    expect(additionsToast(before, cart(line('1', ME), line('2', MEI, { productId: 'tea' })), ME, menu)).toBe('🐱 Mei added 1 × an item')
  })
})

describe('groupOrdered', () => {
  const item = (name: string, guestLabel: string | null, guestAvatar: string | null = null): OrderedItem =>
    ({ name, qty: 1, unitPriceSen: 900, mods: [], note: null, voided: false, guestLabel, guestAvatar })
  it('groups sent items by guest, counter items last', () => {
    const g = groupOrdered([item('Tea', null), item('Latte', 'Eric', 'a1'), item('Cake', 'Mei', 'a3'), item('Mocha', 'Eric', 'a1')])
    expect(g.map((x) => [x.label, x.avatar, x.items.map((i) => i.name)])).toEqual([
      ['Eric', 'a1', ['Latte', 'Mocha']], ['Mei', 'a3', ['Cake']], [null, null, ['Tea']],
    ])
  })
  it('reads items from before this feature (no guest fields) as counter items', () => {
    expect(groupOrdered([{ name: 'Tea', qty: 1, unitPriceSen: 500, mods: [], note: null, voided: false }]).map((x) => x.label)).toEqual([null])
  })
})

describe('isNetworkError', () => {
  it('knows the browsers\' words for no connection', () => {
    expect(isNetworkError('Failed to fetch')).toBe(true)
    expect(isNetworkError('NetworkError when attempting to fetch resource.')).toBe(true)
    expect(isNetworkError('Load failed')).toBe(true)
    expect(isNetworkError('Sold out: Latte')).toBe(false)
  })
})

describe('cartChannel', () => {
  it('is qr- plus 16 hex characters, the same for the same token, and never the token', async () => {
    const a = await cartChannel('abc123')
    expect(a).toMatch(/^qr-[0-9a-f]{16}$/)
    expect(await cartChannel('abc123')).toBe(a)
    expect(await cartChannel('abc124')).not.toBe(a)
    expect(a).not.toContain('abc123')
  })
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `npx vitest run src/qr/qrCart.test.ts`
Expected: FAIL — cannot find module `./qrCart`.

- [ ] **Step 3: Write the implementation**

```ts
// src/qr/qrCart.ts
/** The table's shared cart, as the QR page reads it (spec 2026-11-22-qr-shared-table-cart-design.md).
 *  Pure: the server holds the lines; this groups them, judges them against the menu and words the toast. */
import { findProduct, linePriceSen, type OrderLine, type PosMenu } from '../features/pos/order/cart'
import { avatarEmoji } from './qrGuest'

export interface CartLine extends OrderLine { id: string; guestId: string; guestLabel: string; guestAvatar: string }
export interface CartState { version: string; lines: CartLine[] }
export interface GuestGroup { guestId: string; label: string; avatar: string; isMe: boolean; lines: CartLine[] }
/** an item of qr_table_state: already sent */
export interface OrderedItem {
  name: string; qty: number; unitPriceSen: number; mods: string[]; note: string | null; voided: boolean
  guestLabel?: string | null; guestAvatar?: string | null
}
export interface OrderedGroup { label: string | null; avatar: string | null; items: OrderedItem[] }

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

/** qr_cart_state's reply, or null for anything else. */
export function parseCart(data: unknown): CartState | null {
  if (!isObj(data) || typeof data.version !== 'string' || !Array.isArray(data.lines)) return null
  const lines: CartLine[] = []
  for (const l of data.lines as unknown[]) {
    if (!isObj(l) || typeof l.id !== 'string' || typeof l.guestId !== 'string' || typeof l.productId !== 'string'
        || typeof l.variantId !== 'string' || typeof l.qty !== 'number') return null
    lines.push({
      id: l.id, guestId: l.guestId,
      guestLabel: typeof l.guestLabel === 'string' ? l.guestLabel : 'Guest',
      guestAvatar: typeof l.guestAvatar === 'string' ? l.guestAvatar : 'a1',
      productId: l.productId, variantId: l.variantId, qty: l.qty,
      note: typeof l.note === 'string' ? l.note : null,
      optionIds: Array.isArray(l.optionIds) ? l.optionIds.filter((x): x is string => typeof x === 'string') : [],
    })
  }
  return { version: data.version, lines }
}

/** Can this line be ordered from the menu the phone holds now? Every phone holds the same menu. */
export function lineAvailable(menu: PosMenu, line: OrderLine): boolean {
  const p = findProduct(menu, line.productId)
  if (!p || p.soldOut) return false
  if (!p.variants.some((v) => v.id === line.variantId)) return false
  const offered = new Map(p.groups.flatMap((g) => g.options.map((o) => [o.id, o.available] as const)))
  return line.optionIds.every((id) => offered.get(id) === true)
}

function byGuest(lines: CartLine[], myGuestId: string): GuestGroup[] {
  const out: GuestGroup[] = []
  for (const l of lines) {
    let g = out.find((x) => x.guestId === l.guestId)
    if (!g) {
      g = { guestId: l.guestId, label: l.guestLabel, avatar: l.guestAvatar, isMe: l.guestId === myGuestId, lines: [] }
      out.push(g)
    }
    g.lines.push(l)
  }
  return out
}

/** The cart panel: my lines, then the others' by guest in order of their first line. */
export function groupCart(lines: CartLine[], myGuestId: string): { mine: CartLine[]; others: GuestGroup[] } {
  const all = byGuest(lines, myGuestId)
  return { mine: all.find((g) => g.isMe)?.lines ?? [], others: all.filter((g) => !g.isMe) }
}

/** The send sheet: what will be sent, by guest, me first. */
export function sendGroups(menu: PosMenu, lines: CartLine[], myGuestId: string): GuestGroup[] {
  const all = byGuest(lines.filter((l) => lineAvailable(menu, l)), myGuestId)
  return [...all.filter((g) => g.isMe), ...all.filter((g) => !g.isMe)]
}

/** p_skip for qr_cart_send. */
export const skipIds = (menu: PosMenu, lines: CartLine[]): string[] =>
  lines.filter((l) => !lineAvailable(menu, l)).map((l) => l.id)

export function cartTotalSen(menu: PosMenu, lines: CartLine[]): number {
  let total = 0
  for (const l of lines) {
    if (!lineAvailable(menu, l)) continue
    const p = findProduct(menu, l.productId)
    total += (p ? linePriceSen(p, l) ?? 0 : 0) * l.qty
  }
  return total
}

/** What to tell this guest about lines the others added since the last read; null = nothing. */
export function additionsToast(before: CartState | null, after: CartState, myGuestId: string, menu: PosMenu): string | null {
  if (!before) return null
  const known = new Set(before.lines.map((l) => l.id))
  const added = after.lines.filter((l) => !known.has(l.id) && l.guestId !== myGuestId)
  if (added.length === 0) return null
  const units = added.reduce((n, l) => n + l.qty, 0)
  if (new Set(added.map((l) => l.guestId)).size > 1) return `Others at this table added ${units} items`
  const first = added[0]
  const who = `${avatarEmoji(first.guestAvatar)} ${first.guestLabel}`.trim()
  if (added.length === 1) return `${who} added ${first.qty} × ${findProduct(menu, first.productId)?.name ?? 'an item'}`
  return `${who} added ${units} items`
}

/** "Ordered so far" by guest, in order of their first item; items ordered at the counter (no guest) last. */
export function groupOrdered(items: OrderedItem[]): OrderedGroup[] {
  const out: OrderedGroup[] = []
  for (const i of items) {
    const label = i.guestLabel ?? null
    let g = out.find((x) => x.label === label)
    if (!g) { g = { label, avatar: i.guestAvatar ?? null, items: [] }; out.push(g) }
    g.items.push(i)
  }
  return [...out.filter((g) => g.label !== null), ...out.filter((g) => g.label === null)]
}

export const isNetworkError = (message: string): boolean =>
  message === 'Failed to fetch' || message === 'Load failed' || message.includes('NetworkError')

/** The table's Broadcast channel: "qr-" + the first 16 hex characters of SHA-256(token), so the token is
 *  never a channel name. */
export async function cartChannel(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))
  return `qr-${[...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `npx vitest run src/qr/qrCart.test.ts`
Expected: PASS. If `lineAvailable` or the total disagrees because `linePriceSen` returns `null` for a case this plan did not foresee, read `linePriceSen` in `src/features/pos/order/cart.ts` and fix `qrCart.ts`, not the test.

- [ ] **Step 5: Commit**

```bash
npm run lint && git add src/qr/qrCart.ts src/qr/qrCart.test.ts
git commit -m "feat(qr): shared cart logic — grouping, availability, totals, toast, channel name

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
```

---

### Task 5: `qrCartApi` and `useTableCart`

**Files:**
- Create: `src/qr/qrCartApi.ts`
- Create: `src/qr/useTableCart.ts`
- Test: `src/qr/useTableCart.test.tsx`

**Interfaces:**
- Consumes: `Guest` (Task 3); `CartState`, `parseCart` (Task 4); the RPCs of Task 2; Task 1's answer.
- Produces:
  - `interface CartApi { state(): Promise<CartState>; put(guest: Guest, line: OrderLine, lineId: string | null): Promise<string>; remove(guestId: string, lineId: string): Promise<void>; rename(guest: Guest): Promise<void>; send(pax: number | null, version: string, skip: string[], clientOrderId: string): Promise<'sent' | 'changed'> }`
  - `interface CartSignal { subscribe(onPing: () => void): () => void; ping(): void }`
  - `makeCartApi(client: SupabaseClient, token: string): CartApi`
  - `makeCartSignal(client: SupabaseClient, topic: string): CartSignal`
  - `CART_SWEEP_MS: number`
  - `type CartStatus = 'loading' | 'ready' | 'offline'`
  - `interface TableCart { cart: CartState | null; status: CartStatus; refresh(): Promise<void>; add(guest: Guest, line: OrderLine): Promise<void>; replace(guest: Guest, lineId: string, line: OrderLine): Promise<void>; remove(guestId: string, lineId: string): Promise<void>; rename(guest: Guest): Promise<void>; send(pax: number | null, skip: string[], clientOrderId: string): Promise<'sent' | 'changed'> }`
  - `useTableCart(api: CartApi | null, signal: CartSignal | null, onChange?: (before: CartState | null, after: CartState) => void): TableCart`

- [ ] **Step 1: Write `qrCartApi.ts`** (thin I/O; exercised by the hook's tests through the interface and by the dev check in Task 9)

```ts
// src/qr/qrCartApi.ts
/** The table cart's server calls (qr_cart_* in supabase/migration-2026-11-22-qr-table-cart.sql) and the
 *  "something changed" ping between the phones at one table. */
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import type { OrderLine } from '../features/pos/order/cart'
import { parseCart, type CartState } from './qrCart'
import type { Guest } from './qrGuest'

export interface CartApi {
  state(): Promise<CartState>
  /** lineId null = a new line; returns the line's id */
  put(guest: Guest, line: OrderLine, lineId: string | null): Promise<string>
  remove(guestId: string, lineId: string): Promise<void>
  rename(guest: Guest): Promise<void>
  send(pax: number | null, version: string, skip: string[], clientOrderId: string): Promise<'sent' | 'changed'>
}
export interface CartSignal {
  /** start listening; the returned function stops this listener */
  subscribe(onPing: () => void): () => void
  /** tell the other phones the cart changed (carries no data) */
  ping(): void
}

const UNEXPECTED = 'Unexpected reply from the server'

export function makeCartApi(client: SupabaseClient, token: string): CartApi {
  const call = async (fn: string, args: Record<string, unknown>): Promise<unknown> => {
    const { data, error } = await client.rpc(fn, { p_token: token, ...args })
    if (error) throw new Error(error.message)
    return data
  }
  return {
    async state() {
      const cart = parseCart(await call('qr_cart_state', {}))
      if (!cart) throw new Error(UNEXPECTED)
      return cart
    },
    async put(guest, line, lineId) {
      // only the order line's own fields go up, whatever else the object carries
      const p_line = { productId: line.productId, variantId: line.variantId, qty: line.qty, note: line.note, optionIds: line.optionIds }
      const id = await call('qr_cart_put', { p_guest: guest, p_line, p_line_id: lineId })
      if (typeof id !== 'string') throw new Error(UNEXPECTED)
      return id
    },
    async remove(guestId, lineId) { await call('qr_cart_remove', { p_guest_id: guestId, p_line_id: lineId }) },
    async rename(guest) { await call('qr_cart_rename', { p_guest: guest }) },
    async send(pax, version, skip, clientOrderId) {
      const data = await call('qr_cart_send', { p_pax: pax, p_version: version, p_skip: skip, p_client_order_id: clientOrderId })
      const status = typeof data === 'object' && data !== null ? (data as { status?: unknown }).status : undefined
      if (status !== 'sent' && status !== 'changed') throw new Error(UNEXPECTED)
      return status
    },
  }
}

/** One channel for the page's life: the topic is shared by every phone at the table, and supabase-js
 *  hands back a same-named channel that is still being torn down (POS Phase 0), so it is never removed
 *  and re-created — unsubscribing only drops the listener. */
export function makeCartSignal(client: SupabaseClient, topic: string): CartSignal {
  let channel: RealtimeChannel | null = null
  let handler: (() => void) | null = null
  return {
    subscribe(onPing) {
      handler = onPing
      if (!channel) {
        channel = client.channel(topic, { config: { broadcast: { self: false } } })
          .on('broadcast', { event: 'changed' }, () => handler?.())
        channel.subscribe()
      }
      return () => { if (handler === onPing) handler = null }
    },
    ping() { void channel?.send({ type: 'broadcast', event: 'changed', payload: {} }) },
  }
}
```

- [ ] **Step 2: Write the failing hook test**

```tsx
// src/qr/useTableCart.test.tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { CartApi, CartSignal } from './qrCartApi'
import type { CartLine, CartState } from './qrCart'
import { CART_SWEEP_MS, useTableCart } from './useTableCart'

afterEach(() => { cleanup(); vi.useRealTimers() })

const guest = { id: 'me', name: 'Eric', avatar: 'a1' }
const order = { productId: 'latte', variantId: 'hot', qty: 1, note: null, optionIds: [] }
const line = (id: string): CartLine => ({ id, guestId: 'me', guestLabel: 'Eric', guestAvatar: 'a1', ...order })
const cart = (version: string, ...ids: string[]): CartState => ({ version, lines: ids.map(line) })

function fakes(first: CartState) {
  const server = { cart: first }
  const api: CartApi = {
    state: vi.fn(async () => server.cart),
    put: vi.fn(async () => 'new'),
    remove: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    send: vi.fn(async () => 'sent' as const),
  }
  let onPing: (() => void) | null = null
  const signal: CartSignal & { fire: () => void; pings: number } = {
    pings: 0,
    subscribe: (h) => { onPing = h; return () => { onPing = null } },
    ping() { this.pings++ },
    fire: () => onPing?.(),
  }
  return { server, api, signal }
}

describe('useTableCart', () => {
  it('reads the cart on mount', async () => {
    const { api, signal } = fakes(cart('v1', 'l1'))
    const { result } = renderHook(() => useTableCart(api, signal))
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.cart).toEqual(cart('v1', 'l1'))
  })

  it('does nothing without an api', () => {
    const { result } = renderHook(() => useTableCart(null, null))
    expect(result.current.cart).toBeNull()
    expect(result.current.status).toBe('loading')
  })

  it('reads again on a ping and reports before and after', async () => {
    const { api, signal, server } = fakes(cart('v1', 'l1'))
    const onChange = vi.fn()
    const { result } = renderHook(() => useTableCart(api, signal, onChange))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(onChange).toHaveBeenLastCalledWith(null, cart('v1', 'l1'))
    server.cart = cart('v2', 'l1', 'l2')
    act(() => signal.fire())
    await waitFor(() => expect(result.current.cart?.version).toBe('v2'))
    expect(onChange).toHaveBeenLastCalledWith(cart('v1', 'l1'), cart('v2', 'l1', 'l2'))
  })

  it('reads again every CART_SWEEP_MS while the page is in view', async () => {
    vi.useFakeTimers()
    const { api, signal } = fakes(cart('v1'))
    renderHook(() => useTableCart(api, signal))
    await act(async () => { await Promise.resolve() })
    expect(api.state).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(CART_SWEEP_MS) })
    expect(api.state).toHaveBeenCalledTimes(2)
  })

  it('a write pings the others and reads again', async () => {
    const { api, signal, server } = fakes(cart('v1'))
    const { result } = renderHook(() => useTableCart(api, signal))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    server.cart = cart('v2', 'new')
    await act(() => result.current.add(guest, order))
    expect(api.put).toHaveBeenCalledWith(guest, order, null)
    expect(signal.pings).toBe(1)
    expect(result.current.cart?.version).toBe('v2')
    await act(() => result.current.replace(guest, 'new', { ...order, qty: 2 }))
    expect(api.put).toHaveBeenLastCalledWith(guest, { ...order, qty: 2 }, 'new')
    await act(() => result.current.remove('me', 'new'))
    expect(api.remove).toHaveBeenCalledWith('me', 'new')
    await act(() => result.current.rename(guest))
    expect(api.rename).toHaveBeenCalledWith(guest)
    expect(signal.pings).toBe(4)
  })

  it('send passes the version it holds and returns the server\'s status', async () => {
    const { api, signal } = fakes(cart('v7', 'l1'))
    vi.mocked(api.send).mockResolvedValueOnce('changed')
    const { result } = renderHook(() => useTableCart(api, signal))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    let status = ''
    await act(async () => { status = await result.current.send(2, ['l9'], 'order-1') })
    expect(status).toBe('changed')
    expect(api.send).toHaveBeenCalledWith(2, 'v7', ['l9'], 'order-1')
  })

  it('a failed write throws and changes nothing', async () => {
    const { api, signal } = fakes(cart('v1', 'l1'))
    vi.mocked(api.put).mockRejectedValueOnce(new Error('Failed to fetch'))
    const { result } = renderHook(() => useTableCart(api, signal))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    await expect(act(() => result.current.add(guest, order))).rejects.toThrow('Failed to fetch')
    expect(signal.pings).toBe(0)
    expect(result.current.cart).toEqual(cart('v1', 'l1'))
  })

  it('a failed read keeps the last cart and says offline; the next good read recovers', async () => {
    const { api, signal } = fakes(cart('v1', 'l1'))
    const { result } = renderHook(() => useTableCart(api, signal))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    vi.mocked(api.state).mockRejectedValueOnce(new Error('Failed to fetch'))
    act(() => signal.fire())
    await waitFor(() => expect(result.current.status).toBe('offline'))
    expect(result.current.cart).toEqual(cart('v1', 'l1'))
    act(() => signal.fire())
    await waitFor(() => expect(result.current.status).toBe('ready'))
  })

  it('an older reply never lands after a newer one', async () => {
    const { api, signal } = fakes(cart('v1'))
    const { result } = renderHook(() => useTableCart(api, signal))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    let slow: (c: CartState) => void = () => {}
    vi.mocked(api.state)
      .mockImplementationOnce(() => new Promise<CartState>((r) => { slow = r }))
      .mockImplementationOnce(async () => cart('v3'))
    act(() => signal.fire())            // the slow read starts
    act(() => signal.fire())            // a newer one starts and finishes first
    await waitFor(() => expect(result.current.cart?.version).toBe('v3'))
    await act(async () => { slow(cart('v2')) })
    expect(result.current.cart?.version).toBe('v3')
  })
})
```

- [ ] **Step 3: Run the test to see it fail**

Run: `npx vitest run src/qr/useTableCart.test.tsx`
Expected: FAIL — cannot find module `./useTableCart`.

- [ ] **Step 4: Write the hook**

Use `15_000` for `CART_SWEEP_MS` when Task 1 printed `BROADCAST OK`, `4_000` when it printed `BROADCAST FAILED`.

```ts
// src/qr/useTableCart.ts
/** The table's shared cart on this phone: read on mount, on a ping from another phone, every
 *  CART_SWEEP_MS while in view and when the page comes back into view. Writes go to the server, ping the
 *  others and read again; a failed write throws and shows nothing that the server does not hold. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { OrderLine } from '../features/pos/order/cart'
import type { CartApi, CartSignal } from './qrCartApi'
import type { CartState } from './qrCart'
import type { Guest } from './qrGuest'

/** the fallback read: a missed ping costs at most this (Task 1: 15 s with Broadcast, 4 s without) */
export const CART_SWEEP_MS = 15_000
export type CartStatus = 'loading' | 'ready' | 'offline'

export interface TableCart {
  cart: CartState | null
  status: CartStatus
  refresh(): Promise<void>
  add(guest: Guest, line: OrderLine): Promise<void>
  replace(guest: Guest, lineId: string, line: OrderLine): Promise<void>
  remove(guestId: string, lineId: string): Promise<void>
  rename(guest: Guest): Promise<void>
  /** sends the cart this phone last read; 'changed' = it was not that cart any more, nothing was sent */
  send(pax: number | null, skip: string[], clientOrderId: string): Promise<'sent' | 'changed'>
}

export function useTableCart(
  api: CartApi | null, signal: CartSignal | null,
  onChange?: (before: CartState | null, after: CartState) => void,
): TableCart {
  const [cart, setCart] = useState<CartState | null>(null)
  const [status, setStatus] = useState<CartStatus>('loading')
  const cartRef = useRef<CartState | null>(null)
  const seq = useRef(0)                       // an older reply never lands after a newer one
  const onChangeRef = useRef(onChange)
  useEffect(() => { onChangeRef.current = onChange })

  const refresh = useCallback(async () => {
    if (!api) return
    const mine = ++seq.current
    try {
      const next = await api.state()
      if (mine !== seq.current) return
      const before = cartRef.current
      cartRef.current = next
      setCart(next)
      setStatus('ready')
      onChangeRef.current?.(before, next)
    } catch {
      if (mine === seq.current) setStatus('offline')
    }
  }, [api])

  useEffect(() => {
    if (!api) return
    void refresh()
    const off = signal?.subscribe(() => { void refresh() })
    const tick = () => { if (document.visibilityState === 'visible') void refresh() }
    const timer = window.setInterval(tick, CART_SWEEP_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      off?.()
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [api, signal, refresh])

  const wrote = useCallback(async () => { signal?.ping(); await refresh() }, [signal, refresh])
  const need = (): CartApi => { if (!api) throw new Error('The order is still loading.'); return api }

  return {
    cart, status, refresh,
    add: async (guest, line) => { await need().put(guest, line, null); await wrote() },
    replace: async (guest, lineId, line) => { await need().put(guest, line, lineId); await wrote() },
    remove: async (guestId, lineId) => { await need().remove(guestId, lineId); await wrote() },
    rename: async (guest) => { await need().rename(guest); await wrote() },
    send: async (pax, skip, clientOrderId) => {
      const version = cartRef.current?.version
      if (version === undefined) throw new Error('The order is still loading.')
      const result = await need().send(pax, version, skip, clientOrderId)
      await wrote()
      return result
    },
  }
}
```

- [ ] **Step 5: Run the test to see it pass**

Run: `npx vitest run src/qr/useTableCart.test.tsx`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
npm run lint && git add src/qr/qrCartApi.ts src/qr/useTableCart.ts src/qr/useTableCart.test.tsx
git commit -m "feat(qr): table cart hook — RPC calls, change ping, fallback read

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
```

---

### Task 6: `GuestCard`, `SendSheet`, and `LineSheet`'s busy/error props

**Files:**
- Create: `src/qr/GuestCard.tsx`, `src/qr/SendSheet.tsx`
- Modify: `src/features/pos/order/LineSheet.tsx` (props, the Add button, one error line)
- Test: `src/qr/GuestCard.test.tsx`, `src/qr/SendSheet.test.tsx`, `src/features/pos/order/LineSheet.test.tsx` (two tests added)

**Interfaces:**
- Consumes: `AVATARS`, `DEFAULT_NAME`, `NAME_MAX`, `avatarEmoji`, `cleanName`, `randomAvatar`, `Guest` (Task 3); `GuestGroup` (Task 4).
- Produces:
  - `GuestCard({ initial, onDone, onCancel }: { initial: Guest | null; onDone: (name: string, avatar: string) => void; onCancel?: () => void })` — `onDone` receives the cleaned name.
  - `SendSheet({ groups, menu, totalSen, needsPax, pax, onPax, sending, message, error, onSend, onCancel }: { groups: GuestGroup[]; menu: PosMenu; totalSen: number; needsPax: boolean; pax: string; onPax: (v: string) => void; sending: boolean; message: string | null; error: string | null; onSend: () => void; onCancel: () => void })`
  - `LineSheet` gains optional `busy?: boolean` and `error?: string | null`.

- [ ] **Step 1: Write the failing tests**

```tsx
// src/qr/GuestCard.test.tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import GuestCard from './GuestCard'

afterEach(cleanup)

describe('GuestCard', () => {
  it('a new guest picks an avatar, may type a name, and starts', () => {
    const onDone = vi.fn()
    render(<GuestCard initial={null} onDone={onDone} />)
    expect(screen.getByRole('heading', { name: "Who's ordering?" })).toBeTruthy()
    expect(screen.getAllByRole('radio')).toHaveLength(8)
    expect(screen.getAllByRole('radio').filter((r) => r.getAttribute('aria-checked') === 'true')).toHaveLength(1)
    fireEvent.click(screen.getAllByRole('radio')[2])
    fireEvent.change(screen.getByLabelText('Your name (optional)'), { target: { value: '  Mei ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start ordering' }))
    expect(onDone).toHaveBeenCalledWith('Mei', 'a3')
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  it('an empty name is Guest', () => {
    const onDone = vi.fn()
    render(<GuestCard initial={null} onDone={onDone} />)
    fireEvent.click(screen.getAllByRole('radio')[0])
    fireEvent.click(screen.getByRole('button', { name: 'Start ordering' }))
    expect(onDone).toHaveBeenCalledWith('Guest', 'a1')
  })

  it('editing shows the current name and avatar, Save and Cancel', () => {
    const onDone = vi.fn(), onCancel = vi.fn()
    render(<GuestCard initial={{ id: 'x', name: 'Eric', avatar: 'a5' }} onDone={onDone} onCancel={onCancel} />)
    expect((screen.getByLabelText('Your name (optional)') as HTMLInputElement).value).toBe('Eric')
    expect(screen.getAllByRole('radio')[4].getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onDone).toHaveBeenCalledWith('Eric', 'a5')
  })

  it('a guest called Guest edits an empty field', () => {
    render(<GuestCard initial={{ id: 'x', name: 'Guest', avatar: 'a1' }} onDone={() => {}} />)
    expect((screen.getByLabelText('Your name (optional)') as HTMLInputElement).value).toBe('')
  })
})
```

```tsx
// src/qr/SendSheet.test.tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { PosMenu } from '../features/pos/order/cart'
import type { CartLine, GuestGroup } from './qrCart'
import SendSheet from './SendSheet'

afterEach(cleanup)

const menu: PosMenu = { categories: [{ name: 'Drinks', products: [
  { id: 'latte', name: 'Latte', description: null, soldOut: false,
    variants: [{ id: 'hot', name: 'Hot', priceSen: 900, isBase: true }], groups: [] },
] }] }
const line = (id: string, qty: number): CartLine =>
  ({ id, guestId: 'g', guestLabel: 'x', guestAvatar: 'a1', productId: 'latte', variantId: 'hot', qty, note: null, optionIds: [] })
const groups: GuestGroup[] = [
  { guestId: 'me', label: 'Eric', avatar: 'a1', isMe: true, lines: [line('1', 1)] },
  { guestId: 'mei', label: 'Mei', avatar: 'a3', isMe: false, lines: [line('2', 2)] },
]
type Props = Parameters<typeof SendSheet>[0]
const base: Props = {
  groups, menu, totalSen: 2700, needsPax: false, pax: '', onPax: () => {}, sending: false, message: null, error: null,
  onSend: () => {}, onCancel: () => {},
}

describe('SendSheet', () => {
  it('lists the table\'s items by guest with the subtotal', () => {
    render(<SendSheet {...base} />)
    expect(screen.getByRole('dialog', { name: 'Has everyone ordered?' })).toBeTruthy()
    expect(screen.getByText(/Eric/).textContent).toContain('(you)')
    expect(screen.getByText(/Mei/)).toBeTruthy()
    expect(screen.getByText('1 × Latte')).toBeTruthy()
    expect(screen.getByText('2 × Latte')).toBeTruthy()
    expect(screen.getByText('RM 27.00')).toBeTruthy()
    expect(screen.queryByLabelText(/How many people/)).toBeNull()
  })

  it('sends and cancels', () => {
    const onSend = vi.fn(), onCancel = vi.fn()
    render(<SendSheet {...base} onSend={onSend} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: 'Send order for the table' }))
    expect(onSend).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Not yet' }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('asks the pax when the table needs it', () => {
    const onPax = vi.fn()
    render(<SendSheet {...base} needsPax pax="2" onPax={onPax} />)
    const input = screen.getByLabelText(/How many people/) as HTMLInputElement
    expect(input.value).toBe('2')
    fireEvent.change(input, { target: { value: '3' } })
    expect(onPax).toHaveBeenCalledWith('3')
  })

  it('while sending, both buttons are off', () => {
    render(<SendSheet {...base} sending />)
    expect((screen.getByRole('button', { name: 'Sending…' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Not yet' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows the changed notice and an error', () => {
    render(<SendSheet {...base} message="The order changed — please check again." error="Not sent: Sold out: Latte" />)
    expect(screen.getByRole('status').textContent).toBe('The order changed — please check again.')
    expect(screen.getByRole('alert').textContent).toBe('Not sent: Sold out: Latte')
  })
})
```

Append to `src/features/pos/order/LineSheet.test.tsx` (inside the file, after the existing `describe` block; `latte` is the fixture already defined at the top of that file — its Milk group needs a choice, so click Oat first):

```tsx
describe('LineSheet busy and error (QR table cart)', () => {
  it('while busy, Add is off and says Adding…', () => {
    render(<LineSheet product={latte} busy onCancel={() => {}} onDone={() => {}} />)
    expect((screen.getByRole('button', { name: 'Adding…' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows the error it is given', () => {
    render(<LineSheet product={latte} error="Not added — no connection. Tap Add to try again." onCancel={() => {}} onDone={() => {}} />)
    expect(screen.getByRole('alert').textContent).toBe('Not added — no connection. Tap Add to try again.')
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run src/qr/GuestCard.test.tsx src/qr/SendSheet.test.tsx src/features/pos/order/LineSheet.test.tsx`
Expected: FAIL — the two modules are missing, and LineSheet has no `Adding…` button and no alert.

- [ ] **Step 3: Write `GuestCard.tsx`**

```tsx
// src/qr/GuestCard.tsx
import { useState } from 'react'
import { AVATARS, DEFAULT_NAME, NAME_MAX, cleanName, randomAvatar, type Guest } from './qrGuest'

/** "Who's ordering?" — an avatar and an optional name. `initial` null = a new guest (Start ordering);
 *  otherwise the guest is changing theirs (Save, and Cancel when given). */
export default function GuestCard({ initial, onDone, onCancel }: {
  initial: Guest | null
  /** the name is already cleaned ('Guest' when left empty) */
  onDone: (name: string, avatar: string) => void
  onCancel?: () => void
}) {
  const [avatar, setAvatar] = useState(() => initial?.avatar ?? randomAvatar())
  const [name, setName] = useState(initial && initial.name !== DEFAULT_NAME ? initial.name : '')
  return (
    <div className="m-3 rounded-2xl border border-border bg-card p-4">
      <h2 className="text-lg font-semibold text-brown-dark">Who's ordering?</h2>
      <div role="radiogroup" aria-label="Avatar" className="mt-3 grid grid-cols-4 gap-2">
        {AVATARS.map((a) => (
          <button key={a.key} type="button" role="radio" aria-checked={avatar === a.key} aria-label={`Avatar ${a.emoji}`}
            onClick={() => setAvatar(a.key)}
            className={`h-14 rounded-xl border-2 text-2xl ${avatar === a.key ? 'border-brown-btn bg-cream' : 'border-border'}`}>
            {a.emoji}
          </button>
        ))}
      </div>
      <label className="mt-3 block text-sm">
        Your name (optional)
        <input className="mt-1 w-full rounded-lg border border-border p-2 text-base" value={name} maxLength={NAME_MAX}
          autoComplete="given-name" onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="mt-4 flex gap-2">
        {onCancel && <button type="button" onClick={onCancel} className="flex-1 rounded-xl border border-border py-3">Cancel</button>}
        <button type="button" onClick={() => onDone(cleanName(name), avatar)}
          className="flex-[2] rounded-xl bg-brown-btn py-3 text-white hover:bg-brown-btn-hover">
          {initial ? 'Save' : 'Start ordering'}
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Write `SendSheet.tsx`**

```tsx
// src/qr/SendSheet.tsx
import { findProduct, formatSen, lineLabel, linePriceSen, type PosMenu } from '../features/pos/order/cart'
import type { GuestGroup } from './qrCart'
import { avatarEmoji } from './qrGuest'

/** "Has everyone ordered?" — what will be sent for the whole table, by guest. The caller passes only
 *  lines that can be ordered now (sendGroups). */
export default function SendSheet({ groups, menu, totalSen, needsPax, pax, onPax, sending, message, error, onSend, onCancel }: {
  groups: GuestGroup[]
  menu: PosMenu
  totalSen: number
  needsPax: boolean
  pax: string
  onPax: (value: string) => void
  sending: boolean
  /** e.g. "The order changed — please check again." */
  message: string | null
  error: string | null
  onSend: () => void
  onCancel: () => void
}) {
  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-black/40 sm:items-center" onClick={sending ? undefined : onCancel}>
      <div role="dialog" aria-label="Has everyone ordered?"
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-card p-4 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">Has everyone ordered?</h2>
        {message && <p role="status" className="mt-2 rounded bg-amber-50 p-2 text-sm text-amber-900">{message}</p>}
        {groups.map((g) => (
          <section key={g.guestId} className="mt-3">
            <h3 className="text-sm font-semibold text-brown-dark">{avatarEmoji(g.avatar)} {g.label}{g.isMe && ' (you)'}</h3>
            {g.lines.map((l) => {
              const p = findProduct(menu, l.productId)
              if (!p) return null
              const { name, mods } = lineLabel(p, l)
              return (
                <div key={l.id} className="flex justify-between gap-2 py-1 text-sm">
                  <span>
                    <span>{l.qty} × {name}</span>
                    {mods.length > 0 && <span className="text-brown-muted"> · {mods.join(', ')}</span>}
                  </span>
                  <span>{formatSen((linePriceSen(p, l) ?? 0) * l.qty)}</span>
                </div>
              )
            })}
          </section>
        ))}
        <div className="mt-3 flex justify-between border-t border-border pt-2 font-semibold">
          <span>Subtotal</span><span>{formatSen(totalSen)}</span>
        </div>
        {needsPax && (
          <label className="mt-3 block text-sm">
            How many people?
            <input inputMode="numeric" className="ml-2 w-16 rounded border border-border p-1 text-base" value={pax}
              onChange={(e) => onPax(e.target.value)} />
          </label>
        )}
        {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
        <div className="mt-4 flex gap-2">
          <button type="button" onClick={onCancel} disabled={sending} className="flex-1 rounded-xl border border-border py-3 disabled:opacity-40">Not yet</button>
          <button type="button" onClick={onSend} disabled={sending}
            className="flex-[2] rounded-xl bg-brown-btn py-3 text-white hover:bg-brown-btn-hover disabled:opacity-40">
            {sending ? 'Sending…' : 'Send order for the table'}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Give `LineSheet` its two optional props**

In `src/features/pos/order/LineSheet.tsx`:

Replace the props (the function's opening lines)

```tsx
export default function LineSheet({ product, initial, mostPicked, onCancel, onDone }: {
  product: PosProduct
  initial?: OrderLine
  /** Most picked (menu picks): group id → option id, marked with a pill — never chosen for the guest */
  mostPicked?: Readonly<Record<string, string>>
  onCancel: () => void
  onDone: (line: OrderLine) => void
}) {
```

with

```tsx
export default function LineSheet({ product, initial, mostPicked, busy, error, onCancel, onDone }: {
  product: PosProduct
  initial?: OrderLine
  /** Most picked (menu picks): group id → option id, marked with a pill — never chosen for the guest */
  mostPicked?: Readonly<Record<string, string>>
  /** QR table cart: the line is being written to the server — Add is off and says so */
  busy?: boolean
  /** QR table cart: why the last Add did not go through */
  error?: string | null
  onCancel: () => void
  onDone: (line: OrderLine) => void
}) {
```

Replace

```tsx
        {touched && problem && <p className="mt-2 text-sm text-red-700">{problem}</p>}
        <div className="mt-4 flex gap-2">
          <button onClick={onCancel} className="flex-1 rounded-xl border border-border py-3">Cancel</button>
          <button disabled={!!problem} onClick={() => onDone(line)}
            className="flex-1 rounded-xl bg-brown-btn py-3 text-white hover:bg-brown-btn-hover disabled:opacity-40">
            Add · {price === null ? '—' : formatSen(price * line.qty)}
          </button>
        </div>
```

with

```tsx
        {touched && problem && <p className="mt-2 text-sm text-red-700">{problem}</p>}
        {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
        <div className="mt-4 flex gap-2">
          <button onClick={onCancel} className="flex-1 rounded-xl border border-border py-3">Cancel</button>
          <button disabled={!!problem || busy} onClick={() => onDone(line)}
            className="flex-1 rounded-xl bg-brown-btn py-3 text-white hover:bg-brown-btn-hover disabled:opacity-40">
            {busy ? 'Adding…' : <>Add · {price === null ? '—' : formatSen(price * line.qty)}</>}
          </button>
        </div>
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `npx vitest run src/qr/GuestCard.test.tsx src/qr/SendSheet.test.tsx src/features/pos/order/LineSheet.test.tsx`
Expected: PASS. If `formatSen(2700)` is not `RM 27.00` in this codebase, read `formatSen` in `cart.ts` and correct the expected string in `SendSheet.test.tsx` to what it returns.

- [ ] **Step 7: Commit**

```bash
npm run lint && git add src/qr/GuestCard.tsx src/qr/GuestCard.test.tsx src/qr/SendSheet.tsx src/qr/SendSheet.test.tsx src/features/pos/order/LineSheet.tsx src/features/pos/order/LineSheet.test.tsx
git commit -m "feat(qr): guest card, send sheet, busy/error on the item sheet

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
```

---

### Task 7: Wire the page — `QrApp`

**Files:**
- Modify (replace whole file): `src/qr/QrApp.tsx`
- Modify: `src/qr/qrState.ts`, `src/qr/qrState.test.ts` (keep `tokenFromLocation` only)

**Interfaces:**
- Consumes: everything Tasks 3–6 produce; `qr_table_state` items with `guestLabel` / `guestAvatar` (Task 2).
- Produces: the customer page of spec §2. No exports change (`QrApp` default export).

- [ ] **Step 1: Trim `qrState`**

In `src/qr/qrState.ts` delete `addLine`, `replaceLine`, `removeLine`, `leftTheMenu`, `leftTheMenuNotice`, `pruneAfterRefresh` and the `import` line at the top (nothing else uses it). The file becomes:

```ts
/** /t/<token> is what the printed QR card carries (vercel rewrite); the Vite
 *  dev server has no rewrite, so there the page is /qr/?t=<token>. */
export function tokenFromLocation(pathname: string, search: string): string | null {
  const m = pathname.match(/^\/t\/([A-Za-z0-9]+)\/?$/)
  if (m) return m[1]
  const t = new URLSearchParams(search).get('t')
  return t && /^[A-Za-z0-9]+$/.test(t) ? t : null
}
```

In `src/qr/qrState.test.ts` keep the `describe` block(s) that test `tokenFromLocation` and delete every `describe` block and import for the six removed functions (and any fixtures only they used).

Run: `grep -rn "addLine\|replaceLine\|removeLine\|leftTheMenu\|pruneAfterRefresh" src --include=*.ts --include=*.tsx | grep -v "src/qr/QrApp.tsx"`
Expected: no output (only the old `QrApp.tsx`, replaced next, still names them).

- [ ] **Step 2: Replace `src/qr/QrApp.tsx`**

```tsx
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { qrClient } from './qrClient'
import { tokenFromLocation } from './qrState'
import {
  findProduct, formatSen, lineLabel, linePriceSen, posMenuFromQr,
  type OrderLine, type PosMenu, type PosProduct, type QrMenuJson,
} from '../features/pos/order/cart'
import { goesWellVisible, mostPickedFor, offerPairs, pairsFor, parsePicks, visiblePopular, type MenuPicks } from '../features/pos/order/picks'
import LineSheet from '../features/pos/order/LineSheet'
import PickPill from '../features/pos/order/PickPill'
import { avatarEmoji, loadGuest, newGuest, saveGuest, type Guest } from './qrGuest'
import {
  additionsToast, cartChannel, cartTotalSen, groupCart, groupOrdered, isNetworkError, lineAvailable, sendGroups, skipIds,
  type CartLine, type CartState, type OrderedItem,
} from './qrCart'
import { makeCartApi, makeCartSignal } from './qrCartApi'
import { useTableCart } from './useTableCart'
import GuestCard from './GuestCard'
import SendSheet from './SendSheet'

interface TableState {
  tableLabel: string
  billNo: string | null
  pax: number | null
  items: OrderedItem[]
  subtotalSen: number
}
type Screen = { kind: 'loading' } | { kind: 'invalid' } | { kind: 'error' } | { kind: 'ready'; info: QrMenuJson; menu: PosMenu }

/** M3: a photo path in the public menu-images bucket → its URL (no request is made). */
const photoUrl = (path: string) => qrClient.storage.from('menu-images').getPublicUrl(path).data.publicUrl
const REFRESH_MS = 60_000
/** picks: read with the menu, then again with the minute refresh at most this often */
const PICKS_REFRESH_MS = 10 * 60_000
const TOAST_MS = 4_000

/** "RM 9.00", or "from RM 9.00" when the product has several sizes. */
const priceText = (p: PosProduct) =>
  p.variants.length > 1 ? `from ${formatSen(Math.min(...p.variants.map((v) => v.priceSen)))}` : formatSen(p.variants[0].priceSen)
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export default function QrApp() {
  const token = tokenFromLocation(window.location.pathname, window.location.search)
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' })
  const [state, setState] = useState<TableState | null>(null)
  const stateRef = useRef<TableState | null>(null)
  // table cart (docs/superpowers/specs/2026-11-22-qr-shared-table-cart-design.md): who this phone is
  const [guest, setGuest] = useState<Guest | null>(() => (token ? loadGuest(token) : null))
  const guestRef = useRef(guest)
  useEffect(() => { guestRef.current = guest }, [guest])
  const [guestEdit, setGuestEdit] = useState(false)                  // the card, reopened from the header
  const [sheet, setSheet] = useState<{ product: PosProduct; lineId: string | null } | null>(null)
  const [sheetBusy, setSheetBusy] = useState(false)
  const [sheetError, setSheetError] = useState<string | null>(null)
  const [pax, setPax] = useState('')
  const [category, setCategory] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)           // the cart panel: a removal that failed
  const [sendOpen, setSendOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [sendMessage, setSendMessage] = useState<string | null>(null)
  const [placed, setPlaced] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const sendingRef = useRef(false)
  const pending = useRef<{ id: string; key: string } | null>(null)   // one client_order_id per distinct cart sent
  const menuRef = useRef<PosMenu | null>(null)
  useEffect(() => { menuRef.current = screen.kind === 'ready' ? screen.menu : null }, [screen])
  const refreshSeq = useRef(0)                                       // a slow reply never lands after a newer one
  const refreshNow = useRef<(() => void) | null>(null)               // the minute refresh, callable after a refused send
  // picks (docs/superpowers/specs/2026-11-17-menu-picks-design.md §4): hints only. A failed first read
  // leaves them hidden, a failed re-read keeps the last ones; ordering never waits on them.
  const [picks, setPicks] = useState<MenuPicks | null>(null)
  const picksAt = useRef(0)                                          // when picks last LOADED; 0 until they have
  const picksSeq = useRef(0)                                         // an older reply never overwrites a newer one
  const picksLoaded = useRef(false)
  const [goesWellFor, setGoesWellFor] = useState<string | null>(null)   // the product the Goes well with panel is about
  const pairsShown = useRef(new Set<string>())                           // Goes well with: once per product per visit

  const loadState = async (): Promise<TableState | null> => {
    const { data } = await qrClient.rpc('qr_table_state', { p_token: token })
    if (!data) return null
    stateRef.current = data as TableState
    setState(data as TableState)
    return data as TableState
  }
  const loadPicks = () => {
    if (!token) return
    const mine = ++picksSeq.current
    qrClient.rpc('qr_picks', { p_token: token }).then(
      ({ data, error }) => {
        if (error || mine !== picksSeq.current) return
        picksAt.current = Date.now(); picksLoaded.current = true
        setPicks(parsePicks(data))
      },
      () => { /* offline for a moment: the last picks stay */ },
    )
  }
  const loadMenu = () => {
    if (!token) { setScreen({ kind: 'invalid' }); return }
    setScreen({ kind: 'loading' })
    qrClient.rpc('qr_menu', { p_token: token }).then(({ data, error }) => {
      if (error) { setScreen({ kind: 'error' }); return }
      if (!data) { setScreen({ kind: 'invalid' }); return }
      const info = data as QrMenuJson
      setScreen({ kind: 'ready', info, menu: posMenuFromQr(info, photoUrl) })
      setCategory(info.categories[0]?.name ?? null)
      void loadState()
      loadPicks()
    }, () => setScreen({ kind: 'error' }))
  }
  useEffect(() => { loadMenu() }, [token]) // eslint-disable-line react-hooks/exhaustive-deps

  // M3: read the menu again every minute while the page is in view, and when it comes back into
  // view, quietly: products whose time slot ends leave the menu (an open product sheet for one
  // closes; a cart line for one shows "Not available now" — the cart itself lives on the server),
  // products whose slot starts appear. A failed read keeps the menu on screen; nothing changes while
  // an order is being sent; the server refuses anything out of its slot anyway. The picks are read
  // again with it at most every PICKS_REFRESH_MS.
  const ready = screen.kind === 'ready'
  useEffect(() => {
    if (!ready || !token) return
    const refresh = () => {
      if (document.visibilityState !== 'visible' || sendingRef.current) return
      const mine = ++refreshSeq.current
      qrClient.rpc('qr_menu', { p_token: token }).then(({ data, error }) => {
        if (mine !== refreshSeq.current || error || !data || !menuRef.current || sendingRef.current) return
        const info = data as QrMenuJson
        const menu = posMenuFromQr(info, photoUrl)
        setScreen({ kind: 'ready', info, menu })
        setCategory((c) => (c && info.categories.some((x) => x.name === c) ? c : info.categories[0]?.name ?? null))
        setSheet((s) => (s && findProduct(menu, s.product.id) ? s : null))
        if (!picksLoaded.current || Date.now() - picksAt.current >= PICKS_REFRESH_MS) loadPicks()
      }, () => { /* offline for a moment: try again next minute */ })
    }
    refreshNow.current = refresh
    const timer = setInterval(refresh, REFRESH_MS)
    document.addEventListener('visibilitychange', refresh)
    return () => { refreshNow.current = null; clearInterval(timer); document.removeEventListener('visibilitychange', refresh) }
  }, [ready, token]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── the table's shared cart ──
  const [topic, setTopic] = useState<string | null>(null)
  useEffect(() => {
    if (!token) return
    let live = true
    cartChannel(token).then((t) => { if (live) setTopic(t) }, () => { /* no channel: the 15 s read still runs */ })
    return () => { live = false }
  }, [token])
  const api = useMemo(() => (token ? makeCartApi(qrClient, token) : null), [token])
  const signal = useMemo(() => (topic ? makeCartSignal(qrClient, topic) : null), [topic])
  const table = useTableCart(ready ? api : null, ready ? signal : null, (before: CartState | null, after: CartState) => {
    const menu = menuRef.current
    const me = guestRef.current
    if (menu && me) {
      const text = additionsToast(before, after, me.id, menu)
      if (text) setToast(text)
    }
    // the cart emptied: either the table's order was sent (from any phone) or its last line was
    // removed — "Ordered so far" growing tells which
    if (before && before.lines.length > 0 && after.lines.length === 0) {
      setSendOpen(false)
      const had = stateRef.current?.items.length ?? 0
      void loadState().then((s) => { if ((s?.items.length ?? 0) > had) setPlaced(true) })
    }
  })
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), TOAST_MS)
    return () => clearTimeout(timer)
  }, [toast])

  if (screen.kind === 'loading') return <Shell><p className="p-6 text-center text-brown-muted">Loading menu…</p></Shell>
  if (screen.kind === 'error') {
    return (
      <Shell>
        <div className="p-6 text-center">
          <p>Could not load the menu. Check your connection and try again.</p>
          <button onClick={loadMenu} className="mt-3 rounded-xl bg-brown-btn px-5 py-2 text-white">Try again</button>
        </div>
      </Shell>
    )
  }
  if (screen.kind === 'invalid' || !token) return <Shell><p className="p-6 text-center">This table code is not valid. Please order at the counter.</p></Shell>
  const { info, menu } = screen
  if (info.paused) return <Shell title={`Table ${info.tableLabel}`}><p className="p-6 text-center">Ordering from this table is paused. Please order at the counter.</p></Shell>
  if (!guest) {
    return (
      <Shell title={`Table ${info.tableLabel}`}>
        <GuestCard initial={null} onDone={(name, avatar) => { const g = newGuest(name, avatar); saveGuest(token, g); setGuest(g) }} />
      </Shell>
    )
  }

  const cartLines: CartLine[] = table.cart?.lines ?? []
  const { mine, others } = groupCart(cartLines, guest.id)
  const sendable = sendGroups(menu, cartLines, guest.id)
  const subtotal = cartTotalSen(menu, cartLines)
  const needsPax = info.needsPax && !state?.pax
  // picks, filtered to what this menu offers now; "in the cart" = anywhere in the table's cart
  const popular = visiblePopular(menu, picks)
  const popularIds = new Set(popular.map((p) => p.id))
  const goesWell = goesWellFor ? pairsFor(menu, picks, goesWellFor, cartLines) : []
  const goesWellName = goesWellFor ? findProduct(menu, goesWellFor)?.name ?? null : null
  const showGoesWell = goesWell.length > 0 && goesWellName !== null && goesWellVisible(goesWellFor, cartLines)

  /** The sheet's Add: the line goes to the table's cart on the server. A new line may open Goes well
   *  with (once per product per visit). */
  const done = async (line: OrderLine) => {
    if (!sheet || sheetBusy) return
    const isNew = sheet.lineId === null
    setSheetBusy(true); setSheetError(null)
    try {
      if (sheet.lineId === null) await table.add(guest, line)
      else await table.replace(guest, sheet.lineId, line)
      setSheet(null); setPlaced(false); setError(null)
      if (isNew) {
        const offer = offerPairs(menu, picks, line.productId, [...cartLines, line], pairsShown.current)
        if (offer) pairsShown.current.add(line.productId)
        setGoesWellFor(offer ? line.productId : null)
      }
    } catch (e) {
      const msg = errorText(e)
      setSheetError(isNetworkError(msg) ? 'Not added — no connection. Tap Add to try again.' : `Not added: ${msg}`)
    } finally { setSheetBusy(false) }
  }

  const remove = async (lineId: string) => {
    setError(null)
    try { await table.remove(guest.id, lineId) } catch (e) {
      const msg = errorText(e)
      setError(isNetworkError(msg) ? 'Not removed — no connection. Try again.' : `Not removed: ${msg}`)
    }
  }

  const send = async () => {
    if (sendingRef.current || !table.cart) return
    const paxNum = needsPax ? Number(pax) : null
    if (needsPax && (!Number.isInteger(paxNum) || (paxNum as number) < 1 || (paxNum as number) > 99)) {
      setSendError('How many people are at the table? (1–99)'); return
    }
    const skip = skipIds(menu, cartLines)
    const key = `${table.cart.version}|${skip.join(',')}`
    if (!pending.current || pending.current.key !== key) pending.current = { id: crypto.randomUUID(), key }
    let refused = false
    sendingRef.current = true; setSending(true); setSendError(null); setSendMessage(null)
    try {
      const status = await table.send(paxNum, skip, pending.current.id)
      if (status === 'changed') { setSendMessage('The order changed — please check again.'); return }
      pending.current = null
      setSendOpen(false); setPlaced(true); setGoesWellFor(null); setError(null)
      await loadState()
    } catch (e) {
      const msg = errorText(e)
      if (isNetworkError(msg)) setSendError('Not sent: no connection — tap Send to try again.')
      else { setSendError(`Not sent: ${msg}`); refused = true }
    } finally { sendingRef.current = false; setSending(false) }
    // the server refused a line (it left the menu within the last minute): read the menu now, so the
    // line shows as unavailable and the next Send leaves it out
    if (refused) refreshNow.current?.()
  }

  const renameGuest = (name: string, avatar: string) => {
    const g: Guest = { ...guest, name, avatar }
    saveGuest(token, g); setGuest(g); setGuestEdit(false)
    void table.rename(g).catch(() => { /* the next line this guest adds carries the new name */ })
  }

  const products = menu.categories.find((c) => c.name === category)?.products ?? []
  const ordered = groupOrdered(state?.items ?? [])
  const placeLabel = table.status === 'offline' ? 'Reconnecting…'
    : sendable.length === 0 ? 'Tap an item to start' : `Place order · ${formatSen(subtotal)}`
  return (
    <Shell title={`Table ${info.tableLabel}`} right={
      <button type="button" onClick={() => setGuestEdit(true)} aria-label={`You are ${guest.name}. Change name or avatar`}
        className="min-h-11 rounded-full bg-white/15 px-3 text-sm">{avatarEmoji(guest.avatar)} {guest.name}</button>
    }>
      {toast && <div role="status" className="fixed inset-x-3 top-3 z-30 rounded-xl bg-brown-dark px-4 py-3 text-sm text-white shadow-lg">{toast}</div>}
      {placed && (
        <div className="m-3 rounded-xl bg-green-50 p-3 text-sm text-green-800">
          Order placed — it is on its way. You can add more below.
        </div>
      )}
      {state && state.items.length > 0 && (
        <details className="m-3 rounded-xl border border-border bg-card p-3 text-sm">
          <summary>Ordered so far · {formatSen(state.subtotalSen)}</summary>
          {ordered.map((g) => (
            <div key={g.label ?? '-counter-'} className="mt-2">
              <div className="text-xs font-semibold text-brown-muted">{g.label === null ? 'Ordered at the counter' : `${avatarEmoji(g.avatar)} ${g.label}`.trim()}</div>
              {g.items.map((i, k) => (
                <div key={k} className={`flex justify-between py-1 ${i.voided ? 'line-through opacity-50' : ''}`}>
                  <span>{i.qty} × {i.name}{i.mods.length > 0 && <span className="text-brown-muted"> · {i.mods.join(', ')}</span>}</span>
                  <span>{formatSen(i.unitPriceSen * i.qty)}</span>
                </div>
              ))}
            </div>
          ))}
        </details>
      )}
      {popular.length > 0 && (
        <section aria-label="Popular here" className="px-3 pt-2">
          <h2 className="text-sm font-semibold text-brown-dark">Popular here</h2>
          <div className="mt-1 flex gap-2 overflow-x-auto pb-1">
            {popular.map((p) => <PickCard key={p.id} product={p} onOpen={() => { setSheetError(null); setSheet({ product: p, lineId: null }) }} />)}
          </div>
        </section>
      )}
      <div className="flex gap-1 overflow-x-auto px-3 py-2">
        {menu.categories.map((c) => (
          <button key={c.name} onClick={() => setCategory(c.name)}
            className={`whitespace-nowrap rounded-full px-3 py-1 text-sm ${category === c.name ? 'bg-brown-btn text-white' : 'border border-border bg-card'}`}>{c.name}</button>
        ))}
      </div>
      <div className={`space-y-2 px-3 ${cartLines.length > 0 ? (showGoesWell ? 'pb-[75vh]' : 'pb-[50vh]') : 'pb-24'}`}>
        {products.filter((p) => p.variants.length > 0).map((p) => (
          <button key={p.id} disabled={p.soldOut} onClick={() => { setSheetError(null); setSheet({ product: p, lineId: null }) }}
            className="flex w-full items-start gap-3 rounded-xl border border-border bg-card p-3 text-left disabled:opacity-50">
            {p.imageUrl && <img src={p.imageUrl} alt="" loading="lazy" className="h-16 w-16 shrink-0 rounded-lg object-cover" />}
            <div className="flex-1">
              <div className="font-medium">
                {p.name}
                {popularIds.has(p.id) && <PickPill text="Popular" />}
                {p.soldOut && <span className="ml-2 text-xs text-red-700">Sold out</span>}
              </div>
              {p.description && <div className="text-xs text-brown-muted">{p.description}</div>}
            </div>
            <div className="text-sm">{priceText(p)}</div>
          </button>
        ))}
      </div>

      <div className="fixed inset-x-0 bottom-0 border-t border-border bg-card p-3 text-sm shadow-lg">
        {showGoesWell && (
          <section aria-label="Goes well with" className="mb-2 rounded-xl border border-border bg-cream p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-brown-dark">Goes well with your {goesWellName}</span>
              <button type="button" aria-label="Close" className="-m-1 h-11 w-11 shrink-0" onClick={() => setGoesWellFor(null)}>✕</button>
            </div>
            <div className="mt-1 flex gap-2 overflow-x-auto">
              {goesWell.map((p) => <PickCard key={p.id} product={p} onOpen={() => { setSheetError(null); setSheet({ product: p, lineId: null }) }} />)}
            </div>
          </section>
        )}
        <div className="max-h-[40vh] overflow-y-auto">
          {mine.length > 0 && <div className="text-xs font-semibold uppercase text-brown-muted">Your items</div>}
          {mine.map((l) => (
            <CartRow key={l.id} menu={menu} line={l}
              onEdit={(p) => { setSheetError(null); setSheet({ product: p, lineId: l.id }) }} onRemove={() => void remove(l.id)} />
          ))}
          {others.length > 0 && <div className="mt-2 text-xs font-semibold uppercase text-brown-muted">Others at this table</div>}
          {others.map((g) => (
            <div key={g.guestId}>
              <div className="mt-1 text-xs text-brown-muted">{avatarEmoji(g.avatar)} {g.label}</div>
              {g.lines.map((l) => <CartRow key={l.id} menu={menu} line={l} />)}
            </div>
          ))}
          {error && <p role="alert" className="my-1 text-red-700">{error}</p>}
        </div>
        <button disabled={sendable.length === 0 || table.status !== 'ready'}
          onClick={() => { setSendError(null); setSendMessage(null); setSendOpen(true) }}
          className="mt-1 w-full rounded-xl bg-brown-btn py-3 text-white disabled:opacity-40">
          {placeLabel}
        </button>
      </div>

      {sheet && (
        <LineSheet product={sheet.product} initial={sheet.lineId === null ? undefined : mine.find((l) => l.id === sheet.lineId)}
          mostPicked={mostPickedFor(picks, sheet.product.id)} busy={sheetBusy} error={sheetError}
          onCancel={() => { if (!sheetBusy) setSheet(null) }}
          onDone={(line) => void done(line)} />
      )}
      {sendOpen && sendable.length > 0 && (
        <SendSheet groups={sendable} menu={menu} totalSen={subtotal} needsPax={needsPax} pax={pax} onPax={setPax}
          sending={sending} message={sendMessage} error={sendError}
          onSend={() => void send()} onCancel={() => setSendOpen(false)} />
      )}
      {guestEdit && (
        <div className="fixed inset-0 z-20 flex items-end justify-center bg-black/40 sm:items-center" onClick={() => setGuestEdit(false)}>
          <div className="w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <GuestCard initial={guest} onDone={renameGuest} onCancel={() => setGuestEdit(false)} />
          </div>
        </div>
      )}
    </Shell>
  )
}

/** One line of the table's cart. With onEdit / onRemove it is the guest's own; without, someone else's
 *  (read-only). A line the menu no longer offers is struck through and says so. */
function CartRow({ menu, line, onEdit, onRemove }: {
  menu: PosMenu
  line: CartLine
  onEdit?: (product: PosProduct) => void
  onRemove?: () => void
}) {
  const p = findProduct(menu, line.productId)
  const ok = lineAvailable(menu, line)
  const label = p && ok ? lineLabel(p, line) : { name: p?.name ?? 'Unavailable item', mods: [] as string[] }
  const text = <>{line.qty} × {label.name}{label.mods.length > 0 && <span className="text-brown-muted"> · {label.mods.join(', ')}</span>}</>
  return (
    <div className="flex justify-between gap-2 py-1">
      <span>
        {onEdit && p && ok
          ? <button type="button" className="text-left" onClick={() => onEdit(p)}>{text}</button>
          : <span className={ok ? '' : 'line-through opacity-60'}>{text}</span>}
        {!ok && <span className="block text-xs text-red-700">Not available now</span>}
      </span>
      <span className="shrink-0">
        {p && ok ? formatSen((linePriceSen(p, line) ?? 0) * line.qty) : ''}
        {onRemove && <button type="button" aria-label={`Remove ${label.name}`} className="ml-2 text-red-700" onClick={onRemove}>✕</button>}
      </span>
    </div>
  )
}

/** A card of Popular here and Goes well with: photo, name, price; a tap opens the item sheet. */
function PickCard({ product, onOpen }: { product: PosProduct; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen}
      className="flex w-28 shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card text-left">
      {product.imageUrl
        ? <img src={product.imageUrl} alt="" loading="lazy" className="h-20 w-full object-cover" />
        : <div className="h-20 w-full bg-border" />}
      <div className="p-2">
        <div className="line-clamp-2 text-xs font-medium">{product.name}</div>
        <div className="mt-0.5 text-xs text-brown-muted">{priceText(product)}</div>
      </div>
    </button>
  )
}

function Shell({ title, right, children }: { title?: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-cream">
      <header className="flex items-center justify-between gap-3 bg-brown-header px-4 py-3 text-white">
        <div>
          <div className="text-xs opacity-80">Craft Cafe</div>
          <div className="text-lg font-semibold">{title ?? 'Order'}</div>
        </div>
        {right}
      </header>
      {children}
    </div>
  )
}
```

- [ ] **Step 3: Type-check, lint, test, build**

Run: `npx tsc -b && npm run lint && npm test && npm run build`
Expected: all pass; the test count is the previous count plus the tests added in Tasks 3–6, minus the `qrState` tests removed in Step 1.

Things that may need a small correction, and how to decide:
- If `pairsFor` / `goesWellVisible` / `offerPairs` complain about `CartLine[]`, they take `readonly OrderLine[]` and `CartLine extends OrderLine`, so it should type-check; if a signature differs, read it in `src/features/pos/order/picks.ts` and pass what it asks for — do not change `picks.ts`.
- If `bg-brown-dark` is not a colour in this Tailwind theme (check `src/index.css` for `--color-brown-dark`), use `bg-brown-header` for the toast.
- If the `react-hooks` lint rule objects to the `onChange` arrow passed to `useTableCart`, it is fine as written (the hook keeps the latest in a ref); do not wrap it in `useCallback`.

- [ ] **Step 4: See it work on dev, one phone**

Get a table token: write `/tmp/tok.sql` with

```sql
select t.label, t.qr_token from dining_tables t join branches b on b.id = t.branch_id
 where t.is_active and not t.qr_paused order by b.name, t.sort_order limit 5;
```

Run `runsql /tmp/tok.sql`, pick a token, start the dev server through the preview tool (the `.claude/launch.json` entry that runs `vite`, or add one: `npm run dev`), and open `http://localhost:<port>/qr/?t=<token>`.

Check, at phone width:
1. The `Who's ordering?` card shows; `Start ordering` with an empty name leads to the menu, header shows the avatar and `Guest`.
2. Tap a product → `Add` → the line appears under `Your items`; the button reads `Place order · RM …`.
3. Tap the line → change qty → the cart updates. `✕` removes it.
4. Reload the page: no card again; the cart is still there (it lives on the server).
5. `Place order` → `Has everyone ordered?` lists the line → `Send order for the table` → `Order placed…`, cart empty, `Ordered so far` shows the item under your name.
6. Browser console: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/qr/QrApp.tsx src/qr/qrState.ts src/qr/qrState.test.ts
git commit -m "feat(qr): guest names and the shared table cart on the QR page

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
```

---

### Task 8: The guest on the ticket, the POS bill and Split items

**Files:**
- Modify: `src/features/pos/print/ticket.ts` (+ `ticket.test.ts`)
- Modify: `src/features/pos/order/posApi.ts` (`BillItemRow`, `fetchBillItems`)
- Modify: `src/features/pos/order/BillColumn.tsx`
- Modify: `src/features/pos/order/splitSelection.ts` (+ `splitSelection.test.ts`)
- Modify: `src/features/pos/order/SplitItemsScreen.tsx` (+ `SplitItemsScreen.test.tsx`)

**Interfaces:**
- Consumes: ticket payload lines with optional `guest` and `order_items.guest_id / guest_label` (Task 2).
- Produces:
  - `TicketLine.guest?: string`
  - `BillItemRow.guest_id?: string | null`, `BillItemRow.guest_label?: string | null`
  - `SplitLine.guest: string | null`
  - `guestLabels(lines: SplitLine[]): string[]`, `guestPicked(p: Picked, lines: SplitLine[], guest: string): boolean`, `toggleGuest(p: Picked, lines: SplitLine[], guest: string): Picked`

- [ ] **Step 1: Write the failing tests**

Add to `src/features/pos/print/ticket.test.ts`, inside `describe('renderTicketLines', …)` (it uses that block's `base`):

```ts
  it('names the guest after the item when the line has one', () => {
    const t: TicketPayload = { ...base, lines: [
      { qty: 1, name: 'Latte', note: null, guest: 'Eric' },
      { qty: 2, name: 'Cake', note: 'no nuts', mods: ['Cream'], guest: 'Guest 2' },
      { qty: 1, name: 'Tea', note: null },
    ] }
    expect(renderTicketLines(t, 32).slice(5, -1)).toEqual([
      '1 x Latte - Eric',
      '2 x Cake - Guest 2',
      '    + Cream',
      '    * no nuts',
      '1 x Tea',
    ])
  })
```

In `src/features/pos/order/splitSelection.test.ts`:
- add `guestLabels, guestPicked, toggleGuest,` to the import from `./splitSelection`;
- in the existing test `lists the live lines in bill order with name, modifiers, note and line price`, add `guest: null` to both expected objects:

```ts
    expect(lines).toEqual([
      { id: 'i1', name: 'Latte', mods: ['Oat milk'], note: null, qty: 3, amountSen: 3900, guest: null },
      { id: 'i2', name: 'Cake', mods: [], note: 'no sugar', qty: 1, amountSen: 1500, guest: null },
    ])
```

- append:

```ts
describe('pick by guest', () => {
  const g = splitLines([
    { ...row('a', 'Latte', 2, 1300), guest_label: 'Eric' },
    { ...row('b', 'Cake', 1, 1500), guest_label: 'Mei' },
    { ...row('c', 'Mocha', 1, 1400), guest_label: 'Eric' },
    row('d', 'Tea', 1, 800),                                   // ordered at the counter
  ])
  it('lists the guests on the bill once each, in bill order, without the counter', () => {
    expect(guestLabels(g)).toEqual(['Eric', 'Mei'])
    expect(g.map((l) => l.guest)).toEqual(['Eric', 'Mei', 'Eric', null])
  })
  it('a tap picks every unit of that guest and keeps what was picked', () => {
    const p = toggleGuest({ b: 1 }, g, 'Eric')
    expect(p).toEqual({ a: 2, b: 1, c: 1 })
    expect(guestPicked(p, g, 'Eric')).toBe(true)
    expect(guestPicked(p, g, 'Mei')).toBe(true)
  })
  it('a guest is picked only when every unit of theirs is', () => {
    expect(guestPicked({ a: 1, c: 1 }, g, 'Eric')).toBe(false)
    expect(guestPicked({}, g, 'Nobody')).toBe(false)
  })
  it('a second tap takes that guest\'s lines out and leaves the rest', () => {
    expect(toggleGuest({ a: 2, b: 1, c: 1 }, g, 'Eric')).toEqual({ b: 1 })
  })
  it('a tap on a partly picked guest completes the pick', () => {
    expect(toggleGuest({ a: 1 }, g, 'Eric')).toEqual({ a: 2, c: 1 })
  })
})
```

Append to `src/features/pos/order/SplitItemsScreen.test.tsx` (it uses that file's `row`, `renderPicker`, `flush`, `press`, `button`, `api`):

```tsx
describe('pick by guest chips', () => {
  it('shows a chip per guest when the bill has at least two, and a tap picks that guest\'s units', async () => {
    api.fetchBillItems.mockResolvedValue([
      { ...row('i1', 'Latte', 2, 1300), guest_label: 'Eric' },
      { ...row('i2', 'Cake', 1, 1500), guest_label: 'Mei' },
      row('i3', 'Tea', 1, 800),
    ])
    renderPicker()
    await flush()
    expect(button('Eric').getAttribute('aria-pressed')).toBe('false')
    press('Eric')
    expect(button('Eric').getAttribute('aria-pressed')).toBe('true')
    expect(button('Mei').getAttribute('aria-pressed')).toBe('false')
    expect((screen.getByRole('checkbox', { name: 'Cake' }) as HTMLInputElement).checked).toBe(false)
    press('Eric')
    expect(button('Eric').getAttribute('aria-pressed')).toBe('false')
  })

  it('shows no chips with one guest or none', async () => {
    api.fetchBillItems.mockResolvedValue([{ ...row('i1', 'Latte', 2, 1300), guest_label: 'Eric' }, row('i2', 'Cake', 1, 1500)])
    renderPicker()
    await flush()
    expect(screen.queryByRole('button', { name: 'Eric' })).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run src/features/pos/print/ticket.test.ts src/features/pos/order/splitSelection.test.ts src/features/pos/order/SplitItemsScreen.test.tsx`
Expected: FAIL — `guest` is not printed, `guestLabels` is not exported, no chips.

- [ ] **Step 3: Ticket**

In `src/features/pos/print/ticket.ts`, add to `TicketLine`:

```ts
  guest?: string // QR table cart: the guest who added the line ("Eric", "Guest 2"); absent for the counter
```

and in `renderTicketLines` replace

```ts
    ...wrap(`${l.qty} x ${l.name}`, cols, '    '),
```

with

```ts
    ...wrap(`${l.qty} x ${l.name}${l.guest ? ` - ${l.guest}` : ''}`, cols, '    '),
```

(A plain hyphen, not a dash: the ticket printers' code page is ASCII-safe only.)

- [ ] **Step 4: Bill item row**

In `src/features/pos/order/posApi.ts`, add to `interface BillItemRow` (after `catalog_discount_name`):

```ts
  /** QR table cart: who added the line; absent or null for counter lines */
  guest_id?: string | null
  guest_label?: string | null
```

and in `fetchBillItems` change the second line of the select string from

```ts
            'catalog_discount_bp, catalog_discount_name, discount_kind, discount_value, discount_reason, ' +
```

to

```ts
            'catalog_discount_bp, catalog_discount_name, discount_kind, discount_value, discount_reason, guest_id, guest_label, ' +
```

- [ ] **Step 5: Bill column**

In `src/features/pos/order/BillColumn.tsx`, replace `LineText` with

```tsx
function LineText({ qty, name, mods, note, guest }: { qty: number; name: string; mods: string[]; note: string | null; guest?: string | null }) {
  return (
    <span>
      {qty} × {name}{guest && <span className="ml-1 text-xs text-brown-muted">· {guest}</span>}
      {mods.map((m, k) => <span key={k} className="block pl-4 text-xs text-brown-muted">+ {m}</span>)}
      {note && <span className="block pl-4 text-xs italic text-brown-muted">* {note}</span>}
    </span>
  )
}
```

and in the sent rows change

```tsx
                  <LineText qty={s.qty} name={s.name} mods={s.mods} note={s.note} />
```

(the one inside `view.sent…map`, next to `<DiscountRows rows={s.discountRows} />`) to

```tsx
                  <LineText qty={s.qty} name={s.name} mods={s.mods} note={s.note} guest={s.item.guest_label} />
```

Leave the draft rows' `LineText` as it is.

- [ ] **Step 6: Split selection**

In `src/features/pos/order/splitSelection.ts`:

Replace the `SplitLine` interface with

```ts
/** A live line of the bill, as the picker lists it. `guest` = who added it on the QR page (null: the counter). */
export interface SplitLine { id: string; name: string; mods: string[]; note: string | null; qty: number; amountSen: number; guest: string | null }
```

In `splitLines`, replace the mapped object with

```ts
  return items.filter((i) => i.voided_at === null).map((i) => ({
    id: i.id, name: i.name_snapshot, mods: i.modifiers_snapshot.map((m) => m.name), note: i.note, qty: i.qty,
    amountSen: i.unit_price_sen * i.qty, guest: i.guest_label ?? null,
  }))
```

After `selectAll`, add

```ts
/** The guests on the bill, once each in bill order (QR table cart). Counter lines name no one. */
export const guestLabels = (lines: SplitLine[]): string[] => [...new Set(lines.flatMap((l) => (l.guest ? [l.guest] : [])))]

/** Is every unit of that guest's lines picked? */
export function guestPicked(p: Picked, lines: SplitLine[], guest: string): boolean {
  const own = lines.filter((l) => l.guest === guest)
  return own.length > 0 && own.every((l) => (p[l.id] ?? 0) === l.qty)
}

/** A tap on a guest's chip: picks every unit of their lines, or takes them all out when they already are.
 *  The other lines' picks stay. */
export function toggleGuest(p: Picked, lines: SplitLine[], guest: string): Picked {
  const on = guestPicked(p, lines, guest)
  const next: Record<string, number> = { ...p }
  for (const l of lines) {
    if (l.guest !== guest) continue
    if (on) delete next[l.id]
    else next[l.id] = l.qty
  }
  return next
}
```

- [ ] **Step 7: Split screen chips**

In `src/features/pos/order/SplitItemsScreen.tsx`:

Add `guestLabels, guestPicked, toggleGuest,` to the import from `./splitSelection`.

After the line `const lines = useMemo(() => splitLines(items ?? []), [items])` add

```tsx
  const guests = useMemo(() => guestLabels(lines), [lines])
```

Directly after the closing `</header>` add

```tsx
      {guests.length >= 2 && (
        <div aria-label="Pick by guest" className="flex gap-2 overflow-x-auto border-b border-border bg-card px-3 py-2">
          {guests.map((g) => {
            const on = guestPicked(picked, lines, g)
            return (
              <button key={g} type="button" aria-pressed={on} disabled={busy}
                onClick={() => setPicked((p) => toggleGuest(p, lines, g))}
                className={`min-h-11 shrink-0 rounded-full border-2 px-4 text-sm font-medium disabled:opacity-40 ${on ? 'border-brown-btn bg-brown-btn text-white' : 'border-border-mid text-brown-dark'}`}>
                {g}
              </button>
            )
          })}
        </div>
      )}
```

- [ ] **Step 8: Run everything**

Run: `npx tsc -b && npm run lint && npm test && npm run build`
Expected: all pass. If another test builds a `SplitLine` by hand and now fails to type-check for the missing `guest`, add `guest: null` to that fixture.

- [ ] **Step 9: Commit**

```bash
git add src/features/pos/print/ticket.ts src/features/pos/print/ticket.test.ts src/features/pos/order/posApi.ts src/features/pos/order/BillColumn.tsx src/features/pos/order/splitSelection.ts src/features/pos/order/splitSelection.test.ts src/features/pos/order/SplitItemsScreen.tsx src/features/pos/order/SplitItemsScreen.test.tsx
git commit -m "feat(pos): the QR guest's name on tickets, the bill and Split items

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
```

---

### Task 9: Two-phone check on dev, rollout note, push

**Files:**
- Modify: `docs/pos/2026-10-29-feedme-replacement-readiness.md` (the rollout chain sentence)

**Interfaces:**
- Consumes: everything above, live on dev.

- [ ] **Step 1: Two phones at one table**

With the dev server running (Task 7 Step 4), open the same `/qr/?t=<token>` URL in two separate browser profiles (a normal window and a private window — they must not share `localStorage`). Call them phone A and phone B.

Check each line; a line that fails is a bug to fix before going on (find the cause first — do not patch the symptom):

1. A picks an avatar and types `Eric`; B leaves the name empty. Headers show `Eric` and `Guest`.
2. A adds a Latte. Within about a second B shows a toast `<avatar> Eric added 1 × <product>`, the line under `Others at this table` → `Eric`, and `Place order · RM …`.
3. B adds two different items one after the other. A sees both under `Others at this table` → `Guest`.
4. On A, B's lines have no `✕` and are not tappable. A's own line is.
5. A changes the name to `Mei` from the header. B's view of A's line becomes `Mei` within about a second.
6. B (whose own cart has items) and A: A opens `Place order` → sheet lists `Mei (you)` first, then `Guest`, with the subtotal of all three lines.
7. While A's sheet is open, B adds another item. A taps `Send order for the table` → `The order changed — please check again.` and the sheet now lists four lines. A sends again → both phones show `Order placed — it is on its way.` and an empty cart; `Ordered so far` is grouped under `Mei` and `Guest`.
8. Turn the network off for A (DevTools → Network → Offline), tap a product → `Add` → `Not added — no connection. Tap Add to try again.` Turn it back on, tap `Add` → the line lands.
9. Stop the Realtime path for B (DevTools → Network → block the `wss://…/realtime/` request, or go Offline and back) and add a line on A: B shows it within 15 s (the fallback read).

- [ ] **Step 2: The store's side**

In the POS on dev (`npm run dev`, sign in with the dev owner login, open the same table):

1. The bill's sent lines from Step 1 show `· Mei` / `· Guest` after the item name; a line added at the counter shows no name.
2. `Split / Move items` shows chips `Mei` and `Guest`; tapping `Mei` ticks exactly Mei's lines; tapping again unticks them.
3. Read the newest ticket job for that table and check its lines carry `guest`: write `/tmp/job.sql` with

```sql
select j.route, j.payload->'lines' as lines from print_jobs j
 where j.kind = 'ticket' order by j.created_at desc limit 2;
```

   Run `runsql /tmp/job.sql`. Expected: each line object of the QR order has `"guest": "Mei"` or `"guest": "Guest"`. If the office test printer (192.168.0.32:9100) is the dev Demo Bar/Kitchen printer and a printing tablet is running, the paper ticket reads `1 x <item> - Mei`; if no printing tablet is running, say so in the report instead of claiming it printed.

4. Void the test bill in the POS (reason `test`), so dev is left with no open test bill; then reload phone A: its cart is empty and `Ordered so far` is gone.

- [ ] **Step 3: Add the migration to the prod rollout chain**

In `docs/pos/2026-10-29-feedme-replacement-readiness.md`, find the rollout chain sentence that ends with

```
sales reports (`migration-2026-11-18-pos-reports.sql`)
```

and insert directly after that closing parenthesis:

```
 → QR table cart (`migration-2026-11-22-qr-table-cart.sql`, which re-creates `pos_insert_order` and `qr_table_state`)
```

- [ ] **Step 4: Final checks, commit, push**

```bash
npx tsc -b && npm run lint && npm test && npm run build
git add docs/pos/2026-10-29-feedme-replacement-readiness.md
git commit -m "docs(pos): QR table cart — rollout chain

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
git push origin feature/pos-demo
```

Expected: all four checks pass; the push succeeds. Prod is untouched. The dev trial deployments (`craft-pos-dev`, `craft-os-dev`) are **not** redeployed by this plan — ask the owner before redeploying them.

---

## Self-review notes (already applied)

- Spec §2 entry card, live toast, cart groups, send confirmation, after-send → Tasks 6–7. §3 identity, labels, sync, stale carts, limits, old call → Tasks 2, 3, 5. §4 server → Task 2. §5 client and POS touches → Tasks 3–8. §6 failure cases → Task 7 (`done`, `remove`, `send`, `Reconnecting…`), Task 5 (stale replies, offline), Task 2 (paused, bill closed). §7 testing → each task's tests, Task 2's verify script, Task 9. §8 build order → Tasks 1–9.
- Names used across tasks: `Guest`, `CartLine`, `CartState`, `GuestGroup`, `CartApi`, `CartSignal`, `TableCart`, `useTableCart(api, signal, onChange)`, `qr_cart_state / put / remove / rename / send` — the same in every task that mentions them.
- The ticket prints ` - Eric` (ASCII hyphen) where the spec's prose shows a dash; the spec's intent (the name after the item) holds.
