import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
const dir = fs.mkdtempSync(`${os.tmpdir()}/qq-image-refresh-`);
process.env.QQ_AGENT_DATA_DIR = dir;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6XsAAAAAASUVORK5CYII=', 'base64');
const server = http.createServer((req, res) => {
  if (req.url === '/old') { res.writeHead(400); res.end(); }
  else { res.writeHead(200, { 'content-type': 'image/png' }); res.end(png); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const { updateConfig } = await import('../src/config.js');
  updateConfig({ subagent: { enabled: false }, security: { allowPrivateImageHosts: true } });
  const { buildToolDefs, executeTool } = await import('../src/tools.js');
  const base = `http://127.0.0.1:${server.address().port}`;
  let refreshed = 0;
  const result = await executeTool(buildToolDefs(), {
    chatKey: 'group:1',
    store: { findByMid: () => ({ mid: 1, media: [{ kind: 'image', url: `${base}/old` }] }) },
    onebot: { getMsg: async () => { refreshed++; return { message: [{ type: 'image', data: { url: `${base}/fresh` } }] }; } }
  }, 'get_message_images', { messageId: 1 });
  assert.equal(result.isError, undefined);
  assert.equal(refreshed, 1);
  assert.ok(result.content.some((p) => p.type === 'image_url'));
  console.log('PASS: expired image URL is refreshed through OneBot and safely re-downloaded');
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
}
