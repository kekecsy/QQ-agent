import assert from 'node:assert/strict';
import dns from 'node:dns';
const originalLookup = dns.promises.lookup;
const originalFetch = globalThis.fetch;
let addresses = [{ address: '198.18.0.93', family: 4 }];
let answer = '43.163.181.217';
let calls = 0;
dns.promises.lookup = async () => addresses;
globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: answer }] })); };
try {
  const { validateFetchUrl } = await import('../src/safe-fetch.js');
  await assert.rejects(validateFetchUrl('https://multimedia.nt.qq.com.cn/image'), /内网/);
  assert.equal((await validateFetchUrl('https://multimedia.nt.qq.com.cn/image', { qqImage: true })).ip, answer);
  await assert.rejects(validateFetchUrl('https://evil.example/image', { qqImage: true }), /内网/);
  await assert.rejects(validateFetchUrl('http://multimedia.nt.qq.com.cn/image', { qqImage: true }), /内网/);
  await assert.rejects(validateFetchUrl('https://multimedia.nt.qq.com.cn:444/image', { qqImage: true }), /内网/);
  answer = '127.0.0.1';
  await assert.rejects(validateFetchUrl('https://multimedia.nt.qq.com.cn/image', { qqImage: true }), /不安全/);
  addresses = [{ address: '198.18.0.93', family: 4 }, { address: '192.168.1.1', family: 4 }];
  const previous = calls;
  await assert.rejects(validateFetchUrl('https://multimedia.nt.qq.com.cn/image', { qqImage: true }), /内网/);
  assert.equal(calls, previous);
  console.log('PASS: QQ Fake-IP fallback; unknown hosts, private DNS, HTTP, nonstandard ports remain blocked');
} finally { dns.promises.lookup = originalLookup; globalThis.fetch = originalFetch; }
