import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // The SDK ships as TypeScript-built ESM inside the workspace; let Next compile it
  // rather than requiring a separate build step during development.
  transpilePackages: ["@dsrp/sdk"],
  // Next 16 blocks cross-origin dev resources by default, which silently prevents
  // /_next/ chunks and the HMR socket from loading when the app is opened on a
  // different host spelling than it was started with (127.0.0.1 vs localhost).
  // Dev-only; has no effect on a production build.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default config;
