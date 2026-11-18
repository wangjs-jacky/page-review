# F5 折角票夹生产资源

`f5-selected.png` 是用户选定的 F5 原稿。`f5-production.png` 由内置 image_gen 编辑，仅移除米色底座外的白色背景，保留连续蓝色折带、网页卡片、橙色评注与原材质；不作为新候选方向。

16/32px 使用 `f5-small.svg` 光学校正版：去掉模糊的小圆点、正文细线和材质阴影，保留三项识别形；按 16 单位网格对齐。48/128px 使用透明生产稿；悬浮入口与资料库使用 48px。标注中仍显示点选图标；设置、关闭、录制等按钮继续使用各自语义图标。

`scripts/brand-icons.mjs` 用 Sharp 确定性渲染 SVG 与缩放生产 PNG；可用 `PAGE_REVIEW_SHARP_MODULE` 指定已有 Sharp 模块。生成结果已纳入源码，普通 `npm run build` 只打包现有 PNG，不需要安装 Sharp。生产版本、图标适配与原生安装分别验收。
