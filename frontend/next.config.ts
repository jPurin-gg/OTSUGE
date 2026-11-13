import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";

// Service Worker のキャッシュ名に入れるビルド識別子。`next build` のたびに変わる。
// next build はこのファイルを複数のプロセスで読み込むので、最初に決めた値を環境変数に置いて
// 後続のプロセスにも同じ値を使わせる。OTSUGE_BUILD_ID を外から渡す場合は、ビルドごとに違う値にすること
// （同じ値のままだと、端末に残った古い JS・CSS が使われ続ける）。
function buildId() {
  process.env.OTSUGE_BUILD_ID ||= Date.now().toString(36);
  return process.env.OTSUGE_BUILD_ID;
}

export default function nextConfig(phase: string): NextConfig {
  return {
    output: "standalone",
    env: {
      // 開発サーバーでは空にして、Service Worker に JS・CSS をキャッシュさせない（src/lib/sw.ts を参照）。
      NEXT_PUBLIC_BUILD_ID: phase === PHASE_PRODUCTION_BUILD ? buildId() : "",
    },
  };
}
