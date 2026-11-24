// src/qr/Mascot.tsx
/** Craft Cafe's QR mascot (spec 2026-11-22-qr-ai-pick-mascot-design.md §2): an original round coffee cup
 *  with a face, brand brown and cream, inline SVG. Four poses. Decorative only (aria-hidden); a small
 *  bounce when it appears, off under prefers-reduced-motion (Tailwind's motion-safe). */
export type MascotPose = 'hello' | 'pick' | 'sleepy' | 'cheer'

const INK = '#3D2B1F'       // brown-dark: face
const LINE = '#6B4C35'      // brown-btn: outline, arms
const COFFEE = '#8B6344'    // brown-brand
const CREMA = '#C9A47E'
const CUP = '#FFF9F0'
const SAUCER = '#EDE5D8'    // brown-track
const CHEEK = '#E9A98B'
const GOLD = '#C4813A'      // the sparkle
const STEAM = '#D4C5B0'     // border-mid

const steam = (
  <g stroke={STEAM} strokeWidth={3} fill="none" strokeLinecap="round">
    <path d="M42 27 q-4 -4 0 -8 q4 -4 0 -8" />
    <path d="M54 27 q-4 -4 0 -8 q4 -4 0 -8" />
  </g>
)

/** The parts every pose shares: saucer, cup, coffee, handle, cheeks. */
function Cup({ handle = 'M74 46 q14 0 12 11 q-2 9 -15 9' }: { handle?: string }) {
  return (
    <>
      <ellipse cx={48} cy={84} rx={30} ry={5} fill={SAUCER} stroke={LINE} strokeWidth={2.5} />
      <path d={handle} stroke={LINE} strokeWidth={5} fill="none" strokeLinecap="round" />
      <path d="M20 37 H76 L70.5 71 Q69 80 60 80 H36 Q27 80 25.5 71 Z" fill={CUP} stroke={LINE} strokeWidth={3} strokeLinejoin="round" />
      <ellipse cx={48} cy={37} rx={28} ry={6} fill={COFFEE} stroke={LINE} strokeWidth={3} />
      <ellipse cx={44} cy={36} rx={9} ry={2} fill={CREMA} />
      <ellipse cx={34} cy={62} rx={4} ry={2.5} fill={CHEEK} opacity={0.7} />
      <ellipse cx={62} cy={62} rx={4} ry={2.5} fill={CHEEK} opacity={0.7} />
    </>
  )
}

const eyes = (
  <g fill={INK}>
    <circle cx={39} cy={55} r={3} />
    <circle cx={57} cy={55} r={3} />
  </g>
)
const smile = <path d="M43 61 q5 5 10 0" stroke={INK} strokeWidth={2.5} fill="none" strokeLinecap="round" />

function Pose({ pose }: { pose: MascotPose }) {
  switch (pose) {
    case 'hello':
      return (
        <>
          {steam}
          <Cup />
          {eyes}{smile}
          {/* a waving arm and a small hand */}
          <path d="M23 54 q-9 -3 -11 -15" stroke={LINE} strokeWidth={4} fill="none" strokeLinecap="round" />
          <circle cx={12} cy={38} r={3.6} fill={LINE} />
        </>
      )
    case 'pick':
      return (
        <>
          <Cup />
          {eyes}{smile}
          {/* an arm holding up a sparkle */}
          <path d="M23 54 q-9 -3 -11 -14" stroke={LINE} strokeWidth={4} fill="none" strokeLinecap="round" />
          <path d="M12 22 l2.6 7.4 l7.4 2.6 l-7.4 2.6 l-2.6 7.4 l-2.6 -7.4 l-7.4 -2.6 l7.4 -2.6 z" fill={GOLD} />
          <circle cx={25} cy={18} r={1.8} fill={GOLD} />
        </>
      )
    case 'sleepy':
      return (
        <>
          <Cup />
          {/* closed eyes, a small round mouth, and a z or two */}
          <g stroke={INK} strokeWidth={2.5} fill="none" strokeLinecap="round">
            <path d="M35 55 q4 3 8 0" />
            <path d="M53 55 q4 3 8 0" />
          </g>
          <circle cx={48} cy={63} r={2.2} fill={INK} />
          <g fill="#8B7355" fontFamily="system-ui, sans-serif" fontWeight={700}>
            <text x={64} y={25} fontSize={13}>z</text>
            <text x={76} y={14} fontSize={10}>z</text>
          </g>
        </>
      )
    case 'cheer':
      return (
        <>
          {steam}
          <Cup handle="M73 50 q14 0 12 10 q-2 8 -15 8" />
          {/* happy closed eyes, an open smile, both arms up */}
          <g stroke={INK} strokeWidth={2.5} fill="none" strokeLinecap="round">
            <path d="M35 56 q4 -4 8 0" />
            <path d="M53 56 q4 -4 8 0" />
          </g>
          <path d="M42 60 h12 q0 7 -6 7 q-6 0 -6 -7 z" fill={INK} />
          <g stroke={LINE} strokeWidth={4} fill="none" strokeLinecap="round">
            <path d="M23 50 q-10 -5 -11 -17" />
            <path d="M75 44 q10 -5 10 -17" />
          </g>
          <g fill={GOLD}>
            <circle cx={20} cy={20} r={2} />
            <circle cx={78} cy={16} r={2} />
            <rect x={30} y={8} width={4} height={4} rx={1} transform="rotate(20 32 10)" />
            <rect x={64} y={6} width={4} height={4} rx={1} transform="rotate(-20 66 8)" />
          </g>
        </>
      )
  }
}

export default function Mascot({ pose, size = 72, className = '' }: { pose: MascotPose; size?: number; className?: string }) {
  return (
    <svg data-testid={`mascot-${pose}`} aria-hidden="true" focusable="false" viewBox="0 0 96 96" width={size} height={size}
      className={`block shrink-0 motion-safe:animate-mascot-pop ${className}`}>
      <Pose pose={pose} />
    </svg>
  )
}
