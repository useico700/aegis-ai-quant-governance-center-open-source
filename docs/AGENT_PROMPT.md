# 一键复制给 AI Agent

点击代码块右上角复制按钮。也可在本地 /install 页面点击复制。适用于具备终端与文件能力的Agent；纯聊天模型只能指导。

```text
请安装并运行 AEGIS AI Quant Governance Center 的开源版本：
https://github.com/useico700/aegis-ai-quant-governance-center-open-source

这是从 aegis-ai-quant-governance-center 原项目派生的源码版，请保留原驾驶舱、S1/S2策略、扫描、执行、审计、JEV与TradingView模块，不要另建一个MA示例项目替代它。

Windows使用WSL2/Ubuntu，在Linux家目录安装，不能放在/mnt/c等Windows挂载盘；原生Windows不运行执行回路，因为原审计账本要求POSIX权限与目录同步。

请实际执行以下步骤；你需要终端与文件操作能力。没有这些能力时请明确说明，提供手动步骤，不要假称安装成功。

1. 先说明准备项并检查环境：Git、Node.js >=22.13（建议Node24）、npm、可写的新目录、可访问GitHub与npm的软件安装网络。建议4GB可用内存和3GB磁盘。默认本地模拟无需真实资金、交易所账户、API Key、服务器、Docker或AI模型API Key。缺软件时给出官方安装方法，不擅自提权或执行不明安装脚本。

2. 在独立新目录克隆上面的开源仓库，不安装进既有交易系统目录。若目标目录已有内容，先检查remote和Git状态，不覆盖代码、配置或账本。阅读README.md、AGENTS.md、governance/current-state.json、docs/INSTALL.md与docs/FEATURE_PARITY.md。原项目的个人账户授权不能用于本次安装。

3. 执行 npm ci --ignore-scripts、npm run setup、npm test、npm run verify:migration 和 npm run build。setup调用原S1/S2执行引擎与FakeS1Venue，在完全离线的合成信号/行情中验证入场、保护和记账。报告实际失败，不绕过检查、不移除启动保护、不生成虚假授权。

4. 运行 npm run dev，打开 http://127.0.0.1:3000/s1 和 /s2，验证原项目驾驶舱可用、顶部明确显示开源模拟模式，账户不是私人实盘。若需要持续更新合成演练回执，在另一个终端运行 npm run demo:watch。它重复隔离演练，不是持续市场策略或真实成交。告诉我各进程与Ctrl+C停止方法。页面只绑定本机，不发布公网。

5. 需要查看JEV界面时，先安装 npm --prefix apps/jev-filter ci --ignore-scripts，再 npm run jev:dev，打开 http://127.0.0.1:3001。保留JEV的独立只读边界；默认不启动模型推理或影子运行，不声称已连接AI服务。

6. 离线验收完成后，询问是否继续接入我自己的Binance Demo账户。
- 先读docs/DEMO_GUIDE.md，说明本地模拟交易所和交易所Demo账户是两种环境。npm run demo:network仅检查Demo公共端点可达性，不表示账户已连接或已经下单。
- 如果我选择继续，列出我需在官方Demo环境自行准备的账号、专用Demo HMAC API Key、最小权限和必要网络条件。凭据仅由我在本机密钥管理器或被Git忽略的.env中私下配置，绝不让我粘贴到聊天。
- 此源码保留原订单、风险和对账模块，但原主机启动器已停用，不能仅凭填Key就宣称系统可自动下单。先按文档准备我自己的独立Demo配置、显式授权、持久化目录、单写者和退出保护，逐项验收；在我明确确认Demo执行范围前，不接通交易所订单写入。
- 遇到451/403、地域限制、超时、限流或凭据错误，报告真实错误并停止重试。保持离线演练可用，不切实盘、不绕过访问限制。
- 不启用实盘、不存取真实资金、不修改账户杠杆、不创建或扩大密钥权限，不恢复任何私人JEV服务。

7. 最后报告：安装目录与commit、实际检查和测试结果、S1/S2及JEV页面地址、模拟回执位置、运行进程及停止方式、是否使用Key（只报告是/否）、Demo网络/账户/订单这三个状态分别是否验收，以及仍需我准备的事项。不能输出密钥、签名或完整账户响应，也不能把合成权益或模拟成交当作策略业绩。
```
