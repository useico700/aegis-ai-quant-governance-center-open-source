# AEGIS AI Quant Governance Center · 开源版

**基于原项目源码派生，保留原架构与主要功能，默认从隔离模拟环境开始。**

来源：[aegis-ai-quant-governance-center](https://github.com/useico700/aegis-ai-quant-governance-center)，基线commit：484fcddb3c69f213b0ef26586a2c49f852185bc2。该基线为GitHub已提交的R22版本，不混入其他工作区尚未提交的后续变更。

本版保留原驾驶舱、S1/S2扫描与执行内核、风险/仓位/保护管理、SQLite审计、行情证据、JEV独立观察/研究/影子代码、数据库与Worker、TradingView及部署扩展结构。**默认模拟直接调用原S1/S2执行引擎，不使用另一套MA策略代替原项目。**

[复制AI Agent安装提示词](docs/AGENT_PROMPT.md) · [安装手册](docs/INSTALL.md) · [原项目功能对应表](docs/FEATURE_PARITY.md)

## 与私人部署的区别

这是独立的源码发行版和全新Git历史。私人身份、主机、凭据、账户账本、业绩、聊天记忆、个人授权及事故报告均未导入。交易所地址改为Demo，原主机专属启动器停用；默认不会连接任何交易所订单接口。

保留源码不等于获得原操作者的实盘授权，也不代表所有模块都已完成新环境部署。当前开箱可验收的是原驾驶舱、本地模拟交易所执行回路、可移植组件测试及JEV只读界面。哪些是可运行功能、哪些需用户配置，见[对应表](docs/FEATURE_PARITY.md)。

## 准备什么

Git、Node.js >=22.13（建议Node24）、npm、可写目录，以及访问GitHub/npm的网络。建议4GB可用内存、3GB磁盘。默认不需要实盘账号、资金、API Key、服务器、Docker、Cloudflare账号或模型API Key。

## 安装与运行

```bash
git clone https://github.com/useico700/aegis-ai-quant-governance-center-open-source.git
cd aegis-ai-quant-governance-center-open-source
npm ci --ignore-scripts
npm run setup
npm test
npm run verify:migration
npm run build
npm run dev
```

打开 [S1](http://127.0.0.1:3000/s1)、[S2](http://127.0.0.1:3000/s2)、[复制安装提示词](http://127.0.0.1:3000/install)。所有预览数据有合成标记；原实盘状态不会被复制。

setup运行原执行引擎的合成信号、BBO/Tick、账户和模拟交易所适配器，验证入场、保护单、记账。回执位于 .runtime/public-demo/S1.json 与 S2.json。**这些是假数据演练，不是市场扫描结果、账户业绩或平台Demo成交。**

```bash
npm run demo
npm run demo:watch
```

demo执行一次，demo:watch每10秒重复独立演练并更新本地看板回执。它不是持久市场策略，不能用来计算收益。Ctrl+C停止；强制退出遗留写锁需核对PID后处理。

## JEV界面

```bash
npm --prefix apps/jev-filter ci --ignore-scripts
npm run jev:build
npm run jev:dev
```

打开 [JEV](http://127.0.0.1:3001)。保留原决策、结果研究和影子面板，默认无样本、无模型推理、无运行中的影子实例。可选AI服务需要使用者自己的配置，JEV始终没有订单权限。

## 原模块

| 模块 | 位置 |
| --- | --- |
| AEGIS PRIME / NEXUS治理角色 | agents/aegis-prime、agents/nexus、governance |
| S1/S2扫描、执行、退出、风控和对账 | agents/orion-live |
| 共享策略与纸面引擎 | agents/shared、agents/orion-v2/paper |
| 账户/持仓/候选/交易流水驾驶舱 | app/s1、app/s2、lib |
| JEV观察、研究与影子代码及界面 | integrations/jev、apps/jev-filter |
| 存储、快照API、Cloudflare Worker | db、drizzle、app/api、worker |
| TradingView图表和信号代码 | tradingview |
| 本地安全入口与部署模板 | scripts/public、ops |

## 接入自己的Demo账户

先完成离线安装，再按 [Demo引导](docs/DEMO_GUIDE.md)准备官方Demo账户及专用凭据。npm run demo:network只检查公开端点，不代表账户、单写执行器或保护单已经验收。生产订单连接、个人授权和账户参数不能继承；不能仅填Key就自动启动原主机运行器。

## 文档与许可

- [架构及数据流](docs/ARCHITECTURE.md)
- [部署与配置](docs/DEPLOYMENT.md)
- [脱敏与源代码追溯](docs/SANITIZATION.md)
- [Agent安装提示词](docs/AGENT_PROMPT.md)
- [MIT License](LICENSE) · [贡献](CONTRIBUTING.md) · [安全](SECURITY.md)
