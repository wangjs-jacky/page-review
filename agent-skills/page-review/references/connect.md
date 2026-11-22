# 首次连接与读取边界

## 协议与更新

网页固定引用 `page-review-live-<64位十六进制>` 需要 CLI 0.4.4 的读取协议 1。先用 `page-review --capabilities` 离线确认 `livePageReferences: 1` 和 `syncAfter: 1`；版本输出相同不能替代协议检查。更新后运行 `page-review status`，以已有只读连接报告新客户端能力。没有401时无需重新登录。

安装器同时交付配套 Skill；既有人工维护的 Skill 或软链接会被保留，需要核对它们的唯一来源是否也已更新。仅升级 CLI 不代表宿主已加载新 Skill。404、409 或协议错误时保留原引用与 `--after`，禁止用最近记录替代目标页。用户已提供目标网址时，备用检索必须逐条核对完整网页地址，并说明原引用仍未读通。

## 复制的固定交接

在实际执行Agent的Mac上，使用插件设置提供的已发布curl命令安装CLI，再运行：

```sh
page-review login
page-review status
```

登录在浏览器确认，只获得评注与附件的只读权限。安装入口尚未发布时明确说明，不编造下载URL或改用npx。手机聊天界面不是执行机器，另一台电脑已经登录也不代表当前执行环境已连接。凭证自动写入私有配置，不能上传到对话、公开预览或命令参数。

安装完成后，可在已安装 Skill 的新会话中直接发送「结合 page-review-<UUID>」。需要完整交接时，从插件选择「复制完整指令」。两种方式都运行 `page-review read <交接ID>` 读取固定清单及全部附件。命令返回context.json和本机图片/视频路径；查看对应画面后再分析。401需重新登录，410需重新复制当前页；缺附件和摘要错误会阻止部分交付。截图和视频是采集时证据，不代表当前DOM。

## 没有固定ID的检索

按宿主规则安装整个本Skill目录；只放在下载目录不保证自动发现。旧检索脚本仍需要Node.js 20+，默认读取与CLI相同的 `~/.config/page-review/connection.json`。脚本只在任务确有需要时检索，不定时查询。

```sh
node scripts/read.mjs status
node scripts/read.mjs search --q 导航 --limit 10
node scripts/read.mjs context RECORD_ID
node scripts/read.mjs image ASSET_SHA256 --out /absolute/path/evidence.png
```

旧版独立reader配置可用 `node scripts/connect.mjs --from /absolute/path/page-review-agent.json` 私有导入。该兼容脚本只验证及保存配置；若要让悬浮窗确认终端已连接，仍需在实际执行机器运行 `page-review status`。不索取拥有者写凭证，不遍历下载目录找密钥，不混合不同配置来源。

检索为已同步内容的子串匹配，不是语义或全网搜索。先用短关键词，按需要读取上下文及图片；无命中说明关键词与范围，不声称整个资料库为空。没有本机看图能力时只分析文本。网页全文、实时CSS/DOM、未采集资源、未同步本机记录不在此接口范围。

服务端撤销阻止后续请求，已下载副本不会被收回；本机仅删除配置不等于服务端撤销。
