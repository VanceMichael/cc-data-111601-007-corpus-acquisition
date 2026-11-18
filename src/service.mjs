import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { acquire } from './transport.mjs';
import { inspect } from './reader.mjs';
import { parseShard } from './shard.mjs';
import { startProvider } from './provider.mjs';

async function body(request) {
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 16384) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

async function applyRelease(source, store, path) {
  const manifestBytes = (await acquire(source, path)).bytes;
  const manifest = JSON.parse(manifestBytes.toString());
  const files = manifest?.files;
  if (!Array.isArray(files) || files.some(file => typeof file?.id !== 'string' || !file.id
    || typeof file?.path !== 'string' || !Number.isInteger(file?.revision) || file.revision < 0)
    || new Set(files.map(file => file.id)).size !== files.length) throw new Error('release_malformed');
  const release = await store.saveObject(manifestBytes);
  const fetched = [];
  for (const file of files) {
    const result = await acquire(source, file.path);
    fetched.push({ file, bytes: result.bytes, parsed: parseShard(result.bytes) });
  }
  const applied = [];
  for (const item of fetched) {
    applied.push(await store.applyShard({ file: item.file.id, path: item.file.path,
      revision: item.file.revision, digest: await store.saveObject(item.bytes), size: item.bytes.length,
      edition: manifest.edition ?? null, release, parsed: item.parsed }));
  }
  return { edition: manifest.edition ?? null, files: applied };
}

export async function startService({ source, directory, port = 0 }) {
  const store = await new Store(directory).initialize();
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health') return response.end(JSON.stringify({ ready: true }));
      if (url.pathname === '/records' && request.method === 'GET') return response.end(JSON.stringify(await store.list()));
      if (url.pathname === '/corpus' && request.method === 'GET') {
        const corpus = await store.corpus();
        return response.end(JSON.stringify({ edition: corpus.edition, release: corpus.release, shards: corpus.shards }));
      }
      if (url.pathname === '/corpus/sentences' && request.method === 'GET') {
        const corpus = await store.corpus();
        return response.end(JSON.stringify(corpus.sentences.map(({ key, shard, document, position, sentId, text }) =>
          ({ key, shard, document, position, sentId, text }))));
      }
      if (url.pathname.startsWith('/corpus/sentences/') && request.method === 'GET') {
        const corpus = await store.corpus();
        const sentence = corpus.sentences.find(item => item.key === url.pathname.slice('/corpus/sentences/'.length));
        if (!sentence) { response.writeHead(404); return response.end(JSON.stringify({ error: 'not_found' })); }
        return response.end(JSON.stringify(sentence));
      }
      if (url.pathname === '/corpus/quarantine' && request.method === 'GET') {
        return response.end(JSON.stringify((await store.corpus()).quarantine));
      }
      if (url.pathname.startsWith('/objects/') && request.method === 'GET') {
        response.setHeader('Content-Type', 'application/octet-stream');
        return response.end(await store.object(url.pathname.slice(9)));
      }
      if (url.pathname === '/intakes' && request.method === 'POST') {
        const payload = JSON.parse(await body(request));
        if (typeof payload.path !== 'string') throw new Error('path_required');
        const result = await acquire(source, payload.path);
        const parsed = inspect(result.bytes);
        const record = await store.accept(result.bytes, new URL(payload.path, source).href, parsed);
        response.statusCode = 201;
        return response.end(JSON.stringify(record));
      }
      if (url.pathname === '/releases' && request.method === 'POST') {
        const text = await body(request);
        const payload = text.trim() ? JSON.parse(text) : {};
        let path = payload.path;
        if (path === undefined) path = JSON.parse((await acquire(source, '/catalog')).bytes.toString()).entry;
        if (typeof path !== 'string') throw new Error('release_entry_missing');
        response.statusCode = 201;
        return response.end(JSON.stringify(await applyRelease(source, store, path)));
      }
      response.writeHead(404); response.end(JSON.stringify({ error: 'not_found' }));
    } catch (error) { response.statusCode = 422; response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { server, store, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)) };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const provider = process.env.SOURCE_URL ? null : await startProvider();
  const source = process.env.SOURCE_URL ?? provider.url;
  let service;
  try {
    service = await startService({ source, directory: process.env.DATA_DIR ?? './data',
      port: Number(process.env.PORT ?? 4102) });
  } catch (error) {
    if (provider) await provider.close();
    throw error;
  }
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await service.close();
    if (provider) await provider.close();
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  console.log(JSON.stringify({ product: service.url, source }));
}
