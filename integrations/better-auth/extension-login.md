# 插件普通标签页登录与自动接续

0.4.4候选把新版插件登录放在发起浏览器的普通标签页中；保留原网页、草稿和待复制动作。身份验证完成后接续同步，不再要求“登录并开启同步”。旧版identity请求仍走原确认路径；不能仅给任意授权URL增加自动提交。

## 请求与来源

1. 用户从插件发起登录。插件生成独立state、PKCE verifier及在场proof，POST `/auth/extension/start`，只提交两个challenge和原空间（如有）。沿用数据库0004的intent及expected_workspace字段，无新增迁移。
2. API只允许严格的chromiumapp回调，返回短期requestId及固定中央身份源。插件在发起窗口创建普通标签页，把requestId、标签ID、原标签、proof及PKCE上下文放入`chrome.storage.session`；不写入URL或网页存储。
3. 中央身份页没有会话时进入原GitHub/Google登录。有会话时读取服务端请求元数据，生成绑定实时session、subject、请求及60秒期限的HMAC接力。此GET不会直接批准writer。
4. 中央页面通过`chrome.runtime.sendMessage`向请求所指插件索取proof。`externally_connectable`仅允许固定登录站点，插件还核对顶层frame、精确中央路径、requestId、发起的标签ID和5分钟期限。只打开陌生授权URL或另一个标签不能得到proof。
5. 中央同源POST再次核对实时身份、CSRF及签名接力；API核对独立intent challenge和期待空间。身份切换、错误来源、过期或已使用请求均拒绝。
6. 一次性码作为原chromiumapp格式的逻辑callback返回同一页面，再通过消息交给发起插件，不导航到不存在的外部页面。插件严格核对callback源、路径、恰好一组code/state及PKCE，交换并验证writer账号后才保存连接。
7. 成功优先激活来源标签，然后仅关闭本次创建的登录标签。待复制动作直接继续当前页完整快照；普通登录触发后台有限同步，不等待其他页上传后才返回。

## 生命周期与恢复

重复登录聚焦已有登录标签，不创建第二个请求。关闭登录标签或单次期限结束会取消登录，原连接、记录与草稿保留；没有状态轮询或定时重试。worker重启后的回调从session恢复上下文，完成后向原网页发送接续事件；若来源页已关闭，则不擅自重新打开它。浏览器重启清除session，旧请求只会过期，不能自动恢复凭据。

旧identity分支保留兼容；新版正式构建包含`login-tabs.js`，正常Chrome环境使用普通标签页。CLI仍使用系统默认浏览器，它与插件可能处于不同Profile；本协议不跨浏览器搬运Cookie。

## 性能与完整性

入口先读本地记录并展示，再由本次动作触发一次云刷新。附件按摘要去重，每次最多三份上传，保留所有角色；任何在途失败先等待其余在途结束，保留队列且不提交部分评注。已同步复制直接POST固定交接，服务端仍读取完整当前页并逐一校验本地revision与全部附件。旧修订被服务端拒绝时单次刷新并提示原处重试；不生成旧的或部分交接。

## 升级边界

需先更新Worker的`login.mjs`和中央桥`page-review.mjs`，再安装新版插件。中央`server.ts`路由门禁无需增加例外，现有终端接力不变。保留原数据库、OAuth、secret与用户数据；不可把测试适配器放进构建。本目录说明不构成发布或安装授权。

测试分为协议/来源/取消/恢复回归、真实本机workerd，以及明确Chrome消息和身份适配的浏览器集成。后者不证明原生Chrome的external messaging、生产GitHub/Google或Air体验；这些须在获准的部署与安装阶段分别验证。
