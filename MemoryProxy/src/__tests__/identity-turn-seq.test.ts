import { describe, expect, it } from "vitest";
import { extractClientIdentity } from "../identity.js";
import { countHumanTurns } from "../turnSeq.js";

describe("CodeBuddy runtime context", () => {
  it('does not recover workspace from an old user_info quoted inside a compressed summary',()=>{
    const content='<cb_summary>Summary of the conversation so far:\n<user_info>Workspace Folder: /old</user_info>\n</cb_summary>\n<user_query>continue</user_query>';
    expect(extractClientIdentity({},{messages:[{role:'user',content}]},'codebuddy').userInfo?.workspaceFolder??null).toBeNull();
  });
  it('prefers the newest explicit workspace over an older user envelope',()=>{
    const messages=['/old','/current'].map(path=>({role:'user',content:`<user_info>Workspace Folder: ${path}</user_info>`}));
    expect(extractClientIdentity({},{messages},'codebuddy').userInfo?.workspaceFolder).toBe('/current');
  });
  it("extracts workspace from CodeBuddy's user message", () => {
    const identity = extractClientIdentity({}, {
      messages: [
        { role: "system", content: "ordinary system prompt" },
        {
          role: "user",
          content: "<user_info>\nOS Version: macOS\nShell: zsh\nWorkspace Folder: /Users/demo/project\n</user_info>\n修复缓存问题",
        },
      ],
    }, "codebuddy");
    expect(identity.userInfo?.workspaceFolder).toBe("/Users/demo/project");
  });

  it("does not count session forms as coding turns", () => {
    const messages = [
      { role: "user", content: "<question_answer>是</question_answer>" },
      { role: "user", content: '{"type":"multi_question_result","questions":[]}' },
      { role: "user", content: "User has answered your questions: \"task\"=\"task-1\"" },
      { role: "user", content: "开始执行" },
    ];
    expect(countHumanTurns(messages, "openai")).toBe(1);
  });
});
