export const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

export const INVALID_RESPONSE_MESSAGE = "サーバーから想定外の応答が返りました。";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const data = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(data?.error ?? "通信に失敗しました。");
  // 成功ステータスでも本文が JSON でなければ失敗にする。プロキシなどが HTML を返したときに、
  // 空のデータを成功として画面に渡さないため。
  if (data === undefined) throw new Error(INVALID_RESPONSE_MESSAGE);
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
