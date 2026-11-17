import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
import { Store } from '../src/store.mjs';
import { parseShard } from '../src/corpus.mjs';

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'claim-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  const claim = () => fetch(`${service.url}/claims`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: '/release' }),
  });
  const get = async path => (await fetch(`${service.url}${path}`)).json();
  return { directory, provider, service, claim, get };
}

test('分片领取保留文档与句子来源，跨文件同 sent_id 各自独立', async () => {
  const { provider, service, claim, get, directory } = await setup();
  try {
    const claimed = await claim();
    assert.equal(claimed.status, 201);
    const body = await claimed.json();
    assert.equal(body.edition, '2026-11');
    assert.deepEqual(body.shards.map(shard => [shard.id, shard.revision, shard.status]),
      [['a', 1, 'created'], ['b', 1, 'created']]);

    const sentences = await get('/sentences');
    assert.deepEqual(sentences.map(sentence => [sentence.shard, sentence.position, sentence.doc]),
      [['a', 's1', 'doc-a'], ['a', 's2', 'doc-a'], ['b', 's1', 'doc-b']]);
    // Both files use sent_id = s1, but their keys and documents differ.
    assert.equal(sentences[0].sent_id, sentences[2].sent_id);
    assert.notEqual(sentences[0].key, sentences[2].key);
    assert.equal(sentences[0].key, 'a\u0000s1');
    assert.equal(sentences[2].key, 'b\u0000s1');
    assert.equal(sentences[2].surface.text, "can't run");
    assert.deepEqual((await get('/sentences/a/s1')).words.map(word => word.id), ['1', '2', '3']);
    assert.equal((await fetch(`${service.url}/sentences/b/s2`)).status, 404);
  } finally {
    await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('重领修订分片只替换该来源，保留其他文件同号句子', async () => {
  const { provider, service, claim, get, directory } = await setup();
  try {
    await claim();
    const before = await get('/sentences');
    const untouched = before.find(sentence => sentence.shard === 'b');
    assert.ok(untouched);

    // Phase 1 republishes release with shard a at revision 2 pointing at
    // /primary, and shard b unchanged at revision 1.
    await fetch(`${provider.url}/_phase`, { method: 'POST', body: JSON.stringify({ phase: 1 }) });
    const repeat = await claim();
    assert.equal(repeat.status, 201);
    const body = await repeat.json();
    const shardA = body.shards.find(shard => shard.id === 'a');
    const shardB = body.shards.find(shard => shard.id === 'b');
    assert.equal(shardA.status, 'replaced');
    assert.equal(shardA.revision, 2);
    assert.equal(shardB.status, 'unchanged');
    assert.equal(shardB.revision, 1);

    const after = await get('/sentences');
    const b = after.find(sentence => sentence.shard === 'b');
    assert.equal(b.key, untouched.key);
    assert.equal(b.surface.text, "can't run");
    // Shard a now reflects revision 2 only; the old a/s2 isolated sentence is
    // gone because it belonged to that replaced shard.
    const a = after.filter(sentence => sentence.shard === 'a');
    assert.deepEqual(a.map(sentence => sentence.position), ['s1']);
    assert.equal((await get('/shards')).find(shard => shard.id === 'a').revision, 2);
    assert.equal((await fetch(`${service.url}/sentences/a/s2`)).status, 404);
  } finally {
    await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('同 revision 重领幂等；低版本被拒且不留下部分写入', async () => {
  const { provider, service, claim, get, directory } = await setup();
  try {
    await claim();
    const first = await get('/shards');
    const repeat = await claim();
    assert.equal(repeat.status, 201);
    const repeated = await repeat.json();
    assert.ok(repeated.shards.every(shard => shard.status === 'unchanged'));
    assert.deepEqual((await get('/shards')).map(shard => shard.digest), first.map(shard => shard.digest));

    // Directly committing an older revision for one id aborts the whole batch.
    const store = new Store(directory);
    await store.initialize();
    const state = await store.corpusState();
    assert.deepEqual(Object.keys(state.shards).sort(), ['a', 'b']);
    await assert.rejects(
      store.commitShards([{ id: 'a', path: '/corpus/part-a', revision: 0,
        bytes: Buffer.from('1\tx\tx\tX\t_\t_\t0\troot\t0:root\t_\n\n'), parsed: { sentences: [], issues: [], counts: {} } }]),
      /stale_revision/,
    );
    const unchanged = await store.corpusState();
    assert.equal(unchanged.shards.a.revision, 1);
  } finally {
    await service.close(); await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('同 revision 内容变化报告冲突且保留已接受来源', async () => {
  const { provider, service, claim, get, directory } = await setup();
  try {
    await claim();
    const accepted = (await get('/shards')).find(shard => shard.id === 'a');
    const store = new Store(directory);
    await store.initialize();
    const changed = Buffer.from('# sent_id = s1\n1\tX\tX\tX\t_\t_\t0\troot\t0:root\t_\n\n');
    const result = await store.commitShards([{
      id: 'a', path: '/corpus/part-a', revision: 1, bytes: changed,
      parsed: parseShard(changed, { shard: 'a' }),
    }]);
    assert.equal(result.shards[0].status, 'unchanged');
    assert.equal(result.shards[0].conflict, 'revision_content_changed');
    assert.equal(result.shards[0].digest, accepted.digest);
    const sentence = await get('/sentences/a/s1');
    assert.equal(sentence.surface.text, "can't go");
  } finally {
    await service.close(); await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('已领取分片与句子在重启后仍可按来源查询', async () => {
  const { provider, service, claim, directory } = await setup();
  let payload;
  try {
    const response = await claim();
    payload = await response.json();
    const original = await (await fetch(`${service.url}/sentences/a/s1`)).json();
    await service.close();

    const reopened = await startService({ source: provider.url, directory });
    try {
      const sentence = await (await fetch(`${reopened.url}/sentences/a/s1`)).json();
      assert.deepEqual(sentence, original);
      const shard = (await (await fetch(`${reopened.url}/shards`)).json())
        .find(item => item.id === 'a');
      assert.equal(shard.digest, payload.shards.find(item => item.id === 'a').digest);
      // Original shard bytes are still addressable through the existing
      // object route and match the source fixture.
      const object = Buffer.from(await (await fetch(`${reopened.url}/objects/${shard.object}`)).arrayBuffer());
      assert.deepEqual(object, await readFile(new URL('../fixtures/resource-01.bin', import.meta.url)));
    } finally { await reopened.close(); }
  } finally {
    await provider.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('领取不越过配置来源，畸形清单整体拒收', async () => {
  const { provider, service, claim, get, directory } = await setup();
  try {
    const foreign = await fetch(`${service.url}/claims`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'https://example.invalid/release' }),
    });
    assert.equal(foreign.status, 422);
    const missing = await fetch(`${service.url}/claims`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/missing' }),
    });
    assert.equal(missing.status, 422);
    assert.deepEqual(await get('/sentences'), []);
    assert.deepEqual(await get('/shards'), []);
    assert.equal((await claim()).status, 201);
  } finally {
    await service.close(); await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});
