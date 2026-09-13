import { describe, expect, it } from "vitest";
import {
  stripTeamAssetControlMarkup,
  TeamAssetControlMarkupFilter,
} from "../team-assets-control-markup.js";

describe("team asset control markup", () => {
  it("removes evidence declarations from a completed response", () => {
    expect(stripTeamAssetControlMarkup([
      "修复完成。",
      '<team_asset_use>{"asset_id":"asset-skill"}</team_asset_use>',
      '<acceptance_evidence>{"criterion_id":"criterion-1"}</acceptance_evidence>',
      "8 tests passed.",
    ].join("\n"))).toBe("修复完成。\n\n8 tests passed.");
  });

  it("removes declarations split across streaming chunks", () => {
    const filter = new TeamAssetControlMarkupFilter();
    const chunks = [
      "结论\n<team_",
      'asset_use>{"asset_id":"x",',
      '"target":"service.py"}</team_asset_',
      "use>\n测试通过",
    ];
    const visible = chunks.map((chunk) => filter.push(chunk)).join("") + filter.flush();
    expect(visible).toBe("结论\n\n测试通过");
  });

  it("does not remove ordinary angle-bracket text", () => {
    const filter = new TeamAssetControlMarkupFilter();
    const visible = filter.push("当 x < 10 时继续") + filter.flush();
    expect(visible).toBe("当 x < 10 时继续");
  });
});
