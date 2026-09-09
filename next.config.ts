import type { NextConfig } from "next";

/**
 * Security headers (audit v1.1.1):
 *  - CSP: Firebase Web SDK-র জন্য প্রয়োজনীয় ডোমেইনগুলোই শুধু allow;
 *    'unsafe-inline' script শুধু Next.js hydration-এর জন্য (next/inline
 *    script ছাড়া উপায় নেই) — production-এ nonce-based CSP-তে উন্নীত করা যাবে।
 *  - frame-ancestors 'none' + X-Frame-Options: clickjacking বন্ধ।
 *  - Permissions-Policy: ড্যাশবোর্ড parent-এর ব্রাউজারকে camera/mic/geolocation
 *    capture করতে দেয় না (parent শুধু WebRTC-র receiver — কখনো capturer নয়)।
 *  - HSTS: HTTPS-only পরিবেশে (Caddy termination) প্রযোজ্য।
 */
const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "media-src 'self' blob: mediastream:",
      "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com https://*.cloudfunctions.net https://firebaseinstallations.googleapis.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "),
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  /**
   * Audit fix: build errors were previously swallowed
   * (typescript.ignoreBuildErrors=true) — that can hide type-level security
   * regressions. The build must fail loudly on type errors.
   */
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
