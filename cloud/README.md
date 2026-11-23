# 私人云空间与终端交接

0.4.2 终端简化连接额外需要 `0004-terminal-intent.sql`、中央接力模块及其精确路由；详见 [协议与升级顺序](../integrations/better-auth/terminal-connect.md)。发布时应分别核验新版本活动部署、独立CLI分发及真实SSO，不能只上传客户端包。

Workers 负责鉴权与请求，D1 保存记录、固定清单和凭证摘要，`FILES` R2 保存私有附件。0.4.0增加区域视频和CLI交接，配套Worker、D1迁移、独立CLI分发和中央登录桥已部署。既有0.3.0账号登录部署的历史验收仍保持原范围；当前验证见[验证记录](VALIDATION.md)。

## 登录与授权

扩展通过统一身份服务和 PKCE 获取浏览器写入授权。签发时中央会话必须有效。新授权无到期时间，在 Page Review「连接设置」中退出会撤销当前浏览器的写入授权。已签发的限时授权保留原有效期，重新授权一次即可换成永久授权。新记录自动进入本机同步队列；未归属账号的旧记录可手动「同步本页」。退出保留本机记录。

CLI仅支持macOS。`page-review login`在127.0.0.1随机端口接收浏览器回跳；state、PKCE和一次性码共同校验。`client=cli`仅允许严格的loopback回跳，交换得到reader，不能写评注或管理别人的连接。签发时中央会话必须有效。签发后的终端只读授权持续到用户撤销或从终端退出。曾经签发的限时授权保持原有效期，可重新授权一次换成长期连接。凭证先以600权限落盘，再由执行机器提交连接回执；设置页通过用户动作检查回执，不轮询安装或登录状态。

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

独立可选 `RELEASES` R2 绑定仅保存公开 CLI 制品。CLI 0.4.3 的制品位于 `releases/0.4.3/`，安装入口使用 `installers/0.4.3-r1.sh`。旧版 0.4.0 和 0.4.2 的包继续提供下载。CLI 登录协议沿用 0.4.2，浏览器回调页采用新版设计。

Worker只有在manifest、全部包及新安装器存在时才将 `cliAvailable` 设为true，并开放 `/install.sh`。脚本不缓存；白名单内的版本化公开文件单独读取并进入边缘缓存，支持HEAD、单一Range、If-Range和ETag。范围响应不入缓存，非法范围返回416；私有API和 `FILES` 完全不走此缓存。无需暴露R2桶或新增后台轮询。

安装器使用HTTPS、SHA-256及版本核验后原子安装到用户 `~/.local/bin`，不使用sudo或npx。已有Node 24+时优先使用约6KB轻量包，否则下载原自包含包。下载有阶段/进度、连接/低速/总时限；失败保留部分包供下次用户运行时续传，完整包校验后复用。损坏包不替换已有CLI，连接配置保留。CLI版本固定，不下载任意latest地址。

## 部署准备

本说明不是部署授权。先复核现有账户、D1和R2绑定及回滚版本，再依次应用 `0001.sql`、`0002-login.sql`、`0003-handoff.sql`；已有环境仅执行缺失迁移。迁移不是无条件重复可运行的ALTER TABLE，先核对列。本工程的登录桥适配源码已补充只读授权页面及loopback回跳校验。CLI上线前需同步该适配更新；本次已仅更新Page Review桥接模块并按原入口重启网关，保留原OAuth配置及其他应用路由，不需要另建OAuth注册。旧版仅允许Chrome回跳的适配器不能直接承接CLI。

遵守禁止轮询约束，使用D1单次SQL请求；不要使用已知内部轮询的Wrangler文件导入路径。新服务部署后核对健康版本、登录回跳、同步、视频、固定交接、独立CLI、撤销及删除；公开健康200不能替代业务验收。CLI公开分发还需按产品发布流程处理签名、公证及下载入口。

本机有Miniflare时可运行持久云开发服务 `cloud/dev.mjs`。完整合成集成环境使用：

```sh
PAGE_REVIEW_MINIFLARE_MODULE=file:///absolute/path/to/miniflare/dist/src/index.js node tests/browser/server.mjs
```

该环境只监听127.0.0.1，使用独立合成空间；凭证仅在忽略的.local中，不进入日志、安装包或公开预览。Chrome权限与录制输入是测试适配，不把它当原生采集证明。

官方资料：[Chrome tabCapture](https://developer.chrome.com/docs/extensions/reference/api/tabCapture)、[D1限制](https://developers.cloudflare.com/d1/platform/limits/)、[Workers限制](https://developers.cloudflare.com/workers/platform/limits/)、[Bun自包含可执行文件](https://bun.sh/docs/compiler/executables)。产品自身的上限与平台额度分别处理。
