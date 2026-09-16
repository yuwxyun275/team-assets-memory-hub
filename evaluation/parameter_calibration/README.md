# 参数验证与复现

本目录交付参数设计、比较协议、原始结果与失败记录。正文依据见 [参数说明](../../docs/PARAMETER_EVIDENCE_CN.md)。

## 不调用模型的复现

在仓库根目录执行。需要 Python 3.10+，生成器只使用标准库。

一次核对全部已发布证据可运行 `python3 evaluation/parameter_calibration/verify.py`。CI 同样执行该命令。它重建数据，比较排序与审核结果，核对当前默认配置以及真实返回代码和验收脚本的哈希，不调用模型。

```bash
python3 evaluation/asset_recommendation_bench/build.py --output output/parameter-dataset
python3 evaluation/parameter_calibration/run.py --dataset output/parameter-dataset --output output/ranking-reproduced.json
python3 evaluation/parameter_calibration/quality.py --output output/quality-reproduced.json
```

生成器拒绝覆盖已有目录。`run.py` 冻结比较时间，先只用三个开发仓库选参数，再计算 billing 保留集。每条记录可以核对被选资产及覆盖信息组。当前默认策略应与 `results/ranking.json` 的 `selected_policy` 一致。

质量重放输入是已脱离用户身份的历史模型审核摘要，只含公开合成资产 ID、维度、检查状态和原报告哈希。明确缺陷标注来自原契约生成器。其余资产不是合格金标。

如已安装 Core 依赖，可以重新执行当前规则，再复算门禁：

```bash
MemoryCore/node_modules/.bin/tsx evaluation/parameter_calibration/replay-rules.ts output/parameter-dataset
python3 evaluation/parameter_calibration/quality.py --output output/quality-reproduced.json
```

该命令更新公开摘要中的 `current_rule_blockers`，不调用模型、不修改线上资产或历史审核。它用于已知问题的回归，不伪装独立泛化测试。

## 真实模型确认

`results/live-confirmation.json` 保存本次全部 12 次请求的结果。`generated-code/` 保存实际返回的代码，截断请求没有生成代码。记录包含模型 ID、请求哈希、usage、finish_reason、测试输出和代码哈希。

`confirm_live.py` 必须显式传入 `--allow-external-model` 才会调用外部模型。其配置文件采用本地运行环境的 `llm.baseUrl/apiKey`，不得提交凭据。输出目录不能包含已有实验结果。运行器不自动重试失败。当前验证执行依赖 macOS sandbox-exec，其他平台需要提供等价隔离，不会静默降级为无沙箱执行。

```bash
python3 evaluation/parameter_calibration/confirm_live.py \
  --dataset output/parameter-dataset \
  --private-config /path/to/private-gateway.json \
  --output /path/to/new-private-results \
  --allow-external-model
```

这不是 CodeBuddy CLI 的完整对照。模型自述 `used_assets` 不会升级为可信使用事件。正式 CLI 主案例在技术报告中另行叙述。

## 结果边界

- 参数选择只覆盖当前合成契约和检索后端。没有全局最优保证。
- 旧策略与新策略的比较包含资格前置、去重和集合选择变化，不是 k 的单因素因果实验。
- 保留集 3 个任务属于同一个仓库。真实确认只有 2 个独立任务，不适合推断普遍收益。
- 6 次真实请求耗尽 4,096 输出 Token，未返回完整代码。失败全部保留。
- 固定 8 项、6,000 估算 Token 是比较约束，不会改写所有用户任务的预算。
- 模型金额未核实，历史资产建设和人工审核时间未合并。只报告能核对的 provider usage。
