# Page Review · 网页评注

在正常Chrome浏览中点选或框选网页，留下原评论和可选的👍/👎，保存当时画面。插件只有一个工具栏图标，页面内使用可关闭、拖动及归位右下角的悬浮球；无需把网页导入独立网站。

0.3.0接入既有GitHub/Google统一登录，登录后自动分配私人空间。API使用https://review.paws.rodeo；[预发布安装包](https://github.com/wangjs-jacky/page-review/releases/tag/v0.3.0)不再要求填写拥有者密钥。验证与边界见[云空间说明](cloud/README.md)。

## 使用方式

正常浏览 → 点选/框选 → 直接评论或只留赞踩 → 本地保存 → 同步到私人云空间。没有评注标题或tag；null只表示未评价，不推断喜好。

悬浮球中的“全部保存的网页”打开资料库，可搜索原评论、按赞踩或待同步筛选、回看原画面、编辑并保留修改历史和采纳结果。首次登录可单独选择是否上传已有本机记录，默认不迁移历史。登录后新标注自动加入持久同步队列。

“AI访问设置”签发独立、可撤销的只读连接。首次保存接入配置后，在Agent里直接提出“参考我收藏的导航案例”，由[Page Review Skill](agent-skills/page-review/SKILL.md)检索评论、按需读取原话和图片。Agent配置不含Cloudflare或插件写凭证，不需要逐次搬运网页资料。当前提供Skill与REST API，未提供MCP服务器或托管模型执行。

## 云端与本地数据

本机IndexedDB保存记录、画面及outbox。保存与入队在同一事务提交；断网不影响本地保存。保存、启动、恢复在线或手动同步触发一次有界批次，失败保留队列，没有定时业务轮询。云端为Workers API+D1元数据+私有R2，先上传完整画面再提交记录。幂等请求与预期修订防止重复或过期覆盖；冲突保留本机和云端版本，可将本机意见另存为新记录。

Agent只能读取已提交资料。元数据、上下文和图片均鉴权，撤销后新请求被拒绝；已下载的副本不能收回。删除先写云端墓碑并停止访问，物理对象清理和跨设备恢复不属于这版已完成能力，详见云空间说明。

## 本地开发与构建

核心运行代码无第三方依赖；测试需要Node.js 24+与系统unzip。本机Worker验证使用开发者已有的Miniflare，部署使用已有的Wrangler；本仓库不自动安装工具。

```sh
npm run check
npm test
npm run build
```

默认构建使用https://review.paws.rodeo，网络CSP只放行这一API源。自部署时可以覆盖为确定的HTTPS源：

```sh
PAGE_REVIEW_CLOUD_ORIGIN=https://review.paws.rodeo npm run build
```

该地址只写入生成的cloud-config.js与精确网络CSP；拥有者和Agent凭证绝不进入安装包。构建目录dist/page-review/可在Chrome开发者模式加载；更新旧版保留同一目录与扩展身份，再重新加载插件并刷新网页。未上架Chrome Web Store。

## 边界与验证

当前已通过规则与接口测试及本机workerd链路验证，完整证据归[实现验收](cloud/VALIDATION.md)。浏览器集成运行实际插件页面、IndexedDB、裁图和网络代码，Chrome API由测试适配器提供；它不证明原生Chrome安装、工具栏、站点权限和captureVisibleTab已验收。

复访是保守的启发式定位。目标重复、移除或页面明显变化时停止强行贴回，原评论与截图仍可回看。不支持chrome://、Chrome Web Store、浏览器PDF等受限页面注入；跨源iframe、封闭Shadow DOM和Canvas不提供内部元素定位。整页意见附的是当时视口，不是长截图；有限交互状态不能代替录屏或完整重放。

不执行偏好训练、团队协作或自动改站。[云空间设计稿](design/cloud-library/README.md)保留为设计历史，静态演示不等于运行服务。
