-- ============================================================================
-- Craft OS — Private receiving / wastage photos (brief §4.4 defect 10)
-- (2026-10-27)
--
-- Before: bucket 'receiving-photos' was PUBLIC, with a read policy open to
-- everyone, and receivings stored full public URLs. Anyone holding a link
-- (or guessing a path) could see invoices and delivery photos.
--
-- After:
--   * Photo columns hold plain storage PATHS inside the bucket:
--       receivings.invoice_photo_url, receivings.goods_photo_url (names kept,
--       the content is now a path), wastage_logs.photo_path.
--     Existing public/signed URLs pointing at this bucket are converted to
--     paths (idempotent: a path stays a path). A BEFORE trigger does the same
--     for any client that still sends a URL.
--   * The bucket is private (public = false). The app shows photos through
--     short-lived signed URLs.
--   * Storage read (SELECT) is limited to procurement users who can access
--     the branch the photo belongs to (receiving_photo_readable(name)):
--       '<po_id>/...'                  -> the PO's branch, or HQ for an
--                                         internal PO addressed to it
--       'wastage/<branch_id>/...'      -> that branch
--       anything else (e.g. seeded)    -> the receiving / wastage row that
--                                         references the path
--     Uploads (receiving_photos_write) are unchanged.
--
-- Not purely additive: the old public read policy 'receiving_photos_read'
-- is dropped and replaced, and the bucket flag flips to private.
--
-- Prerequisites: migration-2026-10-27-internal-transfers.sql,
--   migration-2026-10-27-wastage.sql, migration-2026-10-27-procurement-function-grants.sql.
-- Idempotent.
-- ============================================================================

-- 1. URL -> path (internal helper) -------------------------------------------
create or replace function receiving_photo_path(p_value text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_value is null then null
    when p_value ~ '^https?://[^/]+/storage/v1/object/(public|sign|authenticated)/receiving-photos/'
      then split_part(
             regexp_replace(p_value,
               '^https?://[^/]+/storage/v1/object/(public|sign|authenticated)/receiving-photos/', ''),
             '?', 1)
    else p_value
  end
$$;
revoke all on function receiving_photo_path(text) from public, anon, authenticated;

-- 2. Convert stored URLs -----------------------------------------------------
update receivings
   set invoice_photo_url = receiving_photo_path(invoice_photo_url)
 where invoice_photo_url is distinct from receiving_photo_path(invoice_photo_url);
update receivings
   set goods_photo_url = receiving_photo_path(goods_photo_url)
 where goods_photo_url is distinct from receiving_photo_path(goods_photo_url);
update wastage_logs
   set photo_path = receiving_photo_path(photo_path)
 where photo_path is distinct from receiving_photo_path(photo_path);

-- 3. Keep it that way for old clients ---------------------------------------
create or replace function normalise_receiving_photo_paths()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_table_name = 'receivings' then
    new.invoice_photo_url := receiving_photo_path(new.invoice_photo_url);
    new.goods_photo_url   := receiving_photo_path(new.goods_photo_url);
  elsif tg_table_name = 'wastage_logs' then
    new.photo_path := receiving_photo_path(new.photo_path);
  end if;
  return new;
end;
$$;
revoke all on function normalise_receiving_photo_paths() from public, anon, authenticated;

drop trigger if exists receivings_photo_paths on receivings;
create trigger receivings_photo_paths
  before insert or update of invoice_photo_url, goods_photo_url on receivings
  for each row execute function normalise_receiving_photo_paths();

drop trigger if exists wastage_logs_photo_paths on wastage_logs;
create trigger wastage_logs_photo_paths
  before insert or update of photo_path on wastage_logs
  for each row execute function normalise_receiving_photo_paths();

-- 4. Who may read a photo ----------------------------------------------------
create or replace function receiving_photo_readable(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_seg1 text := split_part(p_name, '/', 1);
  v_seg2 text := split_part(p_name, '/', 2);
  v_uuid_re constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
begin
  if p_name is null or not has_procurement_cap('use_procurement') then
    return false;
  end if;

  -- Wastage photos: wastage/<branch_id>/...
  if v_seg1 = 'wastage' and v_seg2 ~ v_uuid_re then
    if can_access_branch(v_seg2::uuid) then
      return true;
    end if;
  end if;

  -- Receiving photos: <po_id>/...
  if v_seg1 ~ v_uuid_re then
    if exists (select 1 from purchase_orders po
                where po.id = v_seg1::uuid
                  and (can_access_branch(po.branch_id) or is_internal_po_source(po.supplier_id))) then
      return true;
    end if;
  end if;

  -- Any other path: the row that references it decides.
  return exists (
      select 1 from receivings r join purchase_orders po on po.id = r.po_id
       where (r.invoice_photo_url = p_name or r.goods_photo_url = p_name)
         and (can_access_branch(po.branch_id) or is_internal_po_source(po.supplier_id)))
    or exists (
      select 1 from wastage_logs w
       where w.photo_path = p_name and can_access_branch(w.branch_id));
end;
$$;
revoke all on function receiving_photo_readable(text) from public, anon;
grant execute on function receiving_photo_readable(text) to authenticated;

-- 5. Storage: private bucket, branch-scoped read ----------------------------
update storage.buckets set public = false where id = 'receiving-photos' and public;

drop policy if exists receiving_photos_read on storage.objects;
create policy receiving_photos_read on storage.objects
  for select to authenticated
  using (bucket_id = 'receiving-photos' and public.receiving_photo_readable(name));

-- == Verify ==================================================================
-- Expect 0 rows still holding a URL, and public = false.
select (select count(*) from receivings
         where invoice_photo_url ~ '^https?://' or goods_photo_url ~ '^https?://') as receiving_urls_left,
       (select count(*) from wastage_logs where photo_path ~ '^https?://')           as wastage_urls_left,
       (select public from storage.buckets where id = 'receiving-photos')            as bucket_public;
