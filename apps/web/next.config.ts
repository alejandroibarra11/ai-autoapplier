import type { NextConfig } from 'next';
const config: NextConfig = {
  transpilePackages: ['@autoapplier/core'],
  serverExternalPackages: ['better-sqlite3', 'playwright', 'playwright-core'],
};
export default config;
