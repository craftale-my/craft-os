-- =============================================================================
-- Craft OS — walk-in takeaway packaging fee (menu data, 2026-10-25).
-- Owner decision 2026-10-25: a takeaway is charged a packaging fee per item, added
-- automatically (SST is added on top by the bill): drinks RM 1.00, food RM 1.00; desserts,
-- bakery, flowers, merchandise and events none. Staff Meal shares these products, so staff
-- takeaways pay it too. A product's fee stays editable in /menu → Products → "Takeaway
-- packaging fee (RM)".
-- Feedme charged it with a "Packaging Fee" item the cashier added by hand (price RM 0); it is
-- switched off here so a takeaway is not charged twice.
-- Only products in the Craft Cafe catalog are touched (the Grab catalogs' own products
-- already carry their fee from the Feedme import). Re-runnable: it sets, never adds.
-- Run on craft-os-dev; on prod after the menu import (Craft OS is the menu master from then).
-- =============================================================================

do $$
begin
  if not exists (select 1 from menu_catalogs where name = 'Craft Cafe') then
    raise exception 'STOP: no Craft Cafe catalog — import the menu first';
  end if;
end $$;

with fee(category, fee_sen) as (values
  -- drinks
  ('BLACK', 100), ('MILK COFFEE', 100), ('MATCHA', 100), ('CHOCOLATE', 100), ('MILK', 100),
  ('TEA', 100), ('SODA FIZZY', 100),
  -- food
  ('PASTA', 100), ('DONBURI', 100), ('AGED CURRY', 100), ('MAIN', 100), ('SALAD', 100),
  ('SANDWICHES', 100), ('SNACK', 100), ('OCHAZUKE', 100), ('Nasi Lemak', 100), ('KID SET', 100)
)
update menu_products p
   set takeaway_fee_sen = fee.fee_sen, updated_at = now()
  from menu_categories mc, fee
 where mc.id = p.category_id and mc.name = fee.category
   and not p.is_addon
   and p.takeaway_fee_sen is distinct from fee.fee_sen
   and exists (select 1 from catalog_products cp join menu_catalogs c on c.id = cp.catalog_id
                where cp.product_id = p.id and c.name = 'Craft Cafe');

update menu_products
   set is_active = false, updated_at = now()
 where name = 'Packaging Fee' and is_active;

-- Result: products with a fee per category of the Craft Cafe catalog, and the old item's state.
select coalesce(mc.name, '(none)') as category, p.takeaway_fee_sen as fee_sen, count(*) as products
  from menu_products p
  join catalog_products cp on cp.product_id = p.id
  join menu_catalogs c on c.id = cp.catalog_id and c.name = 'Craft Cafe'
  left join menu_categories mc on mc.id = p.category_id
 where p.is_active and not p.is_addon
 group by 1, 2
union all
select 'Packaging Fee item active', null, count(*) from menu_products where name = 'Packaging Fee' and is_active
 order by 1, 2;
