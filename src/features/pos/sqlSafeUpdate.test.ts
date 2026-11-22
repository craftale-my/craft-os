import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'

// Supabase's API runs every request under pg-safeupdate: a DELETE or UPDATE with no
// WHERE fails ("DELETE requires a WHERE clause"). The SQL editor does not load it, so
// the verify scripts pass while the app breaks (eae4355). This guard scans every POS
// function body for such a statement.

const SUPABASE = new URL('../../../supabase/', import.meta.url)
// the menu back-office's own migrations (migration-*-menu-*.sql) are scanned too
const POS_MIGRATION = /^migration-.*-(pos|menu)-.*\.sql$/

/** Comments removed and string literals emptied; dollar quotes kept, since a
 *  function body is code. Line breaks are kept so error lines still match. */
function stripCommentsAndStrings(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const c = sql[i]
    const n = sql[i + 1]
    if (c === '-' && n === '-') {
      while (i < sql.length && sql[i] !== '\n') i++
    } else if (c === '/' && n === '*') {
      const end = sql.indexOf('*/', i + 2)
      const stop = end === -1 ? sql.length : end + 2
      out += sql.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
    } else if (c === "'") {
      i++
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2
        else if (sql[i] === "'") break
        else i++
      }
      i++
      out += "''"
    } else {
      out += c
      i++
    }
  }
  return out
}

/** The bodies of `create [or replace] function … as $tag$ … $tag$`. */
function functionBodies(sql: string): { name: string; body: string }[] {
  const clean = stripCommentsAndStrings(sql)
  const re = /create\s+(?:or\s+replace\s+)?function\s+([\w.]+)[\s\S]*?\bas\s+(\$\w*\$)([\s\S]*?)\2/gi
  const out: { name: string; body: string }[] = []
  for (const m of clean.matchAll(re)) out.push({ name: m[1], body: m[3] })
  return out
}

/** Statements in a body that DELETE or UPDATE with no WHERE at their own level.
 *  `on conflict … do update set` and `select … for update` are not UPDATE statements. */
function unguardedWrites(body: string): string[] {
  const found: string[] = []
  for (const raw of body.split(';')) {
    const stmt = raw.replace(/\s+/g, ' ').trim().toLowerCase()
    if (!stmt) continue
    // paren depth at every character, so a WHERE inside a subquery does not count
    const depth: number[] = []
    let d = 0
    for (const ch of stmt) {
      if (ch === '(') d++
      depth.push(d)
      if (ch === ')') d--
    }
    const writes = [...stmt.matchAll(/\b(delete\s+from|update)\b/g)].filter((m) => {
      if (m[1] !== 'update') return true
      const before = stmt.slice(0, m.index).trimEnd()
      if (/\b(do|for)$/.test(before)) return false                 // on conflict do update / for update
      return /^update\s+[\w."]+(\s+(as\s+)?\w+)?\s+set\b/.test(stmt.slice(m.index))
    })
    for (const m of writes) {
      const at = depth[m.index]
      let guarded = false
      for (const w of stmt.slice(m.index).matchAll(/\bwhere\b/g)) {
        const pos = m.index + w.index
        if (depth[pos] === at && !stmt.slice(m.index, pos).split('').some((_, k) => depth[m.index + k] < at)) {
          guarded = true
          break
        }
      }
      if (!guarded) found.push(stmt)
    }
  }
  return found
}

describe('pg-safeupdate guard: the checker itself', () => {
  const body = (s: string) => unguardedWrites(stripCommentsAndStrings(s))
  it('flags a bare delete or update', () => {
    expect(body('delete from pg_temp._x;')).toHaveLength(1)
    expect(body('update bills set pax = 2;')).toHaveLength(1)
    expect(body('update bills b set pax = 2;')).toHaveLength(1)
  })
  it('accepts a delete or update with a where, even where true', () => {
    expect(body('delete from pg_temp._x where true;')).toEqual([])
    expect(body('update bills set pax = 2 where id = v_id;')).toEqual([])
  })
  it('does not count a where that sits only inside a subquery', () => {
    expect(body('update bills set pax = (select max(p) from t where t.id = 1);')).toHaveLength(1)
  })
  it('ignores on conflict do update set, select for update, comments and strings', () => {
    expect(body('insert into t(a) values (1) on conflict (a) do update set b = excluded.b;')).toEqual([])
    expect(body('select * from bills where id = v_id for update;')).toEqual([])
    expect(body("-- delete from t;\nraise exception 'delete from t;';")).toEqual([])
  })
})

describe('pg-safeupdate guard: POS migrations', () => {
  const files = readdirSync(SUPABASE).filter((f) => POS_MIGRATION.test(f) && !f.includes('verify')).sort()

  it('reads the POS function migrations', () => {
    expect(files).toEqual(expect.arrayContaining([
      'migration-2026-10-22-pos-menu-import-fn.sql',
      'migration-2026-10-23-pos-ordering-fn.sql',
      'migration-2026-10-24-pos-catalogs-fn.sql',
      'migration-2026-10-24-pos-checkout-fn.sql',
      'migration-2026-10-24-pos-menu-editor-fn.sql',
      'migration-2026-10-24-pos-slots-photos-fn.sql',
      'migration-2026-10-24-pos-shifts.sql',
      'migration-2026-10-24-pos-shifts-fn.sql',
      'migration-2026-10-25-pos-hardening.sql',
      'migration-2026-10-25-menu-list-photo.sql',
      'migration-2026-10-26-pos-frontend.sql',
      'migration-2026-10-29-pos-outlets.sql',
      'migration-2026-10-29-pos-devices.sql',
      'migration-2026-10-29-pos-device-till.sql',
    ]))
  })

  for (const f of files) {
    it(`${f}: every DELETE / UPDATE inside a function has a WHERE`, () => {
      const sql = readFileSync(new URL(f, SUPABASE), 'utf8')
      const offenders = functionBodies(sql).flatMap(({ name, body }) => unguardedWrites(body).map((s) => `${name}: ${s}`))
      expect(offenders).toEqual([])
    })
  }

  it('finds the functions it checks (the scan is not vacuous)', () => {
    const sql = readFileSync(new URL('migration-2026-10-24-pos-catalogs-fn.sql', SUPABASE), 'utf8')
    const names = functionBodies(sql).map((b) => b.name)
    expect(names).toEqual(expect.arrayContaining(['pos_insert_order', 'menu_import', 'menu_import_catalogs', 'save_branch_catalogs']))
  })

  it('scans every write function of the menu editor (M2)', () => {
    const sql = readFileSync(new URL('migration-2026-10-24-pos-menu-editor-fn.sql', SUPABASE), 'utf8')
    const names = functionBodies(sql).map((b) => b.name)
    expect(names).toEqual(expect.arrayContaining([
      'menu_save_product', 'menu_save_group', 'menu_save_catalog', 'menu_duplicate_catalog', 'menu_reorder_catalogs',
      'menu_set_catalog_active', 'menu_save_catalog_row', 'menu_save_category', 'menu_reorder_categories',
      'menu_set_category_active',
    ]))
  })

  it('scans every write function of time slots and photos (M3)', () => {
    const sql = readFileSync(new URL('migration-2026-10-24-pos-slots-photos-fn.sql', SUPABASE), 'utf8')
    const names = functionBodies(sql).map((b) => b.name)
    expect(names).toEqual(expect.arrayContaining([
      'menu_save_schedule', 'menu_reorder_schedules', 'menu_delete_schedule', 'menu_set_product_schedules',
      'menu_set_product_image', 'pos_insert_order', 'qr_menu',
    ]))
  })

  it('scans every write function of shifts (Sub-plan 4a)', () => {
    const sql = readFileSync(new URL('migration-2026-10-24-pos-shifts-fn.sql', SUPABASE), 'utf8')
    const names = functionBodies(sql).map((b) => b.name)
    expect(names).toEqual(expect.arrayContaining([
      'open_shift', 'record_cash_move', 'close_shift', 'pos_queue_zreport', 'reprint_zreport', 'save_shift_settings',
      'checkout_bill', 'refund_bill',
    ]))
  })

  it('scans every write function of the pre-pilot hardening', () => {
    const sql = readFileSync(new URL('migration-2026-10-25-pos-hardening.sql', SUPABASE), 'utf8')
    const names = functionBodies(sql).map((b) => b.name)
    expect(names).toEqual(expect.arrayContaining([
      'order_items_order_type', 'checkout_bill', 'void_order_item', 'pos_pin_attempt', 'set_my_pos_pin',
      'claim_print_job', 'finish_print_job', 'requeue_print_job',
    ]))
  })

  it('scans the menu back-office tidy-up: menu_product_list with photos, same grants, a STOP guard', () => {
    const sql = readFileSync(new URL('migration-2026-10-25-menu-list-photo.sql', SUPABASE), 'utf8')
    expect(functionBodies(sql).map((b) => b.name)).toEqual(['menu_product_list'])
    expect(sql).toMatch(/security definer set search_path = public, pg_temp as \$\$/)
    expect(sql).toMatch(/'image_path', p\.image_path, 'image_updated_at', p\.image_updated_at/)
    expect(sql).toMatch(/revoke all on function menu_product_list\(\) from public, anon;/)
    expect(sql).toMatch(/grant execute on function menu_product_list\(\) to authenticated;/)
    expect(sql).toMatch(/raise exception 'STOP: menu_products\.image_path or image_updated_at is missing/)
    expect(sql).toMatch(/notify pgrst, 'reload schema';\s*select '[^']+' as result;\s*$/)
  })

  it('scans the Feedme-layout front end additions: the guard, the bill summaries and pax, staff-only grants', () => {
    const sql = readFileSync(new URL('migration-2026-10-26-pos-frontend.sql', SUPABASE), 'utf8')
    expect(functionBodies(sql).map((b) => b.name)).toEqual(['dining_tables_guard', 'pos_open_bill_summaries', 'pos_set_bill_pax'])
    expect(sql).toMatch(/revoke all on function pos_open_bill_summaries\(uuid\) from public, anon;/)
    expect(sql).toMatch(/grant execute on function pos_open_bill_summaries\(uuid\) to authenticated;/)
    expect(sql).toMatch(/revoke all on function pos_set_bill_pax\(uuid, integer\) from public, anon;/)
    expect(sql).toMatch(/grant execute on function pos_set_bill_pax\(uuid, integer\) to authenticated;/)
    expect(sql).toMatch(/raise exception 'STOP: run migration-2026-10-25-pos-hardening\.sql first/)
    const verify = readFileSync(new URL('migration-2026-10-26-pos-frontend-verify.sql', SUPABASE), 'utf8')
    expect(verify).toMatch(/^begin;$/m)
    expect(verify).toMatch(/raise notice 'VERIFY OK';\s*end \$\$;\s*select 'VERIFY OK' as result;\s*rollback;\s*$/)
  })

  it('scans the outlets migration: its write functions, the STOP guard, a rolled-back verify', () => {
    const sql = readFileSync(new URL('migration-2026-10-29-pos-outlets.sql', SUPABASE), 'utf8')
    expect(functionBodies(sql).map((b) => b.name)).toEqual(expect.arrayContaining([
      'branches_outlet_guard', 'save_outlet', 'set_staff_outlet', 'clear_pos_pin', 'pos_next_bill_no',
      'save_receipt_settings', 'save_shift_settings', 'save_branch_catalogs', 'insert_test_print', 'dining_tables_guard',
    ]))
    expect(sql).toMatch(/raise exception 'STOP: run migration-2026-10-26-pos-frontend\.sql first/)
    expect(sql).toMatch(/notify pgrst, 'reload schema';\s*select '[^']+' as result;\s*$/)
    const verify = readFileSync(new URL('migration-2026-10-29-pos-outlets-verify.sql', SUPABASE), 'utf8')
    expect(verify).toMatch(/^begin;$/m)
    expect(verify).toMatch(/raise notice 'VERIFY OK';\s*end \$\$;\s*select 'VERIFY OK' as result;\s*rollback;\s*$/)
  })

  it('scans the devices migration: its write functions, service-role-only activation, a rolled-back verify', () => {
    const sql = readFileSync(new URL('migration-2026-10-29-pos-devices.sql', SUPABASE), 'utf8')
    expect(functionBodies(sql).map((b) => b.name)).toEqual(expect.arrayContaining([
      'pos_activation_request', 'pos_activation_poll', 'pos_activation_finish', 'pos_activation_unclaim',
      'pos_decide_device_request', 'pos_unpair_device', 'pos_set_print_tablet', 'pos_ctx', 'pos_print_branch', 'pos_start_session',
      'pos_end_session', 'save_lock_settings',
    ]))
    for (const f of ['pos_activation_request\\(text, text, text\\)', 'pos_activation_poll\\(text, text\\)',
                     'pos_activation_finish\\(uuid, uuid\\)', 'pos_activation_unclaim\\(uuid\\)']) {
      expect(sql).toMatch(new RegExp(`revoke all on function ${f} from public, anon, authenticated;`))
      expect(sql).toMatch(new RegExp(`grant execute on function ${f} to service_role;`))
    }
    expect(sql).toMatch(/raise exception 'STOP: run migration-2026-10-29-pos-outlets\.sql first/)
    expect(sql).toMatch(/notify pgrst, 'reload schema';\s*select '[^']+' as result;\s*$/)
    const verify = readFileSync(new URL('migration-2026-10-29-pos-devices-verify.sql', SUPABASE), 'utf8')
    expect(verify).toMatch(/^begin;$/m)
    expect(verify).toMatch(/raise notice 'VERIFY OK';\s*end \$\$;\s*select 'VERIFY OK' as result;\s*rollback;\s*$/)
  })

  it('scans the device-till migration: every re-created RPC, no auth.uid() actor left, a rolled-back verify', () => {
    const sql = readFileSync(new URL('migration-2026-10-29-pos-device-till.sql', SUPABASE), 'utf8')
    const names = functionBodies(sql).map((b) => b.name.replace(/^public\./, ''))
    expect(names).toEqual(expect.arrayContaining([
      'pos_ctx', 'pos_my_branch', 'pos_actor', 'pos_print_branch', 'pos_revoke_device', 'pos_unpair_device', 'pos_unpair_this_device',
      'place_counter_order', 'checkout_bill', 'close_shift', 'merge_bills', 'open_shift', 'record_cash_move', 'refund_bill',
      'void_bill', 'void_order_item', 'pos_pin_attempt', 'claim_print_job', 'finish_print_job', 'requeue_print_job', 'insert_test_print',
      'pos_session_branch', 'pos_shift_list', 'pos_shift_zreport', 'reprint_zreport',
    ]))
    for (const { name, body } of functionBodies(sql)) {
      if (/(checkout_bill|close_shift|merge_bills|open_shift|record_cash_move|refund_bill|void_bill|void_order_item|place_counter_order)$/i.test(name)) {
        expect(body, name).not.toMatch(/auth\.uid\(\)/)
      }
    }
    expect(sql).toMatch(/raise exception 'STOP: run migration-2026-10-29-pos-devices\.sql first/)
    expect(sql).toMatch(/notify pgrst, 'reload schema';\s*select '[^']+' as result;\s*$/)
    const verify = readFileSync(new URL('migration-2026-10-29-pos-device-till-verify.sql', SUPABASE), 'utf8')
    expect(verify).toMatch(/^begin;$/m)
    expect(verify).toMatch(/raise notice 'VERIFY OK';\s*end \$\$;\s*select 'VERIFY OK' as result;\s*rollback;\s*$/)
  })
  it('scans the menu picks: its functions, anon only on qr_picks, internal functions closed, a STOP guard', () => {
    const sql = readFileSync(new URL('migration-2026-11-17-menu-picks.sql', SUPABASE), 'utf8')
    expect(functionBodies(sql).map((b) => b.name)).toEqual([
      'pos_picks_rules', 'pos_compute_picks', 'pos_menu_picks_for', 'qr_picks', 'pos_menu_picks',
      'set_product_recommended', 'menu_product_extras',
    ])
    expect([...sql.matchAll(/grant execute on function (\w+)\([^)]*\) to [^;]*\b(anon|public)\b/g)].map((m) => m[1])).toEqual(['qr_picks'])
    expect(sql).toMatch(/revoke all on function pos_picks_rules\(\) from public, anon, authenticated;/)
    expect(sql).toMatch(/revoke all on function pos_compute_picks\(uuid\) from public, anon, authenticated;/)
    expect(sql).toMatch(/revoke all on function pos_menu_picks_for\(uuid\) from public, anon, authenticated;/)
    expect(sql).toMatch(/revoke all on menu_picks_cache from public, anon, authenticated;/)
    expect(sql).toMatch(/raise exception 'STOP: /)
    expect(sql).toMatch(/notify pgrst, 'reload schema';\s*select '[^']+' as result;\s*$/)
  })
  it('scans the sales reports: read-only reports for authenticated only, internal helpers closed, a STOP guard', () => {
    const sql = readFileSync(new URL('migration-2026-11-18-pos-reports.sql', SUPABASE), 'utf8')
    const internal = ['pos_business_day', 'pos_report_scope', 'pos_report_paid_bills', 'pos_report_cards', 'pos_report_lines']
    const reports = ['pos_report_sales', 'pos_report_products', 'pos_report_payments', 'pos_report_sst',
                     'pos_report_audit', 'pos_report_drawer', 'pos_report_ledger']
    const bodies = functionBodies(sql)
    expect(bodies.map((b) => b.name).sort()).toEqual([...internal, ...reports].sort())
    for (const { name, body } of bodies) {
      expect(body, name).not.toMatch(/\b(insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i)   // reports never write
    }
    for (const f of internal) {
      expect(sql).toMatch(new RegExp(`revoke all on function ${f}\\([^)]*\\) from public, anon, authenticated;`))
    }
    for (const f of reports) {
      expect(sql).toMatch(new RegExp(`revoke all on function ${f}\\(uuid\\[\\], date, date\\) from public, anon;`))
      expect(sql).toMatch(new RegExp(`grant execute on function ${f}\\(uuid\\[\\], date, date\\) to authenticated;`))
    }
    expect([...sql.matchAll(/grant execute on function (\w+)\(/g)].map((m) => m[1]).sort()).toEqual([...reports].sort())
    expect(sql).toMatch(/raise exception 'STOP: run migration-2026-11-17-menu-picks\.sql first/)
    expect(sql).toMatch(/create index if not exists pos_discount_log_branch_created_idx on pos_discount_log\(branch_id, created_at\);/)
    expect(sql).toMatch(/create index if not exists order_items_voided_idx on order_items\(voided_at\) where voided_at is not null;/)
    expect(sql).toMatch(/create or replace function pos_business_day\(p_at timestamptz\) returns date\s+language sql immutable set search_path/)
    expect(sql).toMatch(/notify pgrst, 'reload schema';\s*select '[^']+' as result;\s*$/)
    const verify = readFileSync(new URL('migration-2026-11-18-pos-reports-verify.sql', SUPABASE), 'utf8')
    expect(verify).toMatch(/^begin;$/m)
    expect(verify).toMatch(/select 'VERIFY OK' as result;\s*rollback;\s*$/)
  })
  it('scans the W4 migration: call numbers, receipt template and drawer; internal functions closed; a STOP guard', () => {
    const sql = readFileSync(new URL('migration-2026-11-22-pos-receipt-numbers.sql', SUPABASE), 'utf8')
    const internal: [string, string][] = [
      ['pos_next_call_no', 'uuid, text, timestamptz'], ['bills_call_no', ''], ['print_jobs_call_no', ''],
      ['pos_receipt_payload', 'uuid, boolean'], ['pos_part_receipt_payload', 'uuid'],
      ['pos_queue_drawer', 'uuid, text'], ['pos_pay_and_close', 'uuid, uuid, uuid, jsonb, jsonb, uuid'], ['pos_shift_report', 'uuid'],
    ]
    const granted: [string, string][] = [
      ['save_receipt_settings', 'uuid, jsonb'], ['pay_bill_part', 'uuid, uuid, integer, integer, jsonb, integer'],
      ['refund_bill', 'uuid, uuid, integer, uuid, text, uuid, text'], ['record_cash_move', 'uuid, text, integer, text, uuid, text'],
      ['pos_open_drawer', 'uuid, text'], ['pos_report_drawer', 'uuid[], date, date'],
      ['claim_print_job', 'uuid'], ['requeue_print_job', 'uuid'],                                    // C6
    ]
    const bodies = functionBodies(sql)
    expect(bodies.map((b) => b.name).sort()).toEqual([...internal, ...granted].map(([n]) => n).sort())
    for (const { name, body } of bodies) expect(body, name).not.toMatch(/auth\.uid\(\)/)
    for (const [f, args] of internal) {
      expect(sql).toContain(`revoke all on function ${f}(${args}) from public, anon, authenticated;`)
      expect(sql).not.toContain(`grant execute on function ${f}(`)
    }
    for (const [f, args] of granted) {
      expect(sql).toContain(`revoke all on function ${f}(${args}) from public, anon;`)
      expect(sql).toContain(`grant execute on function ${f}(${args}) to authenticated;`)
    }
    expect(sql).toMatch(/raise exception 'STOP: run migration-2026-11-18-pos-reports\.sql first/)
    expect(sql).toContain('create trigger bills_call_no before insert on bills for each row execute function bills_call_no();')
    expect(sql).toContain('create trigger print_jobs_call_no before insert on print_jobs for each row execute function print_jobs_call_no();')
    expect(sql).toContain('alter table print_jobs add column if not exists seq bigint generated by default as identity;')
    expect(sql).toContain("check (action in ('void_item', 'void_bill', 'refund', 'discount', 'open_drawer'))")
    expect(sql).toContain('alter table pos_drawer_opens enable row level security;')
    expect(sql).toContain('revoke all on pos_drawer_opens from public, anon, authenticated;')
    // the kick is queued before the receipt / part receipt / refund slip in each money function
    const body = (n: string) => bodies.find((b) => b.name === n)?.body ?? ''
    expect(body('pos_pay_and_close').indexOf('pos_queue_drawer')).toBeLessThan(body('pos_pay_and_close').indexOf('pos_queue_receipt'))
    expect(body('pay_bill_part').indexOf('pos_queue_drawer')).toBeLessThan(body('pay_bill_part').indexOf('pos_queue_part_receipt'))
    expect(body('refund_bill').indexOf('pos_queue_drawer')).toBeLessThan(body('refund_bill').indexOf('pos_refund_slip_payload'))
    for (const f of ['pos_pay_and_close', 'pay_bill_part', 'refund_bill', 'record_cash_move', 'pos_open_drawer']) {
      expect(body(f), f).toContain('pos_queue_drawer(')
    }
    // C6: the server refuses a repeated or a late drawer kick (the bodies have their strings emptied: read the file)
    const c6 = (n: string) => sql.slice(sql.indexOf(`create or replace function ${n}(`)).split('$function$;')[0]
    expect(c6('requeue_print_job')).toContain("payload->>'kind' = 'drawer'")
    expect(c6('requeue_print_job')).toContain('A cash drawer kick cannot be sent again.')
    expect(c6('claim_print_job')).toContain("interval '2 minutes'")
    expect(c6('claim_print_job')).toContain('Too late to open the drawer.')
    expect(sql).not.toMatch(/\bor\s+\(m->>'priceDeltaSen'\)::numeric/)                // the free add-on filter casts only a number
    expect(sql).toMatch(/notify pgrst, 'reload schema';\s*select '[^']+' as result;\s*$/)
    const verify = readFileSync(new URL('migration-2026-11-22-pos-receipt-numbers-verify.sql', SUPABASE), 'utf8')
    expect(verify).toMatch(/^begin;$/m)
    expect(verify).toMatch(/select 'VERIFY OK' as result;\s*rollback;\s*$/)
  })
  it('scans the W7 migration: last-order time, takeaway lines, children and Serve; grants like their neighbours; a STOP guard', () => {
    const sql = readFileSync(new URL('migration-2026-11-22-pos-feedme-habits.sql', SUPABASE), 'utf8')
    const internal: [string, string][] = [
      ['pos_orders_open', 'uuid, timestamptz'], ['pos_orders_closed_message', 'uuid'], ['order_items_order_type', ''],
      ['pos_insert_order', 'uuid, uuid, text, integer, text, uuid, jsonb, uuid, uuid'], ['pos_queue_void_tickets', 'uuid[]'],
      ['pos_receipt_payload', 'uuid, boolean'], ['pos_part_receipt_payload', 'uuid'], ['pos_move_units', 'jsonb, uuid'],
    ]
    const staff: [string, string][] = [
      ['save_receipt_settings', 'uuid, jsonb'], ['place_counter_order', 'uuid, text, integer, jsonb, uuid, uuid, uuid, integer'],
      ['pos_set_bill_pax', 'uuid, integer, integer'], ['open_table', 'uuid, integer, integer'], ['set_items_served', 'uuid[], boolean'],
    ]
    const guests: [string, string][] = [
      ['qr_menu', 'text'], ['qr_cart_put', 'text, jsonb, jsonb, uuid'], ['qr_cart_send', 'text, integer, text, uuid[], uuid'],
    ]
    const bodies = functionBodies(sql)
    expect(bodies.map((b) => b.name).sort()).toEqual([...internal, ...staff, ...guests].map(([n]) => n).sort())
    for (const { name, body } of bodies) expect(body, name).not.toMatch(/auth\.uid\(\)/)
    for (const [f, args] of internal) {
      expect(sql).toContain(`revoke all on function ${f}(${args}) from public, anon, authenticated;`)
      expect(sql).not.toContain(`grant execute on function ${f}(`)
    }
    for (const [f, args] of staff) {
      expect(sql).toContain(`revoke all on function ${f}(${args}) from public, anon;`)
      expect(sql).toContain(`grant execute on function ${f}(${args}) to authenticated;`)
    }
    for (const [f, args] of guests) {
      expect(sql).toContain(`revoke all on function ${f}(${args}) from public;`)
      expect(sql).toContain(`grant execute on function ${f}(${args}) to anon, authenticated;`)
    }
    expect(sql).toMatch(/raise exception 'STOP: run migration-2026-11-22-pos-receipt-numbers\.sql and migration-2026-11-22-qr-table-cart\.sql first/)
    const body = (n: string) => bodies.find((b) => b.name === n)?.body ?? ''
    // the window refuses QR in the add and send RPCs, and in pos_insert_order (place_table_order goes through it)
    for (const f of ['qr_cart_put', 'qr_cart_send', 'pos_insert_order']) expect(body(f), f).toContain('pos_orders_open(')
    expect(body('pos_insert_order')).toContain('guest_label')                            // still the QR table cart's version
    expect(body('order_items_order_type')).toContain("if new.order_type = '' then return new; end if;")   // bodies have their strings emptied
    // H3: the old signatures go first, so PostgREST has one candidate each
    for (const d of ['place_counter_order(uuid, text, integer, jsonb, uuid, uuid, uuid)', 'pos_set_bill_pax(uuid, integer)', 'open_table(uuid, integer)']) {
      expect(sql).toContain(`drop function if exists ${d};`)
    }
    expect(sql).toContain('alter table bills add column if not exists pax_children integer;')
    expect(sql).toContain('alter table order_items add column if not exists served_at timestamptz;')
    expect(body('set_items_served')).toContain('pos_ctx()')
    // least() skips a null: every clamp of p_children sits inside a case that handles null first
    expect(sql).not.toMatch(/least\(p_children, p_pax\)(?! end)/)
    expect(sql).toMatch(/notify pgrst, 'reload schema';\s*select '[^']+' as result;\s*$/)
    const verify = readFileSync(new URL('migration-2026-11-22-pos-feedme-habits-verify.sql', SUPABASE), 'utf8')
    expect(verify).toMatch(/^begin;$/m)
    expect(verify).toMatch(/select 'VERIFY OK' as result;\s*rollback;\s*$/)
  })
  it('scans the D migration: pos_agent_whoami for print agents only, granted like its neighbours, a STOP guard', () => {
    const sql = readFileSync(new URL('migration-2026-11-22-pos-agent-pairing.sql', SUPABASE), 'utf8')
    const bodies = functionBodies(sql)
    expect(bodies.map((b) => b.name)).toEqual(['pos_agent_whoami'])
    const body = bodies[0].body
    expect(body).toContain("v_dev.kind <> ''")                       // strings are emptied: kind <> 'print_agent'
    expect(body).toContain('v_dev.revoked_at is not null')
    expect(body).toContain("current_setting('')::boolean")           // no stamp in a read-only call
    expect(sql).toContain('revoke all on function pos_agent_whoami() from public, anon;')
    expect(sql).toContain('grant execute on function pos_agent_whoami() to authenticated;')
    expect(sql).toMatch(/raise exception 'STOP: run migration-2026-10-30-pos-app\.sql first/)
    expect(sql).toMatch(/notify pgrst, 'reload schema';\s*select 'pos agent pairing applied' as result;\s*$/)
    const verify = readFileSync(new URL('migration-2026-11-22-pos-agent-pairing-verify.sql', SUPABASE), 'utf8')
    expect(verify).toMatch(/^begin;$/m)
    expect(verify).toMatch(/select 'VERIFY OK' as result;\s*rollback;\s*$/)
  })
})

describe('the discount RPCs act as the POS session, never auth.uid()', () => {
  it('migration-2026-10-30-pos-discounts.sql', () => {
    const sql = readFileSync(new URL('migration-2026-10-30-pos-discounts.sql', SUPABASE), 'utf8')
    const bodies = functionBodies(sql)
    expect(bodies.map((b) => b.name)).toEqual(expect.arrayContaining([
      'set_item_discount', 'clear_item_discount', 'set_bill_discount', 'clear_bill_discount', 'merge_bills',
    ]))
    for (const { name, body } of bodies) {
      if (/(set_item_discount|clear_item_discount|set_bill_discount|clear_bill_discount|merge_bills)$/i.test(name)) {
        expect(body, name).not.toMatch(/auth\.uid\(\)/)
      }
    }
  })
})
