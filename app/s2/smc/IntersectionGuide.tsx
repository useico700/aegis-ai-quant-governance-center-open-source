import { buildIntersectionView } from "./intersection-view.mjs";
import styles from "./smc-workspace.module.css";

type View = ReturnType<typeof buildIntersectionView>;
const time = (t: number, full = false) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour12: false,
  month: full ? "2-digit" : undefined, day: full ? "2-digit" : undefined,
  hour: "2-digit", minute: "2-digit", second: full ? "2-digit" : undefined }).format(t);
const price = (p: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: Math.abs(p) >= 1000 ? 2 : Math.abs(p) >= 10 ? 4 : 6 }).format(p);

export function IntersectionLine({ view }: { view: View }) {
  if (!view.window) return null;
  return <div className={styles.intersectionLine} data-state={view.status} style={{ left: `${view.markerX}%` }} aria-hidden="true">
    <span>交汇</span>
  </div>;
}

export function IntersectionAxis({ view }: { view: View }) {
  if (!view.window || view.start == null || view.end == null) return null;
  return <div className={styles.intersectionAxis} aria-label="交汇时间轴，北京时间">
    <span>{time(view.start)}</span><span>{time(view.end)}</span>
    <i className={styles.intersectionTick} style={{ left: `${view.markerX}%` }} />
    <b style={{ left: `${view.nowX}%` }}>现在</b>
  </div>;
}

export function IntersectionCaption({ view, side }: { view: View; side: "ASK" | "BID" }) {
  if (!view.window) return null;
  const { event, expiresAt } = view.window;
  const source = [event.h, event.l].filter(Boolean).map(s => `${s!.tf.toUpperCase()} / 尺度 ${s!.n}`).join(" × ");
  return <div className={styles.intersectionCaption}>
    <div title={`${source} · ${event.id} · 标记观察期限 ${time(expiresAt, true)}；仅供观察，不拦截交易${view.otherWindows ? ` · 另有 ${view.otherWindows} 个已选窗口` : ""}`}>
      <strong>交汇 {time(event.tx, true)}</strong><span>北京时间 · {view.status === "UPCOMING" ? "未来标记" : "交汇已过"}</span>
    </div>
    <p>交汇价 <b>{price(event.px)}</b><span>{view.distance == null || view.percent == null ? "现价距离待实时报价" : view.distance === 0
      ? `与现价 ${side} 持平` : `比现价 ${side} ${view.distance > 0 ? "高" : "低"} ${price(Math.abs(view.distance))} USDT（${Math.abs(view.percent).toFixed(2)}%）`}</span></p>
  </div>;
}
