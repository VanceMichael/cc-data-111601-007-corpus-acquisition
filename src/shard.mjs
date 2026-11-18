const WORD = /^\d+$/;
const RANGE = /^(\d+)-(\d+)$/;
const EMPTY = /^(\d+)\.(\d+)$/;
const NODE = /^(\d+)(?:\.(\d+))?$/;

export function sentenceKey(shard, document, position) {
  return [shard, document ?? '', String(position)].map(part => encodeURIComponent(part)).join('/');
}

function meta(block, name) {
  for (const line of block) {
    if (!line.startsWith('#')) continue;
    const match = new RegExp(`^${name}\\s*=\\s*(.+)$`).exec(line.slice(1).trim());
    if (match) return match[1].trim();
  }
  return null;
}

const spaceAfterNo = misc => misc !== '_' && misc.split('|').includes('SpaceAfter=No');

function parseSentence(block, document, position) {
  const comments = [];
  const rows = [];
  for (const line of block) {
    if (line.startsWith('#')) { comments.push(line.slice(1).trim()); continue; }
    const columns = line.split('\t');
    if (columns.length !== 10) throw new Error('conllu_columns');
    rows.push(columns);
  }
  if (!rows.length) throw new Error('sentence_rows_missing');
  const words = new Map();
  const ranges = [];
  const empties = [];
  let lastWord = 0;
  const minors = new Map();
  for (const columns of rows) {
    const id = columns[0];
    const range = RANGE.exec(id);
    const empty = EMPTY.exec(id);
    if (WORD.test(id)) {
      const number = Number(id);
      if (words.has(number)) throw new Error('node_duplicate');
      words.set(number, { id, columns });
      lastWord = number;
    } else if (range) {
      ranges.push({ id, start: Number(range[1]), end: Number(range[2]), columns });
    } else if (empty) {
      const major = Number(empty[1]);
      const minor = Number(empty[2]);
      if (minor < 1 || lastWord !== major || (minors.get(major) ?? 0) >= minor) throw new Error('empty_placement');
      minors.set(major, minor);
      empties.push({ id, major, minor, columns });
    } else throw new Error('conllu_columns');
  }
  const covered = new Set();
  for (const item of ranges) {
    if (item.end < item.start) throw new Error('range_invalid');
    for (let number = item.start; number <= item.end; number += 1) {
      if (!words.has(number) || covered.has(number)) throw new Error('range_invalid');
      covered.add(number);
    }
  }
  const basicHead = columns => {
    const head = columns[6];
    if (head === '_') throw new Error('head_missing');
    if (!WORD.test(head) || (head !== '0' && !words.has(Number(head)))) throw new Error('dangling_head');
  };
  for (const { columns } of words.values()) basicHead(columns);
  for (const { columns } of empties) {
    if (columns[6] !== '_') basicHead(columns);
  }
  const known = new Set([...words.keys()].map(String));
  for (const { major, minor } of empties) known.add(`${major}.${minor}`);
  const edges = [];
  for (const { id, columns } of [...words.values(), ...empties]) {
    const deps = columns[8];
    if (deps === '_') continue;
    for (const item of deps.split('|')) {
      const colon = item.indexOf(':');
      const head = colon < 0 ? '' : item.slice(0, colon);
      const relation = colon < 0 ? '' : item.slice(colon + 1);
      if (!head || !relation) throw new Error('deps_malformed');
      if (head !== '0') {
        const node = NODE.exec(head);
        const key = node && (node[2] === undefined ? String(Number(node[1])) : `${Number(node[1])}.${Number(node[2])}`);
        if (!node || !known.has(key)) throw new Error('dangling_deps');
      }
      edges.push({ target: id, head, relation });
    }
  }
  const tokens = [];
  for (const columns of rows) {
    const id = columns[0];
    if (WORD.test(id)) {
      if (covered.has(Number(id))) continue;
      tokens.push({ id, form: columns[1], spaceAfter: !spaceAfterNo(columns[9]) });
    } else if (RANGE.test(id)) {
      const last = words.get(Number(id.split('-')[1]));
      tokens.push({ range: id, form: columns[1],
        spaceAfter: !spaceAfterNo(columns[9]) && !spaceAfterNo(last.columns[9]) });
    }
  }
  let text = '';
  tokens.forEach((token, index) => {
    text += token.form;
    if (token.spaceAfter && index < tokens.length - 1) text += ' ';
  });
  const node = ({ id, columns }) => ({ id, form: columns[1], lemma: columns[2], upos: columns[3],
    xpos: columns[4], feats: columns[5], head: columns[6], relation: columns[7], misc: columns[9] });
  return { document, position, sentId: meta(block, 'sent_id'), comments, text, tokens,
    nodes: [...words.values()].map(node), empty: empties.map(node), edges };
}

export function parseShard(bytes) {
  const lines = bytes.toString('utf8').replace(/\r\n/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (line.trim() === '') {
      if (current.length) { blocks.push(current); current = []; }
    } else current.push(line);
  }
  const sentences = [];
  const quarantine = [];
  let document = null;
  let position = 0;
  for (const block of blocks) {
    const named = meta(block, 'newdoc id');
    if (named !== null) document = named;
    try {
      sentences.push(parseSentence(block, document, position));
    } catch (error) {
      quarantine.push({ document, position, sentId: meta(block, 'sent_id'),
        reason: error.message, raw: block.join('\n') });
    }
    position += 1;
  }
  const tail = current.length
    ? { document: meta(current, 'newdoc id') ?? document, position,
        sentId: meta(current, 'sent_id'), lines: current }
    : null;
  return { sentences, quarantine, tail };
}
