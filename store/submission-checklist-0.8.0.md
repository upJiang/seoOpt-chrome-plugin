# SEO优化 0.8.0 Chrome Web Store 提交清单

## 发布产物

- 版本：`0.8.0`
- 最低 Chrome 版本：`116`
- ZIP：`.output/seo-opt-chrome-plugin-0.8.0-chrome.zip`
- ZIP 大小：约 `1.0 MB`
- SHA-256：`176b16e6563a5e7cf35d21f773600c8dfb08735b735c98cf44d7564de601d2b5`
- 清单版本：Manifest V3

## 商店文案

- 扩展名称：`SEO优化`
- 简短说明：见 `store/zh-CN-listing.md`
- 详细说明：见 `store/zh-CN-listing.md`
- 重新提交说明：见 `store/resubmission-explanation-0.8.0.md`
- 版本说明：见 `store/release-notes-0.8.0.md`
- 权限理由：见 `store/permission-justifications-0.8.0.md`
- 隐私权披露：见 `store/privacy-disclosure-0.8.0.md`
- 审核测试说明：见 `store/reviewer-notes-0.8.0.md`
- 隐私政策源文件：`privacy-policy.html`

## 截图上传顺序

1. `store/assets/01-optimization-code-1280x800.png`
   - 完整优化建议、代码示例和逐段解释。
2. `store/assets/02-core-seo-1280x800.png`
   - 页面 SEO 基础分、正常项、扣分项和分类结果。
3. `store/assets/03-site-audit-1280x800.png`
   - 站点抽样检查、共同问题和受影响页面。
4. `store/assets/04-overseas-market-1280x800.png`
   - 海外市场建设判断和五项海外能力。
5. `store/assets/05-sem-diagnosis-1280x800.png`
   - SEM 漏斗、成本、有效业务和诊断建议。

五张截图均为 `1280 × 800`，不包含真实 API Key、用户账号或私密业务数据。

## 当前验证结果

- TypeScript typecheck：通过。
- Vitest：17 个测试文件、138 项通过。
- Chrome E2E：6 项通过。
- 生产构建：通过，解压后约 2.53 MB。
- 生产依赖审计：0 个漏洞。
- 包内 source map：无。
- 包内常见密钥和私钥模式扫描：未发现。
- Skill 开发源、Codex 和 Claude Code 安装目录：完整 diff 与 SHA-256 一致。

完整 npm 审计仍报告 4 个来自构建工具链的高危公告，路径为 `wxt > web-ext > addons-linter > image-size`。这些依赖不进入扩展运行包，强制修复会破坏性降级 web-ext，因此本次未执行 `npm audit fix --force`。

## 隐私政策阻断项

计划公开地址：`https://codecc.cc/seo-opt/privacy-policy`

2026 年 8 月 14 日检查结果：HTTP 200，但正文仍是 New API 首页，不是“SEO优化隐私政策”。

在修复以下事项前不要提交审核：

- 将项目根目录的 `privacy-policy.html` 部署到固定 HTTPS 地址；
- 未登录和无痕窗口可直接访问；
- 页面标题和正文明确显示“SEO优化隐私政策”；
- 不跳转到登录页、New API 首页或临时文件地址；
- Chrome Web Store 后台隐私政策字段填写同一完整 URL。

## 提交前最终核对

- [ ] Chrome Web Store 后台版本显示 `0.8.0`。
- [ ] 上传的 ZIP SHA-256 与本文件一致。
- [ ] 商品名称、简短说明和详细说明已更新。
- [ ] 五张截图按建议顺序上传。
- [ ] 隐私政策公开地址返回真实政策正文。
- [ ] 权限理由与 Manifest 中的权限完全一致。
- [ ] 数据类型和用途披露与隐私政策一致。
- [ ] 已完成 Chrome Web Store Limited Use 声明。
- [ ] 已说明 AI 功能默认关闭且由用户自行配置服务。
- [ ] 已说明 optional_host_permissions 只在用户主动使用对应功能时申请。
- [ ] 已说明扩展不加载或执行远程代码。
- [ ] 已在新 Chrome 用户配置或无痕环境完成一次安装检查。
- [ ] 未把页面 SEO 基础分写成收录、排名、流量或收入保证。

## 明确不执行

本次文档和产物准备不包含 Git 添加、提交、推送、生产部署或 Chrome Web Store 上传。
