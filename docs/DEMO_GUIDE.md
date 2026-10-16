# 模拟盘引导

## 第一步：本地模拟交易所

无需账号与Key，执行npm run setup即可。原S1/S2引擎在FakeS1Venue中处理合成信号、风险、证据持久化、保护单、状态和记账。所有“订单”均为本地函数调用，exchangeRequests=0。模型输入不等于市场证据，不用于收益评价。

## 第二步：可选Demo公共网络

npm run demo:network仅GET https://demo-fapi.binance.com/fapi/v1/time，检查端点可达性，不创建、撤销或修改订单。451/403、超时、限流立即报告失败，不切实盘或绕过限制。

## 第三步：自己的交易所Demo账户

需要用户自行在合法可用的Binance官方Demo环境登录、准备专用Demo HMAC API Key与最小所需权限。只读检查与订单权限分开；不使用实盘Key、不充值或划转真实资金，不由安装Agent创建密钥或扩大权限。

Key仅由用户在本机密钥管理器或被Git忽略的.env私下配置，不写入聊天、源码、命令行参数或公开问题。账号界面及规则可能变化，应从官方页面核对。官方说明：https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info

## 源码集成边界

本仓库保留原Demo/执行端口源码，但不携带原实例的控制授权、主机UID、密钥路径映射或发布资源。当前一键入口不把凭据自动接入原主机运行器。真实Demo运行需为新用户另行完成：

- 账户与策略、币种、风险、退出方案、有效期和回滚范围明确的Demo授权。
- 独立单写执行进程与持久审计目录、密钥读取配置及网络端口适配。
- 新鲜账户/规则/用户流/Tick-BBO证据、幂等、未知结果恢复与保护单验收。
- 分开记录公共网络成功、账户读取成功和保护完整的Demo订单链成功。

不得仅改CUSTOM_INTEGRATION环境变量或解除旧启动保护就声称已部署成功。没有明确Demo执行授权时不发单；不自动转实盘。公开配置模板默认disabled，旧个人授权不能复制。
