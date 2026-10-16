import type { Metadata } from "next";
import S1ProWorkspace from "./S1ProWorkspace";

export const metadata: Metadata = {
  title: "S1 Pro｜账户与执行监视器",
  description: "S1 监视器动效版：4H × 1H 交汇倒计时、三路心跳、权益轨迹、持仓阶段与候选计划。只读，复用现有快照接口。",
  icons: { icon: { url: "/s1-logo.svg", type: "image/svg+xml" }, shortcut: "/s1-logo.svg" },
};

export default function S1ProPage() { return <S1ProWorkspace />; }
