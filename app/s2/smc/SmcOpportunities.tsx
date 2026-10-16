"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import policy from "../../../lib/smc-scan-policy.json";
import { formatSignedEntryPercent, signedEntryBandDistance } from "../../../lib/smc-distance-display.mjs";
import styles from "./smc-opportunities.module.css";

type CeTouch = { source: "CLOSED_15M_BODY_CROSS" | "CLOSED_15M_WICK_RECLAIM" | "CLOSED_15M_FALSE_BREAK_RECLAIM"; testedAt: number; trigger: number; extreme: number; open: number; close: number; falseBreakAt?: number | null };
type Opportunity = {
  id: string; symbol: string; direction: "LONG" | "SHORT"; status: string; entry: number; stop: number; target: number; netR: number; observedAt: number; expiresAt: number;
  referenceEntry: number; entryBand: { low: number; high: number; ce: number; trigger: number; triggerFraction: .5; zoneFraction: .5; half: "CE_TO_FVG_HIGH" | "FVG_LOW_TO_CE" };
  zone: { kind: string; low: number; high: number; ce?: number };
  structure: { eventType: "BOS" | "CHOCH" | "MSS"; priorBias: string; bosAt: number; bosClose: number; volumeRatio: number; bodyFraction: number; bodyAtr?: number; qualityGrade?: string; qualityModel?: string; nPatternQualified?: boolean };
  entryConfirmation?: { state: string; mode: "CLOSED_15M_POST_TOUCH_MICRO_STRUCTURE_SHIFT" | "CLOSED_15M_SECOND_BAR_CE_REVERSAL"; touchAt: number | null; touchCount: number; ceTouch: CeTouch | null; liveBboInsideBand: boolean; closedBarRequired: true };
  confirmationAt: number | null; quoteFresh?: boolean; executionQualified?: boolean;
  distanceToEntry?: { executablePrice: number; absolute: number; percent: number; quoteAt: number; side: "ASK" | "BID"; basis: string } | null;
};
type StructureObservation = { id: string; symbol: string; direction: "LONG" | "SHORT"; eventType: "BOS" | "CHOCH" | "MSS"; grade: "A" | "B" | "C"; admission: "PLAN_ELIGIBLE" | "OBSERVE_ONLY"; breakAt: number; qualityModel: string; reasons: string[]; nPatternQualified?: boolean };
type ScanResult = { symbol: string; candidates: Opportunity[]; structures: StructureObservation[]; rejected: Record<string, number> };
type Scan = { status: string; sourceAsOf: string; scannedSymbols: number; universe: string[]; candidates: Opportunity[]; errors: { symbol: string; reason: string }[]; results: ScanResult[] };
type JevCandidate = { id: string; researchState: string; probability: number | null };
type JevObservation = { observerRevision: string; mode: "OBSERVE_ONLY"; orderAuthority: false; sourceStatus: string; candidates: JevCandidate[]; research: { frozenCount: number; promotionReviewMinimumIndependentOutcomes: number } };
type ExecutionContext = { liveReady: boolean; entriesAllowed: boolean; positions: number; orders: number; accountFresh: boolean; riskPolicy: Record<string, string | number> | null };

const time = (value: number | string | null | undefined, seconds = false) => value == null ? "—" : new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: seconds ? "2-digit" : undefined, hour12: false }).format(new Date(value));
const price = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "—" : new Intl.NumberFormat("en-US", { maximumFractionDigits: value >= 1000 ? 2 : value >= 10 ? 4 : 6 }).format(value);
const waitingStatus: Record<string, string> = { ARMED_CE_CLOSE: "等待 CE 触及", WAIT_15M_MICRO_STRUCTURE_SHIFT: "CE 已触及，等待 15M 微结构位移", WAIT_CE_REENTRY: "位移已确认，等待回到执行带", WAIT_LIQUIDITY_SWEEP_RECLAIM: "等待清扫内部流动性并收回", WAIT_VALUE_LOCATION: "位置不具优势", WAIT_15M_EXPANSION_CONFIRMATION: "等待脱离压缩", ENTRY_BAND_ACTIVE: "位移确认且价格在执行带" };
const nextActions: Record<string, string> = { ARMED_CE_CLOSE: "等待价格测试 CE", WAIT_15M_MICRO_STRUCTURE_SHIFT: "触及后 4 根 15M 内等待收盘突破前 2 根内部极值", WAIT_CE_REENTRY: "不追价，等待实时盘口回到方向侧半区", WAIT_LIQUIDITY_SWEEP_RECLAIM: "先清扫 CE 与止损间的确认摆点，再收回方向侧", WAIT_VALUE_LOCATION: "拒绝在原始或稳健区间的相对高位追多/低位追空", WAIT_15M_EXPANSION_CONFIRMATION: "等待15M方向位移确认", ENTRY_BAND_ACTIVE: "立即进行账户风险、报价质量与保护单预检" };
const rejectedLabels: Record<string, string> = { NO_FVG: "无有效FVG", FVG_INVALIDATED: "FVG失效", NET_R_BELOW_2: "净R不足", N_PATTERN_NET_R_BELOW_2: "N结构净R不足", NO_UNSWEPT_STRUCTURE_TARGET: "无未扫目标", PROTECTED_STRUCTURE_BROKEN: "结构失效", STRUCTURE_OUTSIDE_ACTIVE_PLAN_HORIZON: "超出14天计划窗口", N_PATTERN_OUTSIDE_ACTIVE_PLAN_HORIZON: "N结构超出14天窗口", TARGET_ALREADY_VISITED: "目标已扫", SETUP_EXPIRED: "计划过期" };

function conditionRows(candidate: Opportunity) {
  const confirmation = candidate.entryConfirmation;
  const touched = Boolean(confirmation?.ceTouch) || candidate.status === "ENTRY_BAND_ACTIVE";
  const inBand = candidate.status === "ENTRY_BAND_ACTIVE";
  return [
    { label: `4H 结构有效 · ${candidate.structure.qualityGrade ?? "A/B"}级 ${candidate.structure.nPatternQualified ? "N / BOS" : candidate.structure.eventType}`, state: true, value: `RVOL ${candidate.structure.volumeRatio.toFixed(2)}×` },
    { label: "4H FVG 与结构目标有效", state: true, value: `${price(candidate.zone.low)}–${price(candidate.zone.high)}` },
    { label: "成本后净盈亏比至少 2R", state: candidate.netR >= 2, value: `${candidate.netR.toFixed(2)}R` },
    { label: "FVG CE 已测试", state: touched, value: touched ? (confirmation?.ceTouch?.source === "CLOSED_15M_BODY_CROSS" ? "顺向实体穿越" : confirmation?.ceTouch?.source === "CLOSED_15M_FALSE_BREAK_RECLAIM" ? "二根K假突破收回" : "影线测试后收回") : price(candidate.entryBand.ce) },
    { label: "15M CE 触碰并收在方向侧", state: confirmation?.closedBarRequired === true && touched, value: touched ? "已确认" : "等待收线" },
    { label: `${candidate.distanceToEntry?.side ?? "BBO"} 位于执行带`, state: inBand, value: inBand ? "可成交" : "等待" }
  ];
}

export default function SmcOpportunities({ executionContext }: { executionContext: ExecutionContext }) {
  const [scan, setScan] = useState<Scan | null>(null);
  const [jev, setJev] = useState<JevObservation | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [now, setNow] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
        const [scanResponse, jevResponse] = await Promise.all([fetch("/api/smc-opportunities", { cache: "no-store", signal }), fetch("/api/smc-jev", { cache: "no-store", signal })]);
        if (!scanResponse.ok) throw new Error("SCAN_UNAVAILABLE");
        const [result, jevResult] = await Promise.all([scanResponse.json(), jevResponse.ok ? jevResponse.json() : Promise.resolve({ observation: null })]);
        if (!disposed) { setScan(result.snapshot ?? null); setJev(jevResult.observation ?? null); setFailed(result.status === "STALE"); }
      } catch { if (!disposed) setFailed(true); }
      finally { if (!disposed) { setLoading(false); setNow(Date.now()); timer = setTimeout(poll, 15000); } }
    };
    void poll();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { disposed = true; controller.abort(); clearTimeout(timer); clearInterval(clock); };
  }, [refreshKey]);

  const fresh = !failed && now > 0 && now - Date.parse(scan?.sourceAsOf ?? "") >= -5000 && now - Date.parse(scan?.sourceAsOf ?? "") <= policy.snapshotStaleAfterMs;
  const candidates = useMemo(() => (scan?.candidates ?? []).filter(candidate => candidate.expiresAt > now).sort((a, b) => Number(b.status === "ENTRY_BAND_ACTIVE") - Number(a.status === "ENTRY_BAND_ACTIVE") || (a.distanceToEntry?.percent ?? 999) - (b.distanceToEntry?.percent ?? 999)), [scan, now]);
  const selected = candidates.find(candidate => candidate.id === selectedId) ?? candidates[0] ?? null;
  const signedDistance = (candidate: Opportunity) => signedEntryBandDistance(candidate.distanceToEntry?.executablePrice ?? candidate.referenceEntry, candidate.direction, candidate.entryBand)?.percent;
  const structures = (scan?.results ?? []).flatMap(result => result.structures ?? []).filter(row => row.admission === "PLAN_ELIGIBLE");
  const conditions = selected ? conditionRows(selected) : [];
  const passedConditions = conditions.filter(row => row.state).length;
  const pendingConditions = conditions.filter(row => !row.state);
  const passedRows = conditions.filter(row => row.state);
  const jevCandidate = jev?.candidates.find(candidate => candidate.id === selected?.id) ?? null;
  const jevVerdict = jevCandidate?.probability == null ? "数据不足" : jevCandidate.probability >= .6 ? "YES" : jevCandidate.probability <= .4 ? "NO" : "观望";
  const rejectionTotals = Object.entries((scan?.results ?? []).reduce<Record<string, number>>((total, result) => { for (const [key, value] of Object.entries(result.rejected ?? {})) total[key] = (total[key] ?? 0) + value; return total; }, {})).sort((a, b) => b[1] - a[1]);
  const policyRisk = executionContext.riskPolicy;
  const decision = !fresh || !executionContext.accountFresh ? "数据冻结" : !executionContext.liveReady || !executionContext.entriesAllowed ? "禁止开仓" : selected?.status === "ENTRY_BAND_ACTIVE" ? "进入下单预检" : "等待触发";

  const mapStyle = selected ? (() => {
    const current = selected.distanceToEntry?.executablePrice ?? selected.referenceEntry;
    const values = [selected.stop, selected.target, selected.referenceEntry, selected.zone.low, selected.zone.high, selected.entryBand.low, selected.entryBand.high, selected.entryBand.ce, current];
    const floor = Math.min(...values);
    const ceiling = Math.max(...values);
    const span = Math.max(ceiling - floor, Math.abs(current) * .002, Number.EPSILON);
    const topPoint = (value: number) => Math.min(91, Math.max(9, (ceiling - value) / span * 82 + 9));
    const top = (value: number) => `${topPoint(value)}%`;
    const zoneTop = Math.min(topPoint(selected.zone.low), topPoint(selected.zone.high));
    const zoneBottom = Math.max(topPoint(selected.zone.low), topPoint(selected.zone.high));
    const entryTop = Math.min(topPoint(selected.entryBand.low), topPoint(selected.entryBand.high));
    const entryBottom = Math.max(topPoint(selected.entryBand.low), topPoint(selected.entryBand.high));
    const referencePoint = topPoint(selected.referenceEntry);
    const targetPoint = topPoint(selected.target);
    const stopPoint = topPoint(selected.stop);
    return {
      "--target-y": top(selected.target), "--stop-y": top(selected.stop), "--current-y": top(current),
      "--ce-y": top(selected.entryBand.ce), "--trigger-y": top(selected.entryBand.trigger),
      "--zone-y": `${zoneTop}%`, "--zone-h": `${Math.max(zoneBottom - zoneTop, 2.6)}%`,
      "--entry-y": `${entryTop}%`, "--entry-h": `${Math.max(entryBottom - entryTop, 2.2)}%`,
      "--reward-y": `${Math.min(referencePoint, targetPoint)}%`, "--reward-h": `${Math.abs(referencePoint - targetPoint)}%`,
      "--risk-y": `${Math.min(referencePoint, stopPoint)}%`, "--risk-h": `${Math.abs(referencePoint - stopPoint)}%`
    } as CSSProperties;
  })() : undefined;

  const planGeometry = selected ? (() => {
    const current = selected.distanceToEntry?.executablePrice ?? selected.referenceEntry;
    const zoneSpan = Math.max(selected.zone.high - selected.zone.low, Number.EPSILON);
    const zonePoint = (value: number) => (value - selected.zone.low) / zoneSpan;
    const geometryPoint = (value: number) => Math.min(99, Math.max(1, 4 + zonePoint(value) * 92));
    const geometryX = (value: number) => `${geometryPoint(value)}%`;
    const currentZonePosition = current < selected.zone.low ? "BELOW" : current > selected.zone.high ? "ABOVE" : "INSIDE";
    const quarterLow = selected.zone.low + zoneSpan * .25;
    const quarterHigh = selected.zone.low + zoneSpan * .75;

    const riskValues = [selected.target, selected.stop, selected.referenceEntry, current];
    const riskMin = Math.min(...riskValues);
    const riskMax = Math.max(...riskValues);
    const riskPad = Math.max((riskMax - riskMin) * .035, Math.abs(current) * .0005, Number.EPSILON);
    const riskFloor = riskMin - riskPad;
    const riskSpan = riskMax - riskMin + riskPad * 2;
    const riskPoint = (value: number) => Math.min(97, Math.max(3, (value - riskFloor) / riskSpan * 100));
    const riskX = (value: number) => `${riskPoint(value)}%`;
    const entryPoint = riskPoint(selected.referenceEntry);
    const targetPoint = riskPoint(selected.target);
    const stopPoint = riskPoint(selected.stop);

    return { currentZonePosition, quarterLow, quarterHigh, style: {
      "--fvg-low-x": geometryX(selected.zone.low), "--fvg-high-x": geometryX(selected.zone.high),
      "--quarter-low-x": geometryX(quarterLow), "--quarter-high-x": geometryX(quarterHigh),
      "--band-low-x": geometryX(selected.entryBand.low), "--band-high-x": geometryX(selected.entryBand.high),
      "--trigger-x": geometryX(selected.entryBand.trigger), "--ce-x": geometryX(selected.entryBand.ce), "--current-x": geometryX(current),
      "--target-x": riskX(selected.target), "--risk-entry-x": riskX(selected.referenceEntry), "--stop-x": riskX(selected.stop),
      "--reward-start-x": `${Math.min(targetPoint, entryPoint)}%`, "--reward-width": `${Math.abs(targetPoint - entryPoint)}%`,
      "--loss-start-x": `${Math.min(stopPoint, entryPoint)}%`, "--loss-width": `${Math.abs(stopPoint - entryPoint)}%`
    } as CSSProperties };
  })() : undefined;

  return <section id="smc-opportunities" className={styles.scanner} aria-labelledby="smc-opportunity-title">
    <aside className={styles.watchlistPane} aria-label="SMC 候选计划">
      <header className={styles.watchlistHeader}>
        <div><span>SMC WATCHLIST</span><h1 id="smc-opportunity-title">候选计划</h1></div>
        <button type="button" disabled={loading} onClick={() => { setLoading(true); setRefreshKey(value => value + 1); }} aria-label="刷新候选计划">{loading ? "…" : "↻"}</button>
      </header>
      <div className={styles.scanMeta} aria-live="polite"><span><i className={fresh ? styles.liveDot : styles.staleDot} />{fresh ? `${candidates.length} 个候选` : "数据暂停"}</span><small>{scan ? `${scan.scannedSymbols}/${policy.universe.length} 市场 · ${time(scan.sourceAsOf, true)}` : "等待扫描快照"}</small></div>

      {selected ? <div className={styles.candidateList} aria-label="候选计划列表">
        {candidates.map(candidate => { const checks = conditionRows(candidate); const passed = checks.filter(row => row.state).length; return <button key={candidate.id} type="button" className={candidate.id === selected.id ? styles.selectedCandidate : undefined} onClick={() => setSelectedId(candidate.id)} aria-pressed={candidate.id === selected.id}>
          <span className={styles.coinMark} aria-hidden="true">{candidate.symbol.slice(0, 1)}</span>
          <span className={styles.candidateCopy}><span><strong>{candidate.symbol}</strong><em className={candidate.direction === "LONG" ? styles.long : styles.short}>{candidate.direction === "LONG" ? "做多" : "做空"}</em></span><small>{waitingStatus[candidate.status] ?? candidate.status}</small></span>
          <span className={styles.candidateNumbers}><strong>{formatSignedEntryPercent(signedDistance(candidate))}</strong><small>{candidate.netR.toFixed(1)}R · {passed}/{checks.length}</small></span>
        </button>; })}
      </div> : <div className={styles.noCandidate}><b>暂无候选</b><small>{structures.length} 个有效结构仍在监视</small></div>}

      <footer className={styles.watchlistFooter}><span>结构 {structures.length}</span><span>淘汰 {rejectionTotals.reduce((sum, [, value]) => sum + value, 0)}</span><span>跨度 60D</span></footer>
    </aside>

    {selected ? <div className={styles.detailPane}>
      <header className={styles.instrumentHeader}>
        <div className={styles.instrumentIdentity}><span className={styles.instrumentMark} aria-hidden="true">{selected.symbol.slice(0, 1)}</span><div><h2>{selected.symbol}</h2><p>BINANCE USDⓈ-M · 4H 结构 / 15M 入场</p></div></div>
        <div className={styles.quoteBlock}><strong>{price(selected.distanceToEntry?.executablePrice ?? selected.referenceEntry)}</strong><span>{selected.distanceToEntry?.side ?? "BBO"} · 距执行带 <b>{formatSignedEntryPercent(signedDistance(selected))}</b></span></div>
      </header>

      <div className={styles.strategyArea}>
        <section className={styles.priceMap} style={mapStyle} aria-label={`${selected.symbol} SMC 价格结构地图`}>
          <header><span>SMC PRICE MAP</span><b>{selected.structure.qualityGrade ?? "A/B"} · {selected.structure.nPatternQualified ? "N / BOS" : selected.structure.eventType}</b></header>
          <div className={styles.mapCanvas}>
            <div className={styles.mapGrid} aria-hidden="true" />
            <div className={styles.rewardField} aria-hidden="true"><span>目标路径 · {selected.netR.toFixed(2)}R</span></div>
            <div className={styles.riskField} aria-hidden="true"><span>初始风险 · 1.00R</span></div>
            <div className={styles.fvgZone}><span>4H FVG</span></div>
            <div className={styles.entryZone}><span>允许入场 · 加仓评估</span></div>
            <div className={`${styles.mapLine} ${styles.targetLine}`}><span>TP · 结构目标 / 减仓</span><b>{price(selected.target)}</b></div>
            <div className={`${styles.mapLine} ${styles.stopLine}`}><span>SL · 保护退出</span><b>{price(selected.stop)}</b></div>
            <div className={`${styles.mapLine} ${styles.ceLine}`}><span>CE · 15M 收线门槛</span><b>{price(selected.entryBand.ce)}</b></div>
            <div className={`${styles.mapLine} ${styles.currentLine}`}><span>LIVE · {selected.distanceToEntry?.side ?? "BBO"}</span><b>{price(selected.distanceToEntry?.executablePrice ?? selected.referenceEntry)}</b></div>
          </div>
          <footer><span>FVG {price(selected.zone.low)}–{price(selected.zone.high)}</span><span className={styles.mapActionKey}>IN 入场/加仓 · TP 减仓/止盈 · SL 退出</span><span>RVOL {selected.structure.volumeRatio.toFixed(2)}×</span></footer>
        </section>

        <section className={styles.decisionPanel} aria-label={`${selected.symbol} 决策状态`}>
          <div className={styles.decisionTop}><span className={selected.direction === "LONG" ? styles.long : styles.short}>{selected.direction === "LONG" ? "LONG · 做多" : "SHORT · 做空"}</span><b data-state={decision}>{decision}</b></div>
          <div className={styles.stateHero}><small>当前状态</small><strong>{waitingStatus[selected.status] ?? selected.status}</strong><p>{nextActions[selected.status] ?? "等待下一次有效确认"}</p></div>
          <div className={styles.progressBlock}><span><small>ENTRY ADMISSION</small><b>{passedConditions}/{conditions.length}</b></span><i><span style={{ width: `${conditions.length ? passedConditions / conditions.length * 100 : 0}%` }} /></i></div>
          <div className={styles.blockingGate}><small>当前阻断</small><strong>{pendingConditions[0]?.label ?? "信号条件全部通过"}</strong><span>{pendingConditions[0]?.value ?? "等待账户与风控预检"}</span></div>
          <aside className={styles.jevCard}><strong>JEV 已停止</strong><span>当前不参与</span></aside>
        </section>
      </div>

      <section className={styles.planBoard} style={planGeometry?.style} aria-label={`${selected.symbol} 执行决策图`}>
        <header className={styles.planCommand}>
          <div><small>EXECUTION STATUS</small><strong>{decision}</strong><span>{nextActions[selected.status] ?? "等待下一次有效确认"}</span></div>
          <dl>
            <div><dt>距执行带</dt><dd>{formatSignedEntryPercent(signedDistance(selected))}</dd><small>{selected.distanceToEntry ? price(selected.distanceToEntry.absolute) : "—"} · {selected.distanceToEntry?.side ?? "BBO"}</small></div>
            <div><dt>净收益风险比</dt><dd>{selected.netR.toFixed(2)}R</dd><small>准入线 ≥ 2.00R</small></div>
          </dl>
          <span className={styles.executionMode} data-online={executionContext.liveReady && executionContext.entriesAllowed}>{executionContext.liveReady && executionContext.entriesAllowed ? "AUTO · ONLINE" : "EXECUTION · HOLD"}</span>
        </header>

        <div className={styles.geometryGrid}>
          <section className={styles.entryGeometry} aria-label="FVG 与入场带比例图">
            <header><div><small>ENTRY GEOMETRY · NORMALIZED</small><strong>FVG 入场几何</strong></div><span>{selected.direction === "LONG" ? "回踩做多" : "反弹做空"}</span></header>
            <div className={styles.geometryRail}>
              <i className={styles.fullFvgRange} />
              <i className={styles.liveBandRange} />
              <div className={styles.geometryScale} aria-hidden="true">
                <span className={styles.scaleLow}>0%</span>
                <span className={styles.scaleQuarterLow}>25%</span>
                <span className={styles.scaleCe}>50%</span>
                <span className={styles.scaleQuarterHigh}>75%</span>
                <span className={styles.scaleHigh}>100%</span>
              </div>
              <span className={`${styles.geometryMarker} ${styles.fvgLowMarker}`}><b>FVG L</b><em>{price(selected.zone.low)}</em></span>
              <span className={`${styles.geometryMarker} ${styles.ceMarker}`}><b>CE · 50% / 收线门槛</b><em>{price(selected.entryBand.ce)}</em></span>
              <span className={`${styles.geometryMarker} ${styles.fvgHighMarker}`}><b>FVG H</b><em>{price(selected.zone.high)}</em></span>
              <span className={`${styles.geometryMarker} ${styles.livePriceMarker}`} data-position={planGeometry?.currentZonePosition}><b>LIVE {selected.distanceToEntry?.side ?? "BBO"} · {planGeometry?.currentZonePosition === "BELOW" ? "低于 FVG" : planGeometry?.currentZonePosition === "ABOVE" ? "高于 FVG" : "区间内"}</b><em>{price(selected.distanceToEntry?.executablePrice ?? selected.referenceEntry)}</em></span>
            </div>
            <footer><span><i /> 完整 4H FVG</span><span><i /> 允许成交带</span><b>{selected.direction === "LONG" ? "CE → 上轨" : "下轨 → CE"} · {price(selected.entryBand.low)} — {price(selected.entryBand.high)}</b></footer>
          </section>

          <section className={styles.riskGeometry} aria-label="风险与目标比例图">
            <header><div><small>RISK PATH · TRUE PRICE SCALE</small><strong>风险路径</strong></div><b>{selected.netR.toFixed(2)}R</b></header>
            <div className={styles.riskRail}>
              <i className={styles.rewardRange} />
              <i className={styles.lossRange} />
              <span className={`${styles.riskMarker} ${styles.targetMarker}`}><b>TARGET</b><em>{price(selected.target)}</em></span>
              <span className={`${styles.riskMarker} ${styles.riskEntryMarker}`}><b>ENTRY</b><em>{price(selected.referenceEntry)}</em></span>
              <span className={`${styles.riskMarker} ${styles.stopMarker}`}><b>STOP</b><em>{price(selected.stop)}</em></span>
            </div>
            <footer><span>单笔 {Number(policyRisk?.perTradeFraction ?? .04) * 100}%</span><span>组合 {Number(policyRisk?.portfolioFraction ?? .1) * 100}%</span><span>持仓 {executionContext.positions}/{String(policyRisk?.maximumOpenPositions ?? 4)}</span><span>委托 {executionContext.orders}</span></footer>
          </section>
        </div>
      </section>

      <details className={styles.planDetails}><summary>查看完整准入条件与参数</summary><div className={styles.detailGrid}><div><span>完整 FVG</span><b>{price(selected.zone.low)}–{price(selected.zone.high)}</b></div><div><span>BBO 时间</span><b>{selected.distanceToEntry ? time(selected.distanceToEntry.quoteAt, true) : "—"}</b></div><div><span>已通过</span><b>{passedRows.length} / {conditions.length}</b></div></div><ol>{conditions.map(row => <li key={row.label} data-pass={row.state}><span>{row.state ? "✓" : "○"}</span><p><b>{row.label}</b><small>{row.value}</small></p></li>)}</ol></details>

      <details className={styles.diagnostics}><summary>扫描诊断 <span>{scan?.universe?.length ?? policy.universe.length} 市场 · {structures.length} 结构</span></summary><div><p>60 天结构跨度 · 14 天计划窗口 · 15M 测试 CE 并收在方向侧半区</p><p>{rejectionTotals.slice(0, 8).map(([key, value]) => `${rejectedLabels[key] ?? key} ${value}`).join(" · ") || "暂无淘汰记录"}</p>{!!scan?.errors.length && <p>错误：{scan.errors.map(error => `${error.symbol}:${error.reason}`).join(" · ")}</p>}</div></details>
    </div> : <div className={styles.emptyDetail}><b>等待有效 SMC 计划</b><span>扫描器仍在监视 {structures.length} 个结构</span></div>}
  </section>;
}
