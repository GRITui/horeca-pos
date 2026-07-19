import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Grit packages ship TypeScript source (no build step) — transpile them.
  transpilePackages: [
    "@grit/database",
    "@grit/passport",
    "@grit/shared-events",
    "@grit/shared-ui",
  ],
  // The @grit packages use ESM-style `./module.js` relative imports that
  // resolve to `.ts` source (standard TS nodenext convention). Webpack maps
  // the specifier extension via `extensionAlias` so those files are found.
  //
  // NOTE (bundler choice): Turbopack (the Next 16 default) has no
  // extensionAlias equivalent and fails to resolve those `./*.js` -> `*.ts`
  // imports inside the workspace packages, so this app builds and runs with
  // webpack (`next build --webpack` / `next dev --webpack` in package.json).
  // If the shared packages ever switch to extensionless relative imports (or
  // ship per-package tsconfigs Turbopack can use), this can revert to
  // Turbopack by dropping the flags.
  experimental: {
    extensionAlias: {
      ".js": [".js", ".ts", ".tsx"],
    },
  },
};

export default nextConfig;
