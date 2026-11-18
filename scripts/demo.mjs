import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const provider = await startProvider();
const service = await startService({ source: provider.url, directory });
const post = (path, payload) => fetch(`${service.url}${path}`, { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
try {
  console.log(JSON.stringify({ source: provider.url, product: service.url }));
  console.log('来源目录', await (await fetch(`${provider.url}/catalog`)).json());
  const response = await post('/intakes', { path: '/primary' });
  if (response.status !== 201) throw new Error(await response.text());
  console.log('单件接收', await response.json());
  const release = await post('/releases', {});
  if (release.status !== 201) throw new Error(await release.text());
  console.log('分片领取', await release.json());
  const sentences = await (await fetch(`${service.url}/corpus/sentences`)).json();
  console.log('句子目录', sentences);
  console.log('句子细节', await (await fetch(`${service.url}/corpus/sentences/${sentences[0].key}`)).json());
  console.log('隔离句', await (await fetch(`${service.url}/corpus/quarantine`)).json());
  console.log('同版重领', await (await post('/releases', {})).json());
  console.log('已保存资料', await (await fetch(`${service.url}/records`)).json());
} finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
