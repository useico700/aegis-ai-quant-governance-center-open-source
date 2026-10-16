"use client";

import { useEffect, useState } from "react";
import { evaluateSmcDraft, restoreSmcDrafts, smcPrecisionReview, smcReadiness, SMC_MODELS, SMC_TIMEFRAMES, SMC_MODULE_REVISION } from "../../lib/smc-executor.mjs";
import type { AccountRecord } from "../s1/AccountWorkspace";
import type { ExecutionState } from "../s1/TradeLedger";
import type { PrecisionRule } from "../s1/PriceCalibration";
import { normalizePriceByPurpose, normalizePriceForTick } from "../../lib/smc-price-input.mjs";
import PriceDigitInput from "./smc/PriceDigitInput";
import styles from "./smc-executor.module.css";

const storageKey = "aegis:s2:smc:plan-drafts:v1";
const initial = { model: "CONTINUATION", direction: "LONG", symbol: "", structureTimeframe: "4h", entryTimeframe: "15m",
  entry: "", stop: "", target: "", quantity: "", feeBps: "", slippageBps: "", fundingCost: "", riskBudget: "", evidence: "" };
type Draft = { id: string; createdAt: string; plan: typeof initial; metrics: NonNullable<ReturnType<typeof evaluateSmcDraft>["metrics"]> };
const number = (value: string | number | null | undefined) => value == null ? "—" : new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4 }).format(Number(value));
const fields = [ ["entry", "计划入场价"], ["stop", "初始止损价"], ["target", "结构止盈价"], ["quantity", "数量（币）"],
  ["riskBudget", "草稿风险预算（USDT）"], ["feeBps", "单边手续费（bp）"], ["slippageBps", "单边滑点（bp）"], ["fundingCost", "资金费成本预留（USDT）"] ] as const;

export default function SmcExecutor({ account, accountFresh, execution, executionFresh, rules = [], now }: {
  account?: AccountRecord; accountFresh: boolean; execution?: ExecutionState | null; executionFresh: boolean; rules?: PrecisionRule[]; now: number;
}) {
  const [form, setForm] = useState(initial);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [notice, setNotice] = useState("");
  const [storageReady, setStorageReady] = useState(false);
  useEffect(() => {
    const load = () => {
      try { setDrafts(restoreSmcDrafts(localStorage.getItem(storageKey) ?? "[]")); setStorageReady(true); }
      catch { setNotice("浏览器存储不可用；可校验并导出草稿。"); }
    };
    const frame = requestAnimationFrame(load);
    const changed = (event: StorageEvent) => { if (event.key === storageKey || event.key === null) load(); };
    window.addEventListener("storage", changed);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("storage", changed); };
  }, []);
  const ready = smcReadiness({ accountFresh, execution, executionFresh });
  const checked = evaluateSmcDraft(form);
  const metrics = checked.metrics;
  const precision = smcPrecisionReview(form, rules.find(rule => rule.symbol === form.symbol), now);
  const precisionRule = rules.find(rule => rule.symbol === form.symbol);
  const tickSize = precisionRule?.price.step ?? null;
  const update = (key: keyof typeof initial, value: string) => setForm(previous => ({ ...previous, [key]: value }));
  const normalizePriceField = (key: "entry" | "stop" | "target") => {
    const value = form[key];
    const normalized = key === "entry" ? normalizePriceForTick(value, tickSize)
      : normalizePriceByPurpose(value, tickSize, form.direction, key === "stop" ? "STOP" : "TARGET");
    if (normalized) update(key, normalized);
  };
  const makeDraft = () => ({ schema: "SMC_TRADE_PLAN_DRAFT_V1", account: "S2", id: crypto.randomUUID(), createdAt: new Date().toISOString(),
    moduleRevision: SMC_MODULE_REVISION, submissionAllowed: false, plan: checked.plan, metrics: checked.metrics });
  const save = () => {
    if (checked.status !== "DRAFT_VALID") return;
    try {
      const saved = restoreSmcDrafts(localStorage.getItem(storageKey) ?? "[]");
      if (saved.length >= 30) { setNotice("已保存 30 份草稿，请先导出并移除不需要的草稿。"); return; }
      const next = restoreSmcDrafts(JSON.stringify([makeDraft(), ...saved]));
      localStorage.setItem(storageKey, JSON.stringify(next)); setDrafts(next); setNotice("草稿已保存在当前浏览器；没有提交订单。");
    } catch { setNotice("保存失败；请导出草稿以免丢失。"); }
  };
  const download = () => {
    if (checked.status !== "DRAFT_VALID") return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(makeDraft(), null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `SMC-S2-${form.symbol}-draft.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const remove = (id: string) => {
    try {
      const next = restoreSmcDrafts(localStorage.getItem(storageKey) ?? "[]").filter((row: Draft) => row.id !== id);
      localStorage.setItem(storageKey, JSON.stringify(next)); setDrafts(next); setNotice("已移除本地草稿。");
    } catch { setNotice("移除失败，浏览器存储不可用。"); }
  };

  return <section id="smc" className={styles.panel} aria-labelledby="smc-title">
    <header className={styles.heading}><div><span className={styles.kicker}>S2 / SMART MONEY CONCEPTS</span><h2 id="smc-title">SMC 交易执行器</h2><p>复用 S2 币安账户 · 独立策略计划 · 当前处于计划校验阶段</p></div><span className={styles.badge}>实盘未启用</span></header>
    <div className={styles.statusGrid}>
      <article><span>账户连接</span><b>{ready.accountState}</b><small>复用 S2 现有同步 · 不需要重新填写 API Key</small></article>
      <article><span>订单执行入口</span><b>{ready.executionState}</b><small>SMC 主机适配待完成 · 保留唯一订单写入器</small></article>
      <article><span>账户权益 / 可用余额</span><b>{accountFresh ? number(account?.equity) : "—"} / {accountFresh ? number(account?.available) : "—"}</b><small>USDT · S2 全账户资金，非 SMC 独立额度</small></article>
    </div>
    <div className={styles.content}>
      <div>
        <h3>新建交易计划</h3>
        <p className={styles.hint}>4H / 15M 是可编辑的草稿初值。填写结构目标和成本预估，校验净盈亏比；不会据此推断胜率。</p>
        <form onSubmit={event => { event.preventDefault(); save(); }}>
          <div className={styles.formGrid}>
            <label className={styles.wide}>交易模型<select value={form.model} onChange={e => update("model", e.target.value)}>{Object.entries(SMC_MODELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
            <label>交易对<input value={form.symbol} placeholder="例如 BTCUSDT" maxLength={24} autoComplete="off" onChange={e => update("symbol", e.target.value.toUpperCase().trim())} /></label>
            <label>方向<select value={form.direction} onChange={e => update("direction", e.target.value)}><option value="LONG">做多</option><option value="SHORT">做空</option></select></label>
            <label>结构周期<select value={form.structureTimeframe} onChange={e => update("structureTimeframe", e.target.value)}>{Object.keys(SMC_TIMEFRAMES).map(tf => <option key={tf}>{tf}</option>)}</select></label>
            <label>入场周期<select value={form.entryTimeframe} onChange={e => update("entryTimeframe", e.target.value)}>{Object.keys(SMC_TIMEFRAMES).map(tf => <option key={tf}>{tf}</option>)}</select></label>
            {fields.map(([key, label]) => { const priceField = key === "entry" || key === "stop" || key === "target"; return <label key={key}>{label}{priceField
              ? <PriceDigitInput tickSize={tickSize} value={form[key]} maxLength={50} autoComplete="off" onValueChange={value => update(key, value)} onBlur={() => normalizePriceField(key)} />
              : <input inputMode="decimal" type="text" value={form[key]} maxLength={50} autoComplete="off" onChange={e => update(key, e.target.value)} />}</label>; })}
            <label className={styles.wide}>结构依据与失效条件<textarea rows={3} maxLength={2000} value={form.evidence} placeholder="记录 BOS / 流动性扫取、OB / FVG 区域、确认 K 线与止损依据。文字备注不等于机器核验。" onChange={e => update("evidence", e.target.value)} /></label>
          </div>
          <p className={styles.hint}>1 bp = 0.01%。费用与滑点按入场、出场双边估算，止损与止盈分别计费；资金费填写非负成本预留。以上均为草稿参数。</p>
          <div className={styles.metrics} aria-live="polite"><div><span>预计初始风险</span><b>{number(metrics?.estimatedInitialRisk)} <small>USDT</small></b></div><div><span>预计净目标收益</span><b>{number(metrics?.estimatedNetReward)} <small>USDT</small></b></div><div><span>净收益 / 初始风险</span><b>{number(metrics?.netRewardRiskRatio)} <small>R</small></b></div></div>
          <p className={styles.validation} role="status">{checked.status === "DRAFT_VALID" ? `基础校验通过 · ${precision.message}` : checked.reason}</p>
          <div className={styles.actions}><button type="submit" disabled={checked.status !== "DRAFT_VALID" || !storageReady}>保存草稿</button><button type="button" disabled={checked.status !== "DRAFT_VALID"} onClick={download}>导出计划</button><button type="button" disabled title="可执行策略、风险政策、主机适配和实盘授权尚未完成">提交交易 · 未启用</button></div>
          {notice && <p role="status" className={styles.hint}>{notice}</p>}
        </form>
      </div>
      <aside className={styles.readiness}><h3>实盘接入进度</h3><p>账户数据已接入 S2 页面，SMC 计划尚未连接主机订单队列。保存或导出不会开仓。</p>
        <ol>{ready.blockers.map(blocker => <li key={blocker}>{blocker}</li>)}</ol>
        <p>风险额度不会继承旧 S2 或历史 F 系列参数。SMC 未来须与 S2 其他策略共同计算持仓、挂单、预留风险及总敞口。</p>
        <p>JEV 尚未接入本模块；没有已校准的入场概率或胜率。当前草稿不计入 S2 成交与 JEV 研究样本。</p>
        <small>{SMC_MODULE_REVISION} · 规划模块版本，非策略版本</small>
      </aside>
    </div>
    <div className={styles.saved}><h3>本地计划草稿 <span>{drafts.length} / 30</span></h3><p className={styles.hint}>仅保存在当前浏览器，不跨设备同步。真实委托、保护单和成交仍在 S2 持仓与流水中核验。</p>
      {drafts.length ? <ul>{drafts.map(draft => <li key={draft.id}><div><b>{draft.plan!.symbol} · {draft.plan!.direction === "LONG" ? "做多" : "做空"}</b><small>{SMC_MODELS[draft.plan!.model as keyof typeof SMC_MODELS]} · {number(draft.metrics!.netRewardRiskRatio)}R · {new Date(draft.createdAt).toLocaleString("zh-CN")}</small></div><div className={styles.actions}><button type="button" onClick={() => { setForm(draft.plan! as typeof initial); setNotice("已载入草稿，请重新核验时效和结构依据。"); }}>载入</button><button type="button" onClick={() => remove(draft.id)}>移除</button></div></li>)}</ul> : <p className={styles.hint}>暂无保存的 SMC 草稿。</p>}
    </div>
  </section>;
}
