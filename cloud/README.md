# 私人云空间与Agent接入

实现为个人资料服务：Chrome负责采集，Workers API负责鉴权与请求，D1保存元数据和凭证摘要，R2保存私有原画面和裁图。Agent在自己的宿主中运行，不由本服务托管。当前已部署真实Cloudflare服务，并用合成资料完成D1/R2保存、独立Skill检索/读图、断网恢复、隔离及撤销验收；原生Chrome安装与另一宿主自动发现仍待验证。

## 一次性接入

拥有者凭证用于插件写入和管理Agent连接；Agent凭证只读。两类随机凭证只在客户端保存原值，D1只保存SHA-256摘要。插件凭证保存在chrome.storage.local且仅限TRUSTED_CONTEXTS；内容脚本不能调用连接管理或读取凭证。保存库状态消息不会返回密钥。

先在插件资料库“连接云空间”配置拥有者连接。迁移已有记录是单独的可选项，默认关闭。再在“AI访问设置”创建Agent只读连接并保存首次配置JSON，将该文件放在Agent执行环境的私有目录、权限设为600。Agent使用本仓库agent-skills/page-review/；首次可由宿主按其规则安装，当前工程不会自动修改全局Skills。

Agent通过PAGE_REVIEW_CONFIG指向连接文件，或使用PAGE_REVIEW_API_URL和PAGE_REVIEW_TOKEN。文件与环境变量不应进入对话、仓库、日志或下载材料。Skill脚本search、context和image均真实调用接口；图片下载校验SHA-256，支持宿主继续看图。只给API地址无法让没有工具能力的宿主自动检索；宿主的Skill自动发现与图像能力需分别验收。

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

## 部署准备

配置模板cloud/wrangler.jsonc不含账户和凭证；database_id需用真实创建结果替换。若只有workers_scripts授权，D1请求会拒绝，不能拿Worker上传成功替代存储权限。

1. 在目标账户准备Workers、D1与R2权限，沿已启用套餐处理；没有授权不购买或升级。只创建本项目独立资源，保留其他应用。
2. 使用Wrangler创建page-review-cloud数据库及page-review-cloud-files私有桶。复制配置到被忽略的.local/，填入真实database_id、账户和正确相对入口路径；也可先在原模板填真实非秘密资源ID再按项目政策管理。不要将R2设为公有。
3. 对指定数据库初始化cloud/migrations/0001.sql，部署Worker并读回实际API源地址、活动版本与绑定。遵守禁止轮询约束时使用D1单次query请求；本次缓存Wrangler的execute --file路径内部含轮询，不要使用。
4. 运行下面的初始化脚本，在私有目录生成拥有者连接和仅含摘要的SQL。读取owner-seed.sql的hash-only内容，用D1单次query请求执行；raw token不进入命令参数或SQL，也不进入安装包。

```sh
node cloud/provision-owner.mjs https://your-api.example .local/production
```

5. 用实际API源构建插件，先用合成资料验证：上传并提交 → 卸载测试页面 → 独立进程检索/读图 → 撤销拒绝元数据与图片 → 断网恢复及重复提交。然后再由用户选择是否迁移真实本机资料。

初始化脚本不自动创建或部署资源；已有文件会拒绝覆盖。数据库迁移幂等且不删除旧记录。0.2.0以独立云版预发布包分发，构建精确放行实际服务源。旧版更新仍保留原插件目录及身份，不先卸载；真实旧记录不会自动迁移。

## 本机验证

已有Miniflare时：

```sh
PAGE_REVIEW_MINIFLARE_MODULE=file:///absolute/path/to/miniflare/dist/src/index.js PAGE_REVIEW_DEV_PORT=18881 node cloud/dev.mjs
PAGE_REVIEW_CLOUD_DEV_URL=http://127.0.0.1:18881 node scripts/fixtures.mjs --port 18880
```

本机服务使用实际workerd及持久D1/R2；测试凭证和数据只保存在.gitignore覆盖的.local/，不输出密钥。测试页面代理只在scripts/fixtures.mjs，不进入插件或Worker。不要把该带认证头的开发代理公开为静态预览。

官方依据：[D1批事务](https://developers.cloudflare.com/d1/worker-api/d1-database/)、[R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-usage/)。套餐与实际费用在真实部署前按账户核实。
