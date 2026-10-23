-- ============================================================================
-- Craft OS — POS menu catalogs · M3 schema: time slots and product photos (2026-10-24).
-- Run on craft-os-dev after migration-2026-10-24-pos-menu-editor-fn.sql (M2).
-- Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-10-24-pos-menu-catalogs-m3.md
-- Design: docs/superpowers/specs/2026-10-24-pos-menu-catalogs-design.md §2, §3, §5
--
-- Time slots follow Feedme's Scheduler (assumed — Feedme behaviour, owner asleep,
-- 2026-10-24): named, reusable schedules, each with one or more windows, linked to
-- products. A product that follows no schedule is always available; one that follows
-- schedules is available inside ANY window of them. Like Feedme, a schedule has no
-- on/off switch: it is deleted, with its windows and links (no order refers to them).
-- The three new tables have no write policy: they are written only through the
-- Edit menu functions in migration-2026-10-24-pos-slots-photos-fn.sql.
-- ============================================================================

do $$ begin
  if to_regclass('public.menu_catalogs') is null or to_regprocedure('menu_require_editor()') is null then
    raise exception 'STOP: run migration-2026-10-24-pos-catalogs.sql, -catalogs-fn.sql and -menu-editor-fn.sql first';
  end if;
  if to_regclass('storage.buckets') is null then
    raise exception 'STOP: no storage schema — run this on the Supabase project, not a bare Postgres';
  end if;
end $$;

-- ── Schedules (Feedme: Menu → Scheduler) ────────────────────────────────────
-- Deleted outright by menu_delete_schedule (Feedme's Delete), the one hard delete of M3.
create table if not exists menu_schedules (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique check (length(trim(name)) between 1 and 60),
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

-- One window: ISO days (1 = Mon … 7 = Sun) and whole-minute times, Malaysia time.
-- The end minute is included (Feedme's "10:00 am – 11:59 pm" runs to midnight).
-- end_time < start_time crosses midnight; days are the days the window starts on.
-- Configuration only (no order refers to it): a save replaces a schedule's windows.
create table if not exists menu_schedule_windows (
  id           uuid primary key default gen_random_uuid(),
  schedule_id  uuid not null references menu_schedules(id),          -- no cascade: menu_delete_schedule removes them itself
  days         smallint[] not null check (cardinality(days) between 1 and 7 and days <@ array[1,2,3,4,5,6,7]::smallint[]),
  start_time   time not null check (extract(second from start_time) = 0),
  end_time     time not null check (extract(second from end_time) = 0),
  sort_order   integer not null default 0,
  check (start_time <> end_time)
);
-- M3 final fixes: names are unique whatever their case, as menu_save_schedule checks them
-- ("Breakfast" and "breakfast" are one name). The function's check alone lets two saves at the
-- same moment both pass it; this index refuses the second (menu_save_schedule turns the
-- unique_violation into "A schedule called … already exists").
do $$ begin
  if exists (select 1 from menu_schedules group by lower(name) having count(*) > 1) then
    raise exception 'STOP: two schedules have the same name in different case — rename one on the Schedules page, then re-run';
  end if;
end $$;
create unique index if not exists menu_schedules_name_lower_idx on menu_schedules (lower(name));

create index if not exists menu_schedule_windows_schedule_idx on menu_schedule_windows(schedule_id);

-- Which schedules a product follows (configuration: a removed link is deleted).
create table if not exists product_schedules (
  product_id   uuid not null references menu_products(id) on delete cascade,
  schedule_id  uuid not null references menu_schedules(id),          -- no cascade, as above
  primary key (product_id, schedule_id)
);
create index if not exists product_schedules_schedule_idx on product_schedules(schedule_id);

-- ── Product photo: a path in the menu-images bucket ─────────────────────────
alter table menu_products add column if not exists image_path text;
alter table menu_products add column if not exists image_updated_at timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'menu_products_image_path_check') then
    alter table menu_products add constraint menu_products_image_path_check
      check (image_path is null or image_path ~ '^products/[0-9a-f-]{36}/[A-Za-z0-9_-]{8,64}\.(webp|jpg)$');
  end if;
end $$;

-- ── RLS: signed-in staff read; nobody writes directly ───────────────────────
do $$
declare t text;
begin
  foreach t in array array['menu_schedules','menu_schedule_windows','product_schedules']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists menu_read on %I', t);
    execute format('create policy menu_read on %I for select to authenticated using (true)', t);
  end loop;
end $$;

-- ── Storage: bucket menu-images, public read, Edit menu writes ──────────────
-- Same pattern as company-assets / staff-avatars (supabase/schema.sql). Files are
-- products/<product_id>/<random>.webp (or .jpg where the browser cannot make WebP),
-- already resized to 800 px wide in the browser: 2 MB is a generous ceiling.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('menu-images', 'menu-images', true, 2097152, array['image/webp', 'image/jpeg'])
on conflict (id) do update
  set public = excluded.public, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "menu_images_read" on storage.objects;
-- Signed-in staff only (the editors' upload and remove need it). Customers fetch photos
-- through the public URL (/object/public/…), which needs no policy, and cannot list the bucket.
create policy "menu_images_read" on storage.objects for select to authenticated
  using (bucket_id = 'menu-images');

drop policy if exists "menu_images_insert" on storage.objects;
create policy "menu_images_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'menu-images' and (storage.foldername(name))[1] = 'products'
              and public.has_menu_cap('manage_menu'));

drop policy if exists "menu_images_update" on storage.objects;
create policy "menu_images_update" on storage.objects for update to authenticated
  using (bucket_id = 'menu-images' and public.has_menu_cap('manage_menu'))
  with check (bucket_id = 'menu-images' and (storage.foldername(name))[1] = 'products'
              and public.has_menu_cap('manage_menu'));

-- M3 final fixes: never a file a product still points at. The editors delete a file only after
-- the product's pointer moved off it; this makes "a product pointing at a deleted file"
-- impossible from any client, including a pointer write that committed after the client saw a
-- network error. A refused delete removes nothing and raises nothing (the file simply stays).
drop policy if exists "menu_images_delete" on storage.objects;
create policy "menu_images_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'menu-images' and public.has_menu_cap('manage_menu')
         and not exists (select 1 from public.menu_products p where p.image_path = objects.name));

-- PostgREST picks up the new tables and columns now, not at its next poll
notify pgrst, 'reload schema';

select 'time slots and photos schema applied' as result;
