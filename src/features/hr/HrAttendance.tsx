import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from '../../shared/lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { useCan } from '../../shared/lib/permissions'
import type { Staff, Attendance, AttendanceStatus, AttendanceBreak, ShiftType, LeaveType } from '../../shared/types'
import { ATTENDANCE_STATUS_LABELS, ATTENDANCE_STATUS_COLORS, BRANCHES, DEPT_LABELS, MONTHS_FULL, DEFAULT_BREAK_MINUTES, computeBreakOvertime, SCHEDULE_LEAVE_LABELS, DEPT_SHIFT_COLORS } from '../../shared/types'
import { toCSV, downloadCSV } from '../../shared/lib/csv'
import { calcLateness } from '../../shared/lib/attendance'
import { Avatar } from '../../shared/components/Avatar'
import { Camera, MapPin, CheckCircle, X, AlertTriangle, RefreshCw, ZoomIn, Coffee } from 'lucide-react'

// ─── Utilities ────────────────────────────────────────────────────────────────

function todayStr(): string {
  return new Date().toISOString().split('T')[0]
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}

function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000
  const toRad = (d: number) => d * Math.PI / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit', hour12: true })
}

// Formats a `time` column value (HH:MM[:SS]) to `9:30am` style. `fmtTime` above
// takes an ISO timestamp, not a bare time-of-day, so it isn't reusable here.
function fmtTime2(t: string): string {
  const [h, m] = t.split(':').map(Number)
  return `${h % 12 || 12}:${String(m).padStart(2, '0')}${h >= 12 ? 'pm' : 'am'}`
}

function fmtTimestamp(date: Date): string {
  return (
    date.toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' }) +
    ', ' +
    date.toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit', hour12: true })
  )
}

async function addWatermark(file: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      const stamp = fmtTimestamp(new Date())
      const barH = Math.max(40, img.height * 0.075)
      const fontSize = Math.round(barH * 0.46)
      ctx.fillStyle = 'rgba(0,0,0,0.58)'
      ctx.fillRect(0, img.height - barH, img.width, barH)
      ctx.fillStyle = '#ffffff'
      ctx.font = `bold ${fontSize}px -apple-system, Arial, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(stamp, img.width / 2, img.height - barH / 2)
      URL.revokeObjectURL(url)
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Canvas failed'))), 'image/jpeg', 0.88)
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')) }
    img.src = url
  })
}

// ─── Photo viewer modal ───────────────────────────────────────────────────────

function PhotoViewer({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <button className="absolute top-4 right-4 text-white/70 hover:text-white p-2" onClick={onClose}>
        <X size={24} />
      </button>
      <img
        src={url}
        alt="Attendance selfie"
        className="max-w-full max-h-full rounded-xl object-contain"
        onClick={e => e.stopPropagation()}
      />
    </div>
  )
}

// ─── Clock modal ──────────────────────────────────────────────────────────────

type ClockStep = 'locating' | 'camera' | 'preview' | 'uploading' | 'error'

interface ClockResult {
  photoUrl: string
  lat: number
  lng: number
  distanceM: number
}

interface ClockModalProps {
  type: 'in' | 'out'
  staffBranch: string | null
  staffId: string
  onDone: (result: ClockResult) => void
  onCancel: () => void
}

function ClockModal({ type, staffBranch, staffId, onDone, onCancel }: ClockModalProps) {
  const [step, setStep] = useState<ClockStep>('locating')
  const [errorMsg, setErrorMsg] = useState('')
  const [locationInfo, setLocationInfo] = useState<{ lat: number; lng: number; distance: number; branchName: string } | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [watermarkedBlob, setWatermarkedBlob] = useState<Blob | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const startLocating = useCallback(async () => {
    setStep('locating')
    setErrorMsg('')

    if (!staffBranch) {
      setStep('error')
      setErrorMsg('No branch is assigned to your account. Please contact your manager.')
      return
    }

    let position: GeolocationPosition
    try {
      position = await new Promise<GeolocationPosition>((res, rej) =>
        navigator.geolocation.getCurrentPosition(res, rej, { timeout: 12000, enableHighAccuracy: true })
      )
    } catch {
      setStep('error')
      setErrorMsg('Please enable location access to clock in. Check your browser or device location settings and try again.')
      return
    }

    const { latitude: myLat, longitude: myLng } = position.coords

    // Match staff branch to branches table (first word match e.g. "Cheras")
    const keyword = staffBranch.split(' ')[0]
    const { data: branchRow } = await supabase
      .from('branches')
      .select('name, latitude, longitude, radius_meters')
      .ilike('name', `%${keyword}%`)
      .limit(1)
      .maybeSingle()

    if (!branchRow || branchRow.latitude == null || branchRow.longitude == null) {
      // No coordinates configured — allow through without distance check
      setLocationInfo({ lat: myLat, lng: myLng, distance: 0, branchName: staffBranch })
      setStep('camera')
      return
    }

    const dist = haversineDistance(myLat, myLng, Number(branchRow.latitude), Number(branchRow.longitude))
    const radius = branchRow.radius_meters ?? 100

    if (dist > radius) {
      setStep('error')
      setErrorMsg(
        `You are ${Math.round(dist)}m away from ${branchRow.name}. You must be within ${radius}m to clock in.`
      )
      return
    }

    setLocationInfo({ lat: myLat, lng: myLng, distance: dist, branchName: branchRow.name })
    setStep('camera')
  }, [staffBranch])

  useEffect(() => {
    startLocating()
    return () => { if (previewUrl) URL.revokeObjectURL(previewUrl) }
  }, [])

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    try {
      const blob = await addWatermark(file)
      if (previewUrl) URL.revokeObjectURL(previewUrl)
      setPreviewUrl(URL.createObjectURL(blob))
      setWatermarkedBlob(blob)
      setStep('preview')
    } catch {
      setStep('error')
      setErrorMsg('Failed to process photo. Please try again.')
    }
  }

  function retake() {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setPreviewUrl(null)
    setWatermarkedBlob(null)
    setStep('camera')
    setTimeout(() => fileInputRef.current?.click(), 80)
  }

  async function confirm() {
    if (!watermarkedBlob || !locationInfo) return
    setStep('uploading')
    try {
      const filename = `${staffId}-${type}-${Date.now()}.jpg`
      const { data, error } = await supabase.storage
        .from('attendance-selfies')
        .upload(filename, watermarkedBlob, { contentType: 'image/jpeg', upsert: true })
      if (error) throw error
      const { data: { publicUrl } } = supabase.storage.from('attendance-selfies').getPublicUrl(data.path)
      onDone({
        photoUrl: publicUrl,
        lat: locationInfo.lat,
        lng: locationInfo.lng,
        distanceM: Math.round(locationInfo.distance),
      })
    } catch {
      setStep('error')
      setErrorMsg('Failed to upload photo. Please check your connection and try again.')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60">
      <div className="w-full sm:max-w-sm bg-white rounded-t-3xl sm:rounded-2xl overflow-hidden shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#F0E8DC]">
          <h3 className="font-bold text-brown-dark text-base">Clock {type === 'in' ? 'In' : 'Out'}</h3>
          <button onClick={onCancel} className="p-1 text-brown-faint hover:text-brown-dark transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="px-5 py-6">
          {step === 'locating' && (
            <div className="text-center py-8 space-y-4">
              <div className="w-16 h-16 mx-auto rounded-full bg-[#EBF5EE] flex items-center justify-center">
                <MapPin size={28} className="text-[#3D7A50] animate-pulse" />
              </div>
              <div>
                <p className="font-semibold text-brown-dark">Checking your location…</p>
                <p className="text-sm text-brown-faint mt-1">Please allow location access when prompted.</p>
              </div>
            </div>
          )}

          {step === 'camera' && locationInfo && (
            <div className="space-y-5">
              <div className="bg-[#EBF5EE] rounded-xl p-3.5 flex items-center gap-3">
                <CheckCircle size={18} className="text-[#3D7A50] flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-[#2E5E3A]">Location verified ✓</p>
                  <p className="text-xs text-[#3D7A50]">
                    {locationInfo.distance > 0
                      ? `${Math.round(locationInfo.distance)}m from ${locationInfo.branchName}`
                      : `At ${locationInfo.branchName}`}
                  </p>
                </div>
              </div>
              <div className="text-center space-y-4">
                <div className="w-16 h-16 mx-auto rounded-full bg-[#FBF0E6] flex items-center justify-center">
                  <Camera size={28} className="text-[#C4813A]" />
                </div>
                <div>
                  <p className="font-semibold text-brown-dark">Take a selfie</p>
                  <p className="text-sm text-brown-faint mt-1">
                    A date &amp; time stamp will be added automatically.
                  </p>
                </div>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full py-3 rounded-xl bg-[#C4813A] text-white font-semibold text-sm hover:bg-[#A86C2C] transition-colors active:scale-[0.98]"
                >
                  Open Camera
                </button>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="user"
                className="hidden"
                onChange={handleFileChange}
              />
            </div>
          )}

          {step === 'preview' && previewUrl && (
            <div className="space-y-4">
              <div className="rounded-xl overflow-hidden border border-[#E8DDD0] bg-black">
                <img src={previewUrl} alt="Preview" className="w-full max-h-72 object-contain" />
              </div>
              <p className="text-xs text-brown-faint text-center">
                Timestamp has been added to the photo.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={retake}
                  className="py-3 rounded-xl border border-[#D4C5B0] text-brown-medium text-sm font-semibold hover:bg-[#F5EDE0] transition-colors"
                >
                  Retake
                </button>
                <button
                  onClick={confirm}
                  className="py-3 rounded-xl bg-[#3D7A50] text-white text-sm font-semibold hover:bg-[#2E6040] transition-colors active:scale-[0.98]"
                >
                  Confirm
                </button>
              </div>
            </div>
          )}

          {step === 'uploading' && (
            <div className="text-center py-8 space-y-4">
              <div className="w-16 h-16 mx-auto rounded-full bg-[#FBF0E6] flex items-center justify-center">
                <RefreshCw size={28} className="text-[#C4813A] animate-spin" />
              </div>
              <div>
                <p className="font-semibold text-brown-dark">Confirming attendance…</p>
                <p className="text-sm text-brown-faint mt-1">Please wait a moment.</p>
              </div>
            </div>
          )}

          {step === 'error' && (
            <div className="space-y-4 py-2">
              <div className="bg-[#FDF3F0] rounded-xl p-4 flex gap-3">
                <AlertTriangle size={18} className="text-[#9E4A30] flex-shrink-0 mt-0.5" />
                <p className="text-sm text-[#9E4A30] leading-relaxed">{errorMsg}</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={onCancel}
                  className="py-3 rounded-xl border border-[#D4C5B0] text-brown-medium text-sm font-semibold hover:bg-[#F5EDE0] transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={startLocating}
                  className="py-3 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors"
                >
                  Try Again
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Manager: daily roster ────────────────────────────────────────────────────

const STATUS_OPTIONS: AttendanceStatus[] = ['present', 'late', 'absent', 'half_day', 'on_leave']

function DailyRoster({ allStaff, managerId }: { allStaff: Staff[]; managerId: string | undefined }) {
  const [date, setDate] = useState(todayStr())
  const [records, setRecords] = useState<Record<string, Attendance>>({})
  const [breaksByAtt, setBreaksByAtt] = useState<Record<string, AttendanceBreak[]>>({})
  const [filterBranch, setFilterBranch] = useState('')
  const [filterDept, setFilterDept] = useState('')
  const [saving, setSaving] = useState<string | null>(null)
  const [viewPhoto, setViewPhoto] = useState<string | null>(null)

  async function load() {
    const { data } = await supabase.from('attendance').select('*').eq('date', date)
    const rows = (data as Attendance[] | null) ?? []
    const map: Record<string, Attendance> = {}
    rows.forEach(r => { map[r.staff_id] = r })
    setRecords(map)

    const attIds = rows.map(r => r.id)
    if (attIds.length === 0) { setBreaksByAtt({}); return }
    const { data: brk } = await supabase.from('attendance_breaks').select('*').in('attendance_id', attIds)
    const bmap: Record<string, AttendanceBreak[]> = {}
    ;(brk as AttendanceBreak[] | null)?.forEach(b => {
      ;(bmap[b.attendance_id] ??= []).push(b)
    })
    setBreaksByAtt(bmap)
  }

  useEffect(() => { load() }, [date])

  async function setStatus(staffId: string, status: AttendanceStatus, lateMinutes = 0) {
    setSaving(staffId)
    await supabase.from('attendance').upsert({
      staff_id: staffId,
      date,
      status,
      late_minutes: lateMinutes,
      recorded_by: managerId ?? null,
    }, { onConflict: 'staff_id,date' })
    setSaving(null)
    load()
  }

  async function markAllPresent() {
    const rows = visibleStaff.map(s => ({
      staff_id: s.id,
      date,
      status: 'present' as const,
      recorded_by: managerId ?? null,
    }))
    await supabase.from('attendance').upsert(rows, { onConflict: 'staff_id,date' })
    load()
  }

  const visibleStaff = allStaff.filter(s => {
    if (filterBranch && s.branch !== filterBranch) return false
    if (filterDept && s.department !== filterDept) return false
    return true
  })

  const selectCls = 'px-3 py-1.5 rounded-lg border border-[#D4C5B0] bg-white text-xs text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'

  return (
    <div className="space-y-4">
      {viewPhoto && <PhotoViewer url={viewPhoto} onClose={() => setViewPhoto(null)} />}

      <div className="flex flex-wrap items-center gap-2">
        <input type="date" value={date} onChange={e => setDate(e.target.value)} className={selectCls} />
        <select className={selectCls} value={filterBranch} onChange={e => setFilterBranch(e.target.value)}>
          <option value="">All branches</option>
          {BRANCHES.map(b => <option key={b} value={b}>{b}</option>)}
        </select>
        <select className={selectCls} value={filterDept} onChange={e => setFilterDept(e.target.value)}>
          <option value="">All depts</option>
          {Object.entries(DEPT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button
          onClick={markAllPresent}
          className="px-3 py-1.5 rounded-lg bg-[#3D7A50] text-white text-xs font-semibold hover:bg-[#2E6040] transition-colors"
        >
          Mark all present
        </button>
      </div>

      <div className="bg-white rounded-xl border border-[#E8DDD0] divide-y divide-[#F0E8DC]">
        {visibleStaff.map(s => {
          const rec = records[s.id]
          const distM = rec?.clock_in_distance_m
          const highDist = distM != null && distM > 200
          return (
            <div key={s.id} className="px-4 py-3 space-y-2">
              <div className="flex items-center gap-3 flex-wrap">
                <Avatar name={s.name} avatar={s.avatar} size="sm" />
                <p className="text-sm font-medium text-brown-dark flex-1 min-w-[100px]">{s.name}</p>
                <div className="flex items-center gap-2 flex-wrap">
                  {STATUS_OPTIONS.map(opt => (
                    <button
                      key={opt}
                      disabled={saving === s.id}
                      onClick={() => setStatus(s.id, opt, opt === 'late' ? (rec?.late_minutes || 5) : 0)}
                      className="px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50"
                      style={
                        rec?.status === opt
                          ? { background: `${ATTENDANCE_STATUS_COLORS[opt]}20`, color: ATTENDANCE_STATUS_COLORS[opt], border: `1px solid ${ATTENDANCE_STATUS_COLORS[opt]}60` }
                          : { background: '#F5EDE0', color: '#8B7355', border: '1px solid transparent' }
                      }
                    >
                      {ATTENDANCE_STATUS_LABELS[opt]}
                    </button>
                  ))}
                  {rec?.status === 'late' && (
                    <input
                      type="number"
                      min={0}
                      value={rec.late_minutes}
                      onChange={e => setStatus(s.id, 'late', Number(e.target.value))}
                      className="w-16 px-2 py-1 rounded-lg border border-[#D4C5B0] text-xs text-brown-dark"
                      placeholder="mins"
                    />
                  )}
                </div>
              </div>

              {rec && (rec.clock_in || rec.clock_in_photo_url) && (
                <div className="flex items-center gap-4 pl-9 flex-wrap">
                  {/* Clock times */}
                  <div className="flex items-center gap-3 text-xs text-brown-faint">
                    {rec.clock_in && <span>In: <span className="font-medium text-brown-medium">{fmtTime(rec.clock_in)}</span></span>}
                    {rec.clock_out && <span>Out: <span className="font-medium text-brown-medium">{fmtTime(rec.clock_out)}</span></span>}
                  </div>

                  {/* Breaks (per-break from attendance_breaks) */}
                  {(breaksByAtt[rec.id] ?? [])
                    .filter(b => b.clock_in_time != null)
                    .sort((a, b) => a.break_number - b.break_number)
                    .map(b => (
                      <span key={b.id} className={`flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${
                        b.is_overtime ? 'bg-[#FDF3F0] text-[#9E4A30]' : 'bg-[#FBF0E6] text-[#8B5E2E]'
                      }`}>
                        <Coffee size={10} />
                        B{b.break_number} {b.duration_minutes ?? 0}m
                        {b.is_overtime ? ` (+${b.overtime_minutes}m ⚠️)` : ' ✓'}
                      </span>
                    ))}

                  {/* GPS distance */}
                  {distM != null && (
                    <span className={`flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${
                      highDist
                        ? 'bg-[#FDF3F0] text-[#9E4A30]'
                        : 'bg-[#EBF5EE] text-[#3D7A50]'
                    }`}>
                      <MapPin size={10} />
                      {distM}m from branch {highDist ? '⚠️' : '✓'}
                    </span>
                  )}

                  {/* Selfie thumbnails */}
                  <div className="flex items-center gap-2">
                    {rec.clock_in_photo_url && (
                      <button
                        onClick={() => setViewPhoto(rec.clock_in_photo_url!)}
                        className="relative group"
                        title="Clock-in selfie"
                      >
                        <img
                          src={rec.clock_in_photo_url}
                          alt="Clock-in"
                          className="w-10 h-10 rounded-lg object-cover border-2 border-[#3D7A50] hover:border-[#2E6040] transition-colors"
                        />
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 rounded-lg flex items-center justify-center transition-colors">
                          <ZoomIn size={12} className="text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                        <span className="absolute -bottom-0.5 -right-0.5 bg-[#3D7A50] text-white text-[8px] font-bold px-1 rounded">IN</span>
                      </button>
                    )}
                    {rec.clock_out_photo_url && (
                      <button
                        onClick={() => setViewPhoto(rec.clock_out_photo_url!)}
                        className="relative group"
                        title="Clock-out selfie"
                      >
                        <img
                          src={rec.clock_out_photo_url}
                          alt="Clock-out"
                          className="w-10 h-10 rounded-lg object-cover border-2 border-[#C4813A] hover:border-[#A86C2C] transition-colors"
                        />
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 rounded-lg flex items-center justify-center transition-colors">
                          <ZoomIn size={12} className="text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                        <span className="absolute -bottom-0.5 -right-0.5 bg-[#C4813A] text-white text-[8px] font-bold px-1 rounded">OUT</span>
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Manager: monthly grid ────────────────────────────────────────────────────

function MonthlyGrid({ allStaff }: { allStaff: Staff[] }) {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [records, setRecords] = useState<Attendance[]>([])
  const [exporting, setExporting] = useState(false)

  async function load() {
    const start = `${year}-${String(month).padStart(2, '0')}-01`
    const end = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth(year, month)).padStart(2, '0')}`
    const { data } = await supabase.from('attendance').select('*').gte('date', start).lte('date', end)
    setRecords((data as Attendance[]) ?? [])
  }

  useEffect(() => { load() }, [year, month])

  const days = Array.from({ length: daysInMonth(year, month) }, (_, i) => i + 1)
  const map: Record<string, Record<number, Attendance>> = {}
  records.forEach(r => {
    const day = Number(r.date.split('-')[2])
    if (!map[r.staff_id]) map[r.staff_id] = {}
    map[r.staff_id][day] = r
  })

  async function exportCSV() {
    setExporting(true)
    const rows = records.map(r => {
      const s = allStaff.find(st => st.id === r.staff_id)
      return [s?.name ?? r.staff_id, r.date, ATTENDANCE_STATUS_LABELS[r.status], r.late_minutes, r.clock_in_distance_m ?? '']
    })
    downloadCSV(`attendance_${MONTHS_FULL[month - 1]}_${year}.csv`, toCSV(['Staff', 'Date', 'Status', 'Late Minutes', 'GPS Distance (m)'], rows))
    setExporting(false)
  }

  const selectCls = 'px-3 py-1.5 rounded-lg border border-[#D4C5B0] bg-white text-xs text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select className={selectCls} value={month} onChange={e => setMonth(Number(e.target.value))}>
          {MONTHS_FULL.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
        </select>
        <input type="number" className={`${selectCls} w-24`} value={year} onChange={e => setYear(Number(e.target.value))} />
        <button onClick={exportCSV} disabled={exporting} className="px-3 py-1.5 rounded-lg border border-[#D4C5B0] text-xs text-brown-medium font-medium hover:bg-[#F5EDE0] transition-colors disabled:opacity-60">
          {exporting ? 'Exporting...' : 'Export CSV'}
        </button>
      </div>
      <div className="bg-white rounded-xl border border-[#E8DDD0] overflow-x-auto">
        <table className="text-xs min-w-max">
          <thead>
            <tr className="border-b border-[#EDE5D8]">
              <th className="text-left px-3 py-2 font-semibold text-brown-faint sticky left-0 bg-white">Staff</th>
              {days.map(d => <th key={d} className="px-1.5 py-2 font-semibold text-brown-faint text-center">{d}</th>)}
            </tr>
          </thead>
          <tbody>
            {allStaff.map((s, i) => (
              <tr key={s.id} className={i > 0 ? 'border-t border-[#F0E8DC]' : ''}>
                <td className="px-3 py-1.5 font-medium text-brown-dark sticky left-0 bg-white whitespace-nowrap">{s.name}</td>
                {days.map(d => {
                  const rec = map[s.id]?.[d]
                  return (
                    <td key={d} className="px-1.5 py-1.5 text-center">
                      {rec ? (
                        <span
                          title={`${ATTENDANCE_STATUS_LABELS[rec.status]}${rec.clock_in_distance_m != null ? ` · ${rec.clock_in_distance_m}m` : ''}`}
                          className="inline-block w-4 h-4 rounded-sm"
                          style={{ background: ATTENDANCE_STATUS_COLORS[rec.status] }}
                        />
                      ) : (
                        <span className="inline-block w-4 h-4 rounded-sm bg-[#F0E8DC]" />
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Staff: my attendance ─────────────────────────────────────────────────────

function MyAttendance({ staff }: { staff: Staff }) {
  const [today, setToday] = useState<Attendance | null>(null)
  const [monthRecords, setMonthRecords] = useState<Attendance[]>([])
  const [clockModal, setClockModal] = useState<'in' | 'out' | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  const [viewPhoto, setViewPhoto] = useState<string | null>(null)
  const [break1Allowed, setBreak1Allowed] = useState(0)
  const [break2Allowed, setBreak2Allowed] = useState(0)
  const [todayShift, setTodayShift] = useState<ShiftType | null>(null)
  const [todayLeave, setTodayLeave] = useState<LeaveType | null>(null)
  const [breaks, setBreaks] = useState<AttendanceBreak[]>([])
  const [breakBusy, setBreakBusy] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())

  async function load() {
    const now = new Date()
    const start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
    const { data } = await supabase
      .from('attendance')
      .select('*')
      .eq('staff_id', staff.id)
      .gte('date', start)
      .order('date')
    setMonthRecords((data as Attendance[]) ?? [])
    const t = (data as Attendance[] | null)?.find(r => r.date === todayStr())
    setToday(t ?? null)
  }

  // Determine today's break allowances from the scheduled shift (break 1 & 2).
  // With no shift, fall back to the company default rule for break 1 only.
  async function loadBreakAllowance() {
    const { data: shiftRow } = await supabase
      .from('scheduled_shifts')
      .select('leave_type, shift_type:shift_types(*)')
      .eq('staff_id', staff.id)
      .eq('date', todayStr())
      .maybeSingle()
    const row = shiftRow as { leave_type: LeaveType | null; shift_type: ShiftType | null } | null
    const st = row?.shift_type ?? null
    setTodayShift(st)
    setTodayLeave(row?.leave_type ?? null)
    if (st) {
      setBreak1Allowed(st.break1_duration_minutes ?? 0)
      setBreak2Allowed(st.break2_duration_minutes ?? 0)
      return
    }
    const { data: ruleRow } = await supabase
      .from('system_rules')
      .select('value')
      .eq('key', 'default_break_minutes')
      .maybeSingle()
    const ruleVal = ruleRow ? parseInt((ruleRow as { value: string }).value) : NaN
    setBreak1Allowed(Number.isFinite(ruleVal) ? ruleVal : DEFAULT_BREAK_MINUTES)
    setBreak2Allowed(0)
  }

  // Load today's break rows (may be empty, or hold break 1 and/or break 2).
  async function loadBreaks(attendanceId: string | undefined) {
    if (!attendanceId) { setBreaks([]); return }
    const { data } = await supabase
      .from('attendance_breaks')
      .select('*')
      .eq('attendance_id', attendanceId)
      .order('break_number')
    setBreaks((data as AttendanceBreak[]) ?? [])
  }

  useEffect(() => { load(); loadBreakAllowance() }, [])
  useEffect(() => { loadBreaks(today?.id) }, [today?.id])

  // Break rows by number, and which one is currently in progress.
  const break1 = breaks.find(b => b.break_number === 1) ?? null
  const break2 = breaks.find(b => b.break_number === 2) ?? null
  const activeBreak = breaks.find(b => b.clock_out_time && !b.clock_in_time) ?? null
  const onBreak = !!activeBreak

  // Tick every second while on break so the countdown stays live.
  useEffect(() => {
    if (!onBreak) return
    const id = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(id)
  }, [onBreak])

  async function startBreak(breakNumber: 1 | 2, allowed: number) {
    if (!today) return
    setBreakBusy(true)
    const nowIso = new Date().toISOString()
    await supabase.from('attendance_breaks').upsert({
      attendance_id: today.id,
      break_number: breakNumber,
      clock_out_time: nowIso,
    }, { onConflict: 'attendance_id,break_number' })
    setBreakBusy(false)
    setNowMs(Date.now())
    setSuccessMsg(`Break ${breakNumber} started — ${allowed} min allowed ☕`)
    loadBreaks(today.id)
    setTimeout(() => setSuccessMsg(null), 5000)
  }

  async function endBreak(row: AttendanceBreak, allowed: number) {
    if (!row.clock_out_time) return
    setBreakBusy(true)
    const endIso = new Date().toISOString()
    const { durationMinutes, overtimeMinutes, isOvertime } =
      computeBreakOvertime(row.clock_out_time, endIso, allowed)
    await supabase.from('attendance_breaks').update({
      clock_in_time: endIso,
      duration_minutes: durationMinutes,
      overtime_minutes: overtimeMinutes,
      is_overtime: isOvertime,
    }).eq('id', row.id)
    setBreakBusy(false)
    setSuccessMsg(
      isOvertime
        ? `Back from break ${row.break_number} — ${durationMinutes} min (${overtimeMinutes} min over) ⚠️`
        : `Back from break ${row.break_number} — ${durationMinutes} min ✓`
    )
    loadBreaks(row.attendance_id)
    setTimeout(() => setSuccessMsg(null), 6000)
  }

  async function handleClockDone(type: 'in' | 'out', result: ClockResult) {
    const now = new Date()
    if (type === 'in') {
      const lateness = todayShift
        ? calcLateness(now.toISOString(), todayStr(), todayShift.start_time)
        : { isLate: false, lateMinutes: 0 }
      await supabase.from('attendance').upsert({
        staff_id: staff.id,
        date: todayStr(),
        clock_in: now.toISOString(),
        status: lateness.isLate ? 'late' : 'present',
        late_minutes: lateness.lateMinutes,
        clock_in_photo_url: result.photoUrl,
        clock_in_lat: result.lat,
        clock_in_lng: result.lng,
        clock_in_distance_m: result.distanceM,
      }, { onConflict: 'staff_id,date' })
      setSuccessMsg(
        lateness.isLate
          ? `Clocked in at ${fmtTime(now.toISOString())} — late by ${lateness.lateMinutes} min ⚠️`
          : `Clocked in at ${fmtTime(now.toISOString())} ✓`
      )
    } else {
      if (!today) return
      await supabase.from('attendance').update({
        clock_out: now.toISOString(),
        clock_out_photo_url: result.photoUrl,
        clock_out_lat: result.lat,
        clock_out_lng: result.lng,
        clock_out_distance_m: result.distanceM,
      }).eq('id', today.id)
      setSuccessMsg(`Clocked out at ${fmtTime(now.toISOString())} ✓`)
    }
    setClockModal(null)
    load()
    setTimeout(() => setSuccessMsg(null), 5000)
  }

  const present = monthRecords.filter(r => r.status === 'present').length
  const late = monthRecords.filter(r => r.status === 'late').length
  const absent = monthRecords.filter(r => r.status === 'absent').length

  const canClockIn = !today?.clock_in
  const canClockOut = !!today?.clock_in && !today?.clock_out

  // Which breaks are available given clock state + shift allowances.
  const clockedInNotOut = !!today?.clock_in && !today?.clock_out
  const break1Complete = !!break1?.clock_in_time
  // Break section shows at all only if this shift has any break, or a row exists.
  const hasAnyBreak = break1Allowed > 0 || break2Allowed > 0 || breaks.length > 0
  // Break 2 only unlocks once break 1 is complete AND the shift defines a break 2.
  const break2Unlocked = break2Allowed > 0 && break1Complete

  const allowedFor = (n: 1 | 2) => (n === 1 ? break1Allowed : break2Allowed)
  const breakDeadlineMs = activeBreak?.clock_out_time
    ? new Date(activeBreak.clock_out_time).getTime() + allowedFor(activeBreak.break_number) * 60000
    : 0
  const breakRemainingMs = breakDeadlineMs - nowMs
  const breakOver = onBreak && breakRemainingMs < 0
  function fmtCountdown(ms: number): string {
    const sign = ms < 0 ? '-' : ''
    const total = Math.floor(Math.abs(ms) / 1000)
    const m = Math.floor(total / 60)
    const s = total % 60
    return `${sign}${m}:${String(s).padStart(2, '0')}`
  }

  return (
    <div className="space-y-5">
      {clockModal && (
        <ClockModal
          type={clockModal}
          staffBranch={staff.branch}
          staffId={staff.id}
          onDone={result => handleClockDone(clockModal, result)}
          onCancel={() => setClockModal(null)}
        />
      )}
      {viewPhoto && <PhotoViewer url={viewPhoto} onClose={() => setViewPhoto(null)} />}

      {/* Today's clock card */}
      <div className="bg-white rounded-2xl border border-[#E8DDD0] overflow-hidden">
        <div className="px-5 pt-5 pb-4">
          <p className="text-xs text-brown-faint uppercase tracking-widest font-semibold mb-1">Today</p>
          <p className="text-lg font-bold text-brown-dark">
            {new Date().toLocaleDateString('en-MY', { weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
          {todayShift ? (
            <div
              className="inline-flex items-center gap-2 mt-2 px-3 py-1.5 rounded-lg text-xs font-semibold"
              style={{
                background: `${DEPT_SHIFT_COLORS[todayShift.department] ?? todayShift.color}18`,
                border: `1px solid ${DEPT_SHIFT_COLORS[todayShift.department] ?? todayShift.color}50`,
                color: DEPT_SHIFT_COLORS[todayShift.department] ?? todayShift.color,
              }}
            >
              <span>{todayShift.name}</span>
              <span className="opacity-80 font-normal">
                {fmtTime2(todayShift.start_time)} – {fmtTime2(todayShift.end_time)}
              </span>
            </div>
          ) : todayLeave ? (
            <p className="mt-2 text-xs font-semibold" style={{ color: '#8B7355' }}>
              🌴 {SCHEDULE_LEAVE_LABELS[todayLeave]}
            </p>
          ) : (
            <p className="mt-2 text-xs text-brown-faint">No shift scheduled today</p>
          )}

          {today?.clock_in ? (
            <div className="mt-3 space-y-2">
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-[#3D7A50]" />
                  <span className="text-sm text-brown-medium">
                    Clocked in at <span className="font-semibold text-brown-dark">{fmtTime(today.clock_in)}</span>
                  </span>
                  {today.clock_in_photo_url && (
                    <button onClick={() => setViewPhoto(today.clock_in_photo_url!)} className="relative group">
                      <img src={today.clock_in_photo_url} alt="In" className="w-8 h-8 rounded-lg object-cover border border-[#3D7A50]" />
                      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 rounded-lg transition-colors" />
                    </button>
                  )}
                </div>
                {today.clock_in_distance_m != null && (
                  <span className="text-xs text-[#3D7A50] bg-[#EBF5EE] px-2 py-0.5 rounded-full flex items-center gap-1">
                    <MapPin size={9} />{today.clock_in_distance_m}m from branch
                  </span>
                )}
                {today.status === 'late' && (today.late_minutes ?? 0) > 0 && (
                  <span className="text-xs text-[#9E4A30] bg-[#FCF0EC] px-2 py-0.5 rounded-full font-semibold">
                    Late by {today.late_minutes} min
                  </span>
                )}
              </div>
              {today.clock_out && (
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-[#C4813A]" />
                    <span className="text-sm text-brown-medium">
                      Clocked out at <span className="font-semibold text-brown-dark">{fmtTime(today.clock_out)}</span>
                    </span>
                    {today.clock_out_photo_url && (
                      <button onClick={() => setViewPhoto(today.clock_out_photo_url!)} className="relative group">
                        <img src={today.clock_out_photo_url} alt="Out" className="w-8 h-8 rounded-lg object-cover border border-[#C4813A]" />
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 rounded-lg transition-colors" />
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="mt-2 text-sm text-brown-faint">Not clocked in yet.</p>
          )}

          {successMsg && (
            <div className="mt-3 flex items-center gap-2 bg-[#EBF5EE] text-[#2E5E3A] text-sm font-medium px-3 py-2 rounded-xl">
              <CheckCircle size={15} />
              {successMsg}
            </div>
          )}
        </div>

        {/* Clock buttons */}
        <div className="grid grid-cols-2 border-t border-[#F0E8DC]">
          <button
            onClick={() => setClockModal('in')}
            disabled={!canClockIn}
            className="py-4 flex flex-col items-center gap-1 text-sm font-bold text-[#3D7A50] hover:bg-[#EBF5EE] disabled:opacity-35 disabled:cursor-not-allowed transition-colors border-r border-[#F0E8DC]"
          >
            <span className="text-2xl">🕘</span>
            Clock In
          </button>
          <button
            onClick={() => setClockModal('out')}
            disabled={!canClockOut}
            className="py-4 flex flex-col items-center gap-1 text-sm font-bold text-[#C4813A] hover:bg-[#FBF0E6] disabled:opacity-35 disabled:cursor-not-allowed transition-colors"
          >
            <span className="text-2xl">🕔</span>
            Clock Out
          </button>
        </div>

        <div className="px-5 pb-3 pt-1">
          <p className="text-[11px] text-brown-faint text-center">
            Requires GPS location + selfie photo to clock in/out
          </p>
        </div>

        {/* ── Break section (separate from attendance clock) ── */}
        {today?.clock_in && hasAnyBreak && (
          <div className="border-t border-[#F0E8DC] px-5 py-4 space-y-4">
            {([1, 2] as const).map(n => {
              const allowed = allowedFor(n)
              const row = n === 1 ? break1 : break2
              // Skip break 2 entirely if the shift has no break 2 and no row exists.
              if (n === 2 && break2Allowed === 0 && !break2) return null
              // Break 2 is locked until break 1 completes.
              const locked = n === 2 && !break2Unlocked && !break2
              const inProgress = !!row?.clock_out_time && !row?.clock_in_time
              const done = !!row?.clock_in_time
              const canStart = clockedInNotOut && !row && !onBreak && (n === 1 ? break1Allowed > 0 : break2Unlocked)

              return (
                <div key={n}>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs text-brown-faint uppercase tracking-widest font-semibold flex items-center gap-1.5">
                      <Coffee size={13} /> Break {n}
                    </p>
                    {!done && <span className="text-[11px] text-brown-faint">{allowed} min allowed</span>}
                  </div>

                  {locked && (
                    <p className="text-xs text-brown-faint italic px-1">Available after Break 1.</p>
                  )}

                  {inProgress && (
                    <div className={`mb-2 rounded-xl px-4 py-3 text-center ${breakOver ? 'bg-[#FDF3F0]' : 'bg-[#FBF0E6]'}`}>
                      <p className={`text-2xl font-bold tabular-nums ${breakOver ? 'text-[#9E4A30]' : 'text-[#C4813A]'}`}>
                        {fmtCountdown(breakRemainingMs)}
                      </p>
                      <p className={`text-xs mt-0.5 ${breakOver ? 'text-[#9E4A30]' : 'text-brown-faint'}`}>
                        {breakOver ? 'Over allowed break time — please clock back in' : 'Time remaining'}
                      </p>
                    </div>
                  )}

                  {done && (
                    <div className={`flex items-center gap-2 text-xs font-medium px-3 py-2 rounded-xl ${
                      row?.is_overtime ? 'bg-[#FDF3F0] text-[#9E4A30]' : 'bg-[#EBF5EE] text-[#2E5E3A]'
                    }`}>
                      {row?.is_overtime ? <AlertTriangle size={14} /> : <CheckCircle size={14} />}
                      Break {n} taken: {row?.duration_minutes ?? 0} min
                      {row?.is_overtime ? ` · ${row?.overtime_minutes} min over limit` : ' · on time'}
                    </div>
                  )}

                  {!done && !locked && (
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={() => startBreak(n, allowed)}
                        disabled={!canStart || breakBusy}
                        className="py-3 flex flex-col items-center gap-0.5 rounded-xl border border-[#C4813A40] text-sm font-bold text-[#C4813A] bg-[#FBF0E6] hover:bg-[#F6E6D4] disabled:opacity-35 disabled:cursor-not-allowed transition-colors"
                      >
                        <span className="text-lg">☕</span>
                        Break {n} Clock-Out
                      </button>
                      <button
                        onClick={() => row && endBreak(row, allowed)}
                        disabled={!inProgress || breakBusy}
                        className="py-3 flex flex-col items-center gap-0.5 rounded-xl border border-[#3D7A5040] text-sm font-bold text-[#3D7A50] bg-[#EBF5EE] hover:bg-[#DCEFE2] disabled:opacity-35 disabled:cursor-not-allowed transition-colors"
                      >
                        <span className="text-lg">🔙</span>
                        Break {n} Clock-In
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Monthly stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-white rounded-xl p-4 border border-[#E8DDD0] text-center">
          <p className="text-2xl font-bold text-[#3D7A50]">{present}</p>
          <p className="text-xs text-brown-faint mt-0.5">Present</p>
        </div>
        <div className="bg-white rounded-xl p-4 border border-[#E8DDD0] text-center">
          <p className="text-2xl font-bold text-[#C4813A]">{late}</p>
          <p className="text-xs text-brown-faint mt-0.5">Late</p>
        </div>
        <div className="bg-white rounded-xl p-4 border border-[#E8DDD0] text-center">
          <p className="text-2xl font-bold text-[#9E4A30]">{absent}</p>
          <p className="text-xs text-brown-faint mt-0.5">Absent</p>
        </div>
      </div>

      {/* Monthly list */}
      <div>
        <p className="text-sm font-semibold text-brown-dark mb-2">This Month</p>
        <div className="bg-white rounded-xl border border-[#E8DDD0] divide-y divide-[#F0E8DC]">
          {monthRecords.length === 0 ? (
            <p className="px-4 py-6 text-xs text-brown-faint text-center">No attendance records yet this month.</p>
          ) : (
            monthRecords.map(r => (
              <div key={r.id} className="flex items-center justify-between px-4 py-2.5 gap-3">
                <span className="text-xs text-brown-medium w-24 flex-shrink-0">{r.date}</span>
                <span
                  className="text-xs font-semibold px-2 py-0.5 rounded-full flex-shrink-0"
                  style={{ background: `${ATTENDANCE_STATUS_COLORS[r.status]}20`, color: ATTENDANCE_STATUS_COLORS[r.status] }}
                >
                  {ATTENDANCE_STATUS_LABELS[r.status]}{r.status === 'late' && r.late_minutes ? ` (${r.late_minutes}m)` : ''}
                </span>
                <div className="flex items-center gap-2 ml-auto">
                  {r.clock_in_distance_m != null && (
                    <span className="text-[10px] text-brown-faint flex items-center gap-0.5">
                      <MapPin size={8} />{r.clock_in_distance_m}m
                    </span>
                  )}
                  {r.clock_in_photo_url && (
                    <button onClick={() => setViewPhoto(r.clock_in_photo_url!)} className="flex-shrink-0">
                      <img src={r.clock_in_photo_url} alt="" className="w-7 h-7 rounded object-cover border border-[#E8DDD0]" />
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function HrAttendancePage() {
  const { staff } = useAuth()
  const { can, ownBranchOnly } = useCan()
  const [allStaff, setAllStaff] = useState<Staff[]>([])
  const [view, setView] = useState<'daily' | 'monthly'>('daily')
  const canSeeTeam = can('manage_hr')

  useEffect(() => {
    supabase.from('staff').select('*').order('name').then(({ data }) => { if (data) setAllStaff(data as Staff[]) })
  }, [])

  if (!staff) return null

  // Supervisors (no all_branches capability) only see their own branch's team.
  const scopedStaff = ownBranchOnly && staff.branch_id
    ? allStaff.filter(s => s.branch_id === staff.branch_id)
    : allStaff

  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-5xl mx-auto px-4 py-8 lg:px-8 space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-brown-dark">Attendance</h1>
          <p className="text-sm text-brown-faint mt-0.5">Clock in/out and track attendance.</p>
        </div>

        <section>
          <h2 className="text-base font-bold text-brown-dark mb-3">My Attendance</h2>
          <MyAttendance staff={staff} />
        </section>

        {canSeeTeam && (
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-bold text-brown-dark">Team Attendance</h2>
              <div className="flex gap-1 bg-white rounded-lg border border-[#E8DDD0] p-0.5">
                {(['daily', 'monthly'] as const).map(v => (
                  <button
                    key={v}
                    onClick={() => setView(v)}
                    className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                      view === v ? 'bg-[#C4813A] text-white' : 'text-brown-muted hover:bg-[#F5EDE0]'
                    }`}
                  >
                    {v === 'daily' ? 'Daily' : 'Monthly'}
                  </button>
                ))}
              </div>
            </div>
            {view === 'daily' ? (
              <DailyRoster allStaff={scopedStaff} managerId={staff.id} />
            ) : (
              <MonthlyGrid allStaff={scopedStaff} />
            )}
          </section>
        )}
      </div>
    </div>
  )
}
