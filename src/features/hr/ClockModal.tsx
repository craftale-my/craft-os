import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from '../../shared/lib/supabase'
import { Camera, MapPin, CheckCircle, X, AlertTriangle, RefreshCw } from 'lucide-react'

// ─── Utilities ────────────────────────────────────────────────────────────────

function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000
  const toRad = (d: number) => d * Math.PI / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
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

// ─── Clock modal ──────────────────────────────────────────────────────────────

export type ClockStep = 'locating' | 'camera' | 'preview' | 'uploading' | 'error'

export interface ClockResult {
  photoUrl: string
  lat: number
  lng: number
  distanceM: number
}

export interface ClockModalProps {
  type: 'in' | 'out'
  staffBranch: string | null
  staffId: string
  onDone: (result: ClockResult) => void
  onCancel: () => void
}

export function ClockModal({ type, staffBranch, staffId, onDone, onCancel }: ClockModalProps) {
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
