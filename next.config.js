/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['pdf-parse', 'pdfjs-dist', 'openai'],
  // pdf-parse loads pdf.js's worker file by path at run time, which the build's file tracing cannot see;
  // without this a serverless deployment can build fine and then fail on the first PDF upload.
  outputFileTracingIncludes: {
    '/api/invoices/ingest': ['./node_modules/pdf-parse/**/*', './node_modules/pdfjs-dist/**/*'],
    '/api/purchase-orders/parse': ['./node_modules/pdf-parse/**/*', './node_modules/pdfjs-dist/**/*'],
  },

  // One deployment serves the API (app/api) and the screens (the built frontend, copied into ./public by
  // `npm run build:web`). The screens are a single-page app, so any path that is not an API route, a Next
  // asset or a real file in ./public (checked first) gets index.html and the router takes over.
  async rewrites() {
    return {
      // '/' is claimed first: app/page.tsx is a scaffold placeholder that would otherwise win.
      beforeFiles: [{ source: '/', destination: '/index.html' }],
      fallback: [{ source: '/:path((?!api/|_next/).*)', destination: '/index.html' }],
    };
  },
};

module.exports = nextConfig;
