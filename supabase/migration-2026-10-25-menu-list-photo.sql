-- ============================================================================
-- Craft OS — menu back-office tidy-up (2026-10-25): the Products list shows photos.
-- Run on craft-os-dev after migration-2026-10-24-pos-menu-editor-fn.sql and
-- migration-2026-10-24-pos-slots-photos.sql. Idempotent — safe to re-run.
-- Prod: run it after the slots-photos and editor-fn files (the STOP guard enforces that); either side of the deploy is safe — until it runs, the Products page just shows no photos.
-- Plan: docs/superpowers/plans/2026-10-25-menu-backoffice-tidy.md
-- Design: docs/superpowers/specs/2026-10-25-menu-backoffice-tidy-design.md §3
--
-- Canonical from here on: menu_product_list (from migration-2026-10-24-pos-menu-editor-fn.sql),
-- re-created from its live text with only the marked line added — each product's image_path
-- and image_updated_at (the thumbnail's cache-buster). Re-running the editor-fn file brings
-- back the list without photos: re-run this file afterwards.
-- Nothing else changes on the server: the Products page's bulk edits and the Takeaway fees
-- and Print routes pages write through the existing menu_products update policy (Edit menu).
-- No DELETE / UPDATE here (src/features/pos/sqlSafeUpdate.test.ts scans this file).
-- ============================================================================

do $$ begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'menu_products' and column_name = 'image_path')
     or not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'menu_products' and column_name = 'image_updated_at') then
    raise exception 'STOP: menu_products.image_path or image_updated_at is missing — run migration-2026-10-24-pos-slots-photos.sql first';
  end if;
  if to_regprocedure('menu_require_editor()') is null then
    raise exception 'STOP: run migration-2026-10-24-pos-menu-editor-fn.sql first (menu_require_editor is missing)';
  end if;
end $$;

-- The Products page: every product, switched-off ones too, in one JSON value (no 1000-row cap).
create or replace function menu_product_list() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform menu_require_editor();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', p.id, 'name', p.name, 'is_active', p.is_active, 'is_addon', p.is_addon,
             'sst_rate_bp', p.sst_rate_bp, 'print_route', p.print_route, 'takeaway_fee_sen', p.takeaway_fee_sen,
             'sort_order', p.sort_order, 'category_id', p.category_id,
             'image_path', p.image_path, 'image_updated_at', p.image_updated_at,          -- 2026-10-25: the list's photo
             'category', case when c.id is null then null
                              else jsonb_build_object('name', c.name, 'sort_order', c.sort_order) end,
             'menu_variants', coalesce((select jsonb_agg(jsonb_build_object(
                                                'id', v.id, 'name', v.name, 'price_sen', v.price_sen,
                                                'is_active', v.is_active, 'sort_order', v.sort_order)
                                              order by v.sort_order, v.name)
                                         from menu_variants v where v.product_id = p.id), '[]'::jsonb),
             'catalog_ids', coalesce((select jsonb_agg(cp.catalog_id)
                                       from catalog_products cp
                                      where cp.product_id = p.id and cp.availability <> 'hidden'), '[]'::jsonb))
           order by p.sort_order, p.name)
      from menu_products p
      left join menu_categories c on c.id = p.category_id), '[]'::jsonb);
end $$;
revoke all on function menu_product_list() from public, anon;
grant execute on function menu_product_list() to authenticated;

-- PostgREST picks up the new list now, not at its next poll
notify pgrst, 'reload schema';

select 'menu list photo applied' as result;
