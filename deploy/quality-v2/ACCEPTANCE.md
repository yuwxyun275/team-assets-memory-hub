# 本地发布与部署验收

在仓库根目录执行。需要 npm、Python 3 + pytest、已安装的 CodeBuddy CLI，以及各模块声明的开发依赖。

```bash
cd MemoryCore
npm run build
npm run test:oss
cd ..
cd MemoryPanel
npm run build
cd web
npm run build
cd ../..
node scripts/verify-release.mjs
node scripts/verify-deployment.mjs output/release-<上一步输出的编号>.json
```

`verify-release.mjs` 通过正常 `npm pack` 构建安装包，在新建的空目录执行 `npm install`，安装 Node 22，验证三个打包的命令行工具、Gateway 启动和 SQLite 元数据初始化。不使用当前开发目录的 node_modules。需要访问 npm registry；安装日志和临时数据保留在输出报告指定的目录中。

`verify-deployment.mjs` 使用上一步实际安装的 Core，以及当前仓库的 Proxy、编译后的 Panel 和 Python 编排器，启动独立回环端口与独立数据库。真实 CodeBuddy CLI 通过 Proxy 鉴权、检索、读取已审核正文，使用 Read/Write/Bash 修改隔离示例并执行 pytest。随后检查任务回执、等待 Core 自动生成回流候选、通过审核，再运行第二个任务复用该候选。未审核资产不能被使用，回执必须具备 recalled/selected/injected/used/validated、变更哈希和测试引用，不能声明 contributed。另检查 Panel 页面能加载，Panel API 返回相同的验证回执；不替代浏览器视觉验收。

这是合成资料和固定 HTTP 模型响应的集成验收。模型提炼、审核结论与 Token 用量由测试响应提供，不是对真实模型生成质量、泛化能力或收益的评测。文件读写与测试结果由实际 CLI 工具产生。所有子服务在退出时关闭；已有部署容器与业务数据不受影响。本脚本验证独立部署，不自动替换正在使用的服务。

报告保存在 `output/release-*.json` 和 `output/deployment-*.json`。失败报告仍保留，并指向诊断日志；只有所有断言通过才标记 passed。私有运行目录包含临时用户凭证，勿提交到版本库。

体验环境显式启用本地 Skill 模块，并检查 Panel 的「团队资产」「Agent 资产」两种技能列表接口。空的 Skill 库应返回正常空列表；仅检查健康接口与首页加载不能覆盖模块未启用的问题。资料提炼与回流候选仍在「资产质量中心」查看和审核。

## 自己动手体验

```bash
node scripts/verify-deployment.mjs output/release-<已通过的编号>.json --walkthrough
```

该模式启动独立 Core、Panel、Proxy、编排器和模拟模型，预建两个示例任务后等待，不自动提交资料、批准候选或执行 Coding。控制台输出 Panel 地址和 `output/walkthrough-*` 目录。登录密钥在该目录的 `login-key.txt`，原始示例资料为 `inventory-contract.md`，仓库与版本等填写值见 `walkthrough.json`。

服务停止后，可以用同一份发布报告恢复原体验目录：

```bash
node scripts/verify-deployment.mjs output/release-<已通过的编号>.json --walkthrough --resume output/walkthrough-<编号>
```

恢复时沿用原端口、登录密钥、任务与数据库，保留已修改的示例代码，不重新创建资产或任务。原服务仍在运行时不要重复启动。

macOS 上持续体验时，使用用户级后台托管，避免服务依赖临时执行终端。以下命令接管已停止的体验目录：

```bash
node scripts/walkthrough-service.mjs start output/walkthrough-<编号> output/release-<已通过的编号>.json
node scripts/walkthrough-service.mjs status output/walkthrough-<编号>
# 结束体验时停止服务，数据仍保留
node scripts/walkthrough-service.mjs stop output/walkthrough-<编号>
```

服务通过 launchd 在当前 macOS 登录会话中运行，子服务异常退出会触发整组恢复；不安装开机或登录自启动。日志保存在体验目录的 `service.log`。不要同时用前台方式启动同一目录。

在「资产质量中心」上传示例资料、填写准确的工作区路径与 `v1`、选择当前团队可见，提交后等待负责人审核。填写审核说明并点击「确认依据并发布」。随后运行：

```bash
node scripts/walkthrough-task.mjs output/walkthrough-<编号> 1
```

在工作台打开 `Inventory idempotency repair`，查看团队资产使用回执和任务经验提炼。自动回流候选完成审核并发布后运行相同命令，将末尾的 `1` 改为 `2`，对应 `Inventory duplicate request regression workflow`。CLI 每次使用新会话，任务 2 保留任务 1 的代码修改。

正常页面上传默认按真实项目资料处理，无需选择「模拟／合成资料」。预置 `inventory-contract.md` 的首行带有 `<!-- team-asset-source: synthetic -->`，上传时会自动保留合成来源标记。这个标记用于记录来源性质，不代替内容审核和执行验证。

此模式只支持指定的两个演示问题，生成、审核模型和后台效果评价为固定响应；它不是可以自由提问的真实模型。CLI、资料上传、资产权限、人工发布、文件读写、pytest、回执与自动回流都走实际服务。后台未判断正向收益时显示未知或待观察，不需要用人工点赞补成“有效”。在启动服务的终端按 Ctrl+C 关闭，体验目录仍保留。
