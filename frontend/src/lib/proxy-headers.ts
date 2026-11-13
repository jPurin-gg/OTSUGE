// host と content-length は fetch が接続先と本文に合わせて付け直す。
// accept-encoding も渡さない。ブラウザの値（Chrome なら zstd を含む）を渡すと、Node の fetch が
// 展開できない符号化で返ってくることがある（Node 22 の fetch は zstd を展開しない）。
// 渡さなければ、fetch が自分で展開できる符号化だけを要求する。
const UNFORWARDED_REQUEST_HEADERS = ["host", "content-length", "accept-encoding"];

// Node の fetch は圧縮された本文を展開して渡すが、ヘッダは上流のまま残す。
// そのまま返すと「展開済みの本文」に「Content-Encoding: gzip」と圧縮後の長さが付き、
// ブラウザが本文を復号できない。本文と食い違うこの3つは返さない。
const STALE_RESPONSE_HEADERS = ["content-encoding", "content-length", "transfer-encoding"];

function without(source: Headers, names: string[]): Headers {
  const headers = new Headers(source);
  for (const name of names) headers.delete(name);
  return headers;
}

export function toUpstreamRequestHeaders(incoming: Headers): Headers {
  return without(incoming, UNFORWARDED_REQUEST_HEADERS);
}

export function toProxyResponseHeaders(upstream: Headers): Headers {
  return without(upstream, STALE_RESPONSE_HEADERS);
}
