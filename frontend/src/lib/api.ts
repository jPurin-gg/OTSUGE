export const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

export const NETWORK_ERROR_MESSAGE = "通信に失敗しました。ネットワークの状態を確認してください。";

/**
 * API 呼び出しの失敗。status は HTTP ステータス（通信自体に失敗したときは 0）、
 * details はサーバーが返した項目別の詳細（入力エラーのときの zod issues など）。
 */
export class ApiError extends Error {
  readonly status: number;
  readonly details: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

export function isUnauthorized(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 401;
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
    throw new ApiError(NETWORK_ERROR_MESSAGE, 0);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof data?.error === "string" && data.error ? data.error : `通信に失敗しました（HTTP ${response.status}）。`;
    throw new ApiError(message, response.status, data?.details);
  }
  return data as T;
}

const FIELD_LABELS: Record<string, string> = {
  message: "本文",
  start_time: "開始",
  end_time: "終了",
  count_per_day: "1日の回数",
  min_interval_minutes: "最低間隔（分）",
  enabled: "有効",
  scheduled_at: "配信時刻",
  password: "合言葉",
};

type Issue = {
  code?: unknown;
  path?: unknown;
  message?: unknown;
  minimum?: unknown;
  maximum?: unknown;
  origin?: unknown;
  type?: unknown;
};

function describeIssue(issue: Issue) {
  const kind = issue.origin ?? issue.type;
  switch (issue.code) {
    case "too_small":
      if (kind === "string") return Number(issue.minimum) <= 1 ? "入力してください。" : `${issue.minimum}文字以上で入力してください。`;
      if (kind === "number") return `${issue.minimum}以上にしてください。`;
      break;
    case "too_big":
      if (kind === "string") return `${issue.maximum}文字以内で入力してください。`;
      if (kind === "number") return `${issue.maximum}以下にしてください。`;
      break;
    case "invalid_format":
    case "invalid_string":
      return "形式が正しくありません。";
    case "invalid_type":
      return "値が正しくありません。";
  }
  return typeof issue.message === "string" ? issue.message : "値が正しくありません。";
}

/** サーバーの details（zod issues）を「項目: 内容」の行に変換する。解釈できない形なら空配列。 */
export function describeDetails(details: unknown): string[] {
  if (!Array.isArray(details)) return [];
  return details
    .filter((issue): issue is Issue => typeof issue === "object" && issue !== null)
    .map((issue) => {
      const key = Array.isArray(issue.path) ? issue.path.join(".") : "";
      const label = FIELD_LABELS[key] ?? key;
      const text = describeIssue(issue);
      return label ? `${label}: ${text}` : text;
    });
}

/** 例外を画面に出す文に変換する。 */
export function describeError(error: unknown) {
  if (error instanceof ApiError) return [error.message, ...describeDetails(error.details)].join("\n");
  if (error instanceof Error && error.message) return error.message;
  return "不明なエラーが発生しました。";
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
