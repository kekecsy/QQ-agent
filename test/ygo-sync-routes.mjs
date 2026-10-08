import assert from 'node:assert/strict';
import { bootApp } from './_harness.mjs';

const app = await bootApp();
try {
  const list = await app.request('GET', '/api/skills');
  const skill = list.data.skills.find((s) => s.id === 'ygo-ruling');
  assert.deepEqual(skill.settingsActions.map((a) => a.id), ['cards', 'lua']);
  const status = await app.request('GET', '/api/skills/ygo-ruling/settings-actions');
  assert.equal(status.status, 200);
  assert.equal(status.data.status.running, false);
  const invalid = await app.request('POST', '/api/skills/ygo-ruling/settings-actions', { body: { action: 'invalid' } });
  assert.equal(invalid.status, 400);
  const absent = await app.request('GET', '/api/skills/missing/settings-actions');
  assert.equal(absent.status, 404);
  console.log('PASS: loaded skill actions, HTTP status, invalid action, missing skill');
} finally {
  await app.teardown();
}
