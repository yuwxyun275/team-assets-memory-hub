# 贡献指南

欢迎为 [team-assets-memory-hub](https://github.com/yuwxyun275/team-assets-memory-hub) 提交问题、文档改进和代码变更。当前仓库以 `main` 为主分支。上游原有贡献政策保存在 [历史参考](docs/upstream/CONTRIBUTING_CN.md)，本仓库按本页流程协作。

## 开始之前

先阅读 [项目首页](README.md) 和 [源码安装与体验](docs/GETTING_STARTED_CN.md)。完整资料入口见 [文档导航](docs/README.md)。

报告问题时，请提供运行环境、复现步骤、预期行为与实际结果。日志中的模型密钥、登录凭据和私有会话内容请先脱敏。较大的功能改动建议先通过本仓库 Issues 说明场景与方案。

## 提交变更

1. Fork 本仓库，从 `main` 创建工作分支。
2. 完成修改，沿用所在组件的代码风格。
3. 运行与改动相关的检查。修复 Bug 时优先补充能复现问题的测试。
4. 提交并推送到自己的 Fork，向本仓库 `main` 发起 Pull Request。
5. 在 PR 中说明解决的问题、修改后的行为、验证结果和已知限制，等待 CI 和代码审阅。

提交标题推荐使用 `feat`、`fix`、`docs`、`test` 或 `chore` 等类型。沿用 DCO 签署方式，确认自己有权贡献所提交内容：

```bash
git commit -s -m "docs: clarify the asset review flow"
```

## 如何验证

在仓库根目录、安装依赖后执行。仅文档修改需检查相对链接、示例命令和页面呈现。

| 改动范围 | 建议检查 |
| --- | --- |
| Core 资产治理 | `npm run test:oss --prefix MemoryCore` |
| Proxy | `npm test --prefix MemoryProxy` 和 `npm run typecheck --prefix MemoryProxy` |
| Panel API | `npm test --prefix MemoryPanel` 和 `npm run build --prefix MemoryPanel` |
| Panel 界面 | `npm run build --prefix MemoryPanel/web`，并检查实际页面 |
| 跨组件流程 | `node scripts/verify-competition.mjs` |
| 安装与打包 | `node scripts/verify-release.mjs` |

本地综合回归不调用真实模型。CLI 协议演示、真实模型体验和收益对照实验有不同用途，详见 [安装与体验](docs/GETTING_STARTED_CN.md)。

## 资产证据的约定

- 召回和注入不等于实际采用。新增回执逻辑应保留资产与具体动作之间的依据。
- 测试通过不自动证明因果贡献。评测结果应说明样本、对照条件和成本口径。
- 自动提炼默认生成候选，发布仍需要质量检查和负责人审核。
- 样例、固定模型响应与真实模型运行应明确标识。

## 许可与来源

贡献内容按本项目 [MIT 许可证](LICENSE) 发布。请保留已有版权和第三方来源说明，项目上游归属见 [UPSTREAM.md](UPSTREAM.md)。
