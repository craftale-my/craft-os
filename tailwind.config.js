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
        // Named versions of the most-used hard-coded hex values, so pages can
        // migrate to tokens without any visual change.
        accent: { DEFAULT: '#C4813A', hover: '#A86C2C', text: '#A86C2C' },
        line:   { DEFAULT: '#E8DDD0', soft: '#F0E8DC' },
        tint:   '#F5EDE0',
        ok:     { DEFAULT: '#3D7A50', bg: '#EBF5EE' },
        bad:    { DEFAULT: '#9E4A30', bg: '#FCF0EC' },
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
        // Brand type, matched to the Craft Cafe logo and menus (2026-10-23):
        // Archivo stands in for Acumin, STIX Two Text is the logo's serif.
        // Chinese falls back to LiHei Pro on Apple, PingFang / Noto elsewhere.
        brand:   ['Archivo', '"LiHei Pro"', '"PingFang SC"', '"Noto Sans SC"', 'system-ui', 'sans-serif'],
        label:   ['"STIX Two Text"', 'Georgia', '"LiHei Pro"', '"PingFang SC"', 'serif'],
      },
      boxShadow: {
        card: '0 1px 4px rgba(61,43,31,0.08), 0 0 0 1px rgba(61,43,31,0.04)',
        'card-hover': '0 4px 12px rgba(61,43,31,0.12), 0 0 0 1px rgba(61,43,31,0.06)',
      },
    },
  },
  plugins: [],
}
