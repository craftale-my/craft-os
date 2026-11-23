// The Craft Cafe Operation System lockup, set like the cafe logo: heavy
// CRAFT CAFE over a spaced serif sub-line. Screen readers get the full name.
const SIZES = {
  sm: { craft: 'text-[17px]', sub: 'text-[7px] mt-[3px] tracking-[0.24em]' },
  md: { craft: 'text-[21px]', sub: 'text-[8px] mt-1 tracking-[0.26em]' },
}

export function Wordmark({ size = 'md', tone = 'light' }: { size?: 'sm' | 'md'; tone?: 'light' | 'dark' }) {
  const s = SIZES[size]
  const craft = tone === 'light' ? 'text-[#F5F0E8]' : 'text-brown-dark'
  const sub = tone === 'light' ? 'text-[#D4C4B0]' : 'text-brown-muted'
  return (
    <span role="img" aria-label="Craft Cafe Operation System" className="inline-flex flex-col items-start leading-none whitespace-nowrap">
      <span aria-hidden="true" className={`type-wordmark ${s.craft} ${craft}`}>Craft Cafe</span>
      <span aria-hidden="true" className={`font-label font-bold uppercase pl-px ${s.sub} ${sub}`}>
        Operation System
      </span>
    </span>
  )
}
