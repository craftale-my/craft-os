// Edge Function: provision-staff
//
// 建员工账号唯一的服务端入口。存在的理由:创建 auth 用户必须用 service_role key,
// 而这个 key 一旦出现在前端就会被打进构建产物、任何访客都能提取,从而绕过全部 RLS。
// 把它关在这里,前端只带自己的 JWT 调用。
//
// 授权判断也一并移到服务端:调用者必须拥有 manage_staff。前端怎么改都绕不过去。
//
// 两个动作:
//   create  — 经理在 Directory 里手工加人
//   approve — 审批一条 registration_request
//
// 部署:
//   supabase functions deploy provision-staff
// 不需要手工设置任何密钥 —— SUPABASE_URL 与 SUPABASE_SECRET_KEYS 由平台自动
// 注入每个 Edge Function(见控制台 Edge Functions → Secrets 的 Default secrets)。

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

type SystemRole = 'owner' | 'admin' | 'hr' | 'manager' | 'supervisor' | 'staff'
type Rank = 'trainee' | 'junior' | 'senior' | 'supervisor' | 'manager'

/**
 * manage_staff 的内置默认值,必须与 src/shared/types/index.ts 的
 * DEFAULT_SYSTEM_ROLE_CAPS 保持一致。这里只复制了本函数需要的那一个能力,
 * 不是整张表 —— 复制越多,漂移的面越大。
 *
 * 长期方向是把这份判断下沉成一个 SQL security definer 函数
 * current_has_cap(text),让 Edge Function 与 RLS 策略共用同一个真值来源。
 */
const MANAGE_STAFF_DEFAULT: Record<SystemRole, boolean> = {
  owner: true, admin: true, hr: true, manager: true, supervisor: true, staff: false,
}

/** 与前端 rankToSystemRole() 同构。 */
function rankToSystemRole(rank: Rank | null | undefined): SystemRole {
  if (rank === 'manager') return 'manager'
  if (rank === 'supervisor') return 'supervisor'
  return 'staff'
}

/**
 * 解析调用者身份并判定是否可以建号。
 * 沿用前端的合并语义:system_role_permissions 的 jsonb 覆盖在代码默认值之上,
 * 缺 key 时回落到默认 —— 判断规则必须和前端一致,否则会出现"界面允许、后端拒绝"。
 */
async function authorize(
  admin: SupabaseClient,
  authHeader: string | null,
): Promise<
  | { ok: true; callerId: string; callerRole: SystemRole; callerRank: Rank | null }
  | { ok: false; status: number; error: string }
> {
  if (!authHeader) return { ok: false, status: 401, error: 'Missing Authorization header' }

  const token = authHeader.replace(/^Bearer\s+/i, '')
  const { data: userData, error: userErr } = await admin.auth.getUser(token)
  if (userErr || !userData.user) return { ok: false, status: 401, error: 'Invalid session' }

  const callerId = userData.user.id
  const { data: caller } = await admin
    .from('staff')
    .select('system_role, rank, status')
    .eq('id', callerId)
    .maybeSingle()

  if (!caller) return { ok: false, status: 403, error: 'No staff profile for this account' }
  if (caller.status === 'resigned') return { ok: false, status: 403, error: 'Account is deactivated' }

  const role: SystemRole = caller.system_role ?? rankToSystemRole(caller.rank)

  const { data: overrideRow } = await admin
    .from('system_role_permissions')
    .select('permissions')
    .eq('system_role', role)
    .maybeSingle()

  const override = overrideRow?.permissions?.manage_staff
  const allowed = typeof override === 'boolean' ? override : MANAGE_STAFF_DEFAULT[role]

  if (!allowed) return { ok: false, status: 403, error: 'You do not have permission to create staff accounts' }
  return { ok: true, callerId, callerRole: role, callerRank: (caller.rank ?? null) as Rank | null }
}

/** 与 SQL staff_guard_authority_update() 的 manager-tier 同一条判断:
 *  rank 'manager',或 system_role ∈ manager/admin/owner。 */
function isManagerTier(role: SystemRole, rank: Rank | null): boolean {
  return rank === 'manager' || role === 'manager' || role === 'admin' || role === 'owner'
}

/** 非 manager-tier(supervisor、hr)只能建这三个 rank。 */
const LOW_RANKS: readonly Rank[] = ['trainee', 'junior', 'senior']

/**
 * 岗位自动匹配 + 技能清单初始化。尽力而为:匹配不到唯一岗位就先不设,
 * 由经理事后手动指派 —— 这与改造前的行为一致,不要收紧成硬失败。
 */
async function assignJobTitle(admin: SupabaseClient, staffId: string, rank: Rank, dept: string | null) {
  if (!dept) return
  const { data: roleRows } = await admin
    .from('roles')
    .select('id')
    .eq('rank', rank)
    .eq('department', dept)
    .eq('is_active', true)
  if (roleRows && roleRows.length === 1) {
    await admin.from('staff').update({ job_title_id: roleRows[0].id }).eq('id', staffId)
    await admin.rpc('initialize_staff_skills', { p_staff_id: staffId })
  }
}

const today = () => new Date().toISOString().split('T')[0]

/**
 * 取一把能绕过 RLS 的服务端密钥。
 *
 * 优先用平台自动注入的 SUPABASE_SECRET_KEYS —— 它是经 JWT Signing Keys 签发的
 * 新版 secret key,可以单独轮换,且在 legacy JWT 体系被停用后依然有效。
 * 其形状官方文档描述为 "JSON dictionary",但没有承诺具体键名,所以这里对
 * 对象/数组/裸字符串三种形态都做兜底,只认 sb_secret_ 前缀。
 *
 * 回退到 SUPABASE_SERVICE_ROLE_KEY 只是过渡:它已被标记 DEPRECATED,
 * 且会随 legacy API keys 一起失效。
 */
function resolveSecretKey(): string | null {
  const raw = Deno.env.get('SUPABASE_SECRET_KEYS')
  if (raw) {
    const looksRight = (v: unknown): v is string =>
      typeof v === 'string' && v.startsWith('sb_secret_')
    if (looksRight(raw)) return raw
    try {
      const parsed = JSON.parse(raw)
      if (looksRight(parsed)) return parsed
      const candidates = Array.isArray(parsed) ? parsed : Object.values(parsed ?? {})
      for (const c of candidates) {
        if (looksRight(c)) return c
        // 元素也可能是 { name, api_key } 之类的对象
        if (c && typeof c === 'object') {
          for (const v of Object.values(c)) if (looksRight(v)) return v
        }
      }
    } catch {
      // 不是 JSON,继续往下回退
    }
  }
  return Deno.env.get('SERVICE_ROLE_KEY')
    ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    ?? null
}

/** 与前端 DEPT_STORE(src/shared/types/index.ts)同构:把老申请里残留的
 *  部门展示字串转回 slug;新申请本来就是 slug,原样返回。 */
const DEPT_STORE: Record<string, string> = {
  'Barista (Full Time)': 'barista',
  'Service Crew':        'service crew',
  'Bakery':              'bakery',
  'Kitchen':             'kitchen',
  'Other':               'other',
}
function normaliseDepartment(dept: string | null): string | null {
  if (!dept) return null
  return DEPT_STORE[dept] ?? dept
}

/**
 * 把仍是 pending 的申请标成 approved,并清掉 phone(号码此刻已在 staff_private,
 * 而 registration_requests 对 supervisor 可读,supervisor 不是电话的读者)。
 * 返回错误字串;成功返回 null。0 行 = 申请已不是 pending(并发审批),也算失败。
 */
async function markApproved(admin: SupabaseClient, requestId: string, callerId: string): Promise<string | null> {
  const { data, error } = await admin.from('registration_requests').update({
    status: 'approved',
    reviewed_by: callerId,
    reviewed_at: new Date().toISOString(),
    phone: null,
  }).eq('id', requestId).eq('status', 'pending').select('id')
  if (error) return `The account is ready, but the request could not be marked approved: ${error.message}`
  if (!data || data.length === 0) return 'The account is ready, but the request was no longer pending and was not marked approved.'
  return null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const serviceKey = resolveSecretKey()
  const url = Deno.env.get('SUPABASE_URL')
  if (!serviceKey || !url) {
    return json({ error: 'Function is not configured: no secret key available' }, 500)
  }

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const auth = await authorize(admin, req.headers.get('Authorization'))
  if (!auth.ok) return json({ error: auth.error }, auth.status)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Body must be JSON' }, 400)
  }

  // ── create ────────────────────────────────────────────────────────────────
  if (body.action === 'create') {
    const name = String(body.name ?? '').trim()
    const email = String(body.email ?? '').trim()
    const password = String(body.password ?? '')
    const rank = (body.rank ?? 'trainee') as Rank
    const branch = (body.branch as string) || null
    const department = (body.department as string) || null

    if (!name || !email || password.length < 6) {
      return json({ error: 'Name, email, and a 6+ character password are required.' }, 400)
    }

    // manage_staff 只说明"能建号",不说明"能建多高"。supervisor / hr 也有
    // manage_staff,若不拦,就能直接建一个 rank manager(连带 system_role
    // manager)的帐号。真正的边界是 DB 的 staff_guard_authority_update()
    // (migration-2026-10-23-staff-authority-guard.sql);但本函数用 service
    // role 写入,那个 trigger 对 auth.uid() 为空的调用一律放行,所以这里必须
    // 自己拦,并给出清楚的错误。
    if (!isManagerTier(auth.callerRole, auth.callerRank) && !LOW_RANKS.includes(rank)) {
      return json({ error: 'Only a manager can create staff at supervisor rank or above.' }, 403)
    }

    const { data: authData, error: authErr } = await admin.auth.admin.createUser({
      email, password, email_confirm: true,
    })
    if (authErr || !authData.user) {
      return json({ error: authErr?.message ?? 'Failed to create auth user' }, 400)
    }

    const { error: profileErr } = await admin.from('staff').insert({
      id: authData.user.id,
      name,
      email,
      rank,
      // system_role 必须显式写入。列的默认值是 'staff',所以漏写会让一个
      // supervisor 拿到 staff 的能力集 —— 权限矩阵从此与实际不符。
      system_role: rankToSystemRole(rank),
      branch,
      department,
      onboarding_completed: rank === 'manager',
      joined_at: today(),
    })
    if (profileErr) {
      // 回滚刚建的 auth 用户,否则会留下一个孤儿账号,让这个邮箱再也建不了。
      await admin.auth.admin.deleteUser(authData.user.id)
      return json({ error: profileErr.message }, 400)
    }

    await assignJobTitle(admin, authData.user.id, rank, department)
    return json({ ok: true, staffId: authData.user.id })
  }

  // ── approve ───────────────────────────────────────────────────────────────
  //
  // 安全要点(2026-10-23 final review):以前 requestId / email 全由前端传入,
  // 申请行从不读取;若该 email 已有 auth 用户,就把它的密码重设成调用者给的值,
  // 再把 staff 行 upsert 回 trainee/staff —— 任何有 manage_staff 的 supervisor/hr
  // 都能借 service role 接管或降级任何帐号(包括 owner),DB guard 也拦不住。
  // 现在:
  //   - 申请行由服务端按 requestId 读取,必须存在且 status = 'pending';
  //   - email / 姓名 / 电话一律取自申请行;body 的 email 若与申请不符就拒绝;
  //   - 只有"auth 用户存在但没有 staff 行"(真正被中断的审批)才接管并重设密码;
  //   - staff 行已存在:绝不重设密码、绝不覆盖 staff 行,只在 staff_private 电话
  //     为空时补上,标记申请已批准,并回传 alreadyExisted 让前端说明;
  //   - staff 行只用 insert 建立,不 upsert。
  if (body.action === 'approve') {
    const requestId = String(body.requestId ?? '')
    const password = String(body.password ?? '')
    if (!requestId || password.length < 6) {
      return json({ error: 'Request id and a 6+ character password are required.' }, 400)
    }

    const { data: reg, error: regErr } = await admin.from('registration_requests')
      .select('id, full_name, email, phone, branch, department, employment_type, status')
      .eq('id', requestId)
      .maybeSingle()
    if (regErr) return json({ error: `Could not load the registration request: ${regErr.message}` }, 500)
    if (!reg) return json({ error: 'Registration request not found.' }, 404)
    if (reg.status !== 'pending') {
      return json({ error: `This registration request is already ${reg.status}.` }, 409)
    }

    const email = String(reg.email ?? '').trim()
    const fullName = String(reg.full_name ?? '').trim()
    if (!email || !fullName) {
      return json({ error: 'The registration request has no email or name.' }, 400)
    }
    const bodyEmail = String(body.email ?? '').trim()
    if (bodyEmail && bodyEmail.toLowerCase() !== email.toLowerCase()) {
      return json({ error: 'The email does not match the registration request.' }, 400)
    }
    const phone: string | null = (reg.phone as string | null) || null
    // 非敏感栏位:申请行有就用申请行,没有才用 body。
    const branch = (reg.branch as string | null) || (body.branch as string) || null
    const department = normaliseDepartment(reg.department as string | null) || (body.department as string) || null
    const employmentType = (reg.employment_type as string | null) || (body.employmentType as string) || null

    // 建 auth 用户 —— 或者接管一个被中断的审批遗留下来的用户(auth 用户在、
    // staff 行不在),否则半途失败过一次的邮箱会永远卡在 "already been registered" 上。
    let userId: string
    let createdNow = false
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email, password, email_confirm: true,
    })
    if (created?.user) {
      userId = created.user.id
      createdNow = true
    } else if (createErr && /already/i.test(createErr.message)) {
      const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
      const existing = list?.users.find((u) => u.email?.toLowerCase() === email.toLowerCase())
      if (!existing) return json({ error: createErr.message }, 400)
      userId = existing.id

      const { data: staffRow, error: staffErr } = await admin.from('staff')
        .select('id').eq('id', userId).maybeSingle()
      if (staffErr) return json({ error: `Could not check for an existing staff profile: ${staffErr.message}` }, 500)

      if (staffRow) {
        // 已是现有员工:不动密码、不动 staff 行。只补空着的电话,然后结案。
        if (phone) {
          const { error: privErr } = await admin.from('staff_private')
            .update({ contact_number: phone, updated_at: new Date().toISOString() })
            .eq('staff_id', userId)
            .is('contact_number', null)
          if (privErr) {
            return json({ error: `The account already exists, but the phone number was not saved: ${privErr.message}` }, 400)
          }
        }
        const marked = await markApproved(admin, requestId, auth.callerId)
        if (marked) return json({ error: marked }, 500)
        return json({
          ok: true,
          staffId: userId,
          alreadyExisted: true,
          message: 'An account for this email already existed. Its password and profile were not changed; the request is marked approved.',
        })
      }

      // 真正被中断的审批:重设密码,让交给经理的那串临时密码确实可用。
      const { error: pwErr } = await admin.auth.admin.updateUserById(userId, { password, email_confirm: true })
      if (pwErr) return json({ error: pwErr.message }, 400)
    } else {
      return json({ error: createErr?.message ?? 'Failed to create user' }, 400)
    }

    // insert,不是 upsert:任何情况下都不覆盖一行已存在的 staff。
    const { error: profileErr } = await admin.from('staff').insert({
      id: userId,
      name: fullName,
      email,
      rank: 'trainee',
      system_role: 'staff',
      branch,
      department,
      employment_type: employmentType,
      onboarding_completed: false,
      joined_at: today(),
    })
    if (profileErr) {
      if (createdNow) await admin.auth.admin.deleteUser(userId)
      return json({ error: profileErr.message }, 400)
    }

    // 电话属于 staff_private(本人 + hr/manager/admin/owner 可读),不再写进 staff。
    // staff_private 那一行由 staff insert trigger 保证存在;这里 upsert 只为写入电话,
    // 所以没有电话就整段跳过。失败时不回滚 auth/staff,也不把申请标成 approved
    // —— 帐号本身是好的,申请留在 pending;经理再按一次审批会走上面的
    // "已存在"分支,只补空着的电话并结案,不会重设密码。
    if (phone) {
      const { error: privErr } = await admin.from('staff_private')
        .upsert({ staff_id: userId, contact_number: phone }, { onConflict: 'staff_id' })
      if (privErr) {
        return json({ error: `Staff created, but the phone number was not saved: ${privErr.message}` }, 400)
      }
    }

    await assignJobTitle(admin, userId, 'trainee', department)

    const marked = await markApproved(admin, requestId, auth.callerId)
    if (marked) return json({ error: marked }, 500)

    return json({ ok: true, staffId: userId })
  }

  return json({ error: `Unknown action: ${String(body.action)}` }, 400)
})
