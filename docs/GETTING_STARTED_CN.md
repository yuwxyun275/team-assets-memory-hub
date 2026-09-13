# 从源码安装与体验

[返回文档导航](README.md) · [项目首页](../README.md)

## 1. 安装与构建

在仓库根目录执行。建议 Node 22 LTS（最低 22.16），Python 3.9+。需要 Git、npm 和网络访问 npm registry。部分可选原生依赖没有适配预编译包时，需要本机 C/C++ 构建工具。

```bash
npx --yes pnpm@11.19.0 --dir MemoryCore install --frozen-lockfile
npm ci --prefix MemoryProxy
npm ci --prefix MemoryPanel
npm ci --prefix MemoryPanel/web
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install pytest
npm run build --prefix MemoryCore
npm run build --prefix MemoryPanel
npm run build --prefix MemoryPanel/web
node scripts/verify-competition.mjs
```

如果使用上游独立 Wiki／CodeGraph 服务，再按 `MemoryKnowledge/` 的组件说明安装和配置。下述库存体验不需要完整外部知识服务。

## 2. 检查安装包

```bash
node scripts/verify-release.mjs
```

它运行正常 npm 打包，将产物安装到新的空目录，启动安装后的 Gateway，并校验命令行入口、健康状态与元数据初始化。结束时打印 `output/release-*.json` 的实际路径。记录这个路径。此步骤不调用真实模型。

## 3. 打开本地交互体验

先安装 CodeBuddy CLI，并确保 `codebuddy --version` 成功。然后将下面的占位路径替换为上一步实际输出。

```bash
node scripts/verify-deployment.mjs output/release-<编号>.json --walkthrough
```

终端输出 Panel 地址、独立体验目录和本地登录密钥路径。打开该地址登录。在资产质量中心上传原始材料，查看候选与来源，完成自动质量审核和负责人发布。任务看板展示后续采用与验证。

**这个启动方式使用固定模型响应，适合重复验证服务和 CLI 协议。** 模型不会自由决策。真实模型模式见下一节。两种模式不混用团队资产。详细的停止、恢复与后台托管命令见 [本地验收说明](../deploy/quality-v2/ACCEPTANCE.md)。

## 4. 切换为真实模型（当前便捷托管脚本适用于 macOS）

真实模式使用你配置的模型完成编码、提炼和审阅，会产生模型调用费用。准备私有环境文件，权限设为 `600`，不要提交到 Git。

```dotenv
MEMORY_LLM_BASE_URL=https://<你的模型服务地址>/v1
MEMORY_LLM_API_KEY=<你的模型密钥>
MEMORY_LLM_MODEL=<支持工具调用的模型名称>
```

先停止上一步前台服务（Ctrl+C），再执行：

```bash
node scripts/enable-real-walkthrough.mjs output/walkthrough-<编号> output/release-<编号>.json /绝对路径/私有模型.env
```

脚本保留原演示数据，使用独立的真实体验团队。它将服务切到 HTTPS 模型上游，自动提交示例约定供真实提炼。模型可以返回“无候选”，这是允许的结果。该脚本通过 macOS launchd 托管，本地持续运行不会依赖当前终端窗口。

```bash
node scripts/walkthrough-task.mjs output/walkthrough-<编号> 1
```

任务完成后，在质量中心查看实际会话、测试与提炼候选。需要时先修订正文和引用，再进行自动审核与人工发布。不要为跑通演示而全局降低质量门槛。发布后运行任务 2，体验新任务复用。

```bash
node scripts/walkthrough-task.mjs output/walkthrough-<编号> 2
node scripts/walkthrough-service.mjs status output/walkthrough-<编号>
node scripts/walkthrough-service.mjs stop output/walkthrough-<编号>
```

模型是否采用资产、是否生成新经验由实际上下文和证据决定，不保证得到与报告完全一致的候选或结果。报告记录的是一次已发生的本地真实模型案例。Linux 可使用各组件的源码启动入口独立部署，但本仓库的 launchd 托管助手不能直接用于 Linux。

## 5. 分别理解三个结果

- **任务完成**：代码修改与验收测试达到目标。
- **资产采用／验证**：明确关联资产内容、具体动作和测试结果。
- **资产收益**：需要合适的对照或独立效果证明。任务完成本身不足以推出节省成本。

普通用户不需要每次手写采用总结。系统记录工具轨迹并异步评价。人工使用反馈可选，候选发布需要负责人审核。

## 配置与数据

- Core 模板：`MemoryCore/tdai-gateway.standalone.yaml`。
- Proxy 模板：`MemoryProxy/config.example.yaml`。
- Panel 模板：`MemoryPanel/.env.example` 和 `MemoryPanel/config/metadata-instances.example.json`。
- 体验数据与凭据：`output/walkthrough-*`，默认不提交。
- 源码入口：`agents/codebuddy/cli.mjs`、`scripts/team-assets.mjs`。

上游通用部署方式见 [归档安装说明](upstream/INSTALL_CN.md)，预构建镜像不等于本竞赛扩展源码的构建产物。不要把本地 `output/`、数据库、原始会话和模型配置加入公开仓库。
