import CandidateHistory, { type FilteredCandidate } from "./CandidateHistory";
import PriceCalibration, { QuotePrice, type MarketQuote, type PrecisionRule } from "./PriceCalibration";
import { arrivalCountdown, candidateStatusNote } from "../../lib/s1-arrival.mjs";
import { sortCandidates } from "../../lib/s1-candidate-order.mjs";
import { candidateInputState, groupCandidateStructures, partitionCandidateFunnel } from "../../lib/s1-candidate-funnel.mjs";
import { summarizePxDistance } from "../../lib/s1-px-distance.mjs";
import { formatBinancePrice } from "../../lib/s1-price-display.mjs";
import type { CandidatePriority, ExecutionState } from "./TradeLedger";
import type { LiveQuoteState } from "./useLiveMarketQuotes";
import styles from "./s1.module.css";

export type Candidate = {
  id: string;
  symbol: string;
  status: string;
  direction: string | null;
  directionClosedAt?: string | null;
  intersectionTime: string | null;
  intersectionPrice: number | null;
  observedAt: string | null;
  stale: boolean;
  reason: string;
};

type CandidateGroup = {
  key: string;
  stage: string;
  symbol: string;
  direction: string | null;
  plans: Candidate[];
};

const labels: Record<string, string> = {
  FORMING: "结构形成",
  WAITING_CLOSE: "等待收线",
  CONFIRMED_SCAN_ONLY: "方向已确认 · 仅观察",
  WAITING_FIRST_PX_CLOSE: "等待入场条件",
  FIRST_CLOSE_LOCKED: "方向已确认",
  INVALIDATED: "反向越过 Px · 已失效",
  CONFIRMED_EXPIRED: "确认窗口已过",
  EXPIRED: "计划已过期",
  NON_CAUSAL_OBSERVATION: "因果证据不足",
};

const clock = (value: string | null | undefined) => value ? new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
}).format(new Date(value)) : "—";
const directionLabel = (direction: string | null) => direction === "LONG" ? "多头" : direction === "SHORT" ? "空头" : "方向待定";
const percent = (value: number) => new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: "always" }).format(value);
const unsignedPercent = (value: number) => new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
const liveStateLabel: Record<LiveQuoteState, string> = { CONNECTING: "实时行情连接中", LIVE: "实时行情", PAUSED: "页面隐藏 · 行情暂停", RECONNECTING: "实时行情重连中", UNAVAILABLE: "实时行情暂不可用" };

function PxDistance({ plans, quote, tickSize, now, stale, bandPercent, distanceGateEnabled }: { plans: Candidate[]; quote?: MarketQuote; tickSize?: string; now: number; stale: boolean; bandPercent: number; distanceGateEnabled: boolean }) {
  const quoteAge = now - Date.parse(quote?.exchangeTime ?? "");
  const fresh = !stale && Number.isFinite(quoteAge) && quoteAge >= -5_000 && quoteAge <= 10_000;
  const summary = fresh ? summarizePxDistance(plans, quote, bandPercent * 100) : null;
  const label = distanceGateEnabled ? `Px ${bandPercent}%区${bandPercent === 2 ? " · 另验1ATR" : ""}` : "Px 距离 · 仅观测";
  if (!summary) return <div className={`${styles.pxDistance} ${styles.pxDistanceUnavailable}`}><span>{label}</span><strong>行情连接中…</strong></div>;
  const value = summary.representative.status;
  const multiple = summary.total > 1;
  const className = value.position === "INSIDE" ? styles.pxDistanceInside : value.position === "AT_PX" ? styles.pxDistanceBoundary : styles.pxDistanceOutside;
  const status = !distanceGateEnabled ? `相对 Px ${percent(value.pxOffsetPercent)}%`
    : value.position === "INSIDE"
    ? `区内${multiple ? ` · ${summary.inside}/${summary.total} 结构` : ""}`
    : value.position === "AT_PX"
      ? `位于 Px 边界${multiple ? ` · ${summary.atPx}/${summary.total} 结构` : ""}`
      : `${value.position === "ABOVE" ? "高于上沿" : "低于下沿"} ${formatBinancePrice(value.distancePrice, tickSize, quote)} · ${unsignedPercent(value.distancePercent)}%`;
  return <div className={`${styles.pxDistance} ${className}`}>
    <span>{label}</span>
    <strong>{status}</strong>
    <small>{value.referenceLabel} {formatBinancePrice(value.marketPrice, tickSize, quote)}{distanceGateEnabled ? ` · 相对 Px ${percent(value.pxOffsetPercent)}%` : " · 不作为准入门"}</small>
  </div>;
}

function CandidateCard({ group, now, stale, quotes, rules, entryInterval, priorities, bandPercent, distanceGateEnabled }: {
  priorities?: CandidatePriority[];
  group: CandidateGroup;
  now: number;
  stale: boolean;
  quotes?: MarketQuote[];
  rules?: PrecisionRule[];
  entryInterval: "15M" | "5M";
  bandPercent: number;
  distanceGateEnabled: boolean;
}) {
  const priority = priorities?.find(row => row.symbol === group.symbol);
  const isLocked = group.stage === "locked" || group.stage === "standby";
  const lead = isLocked ? group.plans.find(plan => plan.id === priority?.planId) : group.plans[0];
  const title = group.symbol.replace("USDT", "");
  const quote = quotes?.find(item => item.symbol === group.symbol);
  const rule = rules?.find(item => item.symbol === group.symbol);
  const tickSize = quote?.tickSize ?? rule?.price.step;
  const multiple = group.plans.length > 1;
  const isUpcoming = group.stage === "upcoming";
  const isReference = group.stage === "reference";
  const quoteAge = now - Date.parse(quote?.exchangeTime ?? "");
  const quoteFresh = !stale && quoteAge >= -5000 && quoteAge <= 10000;
  const distance = lead && quoteFresh ? summarizePxDistance([lead], quote, bandPercent * 100)?.representative.status : null;
  const reason = priority?.reason ?? "";
  const note = isReference ? "已确认结构 · 仅供查看，当前不可据此入场" : isLocked
    ? !priority ? priorities ? "未列为当前执行计划" : "执行计划同步中"
      : priority.state === "POSITION_OPEN" ? "已有持仓 · 其余结构保留备查"
      : priority.state === "SUBMITTING" ? "执行处理中 · 等待成交对账"
      : !lead ? "优先计划同步中"
      : reason === "IQ1_PRE_CROSS_CONTEXT_MISSING" ? "交汇前行情证据待核验"
      : reason === "FORWARD_MARKET_EVIDENCE_STALE" ? "等待新鲜前向行情证据"
      : reason === "IQ1_EXPIRED" ? "IQ1 条件已过期 · 等待新结构"
      : !distanceGateEnabled && /PORTFOLIO|CAPACITY|CORRELATION|GROUP/.test(reason) ? "等待仓位与相关组额度"
      : !distanceGateEnabled && /INFRASTRUCTURE|ACCOUNT|EVIDENCE|QUOTE|STALE/.test(reason) ? "等待数据与账户校验"
      : !distanceGateEnabled && reason ? "等待 IQ1 入场校验"
      : !distanceGateEnabled ? "等待执行检查"
      : !distance ? "等待新鲜报价"
      : distance.position === "AT_PX" || (lead.direction === "LONG" ? distance.marketPrice < distance.px : distance.marketPrice > distance.px)
        ? "等待回到 Px 方向同侧"
      : distance.position !== "INSIDE" ? `等待价格进入同侧 ${bandPercent}%区`
      : reason === "IQ1_PX_SAME_SIDE_BAND_WAIT" ? "区内 · 等待含滑点价格复核"
      : /PORTFOLIO|CAPACITY|CORRELATION|GROUP/.test(reason) ? "区内 · 等待仓位额度"
      : /INFRASTRUCTURE|ACCOUNT|EVIDENCE|QUOTE|STALE/.test(reason) ? "区内 · 等待数据与账户校验"
      : reason ? "区内 · 执行校验未通过"
      : "区内 · 等待执行检查"
    : candidateStatusNote(lead, now, stale || lead?.stale, entryInterval, bandPercent);
  const pxLabel = lead ? formatBinancePrice(lead.intersectionPrice, tickSize, quote) : "—";
  const band = lead?.intersectionPrice && lead.direction ? (lead.direction === "LONG"
    ? `${formatBinancePrice(lead.intersectionPrice, tickSize, quote)} ＜ 价格 ≤ ${formatBinancePrice(lead.intersectionPrice * (1 + bandPercent / 100), tickSize, quote)}`
    : `${formatBinancePrice(lead.intersectionPrice * (1 - bandPercent / 100), tickSize, quote)} ≤ 价格 ＜ ${formatBinancePrice(lead.intersectionPrice, tickSize, quote)}`) : null;
  return <article className={`${styles.candidateCard} ${group.stage === "locked" ? styles.lockedCard : group.stage === "arrived" ? styles.arrivedCard : ""}`}>
    <div className={styles.candidateMain}>
      <div className={styles.candidateTopline}>
        <strong>{title} <span>{directionLabel(lead?.direction ?? group.direction)}</span></strong>
        {isLocked && priority?.state === "WAITING" && lead && <b>当前优先</b>}
      </div>
      <p className={styles.candidateStatusNote}>{note}</p>
      {group.stage !== "upcoming" && lead && <PxDistance plans={[lead]} quote={quote} tickSize={tickSize} now={now} stale={stale || lead?.stale === true} bandPercent={bandPercent} distanceGateEnabled={distanceGateEnabled} />}
    </div>
    <dl className={`${styles.candidateTiming} ${!isUpcoming ? styles.candidateTimingCompact : ""}`}>
      {isUpcoming && <div><dt>倒计时</dt><dd>{arrivalCountdown(lead?.intersectionTime, now, stale || lead?.stale, lead?.status)}</dd></div>}
      <div><dt>交汇</dt><dd>{clock(lead?.intersectionTime)}</dd></div>
      <div><dt>Px</dt><dd>{pxLabel}</dd></div>
      {!isUpcoming && band && distanceGateEnabled && <div className={styles.candidateBand}><dt>同侧 {bandPercent}%区</dt><dd>{band}</dd></div>}
    </dl>
    <div className={styles.candidateActions}>
      {(multiple || isLocked || isReference) && <details className={styles.auditDisclosure}>
        <summary>{multiple ? `${group.plans.length - (lead ? 1 : 0)} 个备选结构` : "计划详情"} <span aria-hidden="true">⌄</span></summary>
        <div className={styles.auditPlans}>{group.plans.map((plan) => <article key={plan.id}>
          <header><b>{plan.id === lead?.id ? "当前展示" : "备选结构"} · {directionLabel(plan.direction)}</b><span>{labels[plan.status] ?? plan.status}</span></header>
          <dl><div><dt>交汇时间</dt><dd>{clock(plan.intersectionTime)}</dd></div><div><dt>原始 Px</dt><dd>{formatBinancePrice(plan.intersectionPrice, tickSize, quote)}</dd></div></dl>
          {plan.id === priority?.planId && reason && <small>执行反馈：{reason}</small>}
          <code title={plan.id}>{plan.id}</code>
        </article>)}</div>
      </details>}
      <details className={styles.marketDisclosure}>
        <summary>价格详情 <span aria-hidden="true">⌄</span></summary>
        <div className={styles.marketDetails}>
          <section><h4>当前盘口</h4><QuotePrice quote={quotes?.find((item) => item.symbol === group.symbol)} now={now} stale={stale || lead?.stale === true} /></section>
          <section><h4>{multiple ? "各计划对齐参考价" : "对齐参考价"}</h4>{group.plans.map((plan) => <div className={styles.calibrationRow} key={plan.id}>{multiple && <small>{clock(plan.intersectionTime)}</small>}<PriceCalibration price={plan.intersectionPrice} symbol={plan.symbol} rule={rule} quote={quote} now={now} stale={stale || plan.stale} /></div>)}</section>
        </div>
      </details>
    </div>
  </article>;
}

function Stage({ title, subtitle, groups, stage, now, stale, quotes, rules, entryInterval, priorities, bandPercent, distanceGateEnabled, collapsible = false, open = false }: {
  priorities?: CandidatePriority[];
  title: string;
  subtitle?: string;
  groups: CandidateGroup[];
  stage: string;
  now: number;
  stale: boolean;
  quotes?: MarketQuote[];
  rules?: PrecisionRule[];
  entryInterval: "15M" | "5M";
  bandPercent: number;
  distanceGateEnabled: boolean;
  collapsible?: boolean;
  open?: boolean;
}) {
  const cards = <div className={styles.candidateList}>{groups.length ? groups.map((group) => <CandidateCard priorities={priorities} key={group.key} group={group} now={now} stale={stale} quotes={quotes} rules={rules} entryInterval={entryInterval} bandPercent={bandPercent} distanceGateEnabled={distanceGateEnabled} />) : <p className={styles.stageEmpty}>当前没有处于此阶段的候选。</p>}</div>;
  if (collapsible) return <details className={styles.candidateStage} open={open}>
    <summary><span><b>{title}</b>{subtitle && <small>{subtitle}</small>}</span><strong>{groups.length} 个</strong><span className={styles.stageToggle} aria-hidden="true">⌄</span></summary>
    {cards}
  </details>;
  return <section className={`${styles.candidateStage} ${styles[`${stage}Stage`] ?? ""}`}>
    <header><span><b>{title}</b>{subtitle && <small>{subtitle}</small>}</span><strong>{groups.length} 个</strong></header>
    {cards}
  </section>;
}

function ConfirmedAudit({ groups, quotes, rules }: { groups: CandidateGroup[]; quotes?: MarketQuote[]; rules?: PrecisionRule[] }) {
  const plans = groups.flatMap(group => group.plans);
  if (!plans.length) return null;
  return <details className={styles.confirmedAudit}>
    <summary>结构备查 <span>{plans.length}</span></summary>
    <div className={styles.confirmedAuditList}>{plans.map(plan => {
      const quote = quotes?.find(item => item.symbol === plan.symbol);
      const tickSize = quote?.tickSize ?? rules?.find(item => item.symbol === plan.symbol)?.price.step;
      return <article key={plan.id}>
        <strong>{plan.symbol.replace("USDT", "")} <span>{directionLabel(plan.direction)}</span></strong>
        <span>{clock(plan.intersectionTime)}</span>
        <span>Px {formatBinancePrice(plan.intersectionPrice, tickSize, quote)}</span>
        <code title={plan.id}>{plan.id}</code>
      </article>;
    })}</div>
  </details>;
}

export default function CandidateFunnel({ execution, executionFresh, candidates = [], filteredCandidates = [], quotes, liveQuoteState = "CONNECTING", rules, now, stale, error, loading, scannedSymbols, universeSize, accountLabel, inputStateOverride, partialScan = false }: {
  inputStateOverride?: "READY" | "UNAVAILABLE" | "UNKNOWN";
  partialScan?: boolean;
  execution?: ExecutionState | null;
  executionFresh?: boolean;
  candidates?: Candidate[];
  filteredCandidates?: FilteredCandidate[];
  quotes?: MarketQuote[];
  liveQuoteState?: LiveQuoteState;
  rules?: PrecisionRule[];
  now: number;
  stale: boolean;
  error: boolean;
  loading: boolean;
  scannedSymbols?: number;
  universeSize?: number;
  accountLabel: "S1" | "S2";
}) {
  const ordered = sortCandidates(candidates, now, stale || error) as Candidate[];
  const funnel = partitionCandidateFunnel(ordered, now, stale || error);
  const inputState = inputStateOverride ?? candidateInputState(execution, executionFresh, now);
  const inputReady = inputState === "READY";
  // Reference plans are display-only. They never become execution priorities.
  const referencePlans = inputReady ? [] : ordered.filter(plan => plan.status === "FIRST_CLOSE_LOCKED");
  const referenceIds = new Set(referencePlans.map(plan => plan.id));
  const references = groupCandidateStructures(referencePlans, "reference") as CandidateGroup[];
  const confirmed = groupCandidateStructures(funnel.locked, "locked") as CandidateGroup[];
  const allowedIds = new Set(funnel.locked.map((plan: Candidate) => plan.id));
  const priorities = inputReady ? execution?.candidatePriorities?.filter(row => row.state === 'POSITION_OPEN' || allowedIds.has(row.planId)) : undefined;
  const activeIds = new Set(priorities?.filter(row => row.state === "WAITING" || row.state === "SUBMITTING").map(row => row.planId));
  const locked = confirmed.filter(group => group.plans.some(plan => activeIds.has(plan.id)));
  const standby = inputReady ? confirmed.filter(group => !group.plans.some(plan => activeIds.has(plan.id))).map(group => ({ ...group, stage: "standby" })) : [];
  const arrived = groupCandidateStructures(funnel.arrived, "arrived") as CandidateGroup[];
  const upcoming = groupCandidateStructures(funnel.upcoming, "upcoming") as CandidateGroup[];
  const inactive = groupCandidateStructures(([...funnel.inactive, ...funnel.unknown] as Candidate[]).filter(plan => !referenceIds.has(plan.id)), "inactive") as CandidateGroup[];
  const showEmpty = !ordered.length;
  const entryInterval = accountLabel === "S2" ? "5M" : "15M";
  const bandPercent = accountLabel === "S2" && execution?.strategyRuntime?.entryAdmissionRevision === "S2-PX-BAND-3PCT-P5-20260921" ? 3 : 2;
  const distanceGateEnabled = accountLabel !== "S1" || execution?.strategyRuntime?.pxDistanceGateEnabled !== false;
  return <section id="candidates" className={styles.panel}>
    <div className={styles.panelHead}><div><span className={styles.panelKicker}>入场漏斗</span><h2>候选计划 <span>{candidates.length} 个结构</span></h2></div></div>
    {!inputReady && !loading && <p className={styles.alert} role="status"><strong>{inputState === "UNAVAILABLE" ? "扫描输入暂不可用" : "执行计划待核验"}</strong> · 已确认结构保留供查看，不代表当前可入场，也不会复用旧信号下单。现有持仓管理独立继续。{partialScan ? " 当前扫描不完整；仅保留本页此前见过的确认结构，部分结构可能暂缺，等待恢复。" : ""}{execution?.candidateSource?.lastGoodAt ? ` 最近有效输入 ${clock(new Date(execution.candidateSource.lastGoodAt).toISOString())}。` : ""}</p>}
    {showEmpty ? <div className={styles.empty}><span className={styles.cross}>＋</span><h3>{loading ? "正在读取候选" : !inputReady ? "候选状态待恢复" : "暂无符合结构条件的候选"}</h3><p>{!inputReady ? "输入未确认，不能把空列表视为本轮没有候选。" : Number.isFinite(scannedSymbols) ? `最近一轮完成 ${scannedSymbols} / ${universeSize ?? 0} 个交易对；没有候选不等于扫描停止。` : "连接成功后显示真实计划，不填充示例交易。"}</p></div> : <div className={styles.funnelBody}>
      {!!references.length && <div id="candidate-reference"><Stage title="已确认计划 · 等待输入恢复" subtitle="保留结构，仅供查看" groups={references} stage="reference" now={now} stale={stale || error} quotes={quotes} rules={rules} entryInterval={entryInterval} bandPercent={bandPercent} distanceGateEnabled={distanceGateEnabled} /></div>}
      {!!locked.length && <div id="candidate-locked"><Stage title="当前优先计划" priorities={priorities} groups={locked} stage="locked" now={now} stale={stale || error} quotes={quotes} rules={rules} entryInterval={entryInterval} bandPercent={bandPercent} distanceGateEnabled={distanceGateEnabled} /></div>}
      {!!arrived.length && <div id="candidate-arrived"><Stage title="等待入场信号" collapsible groups={arrived} stage="arrived" now={now} stale={stale || error} quotes={quotes} rules={rules} entryInterval={entryInterval} bandPercent={bandPercent} distanceGateEnabled={distanceGateEnabled} /></div>}
      {!!upcoming.length && <div id="candidate-upcoming"><Stage title="等待交汇" groups={upcoming} stage="upcoming" now={now} stale={stale || error} quotes={quotes} rules={rules} entryInterval={entryInterval} bandPercent={bandPercent} distanceGateEnabled={distanceGateEnabled} /></div>}
      {!!inactive.length && <Stage title="待归档" groups={inactive} stage="inactive" now={now} stale={stale || error} quotes={quotes} rules={rules} entryInterval={entryInterval} bandPercent={bandPercent} distanceGateEnabled={distanceGateEnabled} collapsible />}
    </div>}
    <ConfirmedAudit groups={standby} quotes={quotes} rules={rules} />
    <div id="candidate-history"><CandidateHistory rows={filteredCandidates} quotes={quotes} rules={rules} /></div>
    <div className={styles.panelFoot}><span>{accountLabel === "S2" ? "1H 结构 × 15M 对向结构 → 5M 入场确认" : "4H 结构 × 1H 对向结构 → 15M 收线确认"}</span><span title="页面报价每秒聚合，实际下单以执行器校验为准">{liveStateLabel[liveQuoteState]}</span></div>
  </section>;
}
