export function getAdminAuthConfig() {
  const password = process.env.ADMIN_PASSWORD;
  const secret = process.env.AUTH_SECRET;
  if (!password || !secret) {
    const missing = [!password && "ADMIN_PASSWORD", !secret && "AUTH_SECRET"].filter(Boolean);
    throw new Error(`管理者認証の必須環境変数が未設定または空です: ${missing.join(", ")}`);
  }
  return { password, secret };
}
