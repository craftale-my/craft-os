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

/** 与 SQL can_read_staff_private() 同一条判断:rank 'manager',或 system_role
 *  ∈ hr/manager/admin/owner。本函数用 service role 写 staff_private,会绕过 RLS,
 *  所以"写别人的私人栏位"之前必须自己先问这一句。 */
function canReadPrivate(role: SystemRole, rank: Rank | null): boolean {
  return rank === 'manager' || role === 'hr' || role === 'manager' || role === 'admin' || role === 'owner'
}

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
 * staff.branch 文字 → branches.id,与 branch_id 一起写入。规则同 DB 的
 * branch_id_for_label()(migration-2026-10-29-staff-branch-id-sync.sql):
 * 文字本身或 " (" 之前的部分等于分店名(不分大小写),active 优先;
 * "Other" / 空 / 不认识 → null。查询失败返回 undefined,不写 branch_id,
 * 交给 trigger staff_sync_branch_id_trg 补。
 */
async function branchIdForLabel(admin: SupabaseClient, label: string | null): Promise<string | null | undefined> {
  const key = (label ?? '').split(' (')[0].trim().toLowerCase()
  if (!key) return null
  const { data, error } = await admin.from('branches').select('id, name, is_active').order('created_at')
  if (error || !data) return undefined
  const hits = (data as { id: string; name: string; is_active: boolean | null }[])
    .filter(b => b.name.trim().toLowerCase() === key)
  return (hits.find(b => b.is_active !== false) ?? hits[0])?.id ?? null
}

/**
 * 把由本次调用认领(reviewed_at = claimAt)、仍是 pending 的申请标成 approved,
 * 并清掉 phone(registration_requests 对 supervisor 可读,supervisor 不是电话的读者)。
 * 成功返回 null;失败返回 { race, text }:text 是可接在句子后面的片段,
 * race = 0 行,即申请在审批途中被别人 reject 或处理掉了(approve/reject 竞态)。
 */
async function markApproved(
  admin: SupabaseClient, requestId: string, callerId: string, claimAt: string,
): Promise<{ race: boolean; text: string } | null> {
  const { data, error } = await admin.from('registration_requests').update({
    status: 'approved',
    reviewed_by: callerId,
    reviewed_at: new Date().toISOString(),
    phone: null,
  }).eq('id', requestId).eq('status', 'pending').eq('reviewed_at', claimAt).select('id')
  if (error) return { race: false, text: `the request could not be marked approved: ${error.message}` }
  if (!data || data.length === 0) {
    return {
      race: true,
      text: 'the request was rejected or decided by someone else while this approval was running (an approve/reject race), so it was not marked approved.',
    }
  }
  return null
}

/** 认领超过这个时间仍未结案,视为调用中途崩溃,允许别人重新认领。 */
const CLAIM_STALE_MS = 5 * 60 * 1000

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

    const branchId = await branchIdForLabel(admin, branch)
    const { error: profileErr } = await admin.from('staff').insert({
      id: authData.user.id,
      name,
      email,
      rank,
      // system_role 必须显式写入。列的默认值是 'staff',所以漏写会让一个
      // supervisor 拿到 staff 的能力集 —— 权限矩阵从此与实际不符。
      system_role: rankToSystemRole(rank),
      branch,
      ...(branchId !== undefined && { branch_id: branchId }),
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
  //   1. 先认领申请:条件式 update(pending 且未被认领或认领已过期),0 行就 409。
  //      之后任何"什么都没建成"的失败都会释放认领,让申请可以重试。
  //   2. email / 姓名 / 电话一律取自申请行;body 的 email 若与申请不符就拒绝。
  //   3. 新 auth 用户带 app_metadata.registration_request_id。email 已有 auth 用户时:
  //      - 已有 staff 行:绝不重设密码、绝不覆盖 staff 行;电话只在调用者本身是
  //        私人栏位读者(can_read_staff_private),或这个帐号正是本申请建出、
  //        还从未登入过时,才补进空着的 staff_private;
  //        标记申请已批准,回传 alreadyExisted;
  //      - 没有 staff 行:只有当它是"本申请"被中断的审批留下的(app_metadata
  //        对得上 requestId)才接管并重设密码;否则是别的登入(非员工、日后 POS /
  //        顾客帐号),一律 409,绝不接管。
  //   4. staff 行只用 insert 建立,不 upsert。
  if (body.action === 'approve') {
    const requestId = String(body.requestId ?? '')
    const password = String(body.password ?? '')
    if (!requestId || password.length < 6) {
      return json({ error: 'Request id and a 6+ character password are required.' }, 400)
    }

    // 1. 认领。并发的两次审批只有一个能认领成功。
    const claimAt = new Date().toISOString()
    const staleBefore = new Date(Date.now() - CLAIM_STALE_MS).toISOString()
    const { data: claimed, error: claimErr } = await admin.from('registration_requests')
      .update({ reviewed_by: auth.callerId, reviewed_at: claimAt })
      .eq('id', requestId)
      .eq('status', 'pending')
      .or(`reviewed_at.is.null,reviewed_at.lt."${staleBefore}"`)
      .select('id, full_name, email, phone, branch, department, employment_type')
    if (claimErr) return json({ error: `Could not load the registration request: ${claimErr.message}` }, 500)
    if (!claimed || claimed.length === 0) {
      const { data: row } = await admin.from('registration_requests')
        .select('status').eq('id', requestId).maybeSingle()
      if (!row) return json({ error: 'Registration request not found.' }, 404)
      if (row.status !== 'pending') {
        return json({ error: `This registration request is already ${row.status}.` }, 409)
      }
      return json({ error: 'This request is already being processed or was decided. If it is still pending in a few minutes, try again.' }, 409)
    }
    const reg = claimed[0]
    // 写进 / 比对 app_metadata 一律用资料库那一行的 id,不用 body 原样传来的字串。
    const regId = String(reg.id)

    // 释放本次的认领(只动自己认领、仍 pending 的那一行)。尽力而为。
    const release = async () => {
      await admin.from('registration_requests')
        .update({ reviewed_by: null, reviewed_at: null })
        .eq('id', requestId).eq('status', 'pending').eq('reviewed_at', claimAt)
    }
    const fail = async (status: number, error: string, extra: Record<string, unknown> = {}) => {
      await release()
      return json({ error, ...extra }, status)
    }

    // 2. 资料一律取自申请行。
    const email = String(reg.email ?? '').trim()
    const fullName = String(reg.full_name ?? '').trim()
    if (!email || !fullName) return fail(400, 'The registration request has no email or name.')
    const bodyEmail = String(body.email ?? '').trim()
    if (bodyEmail && bodyEmail.toLowerCase() !== email.toLowerCase()) {
      return fail(400, 'The email does not match the registration request.')
    }
    const phone: string | null = (reg.phone as string | null) || null
    // 非敏感栏位:申请行有就用申请行,没有才用 body。
    const branch = (reg.branch as string | null) || (body.branch as string) || null
    const department = normaliseDepartment(reg.department as string | null) || (body.department as string) || null
    const employmentType = (reg.employment_type as string | null) || (body.employmentType as string) || null

    // 3. auth 用户。
    let userId: string
    let createdNow = false
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email, password, email_confirm: true,
      app_metadata: { provisioned_by: 'provision-staff', registration_request_id: regId },
    })
    if (created?.user) {
      userId = created.user.id
      createdNow = true
    } else if (createErr && /already/i.test(createErr.message)) {
      // 按 email 直接查 auth.users(RPC 只给 service_role),不再只看 listUsers 第一页:
      // 共用后端加入 POS / 顾客登入后会超过 1000 人。
      const { data: foundId, error: lookupErr } = await admin.rpc('auth_user_id_by_email', { p_email: email })
      if (lookupErr) return fail(500, `Could not look up the existing login: ${lookupErr.message}`)
      if (!foundId) return fail(400, createErr.message)
      const { data: found, error: getErr } = await admin.auth.admin.getUserById(String(foundId))
      if (getErr || !found?.user) return fail(500, `Could not load the existing login: ${getErr?.message ?? 'not found'}`)
      const existing = found.user
      userId = existing.id

      const { data: staffRow, error: staffErr } = await admin.from('staff')
        .select('id').eq('id', userId).maybeSingle()
      if (staffErr) return fail(500, `Could not check for an existing staff profile: ${staffErr.message}`)

      const meta = (existing.app_metadata ?? {}) as Record<string, unknown>
      const fromThisRequest = meta.registration_request_id === regId

      if (staffRow) {
        // 已是现有员工:不动密码、不动 staff 行。
        // 电话:读者可补;或者这个帐号正是本申请建出、从未登入过的那一个
        // (前一次审批建好帐号、电话写失败,supervisor 按"再审批一次"来补)。
        // 只看 metadata 不够:supervisor 能把一张旧的已批准申请改回 pending、改掉
        // 电话再审批,所以还要求从未登入。两种情况都只补空着的 contact_number。
        const ownFreshAccount = fromThisRequest && !existing.last_sign_in_at
        let phoneNote = ''
        if (phone) {
          if (canReadPrivate(auth.callerRole, auth.callerRank) || ownFreshAccount) {
            const { error: privErr } = await admin.from('staff_private')
              .update({ contact_number: phone, updated_at: new Date().toISOString() })
              .eq('staff_id', userId)
              .is('contact_number', null)
            if (privErr) {
              return fail(400, `The account already exists, but the phone number was not saved: ${privErr.message}`)
            }
          } else {
            phoneNote = ' The phone number on the request was not copied and has been removed from the request: only HR or a manager can add personal details. Ask HR or the staff member to add it.'
          }
        }
        const earlierAttemptNote = fromThisRequest
          ? ' This request\'s account was created by an earlier approval attempt; if its password was not handed over, ask an admin to reset it.'
          : ''
        const marked = await markApproved(admin, requestId, auth.callerId, claimAt)
        if (marked) return fail(500, `An account for this email already existed (its password and profile were not changed), but ${marked.text}`)
        return json({
          ok: true,
          staffId: userId,
          alreadyExisted: true,
          message: 'An account for this email already existed. Its password and profile were not changed; the request is marked approved.'
            + earlierAttemptNote + phoneNote,
        })
      }

      // 没有 staff 行:只接管"本申请"被中断的审批留下的用户。
      if (!fromThisRequest) {
        return fail(409, 'This email belongs to an existing login that is not a staff account. Ask an admin.')
      }
      const { error: pwErr } = await admin.auth.admin.updateUserById(userId, { password, email_confirm: true })
      if (pwErr) return fail(400, pwErr.message)
    } else {
      return fail(400, createErr?.message ?? 'Failed to create user')
    }

    // 4. staff 行:insert,不是 upsert,任何情况下都不覆盖一行已存在的 staff。
    const branchId = await branchIdForLabel(admin, branch)
    const { error: profileErr } = await admin.from('staff').insert({
      id: userId,
      name: fullName,
      email,
      rank: 'trainee',
      system_role: 'staff',
      branch,
      ...(branchId !== undefined && { branch_id: branchId }),
      department,
      employment_type: employmentType,
      onboarding_completed: false,
      joined_at: today(),
    })
    if (profileErr) {
      if (createdNow) await admin.auth.admin.deleteUser(userId)
      return fail(400, profileErr.message)
    }

    // 从这里开始帐号已建好,临时密码(经理画面上那一串)已生效。之后的失败
    // 都要明说"帐号已建好,把密码交给对方",否则经理会以为什么都没发生。
    await assignJobTitle(admin, userId, 'trainee', department)
    const createdMsg = `The account for ${email} was created with the password shown — share it with them.`

    // 电话属于 staff_private(本人 + hr/manager/admin/owner 可读),不再写进 staff。
    // 这是申请人自己填的号码、写进自己的新行,不是写别人的私人栏位。
    // 行由 staff insert trigger 保证存在;没有电话就跳过。失败时释放认领、申请留在
    // pending:再按一次审批会走上面的"已存在"分支结案,不会重设密码。
    if (phone) {
      const { error: privErr } = await admin.from('staff_private')
        .upsert({ staff_id: userId, contact_number: phone }, { onConflict: 'staff_id' })
      if (privErr) {
        return fail(400, `${createdMsg} But the phone number was not saved (${privErr.message}); approve the request again to finish it.`,
          { accountCreated: true })
      }
    }

    const marked = await markApproved(admin, requestId, auth.callerId, claimAt)
    if (marked?.race) {
      // 申请在途中被 reject:帐号已经是 trainee,但不该叫经理去交密码。
      return fail(409,
        `The account for ${email} was created as a trainee, but ${marked.text} If the rejection stands, ask a manager to mark that account Resigned on its staff profile.`,
        { accountCreated: true })
    }
    if (marked) return fail(500, `${createdMsg} But ${marked.text}`, { accountCreated: true })

    return json({ ok: true, staffId: userId })
  }

  return json({ error: `Unknown action: ${String(body.action)}` }, 400)
})
