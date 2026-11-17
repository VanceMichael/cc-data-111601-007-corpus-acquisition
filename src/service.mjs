import http from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { acquire } from './transport.mjs';
import { inspect } from './reader.mjs';
import { parseShard, sentenceKey } from './corpus.mjs';

const MAX_BODY = 16384;
const MAX_RELEASE_BYTES = 1024 * 1024;

function createDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readJson(request, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

function releaseFiles(release) {
  if (!release || typeof release !== 'object') throw new Error('release_invalid');
  if (!Array.isArray(release.files)) throw new Error('release_files_required');
  const ids = new Set();
  return release.files.map(file => {
    if (!file || typeof file !== 'object') throw new Error('release_file_invalid');
    if (typeof file.id !== 'string' || file.id === '') throw new Error('release_file_id_required');
    if (ids.has(file.id)) throw new Error('release_file_duplicate');
    ids.add(file.id);
    if (typeof file.path !== 'string' || file.path === '') throw new Error('release_file_path_required');
    if (!Number.isInteger(file.revision) || file.revision < 0) throw new Error('release_file_revision_invalid');
    return { id: file.id, path: file.path, revision: file.revision };
  });
}

function shardSummary(record) {
  return {
    id: record.id,
    path: record.path,
    revision: record.revision,
    digest: record.digest,
    object: record.object,
    edition: record.edition ?? null,
    acquired_at: record.acquired_at,
    documents: record.documents,
    counts: record.counts,
    status: record.status,
    conflict: record.conflict ?? null,
  };
}

function sentenceView(record, sentence) {
  const common = {
    shard: record.id,
    revision: record.revision,
    doc: sentence.doc ?? null,
    doc_index: sentence.identity?.doc_index ?? 0,
    position: sentence.position,
    sent_id: sentence.sent_id ?? null,
    key: sentenceKey(sentence.identity),
    layer: sentence.layer,
    relationClosed: sentence.relationClosed,
    complete: sentence.complete,
    terminated_by: sentence.terminated_by,
    errors: sentence.errors ?? [],
    warnings: sentence.warnings ?? [],
  };
  if (sentence.layer === 'isolated') {
    // An isolated sentence is reported, and its unmodified rows remain
    // inspectable through the raw layer, but it offers no display text and no
    // relation layer built from unclosed edges.
    return { ...common, raw: sentence.raw ?? null, surface: null, words: [], empties: [], basic: [], enhanced: [] };
  }
  return {
    ...common,
    comments: sentence.comments,
    surface: sentence.surface,
    spans: sentence.spans,
    words: sentence.words,
    empties: sentence.empties,
    basic: sentence.basic,
    enhanced: sentence.enhanced,
  };
}

export async function startService({ source, directory, port = 0 }) {
  const store = await new Store(directory).initialize();
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health') return response.end(JSON.stringify({ ready: true }));
      if (url.pathname === '/records' && request.method === 'GET') return response.end(JSON.stringify(await store.list()));
      if (url.pathname.startsWith('/objects/') && request.method === 'GET') {
        response.setHeader('Content-Type', 'application/octet-stream');
        return response.end(await store.object(url.pathname.slice(9)));
      }
      if (url.pathname === '/intakes' && request.method === 'POST') {
        const payload = await readJson(request, MAX_BODY);
        if (typeof payload.path !== 'string') throw new Error('path_required');
        const result = await acquire(source, payload.path);
        const parsed = inspect(result.bytes);
        const record = await store.accept(result.bytes, new URL(payload.path, source).href, parsed);
        response.statusCode = 201;
        return response.end(JSON.stringify(record));
      }

      // Claim every file in a release manifest. The manifest is fetched from
      // the configured source; each listed shard is fetched from that same
      // origin. Revision checks happen across the whole batch before commit.
      if (url.pathname === '/claims' && request.method === 'POST') {
        const payload = await readJson(request, MAX_BODY);
        if (typeof payload.path !== 'string') throw new Error('path_required');
        const manifest = await acquire(source, payload.path);
        if (manifest.bytes.length > MAX_RELEASE_BYTES) throw new Error('release_too_large');
        let release;
        try { release = JSON.parse(manifest.bytes.toString('utf8')); } catch {
          throw new Error('release_invalid');
        }
        const files = releaseFiles(release);
        if (!files.length) throw new Error('release_files_required');
        const entries = [];
        for (const file of files) {
          const fetched = await acquire(source, file.path);
          const parsed = parseShard(fetched.bytes, { shard: file.id });
          entries.push({ ...file, bytes: fetched.bytes, parsed });
        }
        const result = await store.commitShards(entries, {
          path: payload.path,
          edition: release.edition ?? null,
          digest: createDigest(manifest.bytes),
        });
        response.statusCode = 201;
        return response.end(JSON.stringify({
          edition: release.edition ?? null,
          shards: result.shards.map(shardSummary),
        }));
      }

      if (url.pathname === '/shards' && request.method === 'GET') {
        return response.end(JSON.stringify(await store.shards()));
      }

      if (url.pathname === '/sentences' && request.method === 'GET') {
        const shardFilter = url.searchParams.get('shard');
        const documentFilter = url.searchParams.get('doc');
        const entries = await store.sentences();
        const output = [];
        for (const { shard, sentence } of entries) {
          if (shardFilter !== null && shard.id !== shardFilter) continue;
          if (documentFilter !== null && (sentence.identity?.doc ?? null) !== documentFilter) continue;
          output.push(sentenceView(shard, sentence));
        }
        return response.end(JSON.stringify(output));
      }

      if (url.pathname.startsWith('/sentences/') && request.method === 'GET') {
        // Split the path before decoding so an encoded slash inside a shard id
        // cannot be mistaken for the separator.
        const rest = url.pathname.slice('/sentences/'.length);
        const slash = rest.lastIndexOf('/');
        if (slash <= 0) {
          response.statusCode = 404;
          return response.end(JSON.stringify({ error: 'sentence_not_found' }));
        }
        let shardId; let position;
        try {
          shardId = decodeURIComponent(rest.slice(0, slash));
          position = decodeURIComponent(rest.slice(slash + 1));
        } catch {
          response.statusCode = 404;
          return response.end(JSON.stringify({ error: 'sentence_not_found' }));
        }
        if (!/^s\d+$/.test(position)) {
          response.statusCode = 404;
          return response.end(JSON.stringify({ error: 'sentence_not_found' }));
        }
        const found = await store.findSentence(shardId, position);
        if (!found) {
          response.statusCode = 404;
          return response.end(JSON.stringify({ error: 'sentence_not_found' }));
        }
        return response.end(JSON.stringify(sentenceView(found.record, found.sentence)));
      }

      response.writeHead(404); response.end(JSON.stringify({ error: 'not_found' }));
    } catch (error) { response.statusCode = 422; response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { server, store, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)) };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.SOURCE_URL) throw new Error('SOURCE_URL_required');
  const service = await startService({ source: process.env.SOURCE_URL,
    directory: process.env.DATA_DIR ?? './data', port: Number(process.env.PORT ?? 4102) });
  console.log(JSON.stringify({ product: service.url }));
}
