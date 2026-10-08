/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['pdf-parse', 'pdfjs-dist', 'openai'],
};

module.exports = nextConfig;
