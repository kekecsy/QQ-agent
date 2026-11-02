import assert from 'node:assert/strict';
import { promptSections, internals } from '../skills/ygo-ruling/index.js';
const casual = promptSections({ triggerEntries: [{ text: '今天吃啥，来张表情包' }] })[0];
assert.ok(casual.content.length < 200);
assert.ok(!casual.content.includes('Lua 脚本审计'));
const question = promptSections({ triggerEntries: [{ text: '裁定 这张卡的效果会被无效吗' }] })[0];
assert.equal(question.content, internals.playbook());
assert.equal(question.id, casual.id);
assert.ok(question.content.length > 1000);
assert.equal(promptSections({})[0].content, casual.content);
for (const text of ['裁定 灰流丽', '裁定 莫忘阁楼怪', '查卡 青眼白龙']) {
  assert.equal(promptSections({ triggerEntries: [{ text }] })[0].content, internals.playbook(), `explicit command must load full skill rules: ${text}`);
}
for (const text of ['裁定', '查卡', '裁定：灰流丽', ' 查卡 青眼白龙', '请你查卡 青眼白龙', '聊天提到裁定', '游戏王这张卡的效果会被无效吗']) {
  assert.equal(promptSections({ triggerEntries: [{ text }] })[0].content, casual.content, `not a strict command: ${text}`);
}
const { SkillManager } = await import('../src/skills/manager.js');
const manager = new SkillManager();
manager.register({ manifest: { id: 'ygo-scope-test', enabledByDefault: true, prompt: { sections: [{ id: casual.id, content: question.content }] } }, promptSections, providers: {}, hooks: {} });
const sections = manager.getPromptSections({ triggerEntries: [{ text: '早上好' }] });
assert.equal(sections.filter((s) => s.id === casual.id).length, 1);
assert.equal(sections.find((s) => s.id === casual.id).content, casual.content);
console.log(`PASS: casual ${casual.content.length} chars, YGO ${question.content.length} chars, static playbook replaced`);
