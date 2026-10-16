"use client";

import { useEffect, useRef, useState } from "react";
import type { Direction, LedgerAccount, LedgerPendingEntry, SmcLedger, StopSafetyContext, StructurePlan } from "./types";
import { estimateManualOrder, validateManualOrderPrices } from "../../../lib/smc-manual-order-estimate.mjs";
import { formatPriceForDisplay, formatPriceForInput, normalizePriceByPurpose, priceInputStep } from "../../../lib/smc-price-input.mjs";
import PriceDigitInput from "./PriceDigitInput";
import { manualReceiptLabel } from "../../../lib/smc-manual-receipt.mjs";
import styles from "./manual-order.module.css";

export type ManualOrderContext = { symbol: string; direction: Direction; source: "ACTIVE_CANDIDATE" | "RECENT_INVALIDATION" | "MANUAL_CANDIDATE";
  sourceId: string; referenceEntry: number; stop: number; target: number; detail: string; preferredOrderMode?: "IMMEDIATE" | "LIMIT_GTC"; plannedZone?: { low: number; high: number } };
type Quote = { price: number; quoteAt: number; live: boolean };
type Props = {
  tradePlans?: StructurePlan[];
  stopContext?: StopSafetyContext | null;
  candidate: ManualOrderContext;
  quote: Quote | null;
  accountFresh: boolean;
  liveReady: boolean;
  entriesAllowed: boolean;
  manualEntriesEnabled: boolean;
  now: number;
  account: LedgerAccount | null | undefined;
  positions: NonNullable<SmcLedger["snapshot"]>["positions"];
  pendingEntries: LedgerPendingEntry[];
  riskPolicy: Record<string, string | number> | null;
  tickSize: string | null;
  onClose: () => void;
};

const number = (value: number, digits = 2) => Number.isFinite(value) ? new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value) : "—";
const validationMessage: Record<string, string> = {
  ENTRY_INVALID: "预计入场价不可用",
  STOP_INVALID: "请输入有效保护止损",
  TARGET_INVALID: "请输入有效止盈价",
  LONG_STOP_DIRECTION: "做多止损必须低于预计入场价",
  SHORT_STOP_DIRECTION: "做空止损必须高于预计入场价",
  LONG_TARGET_DIRECTION: "做多止盈必须高于预计入场价",
  SHORT_TARGET_DIRECTION: "做空止盈必须低于预计入场价",
};

export default function ManualOrderPanel({ candidate, quote, accountFresh, liveReady, entriesAllowed, manualEntriesEnabled, now, account, positions, pendingEntries, riskPolicy, tickSize, stopContext, tradePlans, onClose }: Props) {
  const [step, setStep] = useState<"ticket" | "review">("ticket");
  const [orderMode, setOrderMode] = useState<"IMMEDIATE" | "LIMIT_GTC">(candidate.preferredOrderMode ?? "IMMEDIATE");
  const [limitPrice, setLimitPrice] = useState(() => formatPriceForInput(candidate.preferredOrderMode === "LIMIT_GTC" ? candidate.referenceEntry : quote?.price ?? candidate.referenceEntry, tickSize)
    || String(candidate.preferredOrderMode === "LIMIT_GTC" ? candidate.referenceEntry : quote?.price ?? candidate.referenceEntry));
  const [stop, setStop] = useState(() => formatPriceForInput(candidate.stop, tickSize) || String(candidate.stop));
  const [targetMode, setTargetMode] = useState<"structure" | "manual">(candidate.target > 0 ? "structure" : "manual");
  const [target, setTarget] = useState(() => candidate.target > 0 ? (formatPriceForInput(candidate.target, tickSize) || String(candidate.target)) : "");
  const [submitting, setSubmitting] = useState(false);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [orderStatus, setOrderStatus] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ status: string; executionState?: string; quantity?: number; entry?: number; result?: { reason?: string } } | null>(null);
  const [canRetrySame, setCanRetrySame] = useState(false);
  const requestRef = useRef<Record<string, unknown> | null>(null);
  const storageKey = `smc-manual-pending:S2:${candidate.symbol}`;
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = previous; window.removeEventListener("keydown", onKey); };
  }, [onClose]);

  useEffect(() => {
    // Restore asynchronously so remounting a source never creates a second ticket.
    void Promise.resolve().then(() => {
      try {
        const saved = localStorage.getItem(storageKey);
        if (!saved) return;
        const body = JSON.parse(saved);
        if (typeof body.id !== "string" || body.symbol !== candidate.symbol) return;
        const followOnly = body.followOnly || body.direction !== candidate.direction || body.sourceId !== candidate.sourceId;
        requestRef.current = followOnly ? null : body; setCanRetrySame(!followOnly);
        if (!followOnly) {
          setOrderMode(body.orderMode); setStop(body.stopPrice); setTargetMode("manual"); setTarget(body.targetPrice);
          if (body.limitPrice) setLimitPrice(body.limitPrice);
        }
        setOrderId(body.id); setOrderStatus("UNKNOWN"); setReceipt({ status: "UNKNOWN" });
      } catch { /* The API still enforces same-symbol queue uniqueness. */ }
    });
  }, [storageKey, candidate.symbol, candidate.direction, candidate.sourceId]);

  // The source/precision key remounts a fresh ticket; live quote updates preserve owner edits.

  const entry = orderMode === "LIMIT_GTC" ? Number(limitPrice) : (quote?.price ?? candidate.referenceEntry);
  const outsidePlannedZone = !!candidate.plannedZone && (entry < candidate.plannedZone.low || entry > candidate.plannedZone.high);
  const chosenTarget = targetMode === "structure" ? candidate.target : Number(target);
  const priceValidation = validateManualOrderPrices({ direction: candidate.direction, entry, stop: Number(stop), target: chosenTarget });
  const estimate = estimateManualOrder({ direction: candidate.direction, entry, stop: Number(stop), target: chosenTarget,
    equity: account?.equity ?? 0, available: account?.available ?? 0,
    committedRisk: positions.reduce((sum, row) => sum + row.initialRiskUsdt, 0)
      + pendingEntries.reduce((sum, row) => sum + row.initialRiskUsdt, 0),
    committedNotional: positions.reduce((sum, row) => sum + row.quantity * row.entry, 0)
      + pendingEntries.reduce((sum, row) => sum + row.grossNotionalUsdt, 0),
    perTradeRiskFraction: Number(riskPolicy?.perTradeFraction ?? .04),
    portfolioRiskFraction: Number(riskPolicy?.portfolioFraction ?? .10),
    maximumGrossNotionalLeverage: Number(riskPolicy?.maximumGrossNotionalLeverage ?? 25),
    maximumLeverage: Number(riskPolicy?.maximumLeverage ?? 25),
    stopContext, tradePlans, orderMode, symbol: candidate.symbol, now, livePrice: quote?.price ?? entry });
  const riskEstimateReady = priceValidation.valid && estimate?.stopSafety.ready === true;
  const priceBlocker = priceValidation.valid ? null : validationMessage[priceValidation.code ?? ""] ?? "止损或止盈价格无效";
  const rewardBlocker = priceValidation.valid && estimate && estimate.netR <= 0 ? "止盈必须覆盖执行成本" : null;
  const capacityBlocker = !estimate || estimate.quantity > 0 ? null
    : estimate.limitingCapacity === "PORTFOLIO_RISK"
      ? `组合风险额度已满 · ${number(estimate.committedRisk)} / ${number(estimate.portfolioRiskLimit)} USDT`
      : estimate.limitingCapacity === "GROSS_NOTIONAL"
        ? `组合仓位额度已满 · ${number(estimate.committedNotional)} / ${number(estimate.grossNotionalLimit)} USDT`
        : estimate.limitingCapacity === "AVAILABLE_MARGIN"
          ? `可用保证金不足 · ${number(account?.available ?? 0)} USDT`
          : "当前容量不足，无法生成有效数量";
  const gates = [
    { pass: priceInputStep(tickSize) !== "any", label: "交易所报价精度尚未同步" },
    { pass: accountFresh && liveReady && entriesAllowed && manualEntriesEnabled, label: "人工下单执行器尚未就绪" },
    { pass: quote?.live === true && now - quote.quoteAt <= 10000, label: "实时盘口不可用" },
    { pass: estimate?.stopSafety.ready === true, label: estimate?.stopSafety.reason === "SMC_STOP_ENTRY_BEYOND_STRUCTURE" ? "入场价已越过所依据的结构保护点，请等待重新形成结构" : estimate?.stopSafety.reason === "SMC_STOP_INSIDE_STRUCTURE" ? "止损尚未越过对应级别的结构保护点，请调整止损并重新核算仓位" : estimate?.stopSafety.reason === "SMC_STOP_STRUCTURE_UNAVAILABLE" ? "结构止损依据未确认，等待新鲜结构" : estimate?.stopSafety.reason === "SMC_STOP_NOISE_UNSAFE" ? "止损距离不足以覆盖正常波动或执行成本，请调整入场与止损" : estimate?.stopSafety.reason === "SMC_STOP_INSIDE_LIQUIDITY" ? "止损位于附近未扫流动性范围内，请调整止损" : "止损安全检查未通过，等待新鲜结构与盘口" },
    { pass: !priceBlocker, label: priceBlocker ?? "价格方向有效" },
    { pass: !rewardBlocker && !capacityBlocker && !!estimate && estimate.quantity > 0, label: rewardBlocker ?? capacityBlocker ?? "订单容量有效" },
    { pass: !positions.some(row => row.symbol === candidate.symbol), label: "该币种已有持仓，请勿重复开仓" },
    { pass: pendingEntries.length === 0, label: "已有待成交挂单，请先在币安撤单或等待成交" },
  ];
  const firstBlocker = gates.find(gate => !gate.pass)?.label ?? null;
  const marketableLimit = orderMode === "LIMIT_GTC" && quote?.live === true
    && (candidate.direction === "LONG" ? entry >= quote.price : entry <= quote.price);

  useEffect(() => {
    if (!orderId || !["QUEUED", "RECEIVED", "UNKNOWN", "SUBMITTED"].includes(orderStatus ?? "")) return;
    let active = true;
    const timer = setInterval(async () => {
      try {
        const response = await fetch(`/api/smc-manual-order?id=${encodeURIComponent(orderId)}`, { cache: "no-store" });
        const result = await response.json();
        if (response.ok && active) {
          setOrderStatus(result.status); setReceipt(result);
          if (["REJECTED", "NO_FILL", "EXPIRED"].includes(result.status) || result.executionState === "FILLED" || result.executionState === "RESTING")
            try { localStorage.removeItem(storageKey); } catch { /* Nonessential storage. */ }
        }
      } catch { /* Keep the visible last state; the order ID remains queryable. */ }
    }, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [orderId, orderStatus, storageKey]);

  async function submit() {
    if (submitting || firstBlocker || (orderId && !requestRef.current)) return;
    setSubmitting(true);
    try {
      let body = requestRef.current;
      if (!body) {
        const normalizedLimit = orderMode === "LIMIT_GTC"
          ? normalizePriceByPurpose(limitPrice, tickSize, candidate.direction, "ENTRY") : null;
        const normalizedStop = normalizePriceByPurpose(stop, tickSize, candidate.direction, "STOP");
        const normalizedTarget = normalizePriceByPurpose(chosenTarget, tickSize, candidate.direction, "TARGET");
        if (!normalizedStop || !normalizedTarget || (orderMode === "LIMIT_GTC" && !normalizedLimit)) return;
        body = { schema: "SMC_OWNER_MANUAL_INTENT_V2", id: crypto.randomUUID(), symbol: candidate.symbol,
          direction: candidate.direction, source: candidate.source, sourceId: candidate.sourceId,
          orderMode, limitPrice: normalizedLimit, stopPrice: normalizedStop, targetPrice: normalizedTarget };
        requestRef.current = body; setCanRetrySame(true);
      }
      const id = String(body.id);
      setOrderId(id); setOrderStatus("UNKNOWN"); setReceipt({ status: "UNKNOWN" });
      try { localStorage.setItem(storageKey, JSON.stringify(body)); } catch { /* Same ID stays in memory. */ }
      const response = await fetch("/api/smc-manual-order", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body) });
      const result = await response.json();
      if (result.status === "PENDING_MANUAL_ORDER" && result.id) {
        const resumed = { ...body, id: result.id };
        // Follow the existing ticket; never retry it using this new ticket's prices.
        requestRef.current = null; setCanRetrySame(false);
        try { localStorage.setItem(storageKey, JSON.stringify({ id: result.id, symbol: candidate.symbol, followOnly: true })); } catch { /* Nonessential storage. */ }
        setOrderId(String(resumed.id)); setOrderStatus(result.orderStatus); setReceipt({ status: result.orderStatus });
      } else if (response.ok) {
        setOrderStatus(result.status); setReceipt(result);
        if (["REJECTED", "NO_FILL", "EXPIRED"].includes(result.status) || result.executionState)
          try { localStorage.removeItem(storageKey); } catch { /* Nonessential storage. */ }
      } else if (response.status < 500) {
        setOrderStatus("REJECTED"); setReceipt({ status: "REJECTED", result: { reason: result.status } });
        try { localStorage.removeItem(storageKey); } catch { /* Nonessential storage. */ }
      }
    } catch { setOrderStatus("UNKNOWN"); setReceipt({ status: "UNKNOWN" }); }
    finally { setSubmitting(false); }
  }

  const receiptText = receipt ? `订单 ${orderId?.slice(0, 8) ?? ""} · ${manualReceiptLabel(receipt)}` : null;
  const retrySame = orderStatus === "UNKNOWN" && canRetrySame;

  return <div className={styles.backdrop} onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className={styles.sheet} role="dialog" aria-modal="true" aria-labelledby="manual-order-title">
      <header className={styles.head}>
        <div><small>SMC · MANUAL INTERVENTION</small><h2 id="manual-order-title">{step === "ticket" ? "手动下单" : "订单预览"}</h2></div>
        <button ref={closeRef} className={styles.close} type="button" aria-label="关闭下单面板" onClick={onClose}>×</button>
      </header>
      <div className={styles.body}>
        <div className={styles.instrument}><span className={styles.icon}>{candidate.symbol.slice(0, 1)}</span><div><strong>{candidate.symbol}</strong><small>{candidate.direction === "LONG" ? "LONG · 做多" : "SHORT · 做空"} · {candidate.detail}</small></div><b>{formatPriceForDisplay(entry, tickSize)}</b></div>
        {step === "ticket" ? <>
          <div className={styles.orderMode} role="group" aria-label="订单类型"><button type="button" data-active={orderMode === "IMMEDIATE"} disabled={!!orderId} onClick={() => setOrderMode("IMMEDIATE")}><b>即时</b><small>按实时盘口成交</small></button><button type="button" data-active={orderMode === "LIMIT_GTC"} disabled={!!orderId} onClick={() => setOrderMode("LIMIT_GTC")}><b>限价挂单</b><small>GTC · 取消前有效</small></button></div>
          <div className={styles.formGrid} data-limit={orderMode === "LIMIT_GTC"}>
            {orderMode === "LIMIT_GTC" && <label>目标成交价 <PriceDigitInput name="smc-limit-entry" disabled={!!orderId} autoComplete="off" tickSize={tickSize} value={limitPrice} onValueChange={setLimitPrice} onBlur={() => setLimitPrice(normalizePriceByPurpose(limitPrice, tickSize, candidate.direction, "ENTRY") ?? limitPrice)} /></label>}
            <label>{riskEstimateReady ? "保护止损" : "止损价格 · 待核验"} <PriceDigitInput name="smc-stop" disabled={!!orderId} autoComplete="off" tickSize={tickSize} value={stop} onValueChange={setStop} onBlur={() => setStop(normalizePriceByPurpose(stop, tickSize, candidate.direction, "STOP") ?? stop)} /></label>
            <div className={styles.targetField}><label htmlFor="smc-manual-target">止盈设置</label><div className={styles.segmented}><button type="button" disabled={!!orderId || candidate.target <= 0} title={candidate.target > 0 ? undefined : "结构目标仍在定位"} data-active={targetMode === "structure"} onClick={() => setTargetMode("structure")}>{candidate.source === "RECENT_INVALIDATION" ? "原目标参考" : "结构目标参考"}</button><button type="button" data-active={targetMode === "manual"} disabled={!!orderId} onClick={() => setTargetMode("manual")}>手动输入</button></div><PriceDigitInput id="smc-manual-target" name="smc-target" autoComplete="off" enterKeyHint="done" tickSize={tickSize} value={targetMode === "structure" ? (formatPriceForInput(candidate.target, tickSize) || String(candidate.target)) : target} disabled={!!orderId || targetMode === "structure"} onValueChange={setTarget} onBlur={() => setTarget(normalizePriceByPurpose(target, tickSize, candidate.direction, "TARGET") ?? target)} /></div>
          </div>
          <div className={styles.metrics}><div><span>预计数量</span><b>{riskEstimateReady && estimate ? `≈ ${number(estimate.quantity, 5)}` : "待保护确认"}</b></div><div><span>最大风险估算</span><b>{riskEstimateReady && estimate ? `${number(estimate.estimatedLoss)} USDT` : "待核算"}</b></div><div><span>当前入场净 R 估算</span><b data-valid={riskEstimateReady && !!estimate && estimate.netR > 0}>{riskEstimateReady && estimate ? `${number(estimate.netR)}R` : "待保护确认"}</b></div></div>
          <p className={styles.context}>按账户权益 {number((estimate?.perTradeRiskFraction ?? .04) * 100, 1)}% 单笔风险、{number((estimate?.portfolioRiskFraction ?? .10) * 100, 1)}% 组合风险和 {number(estimate?.maximumGrossNotionalLeverage ?? 25, 0)}× 总敞口估算。此处每侧费用与普通滑点合计 {estimate?.costModel.feePlusSlippageBpsPerSide ?? 8}bp，止损滑点另按10bp预留、资金费预留 {estimate?.costModel.fundingReserveBps ?? 2}bp；实际数量和净 R 以执行器按最新价格及账户费率重算为准。</p>
          {orderMode === "LIMIT_GTC" && <p className={styles.limitNote} data-marketable={marketableLimit}>{marketableLimit ? "此限价已穿过实时盘口，提交后可能立即成交。" : "原生 Binance GTC 挂单；未成交风险会被预留，结构失效、风控不再满足或安全有效期结束后，由执行器撤销未成交部分。"}</p>}
          <div className={styles.gate} data-ready={!firstBlocker}><i />{receiptText ?? firstBlocker ?? (orderMode === "LIMIT_GTC" ? "可提交；执行器将按挂单价重算并复核" : "可提交；执行器将按最新盘口重算并复核")}</div>
        </> : <>
          <dl className={styles.review}><div><dt>订单类型</dt><dd>{orderMode === "LIMIT_GTC" ? "限价挂单 · GTC" : "即时 · IOC"}</dd></div><div><dt>{orderMode === "LIMIT_GTC" ? "挂单价" : "预计入场"}</dt><dd>{formatPriceForDisplay(entry, tickSize)}{orderMode === "IMMEDIATE" ? ` · ${candidate.direction === "LONG" ? "ASK" : "BID"}` : ""}</dd></div><div><dt>{riskEstimateReady ? "保护止损" : "止损价格 · 待核验"}</dt><dd>{formatPriceForDisplay(stop, tickSize)}</dd></div><div><dt>止盈目标</dt><dd>{formatPriceForDisplay(chosenTarget, tickSize)} · {targetMode === "structure" ? "结构参考" : "手动"}</dd></div><div><dt>预计数量</dt><dd>{riskEstimateReady && estimate ? `≈ ${number(estimate.quantity, 5)}` : "待保护确认"}</dd></div><div><dt>风险 / 净 R</dt><dd>{riskEstimateReady && estimate ? `${number(estimate.estimatedLoss)} USDT` : "待核算"} / {riskEstimateReady && estimate ? `${number(estimate.netR)}R` : "待保护确认"}</dd></div></dl>
          <div className={styles.gate} data-ready={!firstBlocker}><i />{receiptText ?? firstBlocker ?? (orderMode === "LIMIT_GTC" ? "可提交；执行器将按挂单价重算并复核" : "可提交；执行器将按最新盘口重算并复核")}</div>
        </>}
        {riskEstimateReady && estimate && estimate.netR > 0 && !estimate.automaticNetRThresholdMet && <p className={styles.context}>当前入场估算不足净 2R；仅供所有者手动介入，自动交易仍要求净 R ≥ 2。</p>}
        {!riskEstimateReady && <p className={styles.context}>止损尚未通过结构与波动核验。价格可继续调整；保护确认后显示净R和仓位估算。</p>}
        {outsidePlannedZone && <p className={styles.context}>当前入场已偏离原方案区间，须按当前价格重新核验保护和净R。</p>}
      </div>
      <footer className={styles.actions}>
        {step === "ticket" ? <><button type="button" className={styles.secondary} disabled={!!firstBlocker || !estimate} onClick={() => setStep("review")}>预览订单</button><button type="button" className={styles.primary} disabled={!!firstBlocker || submitting || (!!orderId && !retrySame)} onClick={submit}>{retrySame ? "重试同一指令" : orderMode === "LIMIT_GTC" ? "提交挂单" : "⚡ 闪电下单"}</button></>
          : <><button type="button" className={styles.secondary} onClick={() => setStep("ticket")}>返回修改</button><button type="button" className={styles.primary} disabled={!!firstBlocker || submitting || (!!orderId && !retrySame)} onClick={submit}>{retrySame ? "重试同一指令" : orderMode === "LIMIT_GTC" ? "确认挂单" : "确认下单"}</button></>}
        <small>{orderId ? `指令编号 ${orderId} · 请以成交账本为准` : orderMode === "LIMIT_GTC" ? "数量按挂单价与止损距离计算；成交后由执行器接管止损与止盈。" : "下单数量按最新盘口由单一执行器计算；止损与止盈由执行器复核。"}</small>
      </footer>
    </section>
  </div>;
}
