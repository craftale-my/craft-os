-- Self-check for migration-2026-11-23-menu-category-kind.sql. Run on craft-os-dev after it.
-- Everything is rolled back. Success = a result row "VERIFY OK".
begin;

create function pg_temp.expect_error(p_sql text, p_message text, p_label text) returns void
language plpgsql as $$
begin
  execute p_sql;
  raise exception 'FAIL %: no error (expected "%")', p_label, p_message;
exception when raise_exception or check_violation then
  if sqlerrm <> p_message and p_message <> '*' then
    raise exception 'FAIL %: got "%" (expected "%")', p_label, sqlerrm, p_message;
  end if;
end $$;

do $$
declare
  v_owner uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_cat uuid; v_cat_name text; v_token text; v_j jsonb; v_kind text; f text;
begin
  -- A. the column and its check
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'menu_categories' and column_name = 'kind' and data_type = 'text') then
    raise exception 'FAIL column: menu_categories.kind';
  end if;
  select id, name into v_cat, v_cat_name from menu_categories order by sort_order, name limit 1;
  if v_cat is null then raise exception 'STOP: needs a menu category'; end if;
  perform pg_temp.expect_error(format('update menu_categories set kind = %L where id = %L', 'cake', v_cat), '*', 'A check refuses cake');

  -- B. grants and search_path
  foreach f in array array['menu_set_category_kind(uuid,text)', 'menu_editor_lookups()', 'pos_menu_rows(uuid)'] loop
    if has_function_privilege('anon', f, 'execute') or not has_function_privilege('authenticated', f, 'execute') then
      raise exception 'FAIL grants: %', f;
    end if;
  end loop;
  if not has_function_privilege('anon', 'qr_menu(text)', 'execute') then raise exception 'FAIL grants: qr_menu for anon'; end if;
  foreach f in array array['menu_set_category_kind(uuid,text)', 'menu_editor_lookups()', 'pos_menu_rows(uuid)', 'qr_menu(text)'] loop
    if not coalesce((select proconfig @> array['search_path=public, pg_temp'] from pg_proc where oid = f::regprocedure), false) then
      raise exception 'FAIL search_path: %', f;
    end if;
  end loop;

  -- C. the setter: needs an editor; refuses an unknown kind and an unknown category; sets and clears
  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  begin
    perform menu_set_category_kind(v_cat, 'drink');
    raise exception 'FAIL C: a non-editor set a kind';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  perform pg_temp.expect_error(format('select menu_set_category_kind(%L, %L)', v_cat, 'cake'), 'Invalid category type', 'C unknown kind');
  perform pg_temp.expect_error(format('select menu_set_category_kind(%L, %L)', gen_random_uuid(), 'food'),
    'Category not found — refresh and try again', 'C unknown category');
  perform menu_set_category_kind(v_cat, 'drink');
  if (select kind from menu_categories where id = v_cat) is distinct from 'drink' then raise exception 'FAIL C: drink not set'; end if;

  -- D. menu_editor_lookups returns it
  select c->>'kind' into v_kind from jsonb_array_elements(menu_editor_lookups()->'categories') c where (c->>'id')::uuid = v_cat;
  if v_kind is distinct from 'drink' then raise exception 'FAIL D: lookups kind = %', v_kind; end if;

  -- E. pos_menu_rows carries it on each product's category (its caller is a till, so the text is checked)
  if pg_get_functiondef('pos_menu_rows(uuid)'::regprocedure) not like '%''sort_order'', c.sort_order, ''kind'', c.kind)%' then
    raise exception 'FAIL E: pos_menu_rows does not return the category kind';
  end if;

  -- F. qr_menu returns it per category, null for the others; the rest of the reply is unchanged
  update menu_categories set kind = null where id <> v_cat;
  select t.qr_token into v_token from dining_tables t where t.is_active and t.qr_token is not null
     and exists (select 1 from jsonb_array_elements(qr_menu(t.qr_token)->'categories') c where c->>'name' = v_cat_name)
   limit 1;
  if v_token is not null then
    v_j := qr_menu(v_token);
    if not (v_j ? 'tableLabel' and v_j ? 'lastOrderAt' and v_j ? 'ordersOpenAt' and v_j ? 'needsPax') then
      raise exception 'FAIL F: qr_menu lost a field';
    end if;
    select c->>'kind' into v_kind from jsonb_array_elements(v_j->'categories') c where c->>'name' = v_cat_name;
    if v_kind is distinct from 'drink' then raise exception 'FAIL F: qr_menu kind = %', v_kind; end if;
    if exists (select 1 from jsonb_array_elements(v_j->'categories') c where c->>'name' <> v_cat_name and c->>'kind' is not null) then
      raise exception 'FAIL F: another category has a kind';
    end if;
    if exists (select 1 from jsonb_array_elements(v_j->'categories') c where not (c ? 'kind' and c ? 'products')) then
      raise exception 'FAIL F: a category without kind or products';
    end if;
  else
    raise notice 'skip F: no QR table shows %', v_cat_name;
  end if;

  -- G. clear
  perform menu_set_category_kind(v_cat, null);
  if (select kind from menu_categories where id = v_cat) is not null then raise exception 'FAIL G: not cleared'; end if;
end $$;

select 'VERIFY OK' as result;
rollback;
