export const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

export const NETWORK_ERROR_MESSAGE = "通信に失敗しました。ネットワークの状態を確認してください。";

/**
 * API 呼び出しの失敗。message は画面にそのまま出せる日本語の文言。
 * status は HTTP ステータス（通信自体に失敗したときは 0）。
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
  } catch {
    // 通信自体の失敗。ブラウザの英語の文言（Failed to fetch / Load failed）は利用者に見せない。
    throw new ApiError(NETWORK_ERROR_MESSAGE, 0);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof data?.error === "string" && data.error ? data.error : `通信に失敗しました（HTTP ${response.status}）。`;
    throw new ApiError(message, response.status);
  }
  return data as T;
}

export function formatTime(value: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function toDatetimeLocal(value: string) {
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}
