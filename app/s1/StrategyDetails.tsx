import { usesS1Structure } from "../../lib/s1-candidate-funnel.mjs";
import type { ExecutionState } from "./TradeLedger";
import styles from "./strategy-details.module.css";

const P5 = "S1-S2-PX-BAND-RISK-ONLY-P5-20260920";
const S2_THREE_PERCENT = "S2-PX-BAND-3PCT-P5-20260921";
const S1_R221 = "MTFX-0.5.0-R22.1-ENTRY-PROTECTION-CONSISTENCY";
const percent = (value: string) => new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 2 }).format(Number(value));

export default function StrategyDetails({ execution, fresh, accountLabel }: { execution?: ExecutionState | null; fresh: boolean; accountLabel: "S1" | "S2" }) {
  const runtime = execution?.strategyRuntime;
  const s1R221 = accountLabel === "S1" && runtime?.executionRevision === S1_R221 && runtime?.entryQualityRevision === "V2-IQ1-P1-20260915";
  const r22Rollback = runtime?.entryQualityPolicyRevision === 'S1-R22-ROLLBACK-20261010';
  const paperFinal = r22Rollback || s1R221 && runtime?.entryQualityPolicyRevision === "S1-IQ1-P1-PAPER-FINAL-20261010";
  const p5 = runtime?.entryAdmissionRevision === P5 || (accountLabel === "S2" && runtime?.entryAdmissionRevision === S2_THREE_PERCENT);
  const bandPercent = runtime?.entryAdmissionRevision === S2_THREE_PERCENT ? 3 : 2;
  const upper = bandPercent === 3 ? "1.03" : "1.02";
  const lower = bandPercent === 3 ? "0.97" : "0.98";
  const risk = runtime?.riskPolicy;
  const versions = [
    ["当前组合策略", runtime?.displayName],
    ["执行引擎", runtime?.executionRevision],
    ["入场质量模块", runtime?.entryQualityRevision],
    ["基础策略内核", runtime?.baseImplementationRevision],
    ["利润管理", runtime?.managementRevision],
    ["组合保护", runtime?.portfolioProtectionRevision],
    ["入场重确认", runtime?.entryConfirmationRevision],
    ["费用计入规则", runtime?.costPolicyRevision],
    ["候选优先级", runtime?.candidatePriorityRevision],
  ];
  return <section className={styles.strategy} aria-labelledby="strategy-details-title">
    <header><div><h2 id="strategy-details-title">策略与执行</h2><p>{runtime?.displayName ?? "等待策略回报"}</p></div><span className={fresh && runtime?.runtimeLoaded ? styles.synced : styles.stale}>{fresh && runtime?.runtimeLoaded ? "执行进程已载入" : "当前版本待核验"}</span></header>
    {!runtime ? <p className={styles.empty}>执行进程尚未返回策略与版本信息，连接恢复后自动更新。</p> : <>
      {!fresh && <p className={styles.notice}>以下为上次快照，当前执行版本与规则尚待重新核验。</p>}
      <div className={styles.columns}>
        <div><h3>策略详情</h3><dl className={styles.rules}>
          <div><dt>交易范围</dt><dd>{accountLabel} · Binance USDⓈ-M 永续合约</dd></div>
          <div><dt>时间框架</dt><dd>{usesS1Structure(accountLabel, execution) ? "4H × 1H 交汇，15M 确认方向与入场" : "1H × 15M 交汇，5M 确认方向与入场"}</dd></div>
        </dl>
        {r22Rollback ? <div className={styles.descriptions}><section><h4>R22 方向与入场</h4><p>4H × 1H 交汇，15M 两根内首次越过5bp缓冲的收盘确认方向。确认后180秒、交汇后30分钟内执行，报价偏离确认收盘不超过50bp。取消 IQ1 压缩、扩张与Px距离门；保留新鲜Tick/BBO、完整往返成本≤0.12R及实盘相关组风险限额。</p></section><section><h4>分批止盈与保护</h4><p>净+0.5R减原仓40%，净+1R再减25%，净+2R再减20%，余15%跟踪；整单保护底线为+0.15R／+0.60R，1H结构与15M ATR只收紧。R21组合保护至少3笔同向合格仓位；保留真实结算与报价完整性核验。旧仓继续记录的原退出规则。</p></section></div> : s1R221 ? <div className={styles.descriptions}>
          <section><h4>方向与入场</h4><p>R22.1 负责交汇后的方向确认与保护一致性；IQ1 P1 检查压缩、真实交叉锚点、突破后的两段扩张、最新进展、报价新鲜度及相关组容量。{paperFinal ? "新入场距 Px 同时不超过2%与1个冻结15M ATR；确认收盘后180秒、交汇后30分钟内复核，报价相对确认收盘不超过50bp。" : "Px 距离门已取消，Px 距离只保留为观测数据；可执行报价相对已确认的 15M 决策收盘偏离不得超过 50bp。"}</p></section>
          <section><h4>候选与失效</h4><p>完整往返成本不得超过初始风险0.12R，超限即终止本次交汇。候选依次按距Px的ATR倍数、交汇年龄、成本R与盘口点差排序；旧信号必须使用新的前向行情证据重新确认，同币不重复建仓，同组最多2仓。证据过时、交叉锚点缺失、扩张不足、行情断流或账户对账异常都会阻止本次入场。</p></section>
          <section><h4>仓位与利润保护</h4><p>每笔按含手续费与不利滑点的止损损失控制在权益 4% 以内，组合上限 10%。{paperFinal ? "纸面最终原版退出：净+0.5R减原仓40%，净+1R再减25%，净+2R再减20%；整笔净R止损底线分别+0.15R与+0.60R，余15%按1H已确认结构与15M ATR更紧者追踪。历史仓位保留原政策。组合至少3笔同方向仓位达到权益1.5%或初始风险2倍时激活；正常回吐20%预警、30%减初始仓25%、40%清初始仓，弱势阈值为15%／25%／35%。已激活组合剩一两仓仍按回吐冻结同方向新仓15分钟，减仓与清仓仍要求3仓。BTC／ETH不参与组合保护。" : "沿用强化利润锁定：首阶段累计减仓60%，净1R累计80%，净2R累计85%，保留约15%尾仓追踪。"}</p></section>
        </div> : p5 ? <div className={styles.descriptions}>
          <section><h4>方向与入场</h4><p>交汇后，首根收盘价不等于 Px 的完整入场周期 K 线确定方向。当前可执行盘口进入方向同侧 {bandPercent}% 区，即可进入下单校验；首根方向收盘在区外时，等待第一次回踩入区，无须再等一根区内收盘。</p><div className={styles.formulas}><span>做多：Px ＜ 卖一 ≤ {upper} × Px</span><span>做空：{lower} × Px ≤ 买一 ＜ Px</span></div></section>
          <section><h4>候选与失效</h4><p>同币靠近 Px 的计划优先，每个计划最多入场一次。候选没有固定时效，新结构出现不会单独取消旧计划；完整收盘反向越过 Px 后原方向失效。同币不重复建仓，追踪尾仓期间不接受反向开仓。</p></section>
          <section><h4>仓位与保护</h4><p>仓位按实际止损距离计算，开仓和平仓费用及不利滑点均计入风险预算。风险额度是上限，数量向下取整；每笔保留初始止损，并核验新鲜盘口、账户、交易所规则和成交对账。</p></section>
        </div> : <p className={styles.empty}>当前回报不属于此页已核验的入场规则，按右侧实际版本标识核对策略。</p>}
        </div>
        <div><h3>风险限额</h3>{risk && <dl className={styles.risk}>
          <div><dt>单笔风险</dt><dd>≤ {percent(risk.perTradeFraction)}</dd></div>
          <div><dt>组合风险</dt><dd>≤ {percent(risk.portfolioFraction)}</dd></div>
          <div><dt>持仓上限</dt><dd>{risk.maximumOpenPositions} 仓</dd></div>
          <div><dt>最大杠杆</dt><dd>{risk.maximumLeverage} 倍</dd></div>
          <div className={styles.wide}><dt>总名义敞口</dt><dd>≤ 权益 × {risk.maximumGrossNotionalLeverage}</dd></div>
          {risk.effectiveMaximumGroupPositions != null && <div className={styles.wide}><dt>同组持仓上限</dt><dd>{risk.effectiveMaximumGroupPositions} 仓</dd></div>}
        </dl>}
        {paperFinal && <><h3>组合保护实时状态</h3>{execution?.portfolioProtection ? <>
          <p className={styles.versionNote}>{execution.portfolioProtection.evidenceHold ? "行情或结算证据待核验，组合参与币种暂停新开仓" : "组合证据已核验"} · {execution.portfolioProtection.evaluatedAt ? new Date(execution.portfolioProtection.evaluatedAt).toLocaleString("zh-CN") : "待回报"}</p>
          {execution.portfolioProtection.campaigns.map(c => <dl className={styles.rules} key={c.direction}>
            <div><dt>{c.direction === "LONG" ? "多头组合" : "空头组合"}</dt><dd>{c.active ? "已激活" : "未激活"} · {c.positionCount} 仓</dd></div>
            <div><dt>组合净盈亏／高点</dt><dd>{c.markedPnlUsdt.toFixed(2)}／{c.highWaterPnlUsdt.toFixed(2)} USDT</dd></div>
            <div><dt>高点回吐</dt><dd>{(c.drawdownFraction*100).toFixed(1)}% · {({IDLE:"未激活",ARMED:"守护",WARNING:"预警",DEFENSE:"防御",HARD:"硬保护"} as Record<string,string>)[c.entryProtectionTier]}</dd></div>
            <div><dt>同方向新仓冻结</dt><dd>{c.freezeUntil && Date.parse(c.freezeUntil) > Date.now() ? `至 ${new Date(c.freezeUntil).toLocaleTimeString("zh-CN")}` : "无有效冻结"}</dd></div>
          </dl>)}
        </> : <p className={styles.empty}>等待执行器返回组合保护证据。</p>}</>}
        <h3>执行版本</h3><p className={styles.versionNote}>{s1R221 ? "当前策略以 R22 基础内核运行 R22.1 执行层与 IQ1 P1 入场质量层；基础内核版本单独列出，不代表旧策略仍在执行。" : p5 ? "P5 是当前入场规则。基础引擎与质量模块保留各自版本标识，不代表旧附加准入门重新启用。" : "按执行进程回报展示，入场规则与基础引擎有各自的版本号。"}</p><dl className={styles.versions}>{versions.filter(([, value]) => value != null).map(([label, value]) => <div key={label}><dt>{label}</dt><dd><code>{value}</code></dd></div>)}</dl>
        </div>
      </div>
    </>}
  </section>;
}
