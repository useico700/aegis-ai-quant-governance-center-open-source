import type { Metadata } from "next";
import SmcWorkspace from "./SmcWorkspace";

export const metadata: Metadata = {
  title: "SMC Live｜实盘策略监视器",
  description: "币安行情扫描、交汇时间标记、局部SMC与K线确认、净2R候选与独立执行账本。",
};

export default function SmcPage() { return <SmcWorkspace />; }
