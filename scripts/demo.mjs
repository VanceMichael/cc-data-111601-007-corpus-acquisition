import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const provider = await startProvider();
const service = await startService({ source: provider.url, directory });
try {
  console.log(JSON.stringify({ source: provider.url, product: service.url }));
  console.log('来源目录', await (await fetch(`${provider.url}/catalog`)).json());

  const claim = await fetch(`${service.url}/claims`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: '/release' }),
  });
  if (claim.status !== 201) throw new Error(await claim.text());
  console.log('领取结果', await claim.json());

  const sentences = await (await fetch(`${service.url}/sentences`)).json();
  for (const sentence of sentences) {
    console.log('句子', JSON.stringify({
      shard: sentence.shard,
      revision: sentence.revision,
      doc: sentence.doc,
      position: sentence.position,
      sent_id: sentence.sent_id,
      key: sentence.key,
      layer: sentence.layer,
      text: sentence.surface?.text ?? null,
      words: sentence.words.length,
      empties: sentence.empties.length,
      enhanced: sentence.enhanced.length,
      errors: sentence.errors.map(error => error.code),
    }));
  }
} finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
