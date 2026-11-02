import assert from 'node:assert/strict';
import { internals } from '../skills/ygo-ruling/index.js';

const prompt = internals.playbook();
for (const rule of ['连锁构筑与连锁处理', 'C1…Cn', 'Cn+1', '合法性核对', '事件绑定', '状态更新', '不能把所有条件都解释为检查上一连锁块', '发动合法性', '尚未处理', '前一轮自己的回答不是证据', '默认只发送一条', '条件缺失时只追问']) {
  assert.ok(prompt.includes(rule), `missing regression guard: ${rule}`);
}
for (const obsolete of ['C3 紧接的是 C2，不是 C1', '若正在判断 C3', '能/不能在 C3 发动', '判例题的终审依据是脚本', '先做【Lua 脚本审计】', '判例分析较长时建议分条发', '先写出时间线']) {
  assert.ok(!prompt.includes(obsolete), `conflicting legacy instruction: ${obsolete}`);
}
assert.ok(!internals.leanSystem().includes('判例分析可以分条发'));
for (const rule of ['【自肃与限制核查】', '限制台账', '本回合此前', '发动限制与处理限制', '【逐块处理后的场面复核】', '不追溯判为非法发动', '不能一概认为离场就无效']) {
  assert.ok(prompt.includes(rule), `missing restriction/state guard: ${rule}`);
}
console.log('PASS: ruling prompt focuses on activation, chain-event binding, uncertain premises and one concise reply');
