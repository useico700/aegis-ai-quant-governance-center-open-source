"use client";
import { useEffect, useRef, useState } from "react";
import { calendarFreshness, DAY, eventPhase, rollingEvents } from "../../lib/s1-risk-calendar.mjs";
import styles from "./calendar.module.css";
type RiskEvent = { id: string; name: string; category: string; tier: string; provider: string; scheduledAt: string; sourceUrl: string };
type Source = { provider: string; status: string; verifiedAt: string; coverageEnd: string; error: string | null };
type Calendar = { checkedAt: string; sources: Source[]; events: RiskEvent[] };
export type EventGate = { status: string; newEntriesPaused: boolean; pauseUntil: string | null; calendarCheckedAt: string | null };
const stamp = (at: string, date = true) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", ...(date ? { month: "2-digit", day: "2-digit" } : {}), hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(at));
const remaining = (at: string, now: number) => { const minutes = Math.ceil((Date.parse(at) - now) / 60000); if (minutes <= 0) return "计划时间已过"; const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), mins = minutes % 60; return `还有 ${days ? `${days}天 ` : ""}${hours}时 ${mins}分`; };
export default function RiskCalendar({ now, eventGate, scannerFresh }: { now: number; eventGate?: EventGate; scannerFresh: boolean }) {
  const [calendar, setCalendar] = useState<Calendar | null>(null), [failure, setFailure] = useState(false), [days, setDays] = useState(30), [refresh, setRefresh] = useState(0);
  const track = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const load = async () => { try { const response = await fetch("/api/s1-risk-calendar", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]), cache: "no-cache" }); if (!response.ok) throw new Error("CALENDAR_UNAVAILABLE"); const result = await response.json() as Calendar; if (!Array.isArray(result.events) || !Array.isArray(result.sources)) throw new Error("INVALID_CALENDAR"); if (!disposed) { setCalendar(result); setFailure(false); } } catch { if (!disposed) setFailure(true); } finally { if (!disposed) timer = setTimeout(load, 60000); } };
    void load(); return () => { disposed = true; controller.abort(); clearTimeout(timer); };
  }, [refresh]);
  const events = calendar && now ? rollingEvents(calendar.events, now, days) as RiskEvent[] : [];
  const active = events.filter((event) => eventPhase(event, now) === "WINDOW");
  const upcoming = events.find((event) => Date.parse(event.scheduledAt) >= now);
  const unverified = !calendar || !now || failure || calendar.sources.some((source) => ["INCOMPLETE", "NEEDS_RECHECK"].includes(calendarFreshness(source, now, now + 30 * 60000)));
  const pause = active.length > 0 || unverified || !scannerFresh || eventGate?.newEntriesPaused !== false;
  const stateLabel = unverified ? "日历待核验 · 禁止新入场" : active.length ? "风险窗口 · 暂停新入场" : !scannerFresh || !eventGate ? "扫描侧状态待同步" : eventGate.newEntriesPaused ? "扫描侧限制新入场" : "当前不在已知事件窗口";
  return <section className={styles.calendar} aria-labelledby="risk-calendar-heading">
    <header className={styles.header}><div><h2 id="risk-calendar-heading">滚动风险事件日历</h2><p className={styles.subtitle}>北京时间 · 公布前后各 30 分钟暂停新入场 · 已有仓位按原规则管理</p></div><div className={styles.controls}><label>范围<select value={days} onChange={(event) => setDays(Number(event.target.value))}><option value={7}>未来 7 天</option><option value={30}>未来 30 天</option></select></label><button type="button" onClick={() => setRefresh((value) => value + 1)}>更新日历 ↻</button></div></header>
    <div className={`${styles.banner} ${pause ? styles.paused : ""}`} role="status"><span>{stateLabel}</span><small>{active.length ? active.map((event) => event.name).join(" / ") : upcoming ? `下一事件：${upcoming.name} · ${remaining(upcoming.scheduledAt, now)}` : "所选时段暂无已登记事件，不代表没有风险"}</small></div>
    <div className={styles.navigator}><span>按时间自动排序，保留最近 24 小时；重点与关注事件均执行相同暂停窗口。</span><div><button type="button" aria-label="向前滚动风险日历" onClick={() => track.current?.scrollBy({ left: -500, behavior: "instant" })}>←</button><button type="button" aria-label="向后滚动风险日历" onClick={() => track.current?.scrollBy({ left: 500, behavior: "instant" })}>→</button></div></div>
    <div ref={track} className={styles.track} tabIndex={0} role="region" aria-label="可横向滚动的风险事件列表">
      {events.map((event) => { const phase = eventPhase(event, now), at = Date.parse(event.scheduledAt); return <article key={event.id} className={`${styles.card} ${phase === "WINDOW" ? styles.active : phase === "PASSED" ? styles.past : ""}`}><div className={styles.cardTop}><time dateTime={event.scheduledAt}>{stamp(event.scheduledAt)}</time><span>{event.tier === "TIER1" ? "重点" : "关注"}</span></div><h3>{event.name}</h3><p className={styles.countdown}>{phase === "WINDOW" ? now < at ? "公布前暂停窗口" : "公布后暂停窗口" : remaining(event.scheduledAt, now)}</p><div className={styles.window}><span>新入场暂停</span><strong>{stamp(new Date(at - 1800000).toISOString(), false)}–{stamp(new Date(at + 1800000).toISOString(), false)}</strong></div><a href={event.sourceUrl} target="_blank" rel="noreferrer">{event.provider} 官方计划 ↗</a></article>; })}
      {!events.length && <div className={styles.empty}>{calendar ? "此区间暂无已核验事件；请同时检查下方覆盖范围。" : failure ? "日历连接异常，系统保持禁止新入场。" : "正在读取官方事件计划…"}</div>}
    </div>
    <div className={styles.sources}>{calendar?.sources.map((source) => { const freshness = calendarFreshness(source, now, now + days * DAY); return <div key={source.provider}><strong>{source.provider}</strong><span>{freshness === "INCOMPLETE" ? "所选范围覆盖不足" : freshness === "NEEDS_RECHECK" ? "计划已超过复核时限" : source.status === "LIVE_OFFICIAL" ? "官方源已刷新" : "使用已核验备用计划"}</span><small>核验 {stamp(source.verifiedAt)} · 覆盖至 {stamp(source.coverageEnd)}</small></div>; })}</div>
    <p className={styles.note}>暂停窗口重叠时合并，不补追已过期信号。事件窗口只控制策略新入场；实际执行权限和事故拦截以页面执行状态为准。突发政策、交易所故障与未登记的代币事件不在此日历覆盖内；数据源失败或过期会明确标记。</p>
  </section>;
}
