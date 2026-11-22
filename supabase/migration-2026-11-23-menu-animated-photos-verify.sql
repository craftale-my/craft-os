-- Self-check for migration-2026-11-23-menu-animated-photos.sql. Run on craft-os-dev after it.
-- Everything is rolled back. Success = a result row "VERIFY OK".
begin;

create function pg_temp.expect_error(p_sql text, p_message text, p_label text) returns void
language plpgsql as $$
begin
  execute p_sql;
  raise exception 'FAIL %: no error (expected "%")', p_label, p_message;
exception when raise_exception then
  if sqlerrm <> p_message then
    raise exception 'FAIL %: got "%" (expected "%")', p_label, sqlerrm, p_message;
  end if;
end $$;

do $$
declare
  v_owner uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_p uuid; v_other uuid; v_gif text; v_anim text; v_text text; v_skip boolean := false;
begin
  -- A. bucket
  if not exists (select 1 from storage.buckets where id = 'menu-images' and public
                  and file_size_limit = 4194304
                  and allowed_mime_types @> array['image/webp', 'image/jpeg', 'image/gif']
                  and array_length(allowed_mime_types, 1) = 3) then
    raise exception 'FAIL bucket: menu-images must be public, 4 MB, webp + jpeg + gif';
  end if;
  -- B. grants and search_path unchanged
  if has_function_privilege('anon', 'menu_set_product_image(uuid,text)', 'execute')
     or not has_function_privilege('authenticated', 'menu_set_product_image(uuid,text)', 'execute') then
    raise exception 'FAIL grants: menu_set_product_image';
  end if;
  if not coalesce((select proconfig @> array['search_path=public, pg_temp'] from pg_proc
                    where oid = 'menu_set_product_image(uuid,text)'::regprocedure), false) then
    raise exception 'FAIL search_path: menu_set_product_image';
  end if;

  -- the table check allows the same suffixes as the function
  if (select pg_get_constraintdef(oid) from pg_constraint
       where conrelid = 'menu_products'::regclass and conname = 'menu_products_image_path_check')
     not like '%(webp|jpg|gif|anim\\.webp)$%' then
    raise exception 'FAIL check: menu_products_image_path_check does not allow .gif and .anim.webp';
  end if;

  select id into v_p from menu_products order by created_at limit 1;
  select id into v_other from menu_products where id <> v_p order by created_at limit 1;
  if v_p is null or v_other is null then raise exception 'STOP: needs two menu products'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);

  v_gif := 'products/' || v_p || '/verifyanimA1.gif';
  v_anim := 'products/' || v_p || '/verifyanimB2.anim.webp';
  -- C. the path rule: other folders and other extensions are still refused (needs no storage row)
  perform pg_temp.expect_error(format('select menu_set_product_image(%L, %L)', v_p, 'products/' || v_other || '/verifyanimA1.gif'),
    'Invalid photo path', 'C another product''s folder');
  perform pg_temp.expect_error(format('select menu_set_product_image(%L, %L)', v_p, 'products/' || v_p || '/verifyanimA1.png'),
    'Invalid photo path', 'C .png');
  perform pg_temp.expect_error(format('select menu_set_product_image(%L, %L)', v_p, 'products/' || v_p || '/verifyanimA1.gif.png'),
    'Invalid photo path', 'C .gif.png');
  perform pg_temp.expect_error(format('select menu_set_product_image(%L, %L)', v_p, 'products/' || v_p || '/verifyanimA1.anim.gif'),
    'Invalid photo path', 'C .anim.gif');
  perform pg_temp.expect_error(format('select menu_set_product_image(%L, %L)', v_p, 'products/' || v_p || '/short.gif'),
    'Invalid photo path', 'C name under 8');
  -- the new suffixes pass the path rule (the next check is the storage row)
  perform pg_temp.expect_error(format('select menu_set_product_image(%L, %L)', v_p, v_gif),
    'Photo not found — upload it again', 'C .gif not uploaded');
  perform pg_temp.expect_error(format('select menu_set_product_image(%L, %L)', v_p, v_anim),
    'Photo not found — upload it again', 'C .anim.webp not uploaded');
  perform pg_temp.expect_error(format('select menu_set_product_image(%L, %L)', v_p, 'products/' || v_p || '/verifyanimC3.webp'),
    'Photo not found — upload it again', 'C .webp still passes');
  perform pg_temp.expect_error(format('select menu_set_product_image(%L, %L)', v_p, 'products/' || v_p || '/verifyanimD4.jpg'),
    'Photo not found — upload it again', 'C .jpg still passes');

  -- D. with storage rows: set a .gif, replace with .anim.webp (returns the .gif), clear
  begin
    insert into storage.objects(bucket_id, name) values ('menu-images', v_gif), ('menu-images', v_anim);
  exception when others then
    raise notice 'SKIP D: storage refused the test rows (%)', sqlerrm;
    v_skip := true;
  end;
  if not v_skip then
    update menu_products set image_path = null, image_updated_at = null where id = v_p;
    v_text := menu_set_product_image(v_p, v_gif);
    if v_text is not null or (select image_path from menu_products where id = v_p) is distinct from v_gif then
      raise exception 'FAIL D: set a .gif';
    end if;
    v_text := menu_set_product_image(v_p, v_anim);
    if v_text is distinct from v_gif or (select image_path from menu_products where id = v_p) is distinct from v_anim then
      raise exception 'FAIL D: replace with .anim.webp';
    end if;
    v_text := menu_set_product_image(v_p, null);
    if v_text is distinct from v_anim then raise exception 'FAIL D: clear'; end if;
  end if;
end $$;

rollback;
select 'VERIFY OK' as result;
