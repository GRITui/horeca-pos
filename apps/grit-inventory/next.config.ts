import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Grit workspace packages ship TypeScript source (no build step) and must
  // be transpiled by Next.
  transpilePackages: [
    "@grit/passport",
    "@grit/shared-events",
    "@grit/database",
    "@grit/shared-ui",
  ],
  // The @grit packages use TS-ESM style relative imports with ".js"
  // extensions (e.g. `./bus.js` for bus.ts). Teach webpack to map those onto
  // the TypeScript sources. This app builds with the webpack bundler
  // (`next build --webpack` in package.json scripts) because Turbopack has no
  // equivalent extension-alias setting yet.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".js", ".ts", ".tsx"],
      ".mjs": [".mjs", ".mts"],
      ".cjs": [".cjs", ".cts"],
    };
    return config;
  },
};

export default nextConfig;
