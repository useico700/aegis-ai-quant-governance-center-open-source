# 本地与可选部署

默认支持README的本地dev与build流程。保持127.0.0.1绑定，不在未配置认证前公开账户页面。源应用包含S1/S2、历史监视器、SMC和JEV等页面；未配置的模块明确等待数据。

可选Docker模板在ops/compose.yaml，构建仍需联网安装npm依赖。simulation容器network_mode=none；仅共享合成回执卷。此模板不包含SSH、生产密钥、账户授权、云发布或自动实盘启动。运行命令docker compose -f ops/compose.yaml up --build，停止使用同一compose的down；不要删除用户卷。若未实际完成容器验收，应如实报告。

D1/Worker源码与迁移保留。若自行云部署，用户需要自己的Cloudflare账号、资源绑定、域名、认证与快照摄取token。默认本地模式不会因构建成功而发布任何云资源；不存在原操作者的托管项目或账户访问权限。

JEV推理依赖第三方SDK与用户自己的服务配置，必须单独检查版本、许可、费用和数据边界。默认不调用该SDK或发送账户数据。
