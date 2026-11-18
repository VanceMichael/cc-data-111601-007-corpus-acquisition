import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { sentenceKey } from './shard.mjs';

export class Store {
  constructor(directory) {
    this.directory = directory;
    this.pending = Promise.resolve();
  }
  async initialize() {
    await mkdir(join(this.directory, 'objects'), { recursive: true });
    try { await this.list(); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.saveIndex([]);
    }
    try { await this.corpus(); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.saveCorpus({ edition: null, release: null, shards: [], sentences: [], quarantine: [] });
    }
    return this;
  }
  async saveIndex(records) {
    const temporary = join(this.directory, `index-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(records));
    await rename(temporary, join(this.directory, 'index.json'));
  }
  async list() {
    return JSON.parse(await readFile(join(this.directory, 'index.json'), 'utf8'));
  }
  async corpus() {
    return JSON.parse(await readFile(join(this.directory, 'corpus.json'), 'utf8'));
  }
  async saveCorpus(corpus) {
    const temporary = join(this.directory, `corpus-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(corpus));
    await rename(temporary, join(this.directory, 'corpus.json'));
  }
  async saveObject(bytes) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(this.directory, 'objects', digest), bytes);
    return digest;
  }
  async accept(bytes, source, parsed) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    const operation = this.pending.then(async () => {
      const records = await this.list();
      const existing = records.find(record => record.digest === digest && record.source === source);
      if (existing) return existing;
      await this.saveObject(bytes);
      const record = { id: randomUUID(), digest, source, bytes: bytes.length, parsed };
      records.push(record);
      await this.saveIndex(records);
      return record;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async applyShard({ file, path, revision, digest, size, edition, release, parsed }) {
    const operation = this.pending.then(async () => {
      const corpus = await this.corpus();
      const existing = corpus.shards.find(shard => shard.file === file);
      if (existing && existing.revision === revision) {
        return { file, revision, status: 'unchanged', sentences: existing.sentences,
          quarantined: existing.quarantined, tail: existing.tail !== null };
      }
      corpus.sentences = corpus.sentences.filter(sentence => sentence.shard !== file);
      corpus.quarantine = corpus.quarantine.filter(item => item.shard !== file);
      for (const sentence of parsed.sentences) {
        corpus.sentences.push({ key: sentenceKey(file, sentence.document, sentence.position),
          shard: file, revision, ...sentence });
      }
      for (const item of parsed.quarantine) corpus.quarantine.push({ shard: file, revision, ...item });
      const entry = { file, path, revision, digest, bytes: size, received: new Date().toISOString(),
        sentences: parsed.sentences.length, quarantined: parsed.quarantine.length, tail: parsed.tail };
      corpus.shards = [...corpus.shards.filter(shard => shard.file !== file), entry];
      corpus.edition = edition;
      corpus.release = release;
      await this.saveCorpus(corpus);
      return { file, revision, status: existing ? 'replaced' : 'received', sentences: entry.sentences,
        quarantined: entry.quarantined, tail: entry.tail !== null };
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async object(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid_digest');
    return readFile(join(this.directory, 'objects', digest));
  }
}
