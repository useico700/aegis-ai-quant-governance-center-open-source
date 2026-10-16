import type { Metadata } from "next";
import S1Pro from "./S1Pro";

export const metadata: Metadata = {
  title: "S1 Pro｜账户与执行监视器",
  description: "S1 监视器动效版：原版布局与数据不变，增强多空信号流粒子光纤、心跳波形、数字变化与入场动效。",
  icons: { icon: { url: "/s1-logo.svg", type: "image/svg+xml" }, shortcut: "/s1-logo.svg" },
};

export default function S1ProPage() { return <S1Pro />; }
