# 私人云空间与终端交接

Workers 负责鉴权与请求，D1 保存记录、固定清单和凭证摘要，`FILES` R2 保存私有附件。0.4.0增加区域视频和CLI交接；本工作树尚未将这些变化部署到线上。既有0.3.0账号登录部署的历史验收仍保持原范围。

## 登录与授权

扩展沿已有统一身份服务，以Chrome identity回跳和PKCE取得最多6小时的writer会话，且不晚于中央会话到期。新记录自动进入本机同步队列；未归属账号的旧记录不会自动上传，用户可“同步本页”。退出保留本机记录。

CLI仅支持macOS。`page-review login`在127.0.0.1随机端口接收浏览器回跳；state、PKCE和一次性码共同校验。`client=cli`仅允许严格的loopback回跳，交换得到reader，不能写评注或管理别人的连接。有效期最多30天且不晚于当前中央会话到期。凭证先以600权限落盘，再由执行机器提交连接回执；设置页通过用户动作检查回执，不轮询安装或登录状态。

只读授权与插件会话分别撤销；中央注销暂未主动传播到已签发凭证。旧版创建的reader配置仍可由CLI `connect --from`私有导入，不要求在对话里粘贴密钥。

## 固定交接与附件

复制前等待一次有界同步，检查本页尚未同步、冲突和待删除项；读取本页云端完整历史，并核对本机修订。服务端将当前页全部记录及附件引用保存为固定清单。复制文本只带清单ID和读取命令，不含长期凭证。

之后的修改不改变清单，旧附件由清单的授权路径读取；删除清单中的任一记录则整份清单返回410，授权撤销返回401。跨空间访问即使知道ID也返回404。CLI逐一下载附件、校验SHA-256，全部成功后才原子交付私有目录；缺图、损坏或传输中断不交付部分结果。历史快照不是实时DOM或可重放操作。

PNG/JPEG每个最多8MB，WebM最多32MB；附件角色为viewport、crop、video和frame-0…frame-5。视频需要封面及对应关键帧。每次复制最多500条记录、500个去重附件及1.5MB元数据；超限明确失败，不静默截断。删除检查与资产元数据使用JSON表查询，避免按每条记录逐次访问D1；R2完整性检查最多同时5个请求。

D1条件修订及幂等回执防止重复/过期覆盖。先上传R2并登记，再提交引用；未提交上传不可被普通资产接口读取。逻辑删除与物理清理分开，目前没有定期清理或生命周期任务，已下载副本不能收回。

## 主要接口

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | /v1/me | 当前空间及reader/writer权限 |
| GET | /v1/capabilities | 版本、交接及CLI分发是否真实就绪 |
| GET | /v1/pages?url=… | writer读取当前规范化页的完整历史，上限500 |
| GET | /v1/library?from=…&to=… | writer按时间回查，上限500，超限要求缩小时间范围 |
| GET | /v1/annotations | 兼容已有检索与游标分页 |
| GET | /v1/annotations/:id/context | 当前修订的文本和附件引用 |
| PUT / DELETE | /v1/annotations/:id | writer提交及墓碑，需要预期修订和幂等ID |
| PUT | /v1/uploads/:sha256 | writer上传并校验摘要和类型 |
| GET | /v1/assets/:sha256 | 当前未删除记录引用的私有附件 |
| POST | /v1/cli/confirm | reader在执行机器保存配置后确认连接 |
| GET | /v1/cli/connections | writer读取已确认机器，不返回凭证 |
| POST | /v1/handoffs | writer生成本页固定清单 |
| GET | /v1/handoffs/:id | 同空间授权读取固定清单，删除后410 |
| GET | /v1/handoffs/:id/assets/:sha256 | 限本清单的不可变私有附件 |
| GET / POST / DELETE | /v1/connections[/:id] | writer兼容管理与撤销reader |
| DELETE | /v1/session | 当前凭证自行退出与撤销 |

## macOS CLI分发

独立可选 `RELEASES` R2绑定仅保存公开CLI制品，不能复用私人 `FILES`。构建产物原样放入该绑定，路径保持 `dist/cli/` 中的结构：`install.sh`、`releases/0.4.0/manifest.json`、两个架构tar.gz及`SHA256SUMS`。

Worker只有在manifest和所有制品存在时才将 `cliAvailable` 设为true，并开放 `/install.sh` 与白名单版本文件。未配置或缺文件时返回503，界面不显示虚构的可安装入口。无需暴露R2桶。安装器使用HTTPS、检查SHA-256、安装到用户 `~/.local/bin`，不使用sudo、Node或npx；不轮询自动更新。CLI版本由构建固定，不下载任意latest地址。

## 部署准备

本说明不是部署授权。先复核现有账户、D1和R2绑定及回滚版本，再依次应用 `0001.sql`、`0002-login.sql`、`0003-handoff.sql`；已有环境仅执行缺失迁移。迁移不是无条件重复可运行的ALTER TABLE，先核对列。本工程的登录桥适配源码已补充只读授权页面及loopback回跳校验。CLI上线前需同步该适配更新；本轮没有修改或部署中央认证应用，不需要另建OAuth注册。旧版仅允许Chrome回跳的适配器不能直接承接CLI。

遵守禁止轮询约束，使用D1单次SQL请求；不要使用已知内部轮询的Wrangler文件导入路径。新服务部署后核对健康版本、登录回跳、同步、视频、固定交接、独立CLI、撤销及删除；公开健康200不能替代业务验收。CLI公开分发还需按产品发布流程处理签名、公证及下载入口。

本机有Miniflare时可运行持久云开发服务 `cloud/dev.mjs`。完整合成集成环境使用：

```sh
PAGE_REVIEW_MINIFLARE_MODULE=file:///absolute/path/to/miniflare/dist/src/index.js node tests/browser/server.mjs
```

该环境只监听127.0.0.1，使用独立合成空间；凭证仅在忽略的.local中，不进入日志、安装包或公开预览。Chrome权限与录制输入是测试适配，不把它当原生采集证明。

官方资料：[Chrome tabCapture](https://developer.chrome.com/docs/extensions/reference/api/tabCapture)、[D1限制](https://developers.cloudflare.com/d1/platform/limits/)、[Workers限制](https://developers.cloudflare.com/workers/platform/limits/)、[Bun自包含可执行文件](https://bun.sh/docs/compiler/executables)。产品自身的上限与平台额度分别处理。
