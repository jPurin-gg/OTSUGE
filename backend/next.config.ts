import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_SERVER } from "next/constants";
import { getAdminAuthConfig } from "./src/lib/auth-config";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["knex", "sqlite3", "pg", "web-push"],
};

export default function config(phase: string): NextConfig {
  if (phase === PHASE_DEVELOPMENT_SERVER || phase === PHASE_PRODUCTION_SERVER) {
    getAdminAuthConfig();
  }
  return nextConfig;
}
