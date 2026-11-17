import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

function nowIso() {
  return new Date().toISOString();
}

function emptyCorpus() {
  // Shard ids come from a source manifest. A null-prototype map keeps ids such
  // as `__proto__` or `constructor` from mutating the index.
  return { version: 1, releases: [], shards: Object.create(null) };
}

/** Read one shard record from a corpus state, ignoring prototype keys. */
function shardOf(state, id) {
  return Object.hasOwn(state.shards, id) ? state.shards[id] : undefined;
}

function documentSummary(sentences) {
  const documents = new Map();
  for (const sentence of sentences) {
    const key = `${sentence.identity?.doc_index ?? 0}`;
    if (!documents.has(key)) {
      documents.set(key, {
        doc: sentence.identity?.doc ?? null,
        doc_index: sentence.identity?.doc_index ?? 0,
        sentences: 0,
        positions: [],
      });
    }
    const document = documents.get(key);
    document.sentences += 1;
    document.positions.push(sentence.position);
  }
  return [...documents.values()];
}

function publicRecord(record) {
  return {
    id: record.id,
    path: record.path,
    revision: record.revision,
    digest: record.digest,
    object: record.object,
    payload: record.payload,
    edition: record.edition ?? null,
    acquired_at: record.acquired_at,
    documents: record.documents,
    counts: record.counts,
  };
}

/**
 * Persistent intake directory. Raw objects are content addressed exactly as
 * before. Shard payloads live beside them, with their own index, so the
 * compatibility `/records` shape is unchanged while shard claims share the
 * same directory and object storage.
 *
 * Shard identity is the release file id. Sentence identity inside a payload is
 * the source position, never `sent_id`. A newer revision of the same shard id
 * replaces that shard's payload as one unit; sentences in any other shard are
 * untouched even when their `sent_id` happens to match.
 */
export class Store {
  constructor(directory) {
    this.directory = directory;
    this.pending = Promise.resolve();
  }
  async initialize() {
    await mkdir(join(this.directory, 'objects'), { recursive: true });
    await mkdir(join(this.directory, 'shards'), { recursive: true });
    try { await this.list(); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.saveIndex([]);
    }
    try { await this.corpusState(); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.saveCorpus(emptyCorpus());
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
  async accept(bytes, source, parsed) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    const operation = this.pending.then(async () => {
      const records = await this.list();
      const existing = records.find(record => record.digest === digest && record.source === source);
      if (existing) return existing;
      await writeFile(join(this.directory, 'objects', digest), bytes);
      const record = { id: randomUUID(), digest, source, bytes: bytes.length, parsed };
      records.push(record);
      await this.saveIndex(records);
      return record;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async object(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid_digest');
    return readFile(join(this.directory, 'objects', digest));
  }
  async corpusState() {
    const state = JSON.parse(await readFile(join(this.directory, 'corpus.json'), 'utf8'));
    // JSON.parse creates a normal object. Rebuild the shard map without a
    // prototype so a source-supplied id cannot reach inherited members.
    state.shards = Object.assign(Object.create(null), state.shards ?? {});
    state.releases = Array.isArray(state.releases) ? state.releases : [];
    return state;
  }
  async saveCorpus(state) {
    const temporary = join(this.directory, `corpus-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(state));
    await rename(temporary, join(this.directory, 'corpus.json'));
  }
  async writeObject(bytes) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    try {
      await readFile(join(this.directory, 'objects', digest));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await writeFile(join(this.directory, 'objects', digest), bytes);
    }
    return digest;
  }
  async writeShardPayload(payload) {
    const bytes = Buffer.from(JSON.stringify(payload));
    const digest = createHash('sha256').update(bytes).digest('hex');
    const temporary = join(this.directory, `shard-${randomUUID()}.tmp`);
    await writeFile(temporary, bytes);
    await rename(temporary, join(this.directory, 'shards', digest));
    return digest;
  }
  async readShardPayload(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid_digest');
    return JSON.parse(await readFile(join(this.directory, 'shards', digest), 'utf8'));
  }
  async shards() {
    const state = await this.corpusState();
    return Object.values(state.shards).map(publicRecord);
  }
  async shard(id) {
    const state = await this.corpusState();
    const record = shardOf(state, id);
    if (!record) return null;
    return publicRecord(record);
  }
  async shardPayload(id) {
    const record = await this.shard(id);
    if (!record) return null;
    const payload = await this.readShardPayload(record.payload);
    return { record, payload };
  }
  /**
   * Commit one or more parsed shards as a single transaction.
   *
   * Entries are validated against the current state first. Any stale revision
   * aborts the whole batch before a payload or index write happens, so a
   * release claim never leaves a partial set behind.
   */
  async commitShards(entries, release = null) {
    for (const entry of entries) {
      if (typeof entry?.id !== 'string' || entry.id === '' || entry.id.includes('\u0000') ||
          entry.id.includes('/') || entry.id.includes('\\')) {
        throw new Error('invalid_shard_id');
      }
      if (typeof entry.path !== 'string' || entry.path === '') throw new Error('invalid_shard_path');
      if (!Number.isInteger(entry.revision) || entry.revision < 0) throw new Error('invalid_revision');
      if (!Buffer.isBuffer(entry.bytes)) throw new Error('shard_bytes_required');
      if (!entry.parsed || !Array.isArray(entry.parsed.sentences)) throw new Error('shard_parse_required');
    }
    const operation = this.pending.then(async () => {
      const state = await this.corpusState();
      const batchIds = new Set();
      for (const entry of entries) {
        if (batchIds.has(entry.id)) throw new Error('duplicate_shard_id');
        batchIds.add(entry.id);
        const existing = shardOf(state, entry.id);
        if (existing && entry.revision < existing.revision) {
          throw new Error(`stale_revision:${entry.id}`);
        }
      }

      const results = [];
      let changed = false;
      for (const entry of entries) {
        const existing = shardOf(state, entry.id);
        const rawDigest = createHash('sha256').update(entry.bytes).digest('hex');
        if (existing && entry.revision === existing.revision) {
          // Same revision re-claim is idempotent. If the bytes or path
          // contradict the revision contract, keep the already accepted
          // source and report the conflict rather than silently replacing it.
          let conflict = null;
          if (existing.digest !== rawDigest) conflict = 'revision_content_changed';
          else if (existing.path !== entry.path) conflict = 'revision_path_changed';
          results.push({ ...publicRecord(existing), status: 'unchanged', conflict });
          continue;
        }

        const objectDigest = await this.writeObject(entry.bytes);
        const acquiredAt = nowIso();
        const payload = {
          version: 1,
          shard: entry.id,
          source: {
            id: entry.id,
            path: entry.path,
            revision: entry.revision,
            digest: rawDigest,
            object: objectDigest,
            edition: release?.edition ?? entry.edition ?? null,
            release: release?.path ?? null,
            acquired_at: acquiredAt,
          },
          sentences: entry.parsed.sentences,
          issues: entry.parsed.issues,
          counts: entry.parsed.counts,
        };
        const payloadDigest = await this.writeShardPayload(payload);
        const record = {
          id: entry.id,
          path: entry.path,
          revision: entry.revision,
          digest: rawDigest,
          object: objectDigest,
          payload: payloadDigest,
          edition: payload.source.edition,
          acquired_at: acquiredAt,
          documents: documentSummary(entry.parsed.sentences),
          counts: entry.parsed.counts,
          issues: entry.parsed.issues.length,
        };
        state.shards[entry.id] = record;
        changed = true;
        results.push({ ...publicRecord(record), status: existing ? 'replaced' : 'created', conflict: null });
      }

      if (release) {
        const files = entries.map(entry => ({ id: entry.id, revision: entry.revision }));
        const unchanged = state.releases.find(item =>
          item.digest === release.digest && (item.edition ?? null) === (release.edition ?? null));
        if (unchanged) {
          // Same manifest bytes: refresh nothing, but keep the files that this
          // claim actually resolved so a re-claim stays consistent.
          if (JSON.stringify(unchanged.files) !== JSON.stringify(files)) {
            unchanged.files = files;
            unchanged.acquired_at = nowIso();
            changed = true;
          }
        } else {
          state.releases.push({
            path: release.path,
            edition: release.edition ?? null,
            digest: release.digest,
            acquired_at: nowIso(),
            files,
          });
          changed = true;
        }
      }
      if (changed) await this.saveCorpus(state);
      return { shards: results, state };
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  /** All sentences in claim order, each carrying its shard provenance. */
  async sentences() {
    const state = await this.corpusState();
    const output = [];
    for (const record of Object.values(state.shards)) {
      const payload = await this.readShardPayload(record.payload);
      for (const sentence of payload.sentences) {
        output.push({ shard: publicRecord(record), sentence });
      }
    }
    return output;
  }
  async findSentence(shardId, position) {
    const found = await this.shardPayload(shardId);
    if (!found) return null;
    const sentence = found.payload.sentences.find(item => item.position === position);
    if (!sentence) return null;
    return { ...found, sentence };
  }
}
