# 私人云空间与Agent接入

实现为个人资料服务：Chrome负责采集，Workers API负责鉴权与请求，D1保存元数据和凭证摘要，R2保存私有原画面和裁图。Agent在自己的宿主中运行，不由本服务托管。当前已部署真实Cloudflare服务，并用合成资料完成D1/R2保存、独立Skill检索/读图、断网恢复、隔离及撤销验收；原生Chrome安装与另一宿主自动发现仍待验证。

## 账号登录与一次性AI授权

在插件资料库点击“登录并开启同步”，通过已有统一身份服务的GitHub或Google登录，确认后自动分配自己的私人空间。同账号重登回到原空间；不同账号隔离，不按邮箱静默合并，不增加其他Paws应用权限。已有本机记录上传默认不选。API固定为https://review.paws.rodeo。

插件使用chrome.identity及一次性码/PKCE接收短期写入会话，不再要求用户填写拥有者凭证。会话不晚于中央登录到期，最多6小时；退出Page Review撤销当前插件会话，重新登录可继续同步队列。本机记录仍保留。中央注销/停用尚未主动传播撤销到已签发的Page Review凭证，过期与应用内退出仍按上述规则执行。

“AI访问设置”创建独立、可撤销的只读连接，保存首次配置JSON并放在Agent执行环境私有目录（权限600）。Agent按宿主规则安装agent-skills/page-review/，以PAGE_REVIEW_CONFIG指向该文件。随后按任务检索原话、反馈、历史和截图；无需逐次搬运阅读包。退出插件不会代替明确撤销Agent授权；已下载副本无法收回。另一宿主自动发现仍需分别验收。

旧手动拥有者空间不会自动合并到社交账号。若本机保留另一个空间的资料，插件会停止混合并要求先使用原账号处理。登录接入协议与中央路由见[integrations说明](../integrations/better-auth/README.md)。

## 接口

| 方法 | 路径 | 权限与用途 |
|---|---|---|
| GET | /v1/me | 当前连接的workspace和权限，不返回凭证 |
| GET | /v1/annotations | 已提交记录的q/domain/feedback筛选及不透明游标分页 |
| GET | /v1/annotations/:id/context | 原话、明确反馈、采集状态、历史和受保护图片路径 |
| GET | /v1/assets/:sha256 | 已提交且未删除记录引用的PNG/JPEG，private,no-store |
| PUT | /v1/uploads/:sha256 | 拥有者上传，摘要与字节类型校验，上限8MB；暂存资源不可直接读 |
| PUT / DELETE | /v1/annotations/:id | 拥有者提交或墓碑；requestId和expectedRevision必需 |
| GET | /v1/annotations/:id | 拥有者读取原始云端修订以处理冲突 |
| GET / POST | /v1/connections | 拥有者列出或创建只读连接；原密钥仅在创建响应出现一次 |
| DELETE | /v1/connections/:id | 拥有者撤销只读连接 |

workspace从凭证确定，不接收客户端owner选择。D1事务同时保存条件修订和幂等回执；相同requestId的不同内容被拒绝。附件先写R2、登记D1，再提交引用；断在上传阶段的图片不向Agent开放。R2和D1不是跨产品原子事务，暂存/墓碑对象可能保留；当前没有实现物理清理或生命周期任务，也不承诺删除后物理立即擦除。

本地outbox与评论事务入库。每个真实事件处理至多100项快照，失败不自行定时查询或自动退避，等待下一次启动/在线/用户操作。编辑不覆盖历史图；明确无图保存携带缺图状态。两端修改冲突不自动覆盖，可比较原话后另存本机意见；删除遇到云端新修订仍保留队列，不自动删除未知内容。当前不是完整的双向同步/新设备恢复方案。

## 自部署与旧拥有者工具

配置模板cloud/wrangler.jsonc不含账户和凭证；database_id需用真实创建结果替换。若只有workers_scripts授权，D1请求会拒绝，不能拿Worker上传成功替代存储权限。

1. 在目标账户准备Workers、D1与R2权限，沿已启用套餐处理；没有授权不购买或升级。只创建本项目独立资源，保留其他应用。
2. 使用Wrangler创建page-review-cloud数据库及page-review-cloud-files私有桶。复制配置到被忽略的.local/，填入真实database_id、账户和正确相对入口路径；也可先在原模板填真实非秘密资源ID再按项目政策管理。不要将R2设为公有。
3. 对指定数据库按顺序初始化cloud/migrations/0001.sql及0002-login.sql，部署Worker并读回实际API源地址、活动版本与绑定。遵守禁止轮询约束时使用D1单次query请求；本次缓存Wrangler的execute --file路径内部含轮询，不要使用。
4. 运行下面的初始化脚本，在私有目录生成拥有者连接和仅含摘要的SQL。读取owner-seed.sql的hash-only内容，用D1单次query请求执行；raw token不进入命令参数或SQL，也不进入安装包。

```sh
node cloud/provision-owner.mjs https://your-api.example .local/production
```

5. 用实际API源构建插件，先用合成资料验证：上传并提交 → 卸载测试页面 → 独立进程检索/读图 → 撤销拒绝元数据与图片 → 断网恢复及重复提交。然后再由用户选择是否迁移真实本机资料。

以下初始化脚本只服务旧拥有者空间及运维，不是普通用户登录步骤。初始化脚本不自动创建或部署资源；已有文件会拒绝覆盖。数据库迁移幂等且不删除旧记录。0.3.0以账号登录预发布包分发，构建精确放行实际服务源。旧版更新仍保留原插件目录及身份，不先卸载；真实旧记录不会自动迁移。

## 本机验证

已有Miniflare时：

```sh
PAGE_REVIEW_MINIFLARE_MODULE=file:///absolute/path/to/miniflare/dist/src/index.js PAGE_REVIEW_DEV_PORT=18881 node cloud/dev.mjs
PAGE_REVIEW_CLOUD_DEV_URL=http://127.0.0.1:18881 node scripts/fixtures.mjs --port 18880
```

本机服务使用实际workerd及持久D1/R2；测试凭证和数据只保存在.gitignore覆盖的.local/，不输出密钥。测试页面代理只在scripts/fixtures.mjs，不进入插件或Worker。不要把该带认证头的开发代理公开为静态预览。

官方依据：[D1批事务](https://developers.cloudflare.com/d1/worker-api/d1-database/)、[R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-usage/)。套餐与实际费用在真实部署前按账户核实。
