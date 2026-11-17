import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseShard, parseId, compareIds, buildSurface, sentenceKey, parseComment } from '../src/corpus.mjs';

const load = name => readFile(new URL(`../fixtures/${name}`, import.meta.url));

test('空节点按整数分量比较，3.1 与 3.10 不相等', () => {
  const short = parseId('3.1');
  const long = parseId('3.10');
  assert.notEqual(short.key, long.key);
  assert.equal(compareIds(short, long), -1);
  assert.equal(compareIds(long, short), 1);
  assert.equal(compareIds(parseId('3.10'), parseId('3.10')), 0);
  // No float rounding: a long minor part keeps every digit.
  assert.equal(parseId('3.123456789012345678901').key, '3.123456789012345678901');
  assert.throws(() => parseId('3-3'));
  assert.throws(() => parseId('x.1'));
});

test('词面区间覆盖词节点，空节点不进入原句文本', async () => {
  const shard = parseShard(await load('resource-01.bin'), { shard: 'a' });
  const [sentence] = shard.sentences;
  assert.equal(sentence.surface.text, "can't go");
  assert.deepEqual(sentence.surface.segments.map(segment => segment.id), ['1-2', '3']);
  assert.equal(sentence.empties.length, 10);
  assert.equal(sentence.empties.at(-1).id, '3.10');
  assert.ok(!sentence.surface.text.includes('ghost'));
  assert.deepEqual(sentence.words.map(word => word.id), ['1', '2', '3']);
});

test('SpaceAfter=No 保留词面连接，区间与单词都适用', () => {
  const words = [
    { id: '1', form: 'a', misc: '_' },
    { id: '2', form: 'b', misc: 'SpaceAfter=No' },
    { id: '3', form: 'c', misc: '_' },
  ];
  assert.equal(buildSurface(words, []).text, 'a bc');
  const spans = [{ id: '1-2', form: 'ab', words: ['1', '2'], misc: 'SpaceAfter=No' }];
  assert.equal(buildSurface(words, spans).text, 'abc');
});

test('一句关系不闭合只隔离该句，同分片其他句仍可发布', async () => {
  const shard = parseShard(await load('resource-01.bin'), { shard: 'a' });
  const [good, broken] = shard.sentences;
  assert.equal(good.relationClosed, true);
  assert.equal(good.doc, 'doc-a');
  assert.equal(good.surface.text, "can't go");
  assert.equal(broken.relationClosed, false);
  assert.equal(broken.layer, 'isolated');
  assert.deepEqual(broken.words, []);
  assert.deepEqual(broken.basic, []);
  assert.deepEqual(broken.enhanced, []);
  assert.equal(broken.surface.text, '');
  assert.ok(broken.raw.words.some(word => word.head === '99'));
  assert.deepEqual(broken.errors.map(error => error.code).sort(),
    ['missing_dep_target', 'missing_head']);
  assert.equal(shard.counts.published, 1);
  assert.equal(shard.counts.isolated, 1);
});

test('句身份由分片、文档范围和分片句位置组成，跨文件同 sent_id 不冲突', async () => {
  const a = parseShard(await load('resource-01.bin'), { shard: 'a' });
  const b = parseShard(await load('resource-02.bin'), { shard: 'b' });
  const firstA = a.sentences[0];
  const firstB = b.sentences[0];
  assert.equal(firstA.sent_id, firstB.sent_id);
  assert.notEqual(sentenceKey(firstA.identity), sentenceKey(firstB.identity));
  assert.equal(firstA.doc, 'doc-a');
  assert.equal(firstB.doc, 'doc-b');
  assert.equal(sentenceKey(firstA.identity), 'a\u0000s1');
  assert.throws(() => sentenceKey({ shard: 'a' }), /identity_incomplete/);
});

test('# text 与词面不一致是警告，不覆盖重建词面', async () => {
  const shard = parseShard(await load('resource-02.bin'), { shard: 'b' });
  const [sentence] = shard.sentences;
  assert.equal(sentence.surface.text, "can't run");
  assert.equal(sentence.warnings[0].code, 'text_comment_mismatch');
  assert.equal(sentence.layer, 'sentence');
});

test('截断分片保留未完成尾部而不确认成句', () => {
  const text = '# sent_id = ok\n1\tgo\tgo\tVERB\t_\t_\t0\troot\t0:root\t_\n\n# sent_id = tail\n1\tgo\tgo\tVERB\t_\t_\t0\troot\t0:ro';
  const shard = parseShard(Buffer.from(text), { shard: 'cut' });
  assert.equal(shard.sentences.length, 2);
  assert.equal(shard.sentences[0].relationClosed, true);
  const tail = shard.sentences[1];
  assert.equal(tail.complete, false);
  assert.equal(tail.terminated_by, 'truncated');
  assert.equal(tail.relationClosed, false);
  assert.ok(tail.errors.some(error => error.code === 'bad_columns' || error.code === 'incomplete_sentence'));
});

test('文档范围在分片内延续且句位置连续', () => {
  const text = [
    '# newdoc id = d1', '# sent_id = s1',
    '1\tA\ta\tX\t_\t_\t0\troot\t0:root\t_', '',
    '# sent_id = s1',
    '1\tB\tb\tX\t_\t_\t0\troot\t0:root\t_', '',
    '# newdoc id = d2', '# sent_id = s1',
    '1\tC\tc\tX\t_\t_\t0\troot\t0:root\t_', '',
  ].join('\n');
  const shard = parseShard(Buffer.from(text), { shard: 'z' });
  assert.deepEqual(shard.sentences.map(sentence => sentence.doc), ['d1', 'd1', 'd2']);
  assert.deepEqual(shard.sentences.map(sentence => sentence.position), ['s1', 's2', 's3']);
  assert.deepEqual(shard.sentences.map(sentence => sentence.doc_index), [1, 1, 2]);
});

test('基本 HEAD 不指向空节点，增强 DEPS 可以', () => {
  const text = [
    '1\tgo\tgo\tVERB\t_\t_\t0\troot\t0:root|3.1:obj\t_',
    '3.1\tx\tx\tX\t_\t_\t_\t_\t0:dep\t_', '',
  ].join('\n');
  const shard = parseShard(Buffer.from(text), { shard: 'e' });
  const [sentence] = shard.sentences;
  assert.equal(sentence.relationClosed, true);
  assert.deepEqual(sentence.enhanced.map(edge => `${edge.from}->${edge.to}:${edge.relation}`),
    ['0->1:root', '3.1->1:obj', '0->3.1:dep']);
  const bad = parseShard(Buffer.from('1\tgo\tgo\tVERB\t_\t_\t3.1\troot\t3.1:root\t_\n\n'), { shard: 'e2' });
  assert.ok(bad.sentences[0].errors.some(error => error.code === 'head_is_empty'));
});

test('注释保留原始行，未知注释不丢弃', () => {
  assert.deepEqual(parseComment('# sent_id = s1'), { raw: '# sent_id = s1', name: 'sent_id', value: 's1' });
  assert.deepEqual(parseComment('# newdoc id = d'), { raw: '# newdoc id = d', name: 'newdoc id', value: 'd' });
  assert.deepEqual(parseComment('# custom thing here'),
    { raw: '# custom thing here', name: 'custom', value: 'thing here' });
  const shard = parseShard(Buffer.from('# unknown note\n1\ta\ta\tX\t_\t_\t0\troot\t0:root\t_\n\n'), { shard: 'u' });
  assert.equal(shard.sentences[0].comments[0].raw, '# unknown note');
});
