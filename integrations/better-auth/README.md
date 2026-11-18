# 复用现有Better Auth登录

Page Review复用已有身份服务的GitHub/Google登录，不接管其他应用的权限或原始第三方凭据。此目录是窄范围应用接入路由，不是标准OIDC服务。

将page-review.mjs及page-review.d.mts复制到现有Express网关src目录，在同源检查之后、中央兜底路由之前注册createPageReviewBridge。给工厂传入每请求核对的getIdentity、loginOrigin、现有layout，以及只从私有存储读取的readConfig。

readConfig返回`{ apiOrigin, key }`。key是独立随机桥接密钥，仅保存在身份网关的私有文件和Worker Secret LOGIN_BRIDGE_KEY，不能复用第三方OAuth密钥或写进插件。API_ORIGIN与LOGIN_ORIGIN为固定允许源，不接受浏览器指定任意服务地址。

浏览器从chrome.identity登录进入API，再跳到现有身份服务。用户确认后，中央服务器将短期签名证明直接POST给API；一次性码交回Chrome指定地址，插件使用PKCE交换自己的写入会话。用户名只作显示，个人空间按稳定issuer+user ID分配，不按邮箱合并。旧空间及记录不自动关联到新身份。

接入示意：

```ts
const pageReviewBridge = createPageReviewBridge({
  getIdentity: centralIdentity,
  loginOrigin,
  layout,
  readConfig: () => loadPrivateBridgeConfig(),
});
app.use((req, res, next) => originOf(req) === loginOrigin
  ? pageReviewBridge(req, res, next)
  : next());
```

插件会话到期不晚于本次中央会话，最多6小时；退出Page Review立即撤销此插件会话，重新登录回到同一个空间。独立Agent只读授权持续到明确撤销。中央注销/停用不会主动推送撤销已签发的Page Review凭证，其剩余有效期最多为上述会话时长；当前未实现中央事件撤销传播。已有账号的其他应用资格不因此增加。

部署前保存原服务入口和源码摘要，在独立worktree完成测试。实际切换仅添加两个模块和服务端注册行，核对原文件摘要没有并发变化后应用；保留原数据库、OAuth配置及其他应用路由，按原服务启动入口重启。回退移除新增注册行及模块并恢复先前Worker版本，不删数据。

## 0.4.0：终端只读授权

本工程内的适配源码增加了CLI路径。确认页通过Worker的`/auth/request`读取真实权限，不信任客户端的权限提示；`/auth/approve`返回的reader权限与严格loopback地址共同决定是否允许终端回跳。Chrome插件回跳继续保留。

上线时先部署对应Worker与迁移，再同步此桥接适配；旧版只允许chromiumapp.org的适配器会拒绝CLI回跳。本次已同步该适配并沿既有入口重启网关；原OAuth配置、账号及其他应用路由保留，无需新建GitHub/Google OAuth注册。
