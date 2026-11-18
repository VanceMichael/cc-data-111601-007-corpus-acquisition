import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseShard } from '../src/shard.mjs';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';

const fixture = name => readFile(new URL(`../fixtures/${name}`, import.meta.url));
const shard = (...lines) => Buffer.from(`${lines.join('\n')}\n\n`);

test('分片解析分列词面、词节点、空节点与增强关系', async () => {
  const parsed = parseShard(await fixture('resource-01.bin'));
  assert.equal(parsed.tail, null);
  assert.equal(parsed.sentences.length, 1);
  const sentence = parsed.sentences[0];
  assert.equal(sentence.document, 'doc-a');
  assert.equal(sentence.position, 0);
  assert.equal(sentence.sentId, 's1');
  assert.equal(sentence.text, "can't go");
  assert.deepEqual(sentence.tokens, [
    { range: '1-2', form: "can't", spaceAfter: true },
    { id: '3', form: 'go', spaceAfter: true }]);
  assert.equal(sentence.nodes.length, 3);
  assert.deepEqual(sentence.nodes[0], { id: '1', form: 'ca', lemma: 'can', upos: 'AUX',
    xpos: '_', feats: '_', head: '3', relation: 'aux', misc: '_' });
  assert.equal(sentence.empty.length, 10);
  assert.equal(sentence.empty[9].id, '3.10');
  assert.equal(sentence.edges.length, 13);
  assert.deepEqual(sentence.edges[0], { target: '1', head: '3', relation: 'aux' });
  assert.deepEqual(sentence.edges.at(-1), { target: '3.10', head: '3', relation: 'obj' });
  assert.equal(parsed.quarantine.length, 1);
  const broken = parsed.quarantine[0];
  assert.equal(broken.document, 'doc-a');
  assert.equal(broken.position, 1);
  assert.equal(broken.sentId, 'broken');
  assert.equal(broken.reason, 'dangling_head');
  assert.match(broken.raw, /99\tdep/);
});

test('相邻分片同号句各自解析', async () => {
  const parsed = parseShard(await fixture('resource-02.bin'));
  assert.equal(parsed.sentences.length, 1);
  assert.equal(parsed.sentences[0].document, 'doc-b');
  assert.equal(parsed.sentences[0].sentId, 's1');
  assert.equal(parsed.sentences[0].text, "can't run");
  assert.equal(parsed.quarantine.length, 0);
  assert.equal(parsed.tail, null);
});

test('空节点不进入词面文本，SpaceAfter=No 保留', () => {
  const parsed = parseShard(shard(
    '# sent_id = t1',
    '1\tA\t_\tX\t_\t_\t2\tdep\t2:dep\tSpaceAfter=No',
    '2\tB\t_\tX\t_\t_\t0\troot\t0:root\t_',
    '2.1\thidden\t_\tX\t_\t_\t_\t_\t2:dep\t_'));
  const sentence = parsed.sentences[0];
  assert.equal(sentence.text, 'AB');
  assert.equal(sentence.tokens.length, 2);
  assert.equal(sentence.empty.length, 1);
  assert.deepEqual(sentence.edges.at(-1), { target: '2.1', head: '2', relation: 'dep' });
});

test('词面区间末词的 SpaceAfter=No 生效', () => {
  const parsed = parseShard(shard(
    '1-2\tAB\t_\t_\t_\t_\t_\t_\t_\t_',
    '1\tA\t_\tX\t_\t_\t3\tdep\t3:dep\t_',
    '2\tB\t_\tX\t_\t_\t3\tdep\t3:dep\tSpaceAfter=No',
    '3\tC\t_\tX\t_\t_\t0\troot\t0:root\t_'));
  assert.equal(parsed.sentences[0].text, 'ABC');
  assert.equal(parsed.sentences[0].tokens.length, 2);
});

test('增强关系按首个冒号切分，允许多边并引用空节点', () => {
  const parsed = parseShard(shard(
    '1\tA\t_\tX\t_\t_\t2\tnsubj\t2:nsubj:pass|2.1:nsubj\t_',
    '2\tB\t_\tX\t_\t_\t0\troot\t0:root\t_',
    '2.1\tC\t_\tX\t_\t_\t_\t_\t2:nsubj\t_'));
  assert.deepEqual(parsed.sentences[0].edges.slice(0, 2), [
    { target: '1', head: '2', relation: 'nsubj:pass' },
    { target: '1', head: '2.1', relation: 'nsubj' }]);
});

test('小数空节点按整数元组比较', () => {
  const ordered = parseShard(shard(
    '1\tA\t_\tX\t_\t_\t0\troot\t0:root\t_',
    '1.9\tB\t_\tX\t_\t_\t_\t_\t1:dep\t_',
    '1.10\tC\t_\tX\t_\t_\t_\t_\t1:dep\t_'));
  assert.deepEqual(ordered.sentences[0].empty.map(node => node.id), ['1.9', '1.10']);
  const disordered = parseShard(shard(
    '1\tA\t_\tX\t_\t_\t0\troot\t0:root\t_',
    '1.10\tB\t_\tX\t_\t_\t_\t_\t1:dep\t_',
    '1.9\tC\t_\tX\t_\t_\t_\t_\t1:dep\t_'));
  assert.equal(disordered.sentences.length, 0);
  assert.equal(disordered.quarantine[0].reason, 'empty_placement');
  const misplaced = parseShard(shard(
    '1\tA\t_\tX\t_\t_\t2\tdep\t2:dep\t_',
    '2\tB\t_\tX\t_\t_\t0\troot\t0:root\t_',
    '1.1\tC\t_\tX\t_\t_\t_\t_\t1:dep\t_'));
  assert.equal(misplaced.quarantine[0].reason, 'empty_placement');
});

test('关系不闭合只隔离对应句', () => {
  const parsed = parseShard(shard(
    '# sent_id = ok',
    '1\tA\t_\tX\t_\t_\t0\troot\t0:root\t_',
    '',
    '# sent_id = bad-head',
    '1\tB\t_\tX\t_\t_\t9\tdep\t9:dep\t_',
    '',
    '# sent_id = bad-deps',
    '1\tC\t_\tX\t_\t_\t0\troot\t9:dep\t_'));
  assert.deepEqual(parsed.sentences.map(sentence => sentence.sentId), ['ok']);
  assert.deepEqual(parsed.quarantine.map(item => [item.sentId, item.reason, item.position]),
    [['bad-head', 'dangling_head', 1], ['bad-deps', 'dangling_deps', 2]]);
});

test('词节点基本头不得指向空节点', () => {
  const parsed = parseShard(shard(
    '1\tA\t_\tX\t_\t_\t2.1\tdep\t2:dep\t_',
    '2\tB\t_\tX\t_\t_\t0\troot\t0:root\t_',
    '2.1\tC\t_\tX\t_\t_\t_\t_\t2:dep\t_'));
  assert.equal(parsed.quarantine[0].reason, 'dangling_head');
});

test('畸形行与空句按句隔离', () => {
  const parsed = parseShard(shard(
    '# sent_id = short',
    '1\tA\tB',
    '',
    '# sent_id = silent'));
  assert.deepEqual(parsed.quarantine.map(item => item.reason), ['conllu_columns', 'sentence_rows_missing']);
});

test('未终止尾部保留而不计入句子', () => {
  const truncated = parseShard(Buffer.from(
    '# sent_id = done\n1\tA\t_\tX\t_\t_\t0\troot\t0:root\t_\n\n# sent_id = partial\n1\tB\t_\tX'));
  assert.equal(truncated.sentences.length, 1);
  assert.equal(truncated.quarantine.length, 0);
  assert.equal(truncated.tail.sentId, 'partial');
  assert.equal(truncated.tail.position, 1);
  assert.deepEqual(truncated.tail.lines, ['# sent_id = partial', '1\tB\t_\tX']);
  const whole = parseShard(Buffer.from('# sent_id = x\n1\tA\t_\tX\t_\t_\t0\troot\t0:root\t_\n'));
  assert.equal(whole.sentences.length, 0);
  assert.equal(whole.tail.sentId, 'x');
});

test('发布领取、句级隔离、同版幂等与修订替换', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'corpus-test-'));
  const provider = await startProvider();
  let service = await startService({ source: provider.url, directory });
  const intake = () => fetch(`${service.url}/releases`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{}' });
  const sentences = async () => (await fetch(`${service.url}/corpus/sentences`)).json();
  try {
    const first = await (await intake()).json();
    assert.equal(first.edition, '2026-11');
    assert.deepEqual(first.files, [
      { file: 'a', revision: 1, status: 'received', sentences: 1, quarantined: 1, tail: false },
      { file: 'b', revision: 1, status: 'received', sentences: 1, quarantined: 0, tail: false }]);
    const listed = await sentences();
    assert.deepEqual(listed.map(item => item.key).sort(), ['a/doc-a/0', 'b/doc-b/0']);
    assert.deepEqual(listed.map(item => item.sentId), ['s1', 's1']);
    const detail = await (await fetch(`${service.url}/corpus/sentences/a/doc-a/0`)).json();
    assert.equal(detail.text, "can't go");
    assert.equal(detail.empty.length, 10);
    assert.equal(detail.edges.length, 13);
    assert.equal((await fetch(`${service.url}/corpus/sentences/a/doc-a/9`)).status, 404);
    const quarantine = await (await fetch(`${service.url}/corpus/quarantine`)).json();
    assert.deepEqual(quarantine.map(item => [item.shard, item.sentId, item.reason]),
      [['a', 'broken', 'dangling_head']]);
    const corpus = await (await fetch(`${service.url}/corpus`)).json();
    const digest = corpus.shards.find(item => item.file === 'a').digest;
    const saved = await fetch(`${service.url}/objects/${digest}`);
    assert.deepEqual(Buffer.from(await saved.arrayBuffer()), await fixture('resource-01.bin'));
    const again = await (await intake()).json();
    assert.deepEqual(again.files.map(file => file.status), ['unchanged', 'unchanged']);
    assert.equal((await sentences()).length, 2);
    await fetch(`${provider.url}/_phase`, { method: 'POST', body: JSON.stringify({ phase: 1 }) });
    const revised = await (await intake()).json();
    assert.deepEqual(revised.files, [
      { file: 'a', revision: 2, status: 'replaced', sentences: 0, quarantined: 0, tail: true },
      { file: 'b', revision: 1, status: 'unchanged', sentences: 1, quarantined: 0, tail: false }]);
    assert.deepEqual((await sentences()).map(item => item.key), ['b/doc-b/0']);
    assert.equal((await (await fetch(`${service.url}/corpus/quarantine`)).json()).length, 0);
    const shards = (await (await fetch(`${service.url}/corpus`)).json()).shards;
    const retained = shards.find(item => item.file === 'a');
    assert.equal(retained.revision, 2);
    assert.equal(retained.tail.sentId, 's1');
    await service.close();
    service = await startService({ source: provider.url, directory });
    assert.deepEqual((await sentences()).map(item => item.key), ['b/doc-b/0']);
  } finally {
    await service.close();
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('发布清单畸形或路径缺失被拒绝且不改动语料', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'corpus-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  const send = path => fetch(`${service.url}/releases`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
  try {
    assert.equal((await send('/missing')).status, 422);
    assert.equal((await send('/corpus/part-a')).status, 422);
    assert.deepEqual(await (await fetch(`${service.url}/corpus/sentences`)).json(), []);
  } finally {
    await service.close();
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});
