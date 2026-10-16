"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { LedgerPosition, LiveQuote, ScanResult } from "./types";
import { optimizeSmcPositionExit } from "../../../lib/smc-exit-optimizer.mjs";
import { formatPriceForInput, normalizePriceByPurpose } from "../../../lib/smc-price-input.mjs";
import PriceDigitInput from "./PriceDigitInput";
import MonitorDisclosure from "./MonitorDisclosure";
import styles from "./position-controls.module.css";

type State = { tone: "idle" | "pending" | "ok" | "error"; text: string; id?: string };
const messages: Record<string, string> = {
  ACTION_IN_PROGRESS: "该持仓已有操作正在执行",
  POSITION_NOT_FOUND: "持仓已变化，请刷新",
  OWNER_STOP_MUST_TIGHTEN: "新止损必须比当前止损更靠近价格",
  TRIGGER_CROSSED_REFERENCE: "止损或止盈不能穿过当前成交价",
  OWNER_TARGET_MUST_BE_PROFITABLE: "止盈必须位于开仓价的盈利方向",
  OWNER_REDUCTION_BELOW_MINIMUM_LOT: "减仓数量低于交易所最小单位",
  OWNER_REDUCTION_LEAVES_DUST: "减仓后剩余数量低于最小单位",
  OWNER_REDUCTION_REJECTED: "交易所拒绝减仓请求",
  OWNER_REDUCTION_CANCELED: "减仓请求已取消",
  OWNER_REDUCTION_EXPIRED: "减仓请求已过期",
  MANAGEMENT_QUOTE_STALE: "实时盘口未就绪，请稍后重试",
  PRICE_PRECISION_UNAVAILABLE: "交易所报价精度尚未同步",
  STOP_PLAN_TRIGGER_ALREADY_REACHED: "触发条件已经满足，请填写尚未到达的价格",
  STOP_PLAN_STOP_BEYOND_TRIGGER: "计划止损必须在触发价的保护一侧",
  STOP_PLAN_LIMIT: "最多同时保留 8 个待触发计划",
  STOP_PLAN_REPLACEMENT_PENDING: "止损正在替换，完成后刷新查看",
};

export default function PositionControls({ row, enabled, tickSize, quote, scanResult, now, onRefresh }: {
  row: LedgerPosition; enabled: boolean; tickSize: string | null; quote: LiveQuote | null;
  scanResult: ScanResult | null; now: number; onRefresh: () => void;
}) {
  const [fraction, setFraction] = useState("75");
  const [stop, setStop] = useState(() => formatPriceForInput(row.stop, tickSize) || String(row.stop));
  const [target, setTarget] = useState(() => formatPriceForInput(row.target, tickSize) || String(row.target));
  const [optimizerOpen, setOptimizerOpen] = useState(false);
  const [optimizerViewport, setOptimizerViewport] = useState({ height: 0, top: 0 });
  const [optimizerTarget, setOptimizerTarget] = useState(() => formatPriceForInput(row.target, tickSize) || String(row.target));
  const [state, setState] = useState<State>({ tone: "idle", text: "" });
  const [triggerPrice, setTriggerPrice] = useState("");
  const [triggerComparison, setTriggerComparison] = useState(row.direction === "LONG" ? "GTE" : "LTE");
  const [planStopMode, setPlanStopMode] = useState("ENTRY");
  const [planStop, setPlanStop] = useState("");
  const [planExpiry, setPlanExpiry] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const optimizerClose = useRef<HTMLButtonElement | null>(null);
  const optimizerDialog = useRef<HTMLDialogElement | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const [previousPrices, setPreviousPrices] = useState({ stop: row.stop, target: row.target, tickSize });
  if (previousPrices.stop !== row.stop || previousPrices.target !== row.target || previousPrices.tickSize !== tickSize) {
    setPreviousPrices({ stop: row.stop, target: row.target, tickSize });
    if (previousPrices.stop !== row.stop || previousPrices.tickSize !== tickSize) setStop(formatPriceForInput(row.stop, tickSize) || String(row.stop));
    if (previousPrices.target !== row.target || previousPrices.tickSize !== tickSize) setTarget(formatPriceForInput(row.target, tickSize) || String(row.target));
  }
  useEffect(() => {
    if (!optimizerOpen) return;
    const dialog = optimizerDialog.current;
    const viewport = window.visualViewport;
    const previousOverflow = document.body.style.overflow;
    const syncViewport = () => setOptimizerViewport({
      height: Math.round(viewport?.height ?? window.innerHeight),
      top: Math.round(viewport?.offsetTop ?? 0),
    });
    syncViewport();
    if (dialog && !dialog.open) dialog.showModal();
    document.body.style.overflow = "hidden";
    viewport?.addEventListener("resize", syncViewport);
    viewport?.addEventListener("scroll", syncViewport);
    const focusFrame = window.requestAnimationFrame(() => optimizerClose.current?.focus());
    return () => {
      window.cancelAnimationFrame(focusFrame);
      if (dialog?.open) dialog.close();
      document.body.style.overflow = previousOverflow;
      viewport?.removeEventListener("resize", syncViewport);
      viewport?.removeEventListener("scroll", syncViewport);
    };
  }, [optimizerOpen]);
  const optimizer = useMemo(() => optimizeSmcPositionExit({ position: row, quote, scanResult, tickSize, now }),
    [row, quote, scanResult, tickSize, now]);
  const recommendation = optimizer.recommendation as null | {
    target: number; label: string; confidence: string; distancePercent: number; currentStopR: number | null;
    protectionState: string; zone?: { low: number; high: number } | null; frontRunTicks?: number;
    changeRequired?: boolean; referenceTarget?: number; leadDistance?: number; rBasis?: string;
  };

  const openOptimizer = () => {
    const next = recommendation?.target ?? row.target;
    setOptimizerTarget(formatPriceForInput(next, tickSize) || String(next));
    setOptimizerOpen(true);
  };

  const poll = (id: string, attempt = 0) => {
    timer.current = setTimeout(async () => {
      try {
        const response = await fetch(`/api/smc-position-action?id=${encodeURIComponent(id)}`, { cache: "no-store" });
        const result = await response.json() as { status?: string; result?: { reason?: string } };
        if (result.status === "COMPLETED") {
          setState({ tone: "ok", text: result.result?.reason === "STOP_PLAN_ARMED" ? "计划已保存，等待到价触发"
            : result.result?.reason === "STOP_PLAN_CANCELLED" ? "计划已取消" : "已完成" });
          onRefresh(); return;
        }
        if (result.status === "SUBMITTED") {
          setState({ tone: "pending", text: "交易所处理中", id });
          onRefresh();
        }
        if (["REJECTED", "EXPIRED"].includes(result.status ?? "")) {
          const reason = result.result?.reason ?? result.status ?? "REJECTED";
          setState({ tone: "error", text: messages[reason] ?? reason }); return;
        }
      } catch { /* bounded retry below */ }
      if (attempt < 12) poll(id, attempt + 1);
      else setState({ tone: "error", text: "执行回执超时，请刷新确认持仓" });
    }, attempt < 3 ? 1200 : 2500);
  };

  const submit = async (payload: Record<string, unknown>, label: string) => {
    if (!enabled || state.tone === "pending") return false;
    setState({ tone: "pending", text: label });
    try {
      const id = crypto.randomUUID();
      const response = await fetch("/api/smc-position-action", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, planId: row.planId, symbol: row.symbol, direction: row.direction, ...payload }) });
      const result = await response.json() as { status?: string; id?: string };
      if (!response.ok || !result.id) throw new Error(result.status ?? "REJECTED");
      setState({ tone: "pending", text: "执行器处理中", id: result.id });
      poll(result.id);
      return true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "REJECTED";
      setState({ tone: "error", text: messages[reason] ?? reason });
      return false;
    }
  };

  const reduce = (percent: number) => submit({ action: "REDUCE", fractionBps: percent * 100 },
    percent === 100 ? "正在全平" : `正在减仓 ${percent}%`);
  const submitStop = () => {
    const normalized = normalizePriceByPurpose(stop, tickSize, row.direction, "STOP");
    if (!normalized) { setState({ tone: "error", text: "交易所报价精度尚未同步" }); return; }
    setStop(normalized);
    void submit({ action: "TIGHTEN_STOP", stopPrice: Number(normalized) }, "正在更新止损");
  };
  const submitTarget = () => {
    const normalized = normalizePriceByPurpose(target, tickSize, row.direction, "TARGET");
    if (!normalized) { setState({ tone: "error", text: "交易所报价精度尚未同步" }); return; }
    setTarget(normalized);
    void submit({ action: "UPDATE_TARGET", targetPrice: Number(normalized) }, "正在更新止盈");
  };
  const submitOptimizerTarget = async (value: string | number, label: string) => {
    const normalized = normalizePriceByPurpose(value, tickSize, row.direction, "TARGET");
    if (!normalized) { setState({ tone: "error", text: "交易所报价精度尚未同步" }); return; }
    setTarget(normalized); setOptimizerTarget(normalized);
    if (await submit({ action: "UPDATE_TARGET", targetPrice: Number(normalized) }, label)) setOptimizerOpen(false);
  };
  const submitStopPlan = () => {
    const normalized = planStopMode === "FIXED" ? normalizePriceByPurpose(planStop, tickSize, row.direction, "STOP") : null;
    if (!(Number(triggerPrice) > 0) || planStopMode === "FIXED" && !normalized) {
      setState({ tone: "error", text: "请填写有效的触发价和目标止损价" }); return;
    }
    const expiry = planExpiry ? new Date(planExpiry).getTime() : null;
    if (expiry !== null && !(expiry > Date.now())) { setState({ tone: "error", text: "到期时间须晚于当前时间" }); return; }
    void submit({ action: "ARM_STOP_PLAN", comparison: triggerComparison, triggerPrice: Number(triggerPrice),
      stopMode: planStopMode, stopPrice: normalized ? Number(normalized) : null, planExpiresAt: expiry }, "正在保存移动止损计划");
  };

  const optimizerStatus = ({ QUOTE_STALE: "实时盘口已过期，暂不生成推荐", QUOTE_INVALID: "实时盘口不可用",
    PRICE_PRECISION_UNAVAILABLE: "交易所报价精度尚未同步", NO_STRUCTURAL_EXIT: "前方暂无可验证的同源结构出口",
    POSITION_INVALID: "持仓数据尚未完整同步" } as Record<string, string>)[optimizer.status] ?? "等待结构出口";

  return <div className={styles.controls} aria-label={`${row.symbol} 持仓操作`}>
    <div className={styles.reduceRow}>
      <button type="button" onClick={() => reduce(25)} disabled={!enabled || state.tone === "pending"}>减仓 25%</button>
      <button type="button" onClick={() => reduce(50)} disabled={!enabled || state.tone === "pending"}>减仓 50%</button>
      <button type="button" className={styles.closeAll} onClick={() => reduce(100)} disabled={!enabled || state.tone === "pending"}>全部平仓</button>
    </div>
    <MonitorDisclosure className={styles.management} summary={<>管理持仓<span>止盈止损 · 移动止损</span></>}>
    <div className={styles.managementBody}>
    <div className={styles.optimizerEntry}>
      <div><span>持仓后优化</span><small>{recommendation ? `${recommendation.changeRequired === false ? "当前止盈无需调整" : recommendation.label} · 距现价 ${recommendation.distancePercent.toFixed(2)}%` : optimizerStatus}</small></div>
      <button type="button" onClick={openOptimizer} disabled={!enabled || state.tone === "pending"}>优化出场</button>
    </div>
    <div className={styles.customReduce}>
      <label htmlFor={`reduce-${row.planId}`}>自定义减仓</label>
      <select id={`reduce-${row.planId}`} value={fraction} onChange={event => setFraction(event.target.value)} disabled={!enabled || state.tone === "pending"}>
        {[10,25,50,75,100].map(value => <option key={value} value={value}>平 {value}%</option>)}
      </select>
      <button type="button" onClick={() => reduce(Number(fraction))} disabled={!enabled || state.tone === "pending"}>执行减仓</button>
    </div>
    <div className={styles.priceRow}>
      <div className={styles.priceControl}>
        <header><span>修改止损</span><small>{row.direction === "LONG" ? `高于 ${row.stop}` : `低于 ${row.stop}`}</small></header>
        <div><PriceDigitInput aria-label={`${row.symbol} 新止损价`} tickSize={tickSize} value={stop}
          onValueChange={setStop} onBlur={() => setStop(normalizePriceByPurpose(stop, tickSize, row.direction, "STOP") ?? stop)} disabled={!enabled || state.tone === "pending"} />
        <button type="button" onClick={submitStop} disabled={!enabled || state.tone === "pending"}>更新止损</button></div>
      </div>
      <div className={styles.priceControl}>
        <header><span>修改止盈</span><small>{row.targetSource === "OWNER_OVERRIDE" ? "手动目标" : "结构目标"}</small></header>
        <div><PriceDigitInput aria-label={`${row.symbol} 新止盈价`} tickSize={tickSize} value={target}
          onValueChange={setTarget} onBlur={() => setTarget(normalizePriceByPurpose(target, tickSize, row.direction, "TARGET") ?? target)} disabled={!enabled || state.tone === "pending"} />
        <button type="button" onClick={submitTarget} disabled={!enabled || state.tone === "pending"}>更新止盈</button></div>
      </div>
    </div>
    <MonitorDisclosure className={styles.stopPlans} summary={<>移动止损计划<span>{(row.stopPlans ?? []).filter(p => ["ARMED","TRIGGERED","WAIT_PRICE","SUBMITTED"].includes(p.status)).length} 待执行</span></>}>
      <p>到价后再移动止损，可分段添加。多仓按 BID、空仓按 ASK 触发。保本价使用开仓均价，未含手续费。</p>
      <div className={styles.stopPlanForm}>
        <label>价格条件<select value={triggerComparison} onChange={e => setTriggerComparison(e.target.value)}><option value="GTE">上涨至 ≥</option><option value="LTE">下跌至 ≤</option></select></label>
        <label>触发价<PriceDigitInput aria-label="移动止损触发价" tickSize={tickSize} value={triggerPrice} onValueChange={setTriggerPrice} /></label>
        <label>止损移动至<select value={planStopMode} onChange={e => setPlanStopMode(e.target.value)}><option value="ENTRY">开仓均价 {row.entry}</option><option value="FIXED">指定价格</option></select></label>
        {planStopMode === "FIXED" && <label>目标止损<PriceDigitInput aria-label="计划目标止损价" tickSize={tickSize} value={planStop} onValueChange={setPlanStop} /></label>}
        <label>到期时间（可留空）<input type="datetime-local" value={planExpiry} onChange={e => setPlanExpiry(e.target.value)} /></label>
        <button type="button" disabled={!enabled || state.tone === "pending"} onClick={submitStopPlan}>添加计划</button>
      </div>
      {(row.stopPlans ?? []).slice().reverse().map(p => <div className={styles.stopPlanItem} key={p.id}>
        <span>{p.comparison === "GTE" ? "≥" : "≤"} {p.triggerPrice} → 止损 {p.stopPrice}<small>{({ ARMED: "等待到价", TRIGGERED: "已触发", WAIT_PRICE: "已触发，等待可设置价格", SUBMITTED: "交易所处理中", COMPLETED: "已完成", CANCELLED: "已取消", EXPIRED: "已过期", POSITION_CLOSED: "持仓已平" } as Record<string,string>)[p.status]}</small></span>
        {["ARMED","TRIGGERED","WAIT_PRICE"].includes(p.status) && <button type="button" disabled={!enabled || state.tone === "pending"} onClick={() => void submit({ action: "CANCEL_STOP_PLAN", stopPlanId: p.id }, "正在取消计划")}>取消</button>}
      </div>)}
    </MonitorDisclosure>
    <p className={styles.planReference}>开仓 {new Date(row.openedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })} · {row.planId}</p>
    </div>
    </MonitorDisclosure>
    {!!state.text && <p className={styles.status} data-tone={state.tone} role={state.tone === "error" ? "alert" : "status"}>
      <i />{state.text}</p>}
    <dialog ref={optimizerDialog} className={styles.optimizerBackdrop}
      style={optimizerViewport.height ? { height: `${optimizerViewport.height}px`, top: `${optimizerViewport.top}px` } : undefined}
      onCancel={event => { event.preventDefault(); setOptimizerOpen(false); }}
      onPointerDown={event => { if (event.target === event.currentTarget) setOptimizerOpen(false); }}>
      <section className={styles.optimizerModal} role="dialog" aria-modal="true" aria-labelledby={`exit-optimizer-${row.planId}`}>
        <header className={styles.optimizerHead}><div><small>POSITION EXIT OPTIMIZER</small><h3 id={`exit-optimizer-${row.planId}`}>出场优化</h3></div><button ref={optimizerClose} type="button" aria-label="关闭出场优化" onClick={() => setOptimizerOpen(false)}>×</button></header>
        <div className={styles.optimizerBody}>
        <div className={styles.optimizerSymbol}><div><b>{row.symbol}</b><em data-dir={row.direction}>{row.direction === "LONG" ? "做多" : "做空"}</em></div><strong>{optimizer.market ? formatPriceForInput(optimizer.market, tickSize) : "—"}</strong></div>
        {recommendation ? <>
          <div className={styles.recommendationHero}><small>{recommendation.changeRequired === false ? "保持当前止盈" : "建议止盈"}</small><strong>{formatPriceForInput(recommendation.target, tickSize)}</strong><span data-confidence={recommendation.confidence}>{recommendation.confidence === "HIGH" ? "高确信" : "中等确信"}</span><p>{recommendation.label}</p></div>
          <dl className={styles.optimizerMetrics}>
            <div><dt>当前止盈</dt><dd>{formatPriceForInput(row.target, tickSize)}</dd></div>
            <div><dt>距现价</dt><dd>{recommendation.distancePercent.toFixed(2)}%</dd></div>
            <div><dt>成本后计划R</dt><dd>{recommendation.protectionState === "PROFIT_LOCKED" ? "止损已锁盈" : recommendation.currentStopR == null ? "—" : `${recommendation.currentStopR.toFixed(2)}R`}</dd></div>
          </dl>
          <p className={styles.optimizerEvidence}>{recommendation.changeRequired === false && recommendation.zone
            ? `当前止盈已在 ${formatPriceForInput(recommendation.zone.low, tickSize)}–${formatPriceForInput(recommendation.zone.high, tickSize)} 结构区前方，领先参考出口 ${formatPriceForInput(recommendation.referenceTarget, tickSize)} ${recommendation.leadDistance ? `约 ${formatPriceForInput(recommendation.leadDistance, tickSize)}` : ""}，无需重复提交。`
            : recommendation.zone ? `目标置于 ${formatPriceForInput(recommendation.zone.low, tickSize)}–${formatPriceForInput(recommendation.zone.high, tickSize)} 结构区前沿，并提前 ${recommendation.frontRunTicks ?? 0} ticks。成本后R包含预估平仓手续费。`
            : "没有可验证的对向结构区，不把原止盈包装成新建议。"}</p>
          {recommendation.changeRequired === false
            ? <div className={styles.noChange}>✓ 当前止盈已在有效结构出口之前</div>
            : <button className={styles.adoptButton} type="button" disabled={!enabled || state.tone === "pending"} onClick={() => void submitOptimizerTarget(recommendation.target, "正在采纳优化止盈")}>一键采纳 {formatPriceForInput(recommendation.target, tickSize)}</button>}
        </> : <div className={styles.optimizerEmpty}><b>暂不生成系统目标</b><span>{optimizerStatus}</span><small>不会把无关结构或已反复回补的区域拼成止盈建议。</small></div>}
        <div className={styles.manualExit}><header><span>手动止盈</span><small>仍由最新盘口与执行器复核</small></header><div><PriceDigitInput aria-label={`${row.symbol} 优化止盈价`} tickSize={tickSize} value={optimizerTarget} onValueChange={setOptimizerTarget} onBlur={() => setOptimizerTarget(normalizePriceByPurpose(optimizerTarget, tickSize, row.direction, "TARGET") ?? optimizerTarget)} disabled={!enabled || state.tone === "pending"} /><button type="button" disabled={!enabled || state.tone === "pending"} onClick={() => void submitOptimizerTarget(optimizerTarget, "正在更新手动止盈")}>更新</button></div></div>
        </div>
        <footer>只修改当前仓位止盈 · 不改变止损、仓位数量或自动交易状态</footer>
      </section>
    </dialog>
  </div>;
}
