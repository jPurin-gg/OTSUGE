import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["knex", "sqlite3", "pg", "web-push"],
};

export default nextConfig;
