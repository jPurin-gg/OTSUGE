import type { PushCardView } from "@/lib/push-state";

type Props = {
  view: PushCardView;
  /** 購読・解除の処理中。 */
  loading: boolean;
  /** 操作の結果や失敗の文言。なければ空文字。 */
  message: string;
  onSubscribe: () => void;
  onUnsubscribe: () => void;
};

/** 通知の受け取り状態と、状態に応じた操作・案内を出すカード。文言と状態判定は lib/push-state.ts にある。 */
export function PushCard({ view, loading, message, onSubscribe, onUnsubscribe }: Props) {
  // ホーム画面への追加が必要・非対応・ブロック中は、押しても購読できないのでボタンを出さず、案内だけにする。
  const showActions = view.state === "checking" || view.state === "unsubscribed" || view.state === "subscribed";

  return (
    <div className="rounded-lg bg-slate-950 p-6 text-white shadow-sm">
      <p className="text-sm font-bold text-amber-300">現在の状態</p>
      <div className="mt-4 flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="text-3xl font-bold">{view.heading}</p>
          <p className="mt-2 max-w-xl text-sm leading-6 text-slate-300">{view.description}</p>
          {view.steps.length > 0 && (
            <ol className="mt-3 max-w-xl list-decimal space-y-1 pl-5 text-sm leading-6 text-slate-100">
              {view.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          )}
          {view.note && <p className="mt-3 max-w-xl text-xs leading-5 text-slate-400">{view.note}</p>}
        </div>
        {showActions && (
          <div className="flex flex-wrap gap-2">
            <button
              className="rounded-md bg-cyan-300 px-4 py-3 text-sm font-bold text-slate-950 shadow-sm transition hover:bg-cyan-200 disabled:opacity-40"
              disabled={loading || view.state !== "unsubscribed"}
              onClick={onSubscribe}
            >
              受け取る
            </button>
            <button
              className="rounded-md border border-white/30 px-4 py-3 text-sm font-bold text-white transition hover:bg-white/10 disabled:opacity-40"
              disabled={loading || view.state !== "subscribed"}
              onClick={onUnsubscribe}
            >
              停止する
            </button>
          </div>
        )}
      </div>
      {message && <p className="mt-5 rounded-md bg-white/10 p-3 text-sm text-slate-100">{message}</p>}
    </div>
  );
}
