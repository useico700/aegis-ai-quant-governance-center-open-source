export function arrivalCountdown(scheduledAt, now, stale = false, status = "FORMING") {
  if (!now || !Number.isFinite(Date.parse(scheduledAt))) return "—";
  if (stale) return "数据过时";
  if (status === "INVALIDATED") return "已失效 / 待核验";
  if (["EXPIRED", "CONFIRMED_EXPIRED", "NON_CAUSAL_OBSERVATION"].includes(status)) return "已过期 / 待核验";
  const seconds = Math.ceil((Date.parse(scheduledAt) - now) / 1000);
  if (seconds <= 0) return "已到达";
  const days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60;
  return `${days ? `${days}天 ` : ""}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

export function candidateStatusNote(candidate, now, stale = false, entryInterval = "15M", bandPercent = 2) {
  if (stale || candidate?.stale) return "状态暂停";
  const status = candidate?.status;
  const reason = candidate?.reason;
  const intersectionAt = Date.parse(candidate?.intersectionTime);
  const arrived = Number.isFinite(intersectionAt) && Number.isFinite(now) && now >= intersectionAt;

  if (status === "WAITING_FIRST_PX_CLOSE") {
    if (reason === "PX_FIRST_PULLBACK_PENDING") return `等待价格进入同侧 ${bandPercent}%区`;
    if (reason === "DIRECTION_CLOSE_PENDING") return arrived
      ? `等首根 ${entryInterval} 收盘定向`
      : `等交汇后首根 ${entryInterval} 收盘`;
    return arrived ? "等入场状态更新" : "跟踪中";
  }
  if (status === "FIRST_CLOSE_LOCKED") return "方向已确认 · 等待执行检查";
  if (status === "FORMING") return arrived ? "等结构状态同步" : "跟踪中";
  if (status === "WAITING_CLOSE") return arrived ? "等完整收盘" : "等结构收线";
  if (status === "CONFIRMED_SCAN_ONLY") return "方向已确认";
  if (status === "INVALIDATED") return "反向越过 Px · 已失效";
  if (["EXPIRED", "CONFIRMED_EXPIRED", "NON_CAUSAL_OBSERVATION"].includes(status)) return "已离开入场流程";
  return "状态同步中";
}
