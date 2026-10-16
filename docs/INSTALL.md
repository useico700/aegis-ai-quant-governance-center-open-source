# 安装、准备与停止

准备Git、Node >=22.13（建议24）、npm、独立可写目录。建议4GB内存、3GB磁盘；JEV子项目另装依赖。默认无需账号或Key。支持具有终端能力的AI Agent；纯聊天模型无法替你运行命令。

按README执行npm ci --ignore-scripts、npm run setup、npm test、npm run verify:migration、npm run build、npm run dev。构建与开发使用原Vinext/React/Worker结构，不要求Cloudflare登录或部署资源。首次npm安装需要联网，之后本地合成演练不访问交易所。

dev默认只绑定127.0.0.1:3000。JEV单独安装后绑定3001。端口占用时先检查使用进程，使用Vite --port选项选择其他端口，不能直接终止其他项目。

在第二终端可执行npm run demo:watch，每10秒重复独立合成演练。看板数据带合成标记，账户不是自己的交易所账号；没有信号生成或真实下单。

停止：各终端Ctrl+C。没有自动安装系统服务、计划任务或外部任务。写锁在.runtime/public-demo/writer.lock，包含pid。异常断电/强杀遗留锁时，先确认对应进程退出再人工删除锁目录，不自动破坏单写保护。

更新前停止本项目进程，备份自己的配置与运行数据，再git pull --ff-only、npm ci --ignore-scripts并重跑验证。不要覆盖新用户的.env和账本。

常见问题：Node不满足则升级后重开终端；缺少依赖先npm ci；451/403是Demo访问受限，保留离线模式；原主机启动器报错是预期边界，使用scripts/public入口，不移除保护。未知Cloudflare运行问题记录具体错误，不发布公网试错。

## Windows安装

Windows使用WSL2/Ubuntu，在Linux家目录安装，不能放在/mnt/c等Windows挂载盘；原生Windows不运行执行回路，因为原审计账本要求POSIX权限与目录同步。

WSL2准备见 https://learn.microsoft.com/windows/wsl/install 。需要安装或启用系统组件时由用户按官方步骤操作，Agent不自行提权。WSL系统镜像另外需要磁盘空间。
