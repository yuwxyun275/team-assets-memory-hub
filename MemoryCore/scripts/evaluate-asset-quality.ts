import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { evaluateQuality } from "../src/asset-quality/evaluator.js";
import { createConfiguredReviewer } from "../src/asset-quality/configured-reviewer.js";
import { reportToMarkdown } from "../src/asset-quality/report.js";
import { snapshotSchema, type ModelReviewer } from "../src/asset-quality/types.js";

async function main() {
  const { values } = parseArgs({ options: {
    input: { type: "string" }, output: { type: "string" }, model: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  } });
  if (values.help || !values.input) {
    process.stdout.write("Usage: node --import tsx scripts/evaluate-asset-quality.ts --input snapshot.json [--output report-prefix] [--model]\nDefault: local rules only, no network. --model explicitly sends the snapshot to QUALITY_LLM_BASE_URL.\n");
    process.exitCode = values.help ? 0 : 1;
    return;
  }
  const inputPath = resolve(values.input);
  if ((await stat(inputPath)).size > 240_000) throw new Error("snapshot_too_large");
  const snapshot = snapshotSchema.parse(JSON.parse(await readFile(inputPath, "utf8")));
  let reviewer: ModelReviewer | undefined;
  if (values.model) {
    const baseUrl = process.env.QUALITY_LLM_BASE_URL;
    const apiKey = process.env.QUALITY_LLM_API_KEY;
    const model = process.env.QUALITY_LLM_MODEL;
    if (!baseUrl || !apiKey || !model) throw new Error("quality_model_environment_required");
    reviewer = createConfiguredReviewer({ baseUrl, apiKey, model });
  }
  const report = await evaluateQuality(snapshot, { reviewer });
  if (values.output) {
    const prefix = resolve(values.output);
    // Refuse overwriting previous evidence reports.
    await writeFile(`${prefix}.json`, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await writeFile(`${prefix}.md`, reportToMarkdown(report), { flag: "wx", mode: 0o600 });
    process.stdout.write(`${report.decision}: ${prefix}.json; ${prefix}.md\n`);
  } else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch(() => {
  // Provider / parser errors can contain submitted content or credentials.
  process.stderr.write("评估失败：请检查输入格式、文件大小、输出是否已存在，以及启用模型时的环境变量；未自动发布资产。\n");
  process.exitCode = 1;
});
