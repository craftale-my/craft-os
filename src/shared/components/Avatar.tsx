export function Avatar({
  name,
  avatar,
  size = 'md',
}: {
  name: string
  avatar: string | null
  size?: 'sm' | 'md' | 'lg'
}) {
  const sizeClass = { sm: 'w-7 h-7 text-xs', md: 'w-9 h-9 text-sm', lg: 'w-12 h-12 text-base' }[size]
  if (avatar) {
    return <img src={avatar} alt={name} className={`${sizeClass} rounded-full object-cover flex-shrink-0`} />
  }
  return (
    <div className={`${sizeClass} rounded-full bg-[#C4813A20] flex items-center justify-center font-bold text-[#8B6344] flex-shrink-0`}>
      {name.charAt(0).toUpperCase()}
    </div>
  )
}
