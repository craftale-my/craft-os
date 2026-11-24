-- Animated product photos (spec docs/superpowers/specs/2026-11-22-menu-animated-photos-design.md §4).
-- A product photo may be a GIF or an animated WebP, stored as uploaded. Idempotent; dev first, then prod.
-- Run before the back-office build that uploads animations (an older server refuses their paths).
-- Then run migration-2026-11-23-menu-animated-photos-verify.sql (prints VERIFY OK).

do $$
begin
  if to_regprocedure('menu_set_product_image(uuid,text)') is null
     or not exists (select 1 from storage.buckets where id = 'menu-images') then
    raise exception 'STOP: run migration-2026-10-24-pos-slots-photos.sql and -slots-photos-fn.sql first';
  end if;
end $$;

-- ── Bucket: 4 MB (an animation is not resized), GIF allowed ────────────────
-- Still photos stay ~100–200 KB WebP/JPEG; the 4 MB ceiling is for animations (spec §3).
update storage.buckets
   set file_size_limit = 4194304,
       allowed_mime_types = array['image/webp', 'image/jpeg', 'image/gif']
 where id = 'menu-images';

-- ── menu_products.image_path check: the same suffixes as the function ──────
-- The 2026-10-24 migration also pins the suffix in a table check; widened in step with the function.
alter table menu_products drop constraint if exists menu_products_image_path_check;
alter table menu_products add constraint menu_products_image_path_check
  check (image_path is null or image_path ~ '^products/[0-9a-f-]{36}/[A-Za-z0-9_-]{8,64}\.(webp|jpg|gif|anim\.webp)$');

-- ── menu_set_product_image: also .gif and .anim.webp ───────────────────────
-- Re-created from its current text (migration-2026-10-24-pos-slots-photos-fn.sql); only the
-- path pattern changes.
-- p_path: a file the editor has just uploaded to menu-images,
-- products/<this product>/<random>.webp|.jpg|.gif|.anim.webp (.anim.webp = an animated WebP);
-- null = no photo. Returns the path it replaced (the editor then deletes that file), or null.
create or replace function menu_set_product_image(p_product_id uuid, p_path text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_old text;
begin
  perform menu_require_editor();
  select image_path into v_old from menu_products where id = p_product_id for update;
  if not found then
    raise exception 'Product not found — refresh and try again';
  end if;
  if p_path is not null then
    if p_path !~ ('^products/' || p_product_id::text || '/[A-Za-z0-9_-]{8,64}\.(webp|jpg|gif|anim\.webp)$') then
      raise exception 'Invalid photo path';
    end if;
    if not exists (select 1 from storage.objects o where o.bucket_id = 'menu-images' and o.name = p_path) then
      raise exception 'Photo not found — upload it again';
    end if;
  end if;
  update menu_products
     set image_path = p_path, image_updated_at = case when p_path is null then null else now() end, updated_at = now()
   where id = p_product_id;
  return case when v_old is distinct from p_path then v_old end;
end $$;
revoke all on function menu_set_product_image(uuid, text) from public, anon;
grant execute on function menu_set_product_image(uuid, text) to authenticated;

select 'animated photos applied' as result;
