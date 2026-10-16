export const MONITOR_PRESENTATION_REVISION = "MONITOR-SYNC-11-20260825";

export function abnormalLossGateLabel(status?: string) {
  return ({ CLEAR: "正常", YELLOW: "黄色观察", ORANGE: "橙色恢复", RED: "红色熔断" } as Record<string, string>)[status ?? ""] ?? "状态未知";
}

export const MONITOR_COMMON_COPY = Object.freeze({
  healthy: "同步正常",
  stale: "同步待恢复",
  refresh: "刷新",
  refreshing: "刷新中",
  sourceTime: "源数据时间",
  positions: "当前持仓",
  candidates: "候选计划",
  emptyCandidates: "当前无候选计划",
});

export const AUTHORIZED_MONITOR_ROUTES = Object.freeze([
  { id: "ORION_V2", route: "/v2-ledger" },
  { id: "ORION_V2_ACCOUNT_EQUITY_SHADOW", route: "/v2-ledger/account-shadow" },
  { id: "ORION_V3", route: "/v3-equity" },
  { id: "ORION_V3_HF12A_SHADOW", route: "/v3-equity/hf12a-shadow" },
  { id: "ORION_V4", route: "/v4-monitor" },
]);
