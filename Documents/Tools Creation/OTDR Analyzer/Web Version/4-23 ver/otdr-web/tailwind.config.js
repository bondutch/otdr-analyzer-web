/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx}',
    './components/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
        sans: ['DM Sans', 'system-ui', 'sans-serif'],
      },
      colors: {
        fiber: {
          core: '#00E5FF',
          clad: '#0A1628',
          jacket: '#132040',
          pulse: '#00BCD4',
          warn: '#FF6B35',
          pass: '#00E676',
          fail: '#FF5252',
          1310: '#64B5F6',
          1550: '#FFB74D',
        }
      }
    },
  },
  plugins: [],
};
