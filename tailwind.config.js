/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        cream:  '#F5F0E8',
        canvas: '#FDFAF6',
        card:   '#FFFFFF',
        border: '#EDE5D8',
        'border-mid': '#D4C5B0',
        brown: {
          dark:   '#3D2B1F',
          header: '#4A2E1A',
          brand:  '#8B6344',
          btn:    '#6B4C35',
          'btn-hover': '#5A3D28',
          muted:  '#8B7355',
          faint:  '#A09080',
          track:  '#EDE5D8',
        },
        xp: '#C4813A',
        rank: {
          trainee:    '#A0845C',
          junior:     '#C4813A',
          senior:     '#5B9E6A',
          supervisor: '#4A8FBF',
          manager:    '#C27BA0',
        },
      },
      fontFamily: {
        display: ['"Playfair Display"', 'Georgia', 'serif'],
        body:    ['"DM Sans"', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 4px rgba(61,43,31,0.08), 0 0 0 1px rgba(61,43,31,0.04)',
        'card-hover': '0 4px 12px rgba(61,43,31,0.12), 0 0 0 1px rgba(61,43,31,0.06)',
      },
    },
  },
  plugins: [],
}
