# Page Review · 网页评注

在原网页点选、框选或评论整页，附上截图或区域视频。保存后点击“复制本页评注”，粘贴给终端 Agent；它通过独立只读 CLI 获取本页全部已保存评注和附件，无需先打开资料库。

当前扩展为 **0.4.17 开发候选版**。点击框选或录制后，拖动区域时显示十字光标，确认或按 Esc 取消后恢复网页原有光标。网页引用需要 CLI **0.4.4**（读取协议 1）及配套云端迁移；旧固定交接继续兼容。终端连接见 [终端连接协议](integrations/better-auth/terminal-connect.md)。

## 使用流程

1. 在悬浮窗点选、框选或选择整页，写评注及可选赞踩。截图自动附上，可放大、重拍、移除；失败可重试或明确仅保存评注。
2. 录制先框选区域，再开始。录制只保留该区域，按钮在区域外；停止后播放、跳转关键帧、重录或重新选区。取消替换保留原视频和输入。首版无音频，单段最多两分钟、32MB。
3. 首次在设置登录账号。终端通过已发布的 `curl` 安装命令安装 macOS CLI，再运行 `page-review login` 完成一次浏览器授权。凭证保存在执行机器的私有配置中，不放进复制内容。
4. 点击“复制本页评注”取得该网页的 `page-review-live-<64位十六进制>` 引用。复制时单次核对云端支持及终端协议；尚未同步的保存会附 `同步要求：--after <标记>`，不能删除该行。终端未确认同步前返回409，插件提示同步完成后可再次读取，不自动轮询。历史页用于按时间、关键词回查。

网页引用读取同一网页当前已同步的完整资料；旧版 `page-review-<UUID>` 仍读取复制时的固定清单，修改不漂移，删除其中记录返回410。撤销授权阻止后续读取，已经下载的副本无法收回。单次交接最多500条评注、500个去重附件及1.5MB元数据；超过限制会失败，不返回部分“全部评注”。

## 开发与构建

需要 Node.js 24+。扩展核心不依赖第三方运行库。

```sh
npm ci
npm run check
npm test
npm run test:runtime
npm run build
```

默认 API 为 `https://review.paws.rodeo`。自部署构建通过 `PAGE_REVIEW_CLOUD_ORIGIN` 指定固定 HTTPS 源。凭证不进入构建目录。`dist/page-review/` 是未打包扩展目录，`dist/page-review-0.4.17.zip` 是扩展安装包。更新时在原目录覆盖扩展文件并重新加载，以保留扩展身份和本机资料。

CLI 安装器支持 macOS arm64/x64。已有支持 `--use-env-proxy` 的 Node 时（22.x 从 22.21.0 开始）优先下载约 9KB 的轻量版；其余机器使用约 40MB 的自包含版，无需另装运行时。两版使用相同登录和读取协议，凭证分别保存在执行机器的私有配置中。用户安装及授权：

```sh
curl -fsSL https://review.paws.rodeo/install.sh | sh
~/.local/bin/page-review login
```

开发构建需要已有 Bun：

```sh
PAGE_REVIEW_BUN=/absolute/path/to/bun npm run build:cli
PAGE_REVIEW_BUN=/absolute/path/to/bun npm run build:cli:light
node --test tests/installer.test.mjs tests/installer-delivery.test.mjs
```

制品在 `dist/cli/`；轻量构建单独生成 `SHA256SUMS.node` 和 `installers/0.4.4-r1.sh`，保留原独立包与校验清单。安装显示阶段和进度，有连接、低速和总时限；中断后再次运行同一命令可续传，不自动重试。SHA-256、版本值及命令退出码通过后才原子替换 CLI；最终安装路径再次核对版本，失败恢复旧 CLI，首次安装失败则移除新文件。设置 `PAGE_REVIEW_CLI_FLAVOR=standalone` 可强制使用独立版。轻量版需要 PATH 中支持 `--use-env-proxy` 的 Node 22 或更新版本（22.x 从 22.21.0 开始），否则自动选独立版；安装时规范启动行，使该CLI进程沿用现有HTTP(S)_PROXY与NO_PROXY，不修改系统代理。代码构建不等于已完成公证、签名、公开分发或所有架构的真机验证。

默认「复制本页评注」写入网页固定引用；没有安装 Skill 的宿主可用「复制完整指令」，两种入口指向同一网页。完整指令同样保留 `page-review-live-` 前缀及 `--after`，避免旧CLI忽略同步要求。新版CLI支持完整引用；读取失败不得用资料库最近记录代替目标。

安装脚本包含 CLI 所需的原版本包下载和完整读取 Skill。它检测 PATH 中的命令或现有宿主配置目录，将 Skill 安装到 Codex 的 `~/.agents/skills/page-review` 与 Claude Code 的 `${CLAUDE_CONFIG_DIR:-~/.claude}/skills/page-review`。Paws 由所选执行机器的 Codex 或 Claude Code 加载。尚无受支持宿主时仅安装 CLI，之后可用同一命令补装。重装更新由安装器维护的文件，保留用户添加的文件和独立维护的同名入口。

## 验证与部署边界

[云服务与交接协议](cloud/README.md)说明独立授权、迁移、分发绑定与部署步骤。[Agent Skill](agent-skills/page-review/SKILL.md)同时保留已有检索读取方式。

`tests/browser/server.mjs` 是只绑定loopback的集成环境：运行实际页面、IndexedDB、workerd、D1与私有R2，Chrome API和媒体输入明确使用适配器。它不进入安装包，不可公开成预览。原生 Chrome 安装、截图、tabCapture及账号登录应分别记录证据，不能用该环境代替。

页面定位采用保守启发式：位置重复、移除或页面明显变化时停止强行贴回。整页评论附当时视口，不是长截图；跨源 iframe、封闭 Shadow DOM 和 Canvas不提供内部元素定位。切换页面、改变视口或采集被中止时结束录制并尽量保留已录部分。

没有定时业务轮询、托管模型执行、自动改站或团队协作。保留旧设计稿供回溯，静态演示不代表实际云端能力。
