# 📚 文档导航

第一次阅读，建议从「了解项目 → 安装体验 → 技术机制 → 效果评测」开始。根目录 README 是项目入口，本页负责集中导航，详细说明保留在对应组件中。

## 当前版本：先看这些

| 你想了解什么 | 阅读入口 |
| --- | --- |
| 项目做什么，完整闭环是什么 | [项目首页](../README.md) |
| 从源码安装，打开界面并体验 | [安装与体验](GETTING_STARTED_CN.md) |
| 六项竞赛任务、流程图与真实库存案例 | [技术报告 PDF](technical-report.pdf) |
| 原始材料如何提炼、审核和回流 | [资产学习机制](../MemoryCore/docs/ASSET_LEARNING_CN.md) |
| 如何验证打包、部署与 CLI 协议 | [本地验收说明](../deploy/quality-v2/ACCEPTANCE.md) |
| 检索、使用归因与反事实评测 | [TeamAssetBench](../evaluation/team_asset_bench/README.md) |
| 推荐评价与费用核算 | [资产推荐评测](../evaluation/asset_recommendation_bench/README.md) |
| 如何贡献，使用什么许可证 | [贡献指南](../CONTRIBUTING.md) · [许可](../LICENSE) · [上游归属](../UPSTREAM.md) |

**体验模式需要区分**：固定模型响应用于重复验证协议。真实模型体验由配置的模型决策。资产收益还需独立对照，不能用一次任务成功替代。

## 组件与开发参考

| 组件 | 说明 |
| --- | --- |
| [MemoryCore](../MemoryCore/README_CN.md) | 记忆服务基础能力，当前资产治理扩展另见资产学习机制 |
| [MemoryProxy](../MemoryProxy/README_CN.md) | 请求代理、上下文组织与 Agent 接入 |
| [MemoryPanel](../MemoryPanel/README.md) | 管理 API 与界面 |
| [MemoryKnowledge](../MemoryKnowledge/README.md) | Wiki 与代码知识服务 |
| [CodeBuddy 接入](../agents/codebuddy/README.md) | CodeBuddy CLI 适配 |
| [其他 Agent](../agents/README.md) | 上游各客户端接入说明 |

各组件保留自己的开发文档。当前竞赛版本的统一安装入口为本页上方的「安装与体验」。

## 上游历史参考

以下资料保留上游原文，便于理解已有组件。旧镜像、分支名称、版本记录和路线图不代表本仓库当前的交付状态。

| 资料 | 入口 |
| --- | --- |
| 通用安装 | [中文](upstream/INSTALL_CN.md) · [English](upstream/INSTALL.md) |
| 部署形态与集成 | [部署说明](upstream/README.deployment.md) |
| Docker 部署 | [Docker 说明](upstream/README.docker.md) |
| 历史更新 | [CHANGELOG](upstream/CHANGELOG.md) |
| 上游路线图 | [中文](upstream/ROADMAP_CN.md) · [English](upstream/ROADMAP.md) |
| 上游贡献约定 | [中文](upstream/CONTRIBUTING_CN.md) · [English](upstream/CONTRIBUTING.md) |
