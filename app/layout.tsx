import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'OTDR Analyzer v1.0 — Web Edition',
  description: 'Analyze VIAVI, EXFO, and Anritsu OTDR PDF reports online. Upload, parse, preview, and export to Excel/CSV/JSON.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=JetBrains+Mono:wght@300;400;500;600&display=swap"
          rel="stylesheet"
        />
        {/* Initialize theme before paint to prevent flash */}
        <script dangerouslySetInnerHTML={{ __html: `
          (function() {
            try {
              var t = localStorage.getItem('otdr-theme');
              if (t === 'light') document.documentElement.className = 'theme-light';
              else document.documentElement.className = 'theme-dark';
            } catch(e) { document.documentElement.className = 'theme-dark'; }
          })();
        `}} />
      </head>
      <body className="font-sans antialiased min-h-screen transition-colors duration-200">
        {children}
      </body>
    </html>
  );
}
