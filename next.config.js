/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config, { isServer }) => {
    config.resolve.alias.canvas = false;
    config.resolve.alias.encoding = false;
    if (isServer) {
      // Don't bundle pdf.js worker on server
      config.resolve.alias['pdfjs-dist/build/pdf.worker.min.mjs'] = false;
    }
    return config;
  },
  // Allow larger file uploads for PDF processing
  api: {
    bodyParser: false,
  },
  serverExternalPackages: ['pdf-parse'],
};

module.exports = nextConfig;
