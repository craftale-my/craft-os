-- =============================================================================
-- Craft OS — kitchen ticket print routes for Craft Cafe drinks and food (menu data, 2026-10-25).
-- Owner decision 2026-10-25: drinks print on "Bar", food on "Kitchen". A product's route
-- is a name; each branch maps the name to a printer in print_routes (POS settings).
-- Products with no route print no ticket (desserts, bakery, flowers, merchandise, events
-- are left as they are). Only products in the Craft Cafe catalog are touched.
-- A product's route stays editable in /menu → Products. Re-runnable: it sets, never adds.
-- Run on craft-os-dev; on prod after the menu import, once the owner confirms the same split.
-- =============================================================================

do $$
begin
  if not exists (select 1 from menu_catalogs where name = 'Craft Cafe') then
    raise exception 'STOP: no Craft Cafe catalog — import the menu first';
  end if;
end $$;

with route(category, print_route) as (values
  -- drinks
  ('BLACK', 'Bar'), ('MILK COFFEE', 'Bar'), ('MATCHA', 'Bar'), ('CHOCOLATE', 'Bar'), ('MILK', 'Bar'),
  ('TEA', 'Bar'), ('SODA FIZZY', 'Bar'),
  -- food
  ('PASTA', 'Kitchen'), ('DONBURI', 'Kitchen'), ('AGED CURRY', 'Kitchen'), ('MAIN', 'Kitchen'),
  ('SALAD', 'Kitchen'), ('SANDWICHES', 'Kitchen'), ('SNACK', 'Kitchen'), ('OCHAZUKE', 'Kitchen'),
  ('Nasi Lemak', 'Kitchen'), ('KID SET', 'Kitchen')
)
update menu_products p
   set print_route = route.print_route, updated_at = now()
  from menu_categories mc, route
 where mc.id = p.category_id and mc.name = route.category
   and not p.is_addon
   and p.print_route is distinct from route.print_route
   and exists (select 1 from catalog_products cp join menu_catalogs c on c.id = cp.catalog_id
                where cp.product_id = p.id and c.name = 'Craft Cafe');

-- Result: products per category and route in the Craft Cafe catalog.
select coalesce(mc.name, '(none)') as category, coalesce(p.print_route, '(none)') as print_route, count(*) as products
  from menu_products p
  join catalog_products cp on cp.product_id = p.id
  join menu_catalogs c on c.id = cp.catalog_id and c.name = 'Craft Cafe'
  left join menu_categories mc on mc.id = p.category_id
 where p.is_active and not p.is_addon
 group by 1, 2
 order by 2, 1;
