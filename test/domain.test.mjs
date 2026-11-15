import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect } from '../src/reader.mjs';
const primary=await readFile(new URL('../fixtures/primary.bin',import.meta.url));
const manifest=JSON.parse(await readFile(new URL('../fixtures/upstream.json',import.meta.url),'utf8'));
async function resource(path) {
  const item=manifest.resources[path];
  return item.file ? readFile(new URL(`../fixtures/${item.file}`,import.meta.url)) : Buffer.from(item.body);
}

test('单句保留词面范围与节点',()=>{
  const result=inspect(primary);assert.equal(result.rows[0].id,'1-2');assert.equal(result.rows[1].form,'ca');
});
test('多个空节点及同号分片确实存在',async()=>{
  const text=(await resource('/corpus/part-a')).toString();assert.match(text,/3\.10\t/);
  const part=(await resource('/corpus/part-b')).toString();assert.match(part,/# sent_id = s1/);
  assert.match(part,/# newdoc id = doc-b/);
});
test('坏列数不被补齐',()=>{
  assert.throws(()=>inspect(Buffer.from('1\ta\tb')));assert.throws(()=>inspect(Buffer.from('# only comment')));
});
