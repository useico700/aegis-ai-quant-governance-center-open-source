"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MONITOR_COMMON_COPY, MONITOR_PRESENTATION_REVISION } from "../../monitor-sync";
import styles from "./shadow.module.css";
import CandidateStudyPanel from "./CandidateStudyPanel";

type ShadowObservation = {
  sourceAsOf: string;
  actualMarkedEquityUsdt: number;
  shadowMarkedEquityUsdt: number;
  confirmedHighWaterUsdt: number;
  protectionFloorUsdt: number;
  shadowStressStopEquityUsdt: number;
  effectiveExposureFraction: number;
  action: string;
  evidenceStatus: string;
};

type ShadowState = {
  schemaVersion: number;
  experimentId: string;
  status: "ACTIVE_OBSERVE_ONLY";
  prospectiveStart: string | null;
  sourceAsOf: string;
  rollingAccount: {
    startedAt: string; shadowEquityUsdt: number; confirmedHighUsdt: number;
    protectionFloorUsdt: number; retainedProfitTargetUsdt: number;
    fundedReserveReferenceUsdt: number; compoundBaseReferenceUsdt: number;
    profitAtRiskUsdt: number; exposureFraction: number; dailyNetChangeUsdt: number;
    floorShortfallUsdt: number; shadowStressEquityUsdt: number; status: string;
    validationEligible: boolean; performanceValidated: false;
  } | null;
  policy: {
    valuationScope: string;
    highWaterConfirmationMs: number;
    maximumQuoteAgeMs: number;
    maximumQuoteSkewMs: number;
    maximumObservationGapMs: number;
    minimumEligibleCompletedCampaigns: number;
    requiredGivebackReductionFraction: number;
    minimumNetOutcomeRetentionFraction: number;
    minimumTrendGainRetentionFraction: number;
    tiers: Array<{ id: string; minimumPeakProfitFraction: number; lockFraction: number; runnerFraction: number }>;
  };
  boundary: {
    executionInfluence: false;
    ordersOrPositionsAffected: false;
    strategyOrRiskChanged: false;
    automaticPromotionAllowed: false;
    valuationScope: string;
  };
  evidence: {
    status: string;
    analysisEligible: boolean;
    validationEligible: boolean;
    promotionEligible: false;
    historicalGapDetected: boolean;
    recoveryGapPositions: number;
    maximumQuoteAgeMs: number;
    futureQuoteSkewMs: number;
    quoteSkewMs: number;
    transportLagMs: number;
    limitations: string[];
  };
  current: {
    dayKey: string;
    dayBaselineKind: string;
    baselineEquityUsdt: number;
    actualMarkedEquityUsdt: number;
    shadowMarkedEquityUsdt: number;
    actualStressStopEquityUsdt: number;
    shadowStressStopEquityUsdt: number;
    confirmedHighWaterUsdt: number;
    pendingHighWaterUsdt: number | null;
    protectionFloorUsdt: number;
    peakProfitFraction: number;
    lockFraction: number;
    runnerFraction: number;
    effectiveExposureFraction: number;
    distanceToFloorUsdt: number;
    stressFloorGapUsdt: number;
    tier: string;
    action: string;
    actionChangedAt: string;
  };
  activeCampaign: { id: string; activatedAt: string; interventionAt: string | null; evidenceEligible: boolean } | null;
  observations: ShadowObservation[];
  validation: {
    activatedCampaignCount: number;
    completedCampaignCount: number;
    eligibleCompletedCampaignCount: number;
    excludedCompletedCampaignCount: number;
    givebackReductionFraction: number | null;
    netOutcomeRetentionFraction: number | null;
    trendGainRetentionFraction: number | null;
    baselineNetOutcomeUsdt: number;
    shadowNetOutcomeUsdt: number;
    status: string;
    automaticPromotionAllowed: false;
  };
};

type Envelope = {
  status: string;
  sourceAsOf: string;
  receivedAt: string;
  accountShadowStatus: string;
  accountShadowSourceAsOf: string | null;
  accountShadowReceivedAt: string | null;
  accountShadowRevision: number | null;
  accountShadow: ShadowState | null;
  snapshot?: { implementationRevision?: string };
};

const moneyFormat = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const timeFormat = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
function money(value?: number | null) { return value == null || !Number.isFinite(value) ? "—" : `${value < 0 ? "−" : ""}${moneyFormat.format(Math.abs(value))}`; }
function signedMoney(value?: number | null) { return value == null || !Number.isFinite(value) ? "—" : `${value > 0 ? "+" : value < 0 ? "−" : ""}${moneyFormat.format(Math.abs(value))}`; }
function percent(value?: number | null, digits = 1) { return value == null || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(digits)}%`; }
function time(value?: string | number | null) { return value == null ? "—" : timeFormat.format(new Date(value)).replaceAll("/", "-"); }

function actionLabel(action?: string) {
  return ({
    OBSERVE_ONLY_BASELINE_SEEDED: "基线已建立",
    OBSERVE_ONLY_EVIDENCE_HOLD: "证据暂停",
    OBSERVE_ONLY_NO_CHANGE: "继续观察",
    OBSERVE_ONLY_RUNNER_PRESERVED: "利润保护已武装",
    OBSERVE_ONLY_PROTECTED_RUNNER_ACTIVE: "保护后尾仓跟随",
    OBSERVE_ONLY_NEAR_FLOOR: "接近保护地板",
    OBSERVE_ONLY_REVIEW_STRESS_GAP: "压力止损低于地板",
    OBSERVE_ONLY_REVIEW_LOCK_BREACH: "权益触及保护地板",
  } as Record<string, string>)[action ?? ""] ?? "等待首个判定";
}

function evidenceLabel(status?: string) {
  return ({
    PRICE_SIDE_EVIDENCE_ACCEPTED: "价格侧证据合格",
    WEBSOCKET_DISCONNECTED: "行情连接中断",
    VALUATION_INCOMPLETE: "估值字段不完整",
    QUOTE_TIME_INCOMPLETE: "报价时间不完整",
    CONTINUITY_EPOCH_INCOMPLETE: "连接代际证据不完整",
    CONTINUITY_EPOCH_CHANGED: "检测到断线或自愈代际变化",
    OBSERVATION_INTERVAL_GAP: "前向观察间隔超限",
    SOURCE_TIME_IN_FUTURE: "源时间超前",
    QUOTE_TIME_IN_FUTURE: "报价时间超前",
    TRANSPORT_STALE: "传输延迟超限",
    QUOTE_STALE: "报价新鲜度超限",
    QUOTE_SKEW_EXCEEDED: "跨仓报价偏斜超限",
  } as Record<string, string>)[status ?? ""] ?? "证据状态待确认";
}

function limitationLabel(value: string) {
  return ({
    FUNDING_NOT_ACCRUED: "资金费尚未计入",
    ORDER_BOOK_DEPTH_NOT_MODELED: "订单簿档位容量尚未建模",
    BBO_SIZE_EVENT_TIME_AND_UPDATE_ID_NOT_PUBLISHED: "线上快照未发布 BBO 数量、交易所事件时间与更新序号",
    SNAPSHOT_CAPTURE_TIME_NOT_PUBLISHED_COMPOSITE_REFERENCE_USED: "快照构建时刻未单独发布，使用心跳、最新行情事件与报价的组合证据时钟",
    HISTORICAL_CAPTURE_GAP: "历史采集存在缺口",
    RECOVERY_GAP_POSITIONS_EXCLUDED_FROM_VALIDATION: "恢复缺口仓位不进入验证统计",
    FORWARD_CONNECTION_EPOCH_CHANGED: "连接代际变化，不跨缺口映射权益",
    UNOBSERVED_INTERVAL_EXCEEDED: "未观察间隔超限，本帧冻结",
  } as Record<string, string>)[value] ?? value;
}

function tierLabel(id: string) {
  return ({ T0: "基础档", T1: "一级锁利", T2: "二级锁利", T3: "三级锁利", T4: "四级锁利" } as Record<string, string>)[id] ?? "未知档位";
}

function validationLabel(status?: string) {
  if (status === "INDICATIVE_PASS_REVIEW_READY") return "达到指示性复盘门槛";
  if (status === "INDICATIVE_REVIEW_CRITERIA_NOT_MET") return "样本已足，指标尚未通过";
  return "正在累积前向样本";
}

function ShadowCurve({ points }: { points: ShadowObservation[] }) {
  const geometry = useMemo(() => {
    if (!points.length) return null;
    const values = points.flatMap((point) => [point.actualMarkedEquityUsdt, point.shadowMarkedEquityUsdt, point.protectionFloorUsdt]).filter(Number.isFinite);
    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    const pad = Math.max((rawMax - rawMin) * 0.14, 20);
    const minimum = rawMin - pad;
    const maximum = rawMax + pad;
    const x = (index: number) => 42 + (points.length === 1 ? 0 : index / (points.length - 1)) * 928;
    const y = (value: number) => 18 + (maximum - value) / Math.max(maximum - minimum, 1) * 222;
    const line = (field: keyof Pick<ShadowObservation, "actualMarkedEquityUsdt" | "shadowMarkedEquityUsdt" | "protectionFloorUsdt">) => points.map((point, index) => `${x(index)},${y(point[field])}`).join(" ");
    return { minimum, maximum, actual: line("actualMarkedEquityUsdt"), shadow: line("shadowMarkedEquityUsdt"), floor: line("protectionFloorUsdt") };
  }, [points]);
  if (!geometry) return <div className={styles.emptyChart}>等待首个前向观察节点</div>;
  return <div className={styles.chartWrap}>
    <svg viewBox="0 0 1000 270" preserveAspectRatio="none" role="img" aria-label="当前账户权益、影子权益与保护地板的前向观察曲线">
      {[0, 1, 2, 3].map((row) => <line key={row} x1="42" x2="970" y1={18 + row * 74} y2={18 + row * 74} className={styles.gridLine}/>) }
      <polyline points={geometry.actual} className={styles.actualLine}/>
      <polyline points={geometry.shadow} className={styles.shadowLine}/>
      <polyline points={geometry.floor} className={styles.floorLine}/>
    </svg>
    <div className={styles.axis}><span>{money(geometry.maximum)}</span><span>{money(geometry.minimum)}</span></div>
  </div>;
}

export default function AccountShadowPage() {
  const [envelope, setEnvelope] = useState<Envelope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(0);

  const refresh = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const response = await fetch(`/api/mtfx-ledger?account-shadow=${Date.now()}`, { cache: "no-store", headers: { "cache-control": "no-cache" } });
      if (!response.ok) throw new Error(response.status === 404 ? "等待首份 V2 在线快照" : "影子数据暂不可用");
      const next = await response.json() as Envelope;
      setEnvelope((current) => {
        const currentShadowTime = Date.parse(current?.accountShadowSourceAsOf ?? current?.accountShadow?.sourceAsOf ?? "");
        const nextShadowTime = Date.parse(next.accountShadowSourceAsOf ?? next.accountShadow?.sourceAsOf ?? "");
        return !current || !Number.isFinite(currentShadowTime) || nextShadowTime >= currentShadowTime ? next : current;
      });
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "影子数据暂不可用");
    } finally { setRefreshing(false); }
  }, []);

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => {
      setNow(Date.now());
      void refresh();
    }, 0);
    const poll = window.setInterval(() => void refresh(), 15_000);
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    const resume = () => void refresh();
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", resume);
    window.addEventListener("pageshow", resume);
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(poll); window.clearInterval(clock);
      window.removeEventListener("focus", resume); window.removeEventListener("pageshow", resume); window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);

  const shadow = envelope?.accountShadow;
  const shadowReceivedAt = envelope?.accountShadowReceivedAt ?? null;
  const ageSeconds = shadowReceivedAt && now > 0 ? Math.max(0, Math.floor((now - Date.parse(shadowReceivedAt)) / 1000)) : null;
  const syncHealthy = !error && envelope?.accountShadowStatus === "ACTIVE_OBSERVE_ONLY" && ageSeconds != null && ageSeconds <= 45;
  if (!shadow) return <main className={styles.loading} data-monitor-sync-revision={MONITOR_PRESENTATION_REVISION}>
    <div className={styles.loadingMark}>S</div><p>ORION V2 · ACCOUNT LAYER</p><h1>账户权益影子验证</h1>
    <span aria-live="polite">{error ?? (envelope?.accountShadowStatus === "SHADOW_STATE_INTEGRITY_FAILURE_BASELINE_UNAFFECTED" ? "影子状态完整性校验失败，已冻结；主监视器不受影响" : "正在等待部署后的首份前向观察…")}</span>
    <a href="/v2-ledger">返回 V2 监视器</a>
    <CandidateStudyPanel/>
  </main>;

  if (!shadow.prospectiveStart) return <main className={styles.loading} data-monitor-sync-revision={MONITOR_PRESENTATION_REVISION} data-shadow-execution-influence="false">
    <div className={styles.loadingMark}>S</div><p>ORION V2 · ACCOUNT LAYER · OBSERVE ONLY</p><h1>等待首份合格前向证据</h1>
    <span aria-live="polite">{evidenceLabel(shadow.evidence.status)}。本页不会用过期、错位或不完整数据建立当日基线与高水位；主监视器与 R22 执行不受影响。</span>
    <a href="/v2-ledger">返回 V2 监视器</a>
    <CandidateStudyPanel/>
  </main>;

  const current = shadow.current;
  const rolling = shadow.rollingAccount;
  const validation = shadow.validation;
  const progress = Math.min(1, validation.eligibleCompletedCampaignCount / shadow.policy.minimumEligibleCompletedCampaigns);
  const actionRisk = current.action.includes("BREACH") || current.action.includes("STRESS_GAP") || current.action.includes("EVIDENCE_HOLD");

  return <main className={styles.page} data-monitor-sync-revision={MONITOR_PRESENTATION_REVISION} data-shadow-execution-influence="false">
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.identity}><a href="/v2-ledger" aria-label="返回 ORION V2 MTFX 在线监视器">← V2 监视器</a><span>S</span><div><small>ORION V2 · ACCOUNT LAYER · OBSERVE ONLY</small><h1>账户权益影子验证</h1><p>高水位、利润地板与尾仓保留的前向反事实控制面</p></div></div>
        <div className={styles.headerStatus}>
          <span className={syncHealthy ? styles.liveBadge : styles.alertBadge} title={error ?? undefined}><i/>{error ? "刷新异常" : syncHealthy ? MONITOR_COMMON_COPY.healthy : MONITOR_COMMON_COPY.stale}</span>
          <span><small>{MONITOR_COMMON_COPY.sourceTime}</small><b>{time(shadow.sourceAsOf)} CST</b></span>
          <button type="button" onClick={() => void refresh(true)} disabled={refreshing}>{refreshing ? MONITOR_COMMON_COPY.refreshing : MONITOR_COMMON_COPY.refresh}</button>
        </div>
      </header>

      <section className={styles.boundary} aria-label="影子边界">
        <b>仅做观察与反事实记账</b><span>不阻断新仓、不调整持仓、不移动止损、不提交订单，也不自动晋级。</span><em>PRICE-SIDE ONLY</em>
      </section>

      <CandidateStudyPanel baseline={{ aEquity: current.actualMarkedEquityUsdt, bEquity: rolling?.shadowEquityUsdt ?? null, sourceAsOf: shadow.sourceAsOf }}/>

      {rolling && <section className={styles.policyCard} aria-label="跨日滚动利润锁定">
        <div className={styles.sectionHead}><div><small>ROLLING ACCOUNT · FORWARD RESEARCH</small><h2>跨日滚动锁利</h2>
          <p>午夜只重置当日收益展示；累计影子权益、确认高点、保护目标和参与比例连续保留。下面是待验证的账户层规则，保护目标不等于已经落袋的利润。</p></div></div>
        <div className={styles.metrics}>
          <article><small>连续影子权益</small><b>{money(rolling.shadowEquityUsdt)}</b><span>当日变化 {signedMoney(rolling.dailyNetChangeUsdt)}</span></article>
          <article><small>跨日保护目标</small><b>{money(rolling.protectionFloorUsdt)}</b><span>确认高点 {money(rolling.confirmedHighUsdt)}</span></article>
          <article><small>利润留存目标</small><b>{money(rolling.retainedProfitTargetUsdt)}</b><span>已实现覆盖参考 {money(rolling.fundedReserveReferenceUsdt)}</span></article>
          <article><small>可再冒险余额</small><b>{money(rolling.profitAtRiskUsdt)}</b><span>影子参与比例 {percent(rolling.exposureFraction)}</span></article>
          <article><small>复利本金参考</small><b>{money(rolling.compoundBaseReferenceUsdt)}</b><span>凯利与自动扩仓均未启用</span></article>
        </div>
        <p>{rolling.status === "EVIDENCE_HOLD" ? "证据暂停：权益路径与高点冻结，恢复时不补算缺失区间。"
          : rolling.status === "FLOOR_BREACHED_REVIEW" ? `目标已被穿透 ${money(rolling.floorShortfallUsdt)} USDT：如实记录缺口，保护目标不能保证成交结果。`
            : rolling.status === "STRESS_OVERRIDES_RUNNER" ? "压力预算不足：尾仓参与目标让位于净值保护，影子参与比例可降至零。"
              : "按压力损失与可再冒险余额计算参与比例；恢复参与须重新确认高点，并连续满足 30 分钟冷却和权益缓冲条件。"}</p>
        <div className={styles.gates}>
          <span><small>保留单边机会</small><b>25% 尾仓目标</b><em>不是强制最低仓位，压力约束优先</em></span>
          <span><small>利润分配</small><b>75% 保留 · 25% 复利</b><em>仅对已实现覆盖的留存目标计算参考值</em></span>
          <span><small>验证状态</small><b>前向观察中</b><em>{rolling.validationEligible ? "路径证据合格，尚未验证收益改善" : "路径包含不合格证据，不纳入绩效结论"}</em></span>
        </div>
        <p>复利基数同时受当前已实现权益与影子权益约束；浮盈不直接放大本金。资金费、深度和实际再平衡成本尚未建模。初始 1% 权益缓冲与上述比例都是预声明研究参数，尚未证明最优。</p>
      </section>}

      <section className={styles.hero}>
        <article className={styles.equityHero}>
          <small>日内对照权益 · 指示性</small><strong>{money(current.shadowMarkedEquityUsdt)} <em>USDT</em></strong>
          <span className={current.shadowMarkedEquityUsdt >= current.baselineEquityUsdt ? styles.positive : styles.negative}>{signedMoney(current.shadowMarkedEquityUsdt - current.baselineEquityUsdt)} · 当日基线 {money(current.baselineEquityUsdt)}</span>
          <div><i/><p>当前账户权益变化在影子保护触发后，仅按保留尾仓比例继续映射。</p></div>
        </article>
        <article className={styles.floorHero}>
          <div><small>双帧价格侧高水位</small><b>{money(current.confirmedHighWaterUsdt)}</b></div>
          <div><small>利润保护地板</small><b>{money(current.protectionFloorUsdt)}</b></div>
          <div className={styles.floorTrack} role="progressbar" aria-label="当日高水位利润锁定比例" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(current.lockFraction * 100)}><i style={{ width: `${current.lockFraction * 100}%` }}/></div>
          <span>锁定 {percent(current.lockFraction, 0)} · 尾仓 {percent(current.runnerFraction, 0)} · 距地板 {signedMoney(current.distanceToFloorUsdt)}</span>
        </article>
        <article className={`${styles.actionHero} ${actionRisk ? styles.actionRisk : ""}`}>
          <small>CURRENT SHADOW ASSESSMENT</small><b>{actionLabel(current.action)}</b>
          <p>{current.action.includes("STRESS_GAP") ? "若全部当前止损在压力成本下完成，影子权益低于保护地板。" : current.action.includes("BREACH") ? "价格侧权益已触及影子保护地板，记录为复盘事件。" : current.action.includes("EVIDENCE_HOLD") ? "当前证据不满足更新条件，高水位与保护状态冻结。" : "保留追逐单边行情的尾仓参与度，继续等待前向数据。"}</p>
          <span>{tierLabel(current.tier)} · 影子风险暴露 {percent(current.effectiveExposureFraction, 0)}</span>
        </article>
      </section>

      <section className={styles.metrics} aria-label="账户影子指标">
        <article><small>当前账户权益</small><b>{money(current.actualMarkedEquityUsdt)}</b><span>现行 R22 只读标记</span></article>
        <article><small>峰值利润</small><b className={styles.positive}>{signedMoney(current.confirmedHighWaterUsdt - current.baselineEquityUsdt)}</b><span>{percent(current.peakProfitFraction)} / 当日基线</span></article>
        <article><small>当前压力止损权益</small><b>{money(current.actualStressStopEquityUsdt)}</b><span>止损、手续费与不利滑点</span></article>
        <article><small>影子压力止损权益</small><b className={current.stressFloorGapUsdt >= 0 ? styles.positive : styles.negative}>{money(current.shadowStressStopEquityUsdt)}</b><span>相对地板 {signedMoney(current.stressFloorGapUsdt)}</span></article>
        <article><small>活动保护周期</small><b>{shadow.activeCampaign ? "1" : "0"}</b><span>{shadow.activeCampaign?.interventionAt ? "已记录保护判定" : shadow.activeCampaign ? "已武装，尚未判定" : "峰值利润未达 1%"}</span></article>
      </section>

      <section className={styles.curveCard}>
        <div className={styles.sectionHead}><div><small>FORWARD ACCOUNT PATH</small><h2>账户路径与保护地板</h2><p>至少每五分钟记录，并在动作或证据状态变化时追加；绿色为当前账户权益，蓝色为影子权益，琥珀虚线为不可下调的当日保护地板。</p></div><div className={styles.legend}><span className={styles.actualKey}>当前</span><span className={styles.shadowKey}>影子</span><span className={styles.floorKey}>地板</span></div></div>
        <ShadowCurve points={shadow.observations}/>
      </section>

      <section className={styles.twoColumn}>
        <article className={styles.policyCard}>
          <div className={styles.sectionHead}><div><small>DAILY COMPARATOR POLICY</small><h2>日内对照锁利梯度</h2><p>此处保留原日内对照口径，与上方跨日研究分别记账。只按双帧价格侧高水位划档；压力止损跌破基础地板时，锁定率额外增加 5 个百分点，最高 80%。</p></div></div>
          <div className={styles.tierHead}><span>峰值利润</span><span>锁定</span><span>尾仓</span></div>
          {shadow.policy.tiers.map((tier, index) => <div key={tier.id} className={`${styles.tierRow} ${current.tier === tier.id ? styles.activeTier : ""}`}>
            <span><b>{tierLabel(tier.id)}</b>{index === 0 ? "< 1%" : index === shadow.policy.tiers.length - 1 ? "≥ 5%" : `${percent(tier.minimumPeakProfitFraction, 0)}–<${percent(shadow.policy.tiers[index + 1].minimumPeakProfitFraction, 0)}`}</span>
            <strong>{percent(tier.lockFraction, 0)}</strong><em>{percent(tier.runnerFraction, 0)}</em>
          </div>)}
        </article>

        <article className={styles.validationCard}>
          <div className={styles.sectionHead}><div><small>VALIDATION GATE</small><h2>{validationLabel(validation.status)}</h2><p>仅达到全部预声明门槛后才允许人工复盘；仍不构成策略或风险变更授权。</p></div></div>
          <div className={styles.sampleProgress}><span><b>{validation.eligibleCompletedCampaignCount}</b> / {shadow.policy.minimumEligibleCompletedCampaigns} 个可分析已完成保护周期</span><div role="progressbar" aria-label="影子验证样本进度" aria-valuemin={0} aria-valuemax={shadow.policy.minimumEligibleCompletedCampaigns} aria-valuenow={Math.min(validation.eligibleCompletedCampaignCount, shadow.policy.minimumEligibleCompletedCampaigns)}><i style={{ width: `${progress * 100}%` }}/></div><small>累计武装 {validation.activatedCampaignCount} · 完成 {validation.completedCampaignCount} · 排除 {validation.excludedCompletedCampaignCount}</small></div>
          <div className={styles.gates}>
            <span><small>回吐尾部降低</small><b>{percent(validation.givebackReductionFraction)}</b><em>目标 ≥ {percent(shadow.policy.requiredGivebackReductionFraction, 0)}</em></span>
            <span><small>净结果保留</small><b>{percent(validation.netOutcomeRetentionFraction)}</b><em>目标 ≥ {percent(shadow.policy.minimumNetOutcomeRetentionFraction, 0)}</em></span>
            <span><small>趋势收益保留</small><b>{percent(validation.trendGainRetentionFraction)}</b><em>目标 ≥ {percent(shadow.policy.minimumTrendGainRetentionFraction, 0)}</em></span>
          </div>
        </article>
      </section>

      <section className={styles.evidenceCard}>
        <div className={styles.sectionHead}><div><small>EVIDENCE QUALITY</small><h2>{evidenceLabel(shadow.evidence.status)}</h2><p>{shadow.evidence.analysisEligible && syncHealthy ? "当前可用于价格侧影子分析；仍因缺少档位容量与资金费，不能称为全仓可成交高水位，也不能进入自动晋级。" : "当前证据或影子同步不满足分析条件；高水位与评估保持暂停，不影响主监视器。"}</p></div><span className={shadow.evidence.analysisEligible && syncHealthy ? styles.goodState : styles.badState}>{shadow.evidence.analysisEligible && syncHealthy ? "ANALYSIS READY" : "HOLD"}</span></div>
        <div className={styles.evidenceGrid}>
          <span><small>证据时钟最大报价年龄</small><b>{money(shadow.evidence.maximumQuoteAgeMs)} ms</b><em>上限 {shadow.policy.maximumQuoteAgeMs} ms</em></span>
          <span><small>跨仓报价偏斜</small><b>{money(shadow.evidence.quoteSkewMs)} ms</b><em>上限 {shadow.policy.maximumQuoteSkewMs} ms</em></span>
          <span><small>站点传输延迟</small><b>{money(shadow.evidence.transportLagMs)} ms</b><em>快照年龄 {ageSeconds ?? "—"} 秒</em></span>
          <span><small>恢复缺口仓位</small><b>{shadow.evidence.recoveryGapPositions}</b><em>{shadow.evidence.historicalGapDetected ? "历史缺口仍保留" : "未见历史缺口"}</em></span>
        </div>
        <div className={styles.limitations}>{shadow.evidence.limitations.map((item) => <span key={item}>{limitationLabel(item)}</span>)}</div>
      </section>

      <footer className={styles.footer}>
        <span>前向起点 · {time(shadow.prospectiveStart)} CST</span><span>日界 · Asia/Shanghai 00:00 后首个有效快照</span><span>高水位确认 · 两个间隔 ≥ {shadow.policy.highWaterConfirmationMs / 1000} 秒的合格价格侧帧取较低值</span><span>连续性 · 断线代际变化或观察间隔 &gt; {shadow.policy.maximumObservationGapMs / 1000} 秒即冻结</span>
      </footer>
    </div>
  </main>;
}
