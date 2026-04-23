# OTDR Analyzer v8.2 — Web Edition

A browser-based OTDR PDF report analyzer, ported from the Python/tkinter desktop app. Upload OTDR test reports, parse them client-side, preview results in color-coded tables, and export to Excel/CSV/JSON.

**All parsing runs in your browser** — no server-side processing, no data leaves your machine.

## Supported Formats

| Manufacturer | Format | Details |
|---|---|---|
| **VIAVI** | Standard (dual-wavelength) | T-BERD, ONA-800, summary + detail pages |
| **VIAVI** | Single-wavelength per page | JDSU-style, auto-paired by filename |
| **VIAVI** | Compiled multi-test | Multiple tests in one PDF (3 pages each) |
| **EXFO** | Legacy (MAX-7xx) | iOLM results + element table |
| **EXFO** | FTBx OTDR | 4-page format (1310+1550 summary + event tables) |
| **EXFO** | iOLM | 2 pages per test, multi-test PDFs |
| **Anritsu** | MT9083 | Dual-wavelength per page, multi-page PDFs |
| **Anritsu** | MT9085 Dual | 4-page format with dual wavelength summary |
| **Anritsu** | MT9085 Compiled | Single-wavelength tests compiled into one PDF |

## Features

- **Drag & drop** PDF upload (multi-file)
- **Auto-detection** of report format (or manual override)
- **Reflectance filtering**: First/last event reflectance excluded when 4+ events
- **Wavelength merging**: Separate 1310/1550 PDFs auto-merged by filename
- **Color-coded results** table with Results / Thresholds / Equipment tabs
- **Search/filter** across results
- **Export** to Excel (.xlsx), CSV, or JSON
- **Pass/Fail** badge highlighting

## Deploy to Vercel

### Option 1: GitHub + Vercel (Recommended)

1. **Push to GitHub:**
   ```bash
   cd otdr-analyzer-web
   git init
   git add .
   git commit -m "OTDR Analyzer v8.2 Web Edition"
   git remote add origin https://github.com/YOUR_USERNAME/otdr-analyzer-web.git
   git push -u origin main
   ```

2. **Connect to Vercel:**
   - Go to [vercel.com](https://vercel.com) and sign in with GitHub
   - Click **"Add New Project"**
   - Select your `otdr-analyzer-web` repository
   - Framework: **Next.js** (auto-detected)
   - Click **Deploy**
   - Done! Your app is live at `https://otdr-analyzer-web.vercel.app`

3. **Auto-updates:** Every push to `main` triggers a new deployment.

### Option 2: Vercel CLI

```bash
npm install -g vercel
cd otdr-analyzer-web
vercel
```

Follow the prompts. First deploy creates the project; subsequent `vercel` commands update it.

## Local Development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Project Structure

```
otdr-analyzer-web/
├── app/
│   ├── layout.tsx          # Root layout with fonts
│   ├── page.tsx            # Main UI (upload, tables, export)
│   └── globals.css         # Fiber optic themed styling
├── lib/
│   ├── types.ts            # TypeScript interfaces (OTDRReport, etc.)
│   ├── pdf-extract.ts      # PDF text extraction via pdf.js
│   ├── otdr-parser.ts      # Complete parsing engine (all 8 formats)
│   └── export.ts           # Excel/CSV/JSON export
├── package.json
├── next.config.js
├── tailwind.config.js
├── tsconfig.json
├── vercel.json
└── README.md
```

## Changelog

### v8.2 Web Edition
- Complete port from Python/tkinter to Next.js/TypeScript
- Client-side PDF parsing using pdf.js (replaces pdfplumber)
- Drag-and-drop file upload
- Live search/filter across results
- Responsive design for desktop and tablet
- Vercel deployment ready

### v8.2 (Python)
- Fixed VIAVI reflectance parsing
- Added Anritsu MT9085 compiled single-wavelength format
- Reflectance first/last event filtering across all parsers
