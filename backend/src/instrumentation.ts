export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getAdminAuthConfig } = await import("./lib/auth-config");
    getAdminAuthConfig();
  }
}
