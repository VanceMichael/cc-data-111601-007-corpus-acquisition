import { createHash } from 'node:crypto';

const SPACE_AFTER_NO = /(?:^|\|)SpaceAfter=No(?:$|\|)/;
const INTEGER = /^([1-9]\d*)$/;
const RANGE = /^([1-9]\d*)-([1-9]\d*)$/;
const DECIMAL = /^([1-9]\d*)\.(\d+)$/;

function issueOf(code, line, extra = {}) {
  return { code, line, ...extra };
}

/**
 * Parse a CoNLL-U identifier without ever converting a decimal identifier to a
 * float. `3.10` and `3.1` are distinct nodes; their major/minor parts stay as
 * BigInt so equality and ordering are exact.
 */
export function parseId(value) {
  if (typeof value !== 'string') throw new Error('invalid_id');
  if (value === '0') return { kind: 'root', raw: value, key: '0' };
  let match = INTEGER.exec(value);
  if (match) {
    const major = BigInt(match[1]);
    return { kind: 'word', raw: value, key: major.toString(), major };
  }
  match = RANGE.exec(value);
  if (match) {
    const start = BigInt(match[1]);
    const end = BigInt(match[2]);
    if (start >= end) throw new Error('invalid_range');
    return { kind: 'range', raw: value, key: value, start, end };
  }
  match = DECIMAL.exec(value);
  if (match) {
    const major = BigInt(match[1]);
    const minor = BigInt(match[2]);
    // Keep the literal minor spelling in the key. `3.10` and `3.1` are
    // different nodes, and a decimal is never compared through a float.
    return {
      kind: 'empty',
      raw: value,
      key: `${major.toString()}.${match[2]}`,
      major,
      minor,
      minorText: match[2],
    };
  }
  throw new Error('invalid_id');
}

/** Order word and empty identifiers by their exact integer components. */
export function compareIds(left, right) {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.kind === 'empty' && right.kind === 'empty') {
    if (left.minor === right.minor) return 0;
    return left.minor < right.minor ? -1 : 1;
  }
  if (left.kind === right.kind) return 0;
  return left.kind === 'empty' ? 1 : -1;
}

/**
 * Split one metadata comment into a name and a value. CoNLL-U uses both
 * `# name = value` and `# name value` spellings. Unknown comments are retained
 * rather than treated as absent.
 */
export function parseComment(line) {
  const raw = line.replace(/\r$/, '');
  const body = raw.slice(1).trim();
  if (!body) return null;
  const equals = body.indexOf('=');
  if (equals !== -1) {
    return { raw, name: body.slice(0, equals).trim(), value: body.slice(equals + 1).trim() };
  }
  const space = body.search(/\s/);
  if (space === -1) return { raw, name: body, value: '' };
  return { raw, name: body.slice(0, space), value: body.slice(space + 1).trim() };
}

function asField(value) {
  return value === '' ? '_' : value;
}

function decodeNode(columns, id) {
  return {
    id: id.raw,
    form: asField(columns[1]),
    lemma: asField(columns[2]),
    upos: asField(columns[3]),
    xpos: asField(columns[4]),
    feats: asField(columns[5]),
    head: asField(columns[6]),
    relation: asField(columns[7]),
    deps: asField(columns[8]),
    misc: asField(columns[9]),
  };
}

function edgeParts(edge) {
  const colon = edge.indexOf(':');
  if (colon <= 0) return null;
  const relation = edge.slice(colon + 1);
  if (!relation) return null;
  let node;
  try { node = parseId(edge.slice(0, colon)); } catch { return null; }
  if (node.kind === 'range') return null;
  return { node, relation };
}

/**
 * Verify that every basic HEAD and enhanced dependency resolves inside the
 * same sentence, and that range forms cover real word nodes. A sentence that
 * fails closure is isolated; it is never repaired by inventing nodes.
 */
export function validateSentence(sentence) {
  const errors = [];
  const warnings = [];
  const words = new Map();
  const empties = new Map();
  for (const word of sentence.words) {
    if (words.has(word.id)) errors.push({ code: 'duplicate_word_id', id: word.id });
    words.set(word.id, word);
  }
  for (const empty of sentence.empties) {
    if (empties.has(empty.id)) errors.push({ code: 'duplicate_empty_id', id: empty.id });
    empties.set(empty.id, empty);
  }

  const spanOwners = new Map();
  for (const span of sentence.spans) {
    for (const id of span.words) {
      if (!words.has(id)) errors.push({ code: 'span_missing_word', id: span.id, word: id });
      if (spanOwners.has(id)) errors.push({ code: 'span_overlap', id: span.id, word: id });
      spanOwners.set(id, span.id);
    }
  }

  for (const word of sentence.words) {
    if (word.head === '_') continue;
    let headId;
    try { headId = parseId(word.head); } catch {
      errors.push({ code: 'invalid_head', id: word.id, head: word.head });
      continue;
    }
    if (headId.kind === 'range') {
      errors.push({ code: 'head_is_range', id: word.id, head: word.head });
    } else if (headId.kind === 'empty') {
      // A basic HEAD points at a word node or at the root, never at an empty
      // node. Enhanced DEPS is the layer that may address empty nodes.
      errors.push({ code: 'head_is_empty', id: word.id, head: word.head });
    } else if (headId.kind === 'word' && !words.has(headId.key)) {
      errors.push({ code: 'missing_head', id: word.id, head: word.head });
    }
    if (word.relation === 'root' && word.head !== '0') {
      errors.push({ code: 'root_nonzero', id: word.id, head: word.head });
    }
    if (word.head === '0' && word.relation !== '_' && word.relation !== 'root') {
      errors.push({ code: 'root_relation_mismatch', id: word.id, relation: word.relation });
    }
  }

  // Empty nodes carry no basic HEAD and no basic relation; their links live
  // only in the enhanced layer.
  for (const empty of sentence.empties) {
    if (empty.head !== '_') errors.push({ code: 'empty_head_present', id: empty.id, head: empty.head });
    if (empty.relation !== '_') {
      errors.push({ code: 'empty_relation_present', id: empty.id, relation: empty.relation });
    }
  }

  const nodes = [...sentence.words, ...sentence.empties];
  for (const node of nodes) {
    if (node.deps === '_') continue;
    for (const edge of node.deps.split('|')) {
      const parts = edgeParts(edge);
      if (!parts) {
        errors.push({ code: 'invalid_dep', id: node.id, dep: edge });
        continue;
      }
      const target = parts.node;
      if (target.kind !== 'root' && !words.has(target.key) && !empties.has(target.key)) {
        errors.push({ code: 'missing_dep_target', id: node.id, dep: edge });
      }
    }
  }

  // Basic dependencies must be closed: following HEAD pointers from any word
  // must reach the root without revisiting a node or leaving the sentence.
  // Colour mark (0 unseen, 1 on path, 2 finished) keeps this linear.
  const headColor = new Map();
  for (const word of words.values()) {
    if (headColor.get(word.id) === 2) continue;
    const path = [];
    let cursor = word;
    while (cursor) {
      const color = headColor.get(cursor.id);
      if (color === 1) { errors.push({ code: 'head_cycle', id: cursor.id }); break; }
      if (color === 2) break;
      headColor.set(cursor.id, 1);
      path.push(cursor.id);
      if (cursor.head === '_' || cursor.head === '0') break;
      let next;
      try { next = parseId(cursor.head); } catch { break; }
      if (next.kind !== 'word') break;
      cursor = words.get(next.key);
    }
    for (const id of path) headColor.set(id, 2);
  }

  const basic = [];
  for (const word of sentence.words) {
    if (word.head === '_' || word.relation === '_') continue;
    let headId;
    try { headId = parseId(word.head); } catch { continue; }
    if (headId.kind !== 'root' && headId.kind !== 'word') continue;
    basic.push({ from: headId.key, to: word.id, relation: word.relation });
  }
  const enhanced = [];
  for (const node of nodes) {
    if (node.deps === '_') continue;
    for (const edge of node.deps.split('|')) {
      const parts = edgeParts(edge);
      if (!parts) continue;
      enhanced.push({ from: parts.node.key, to: node.id, relation: parts.relation });
    }
  }
  // Enhanced relations are their own graph. A cycle there is just as
  // unclosed as a dangling target; report it without touching the other
  // sentences of the shard.
  const outgoing = new Map();
  for (const edge of enhanced) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge.to);
  }
  // Iterative depth-first search avoids a deep recursion on long chains.
  const color = new Map();
  let enhancedCycle = false;
  for (const start of outgoing.keys()) {
    if (color.get(start) === 2) continue;
    const stack = [{ node: start, next: 0 }];
    while (stack.length && !enhancedCycle) {
      const frame = stack[stack.length - 1];
      if (frame.next === 0) {
        const state = color.get(frame.node);
        if (state === 1) { enhancedCycle = true; break; }
        if (state === 2) { stack.pop(); continue; }
        color.set(frame.node, 1);
      }
      const neighbours = outgoing.get(frame.node) ?? [];
      if (frame.next < neighbours.length) {
        const next = neighbours[frame.next];
        frame.next += 1;
        const state = color.get(next);
        if (state === 1) { enhancedCycle = true; break; }
        if (state !== 2) stack.push({ node: next, next: 0 });
      } else {
        color.set(frame.node, 2);
        stack.pop();
      }
    }
    if (enhancedCycle) break;
  }
  if (enhancedCycle) errors.push({ code: 'enhanced_cycle' });
  return { errors, warnings, basic, enhanced };
}

/**
 * Build display text from range forms plus uncovered word forms. Empty nodes
 * never contribute to the surface string. `SpaceAfter=No` on a range or word
 * prevents the separator that would otherwise follow it.
 */
export function buildSurface(words, spans) {
  const segments = [];
  const covered = new Set();
  for (const span of spans) {
    for (const id of span.words) covered.add(id);
    segments.push({
      kind: 'span',
      id: span.id,
      form: span.form,
      spaceAfterNo: SPACE_AFTER_NO.test(span.misc),
      words: [...span.words],
    });
  }
  for (const word of words) {
    if (covered.has(word.id)) continue;
    segments.push({
      kind: 'word',
      id: word.id,
      form: word.form,
      spaceAfterNo: SPACE_AFTER_NO.test(word.misc),
      words: [word.id],
    });
  }
  segments.sort((left, right) => compareIds(
    parseId(left.kind === 'span' ? left.words[0] : left.id),
    parseId(right.kind === 'span' ? right.words[0] : right.id),
  ));
  let text = '';
  const unspaced = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    text += segment.form;
    if (segment.spaceAfterNo) unspaced.push(segment.id);
    else if (index !== segments.length - 1) text += ' ';
  }
  return {
    text,
    segments,
    unspaced,
    // Reconstructed from word and range forms, never copied from the
    // unverified `# text` comment and never from empty nodes.
    source: 'words',
  };
}

function newBlock(line, doc, docIndex) {
  return {
    startLine: line,
    rows: [],
    bad: [],
    metadata: [],
    sentId: null,
    doc,
    docIndex,
    endedByBlank: false,
  };
}

/**
 * Read one shard. Blank lines terminate sentences.
 *
 * - Each sentence keeps its own provenance: shard, document scope and position.
 * - Range forms and uncovered word forms produce the display text; empty nodes
 *   are recorded separately and are never inserted into that text.
 * - A sentence whose relations do not close is isolated on its own. Its raw
 *   rows are retained for diagnosis, but it publishes no word layer, no
 *   surface text and no relation layer.
 * - A trailing block whose last line is malformed (a truncated shard) is kept
 *   as an unfinished tail and is not confirmed. A structurally complete block
 *   that simply ends at end-of-file is accepted, since that is a normal final
 *   sentence boundary.
 *
 * @param {Buffer|string} bytes shard bytes
 * @param {{shard?: string}} options stable shard identifier
 */
export function parseShard(bytes, options = {}) {
  const text = (Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes)).replace(/^﻿/, '');
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  // A final newline is a line terminator, not by itself a blank separator.
  if (lines.length && lines[lines.length - 1] === '' && normalized.endsWith('\n')) lines.pop();

  const sentences = [];
  const issues = [];
  const shard = options.shard ?? null;
  let current = null;
  let documentId = null;
  let documentIndex = 0;
  let ordinal = 0;

  const finish = (endedByBlank, endLine) => {
    const block = current;
    current = null;
    if (!block) return;
    block.endedByBlank = endedByBlank;
    if (!block.rows.length) {
      // A block that only carries comments has no boundary of its own. A
      // block that carried only malformed rows is still recorded as an
      // isolated sentence so the failure stays locatable.
      if (block.bad.length) {
        ordinal += 1;
        const position = `s${ordinal}`;
        const errors = block.bad.map(error => ({ line: error.line, ...error }));
        sentences.push({
          identity: {
            shard,
            doc: block.doc,
            doc_index: block.docIndex,
            position,
            sent_id: block.sentId,
          },
          sent_id: block.sentId,
          doc: block.doc,
          position,
          comments: block.metadata,
          complete: false,
          terminated_by: endedByBlank ? 'blank' : 'truncated',
          layer: 'isolated',
          relationClosed: false,
          surface: { text: '', segments: [], unspaced: [], source: 'none' },
          spans: [],
          words: [],
          empties: [],
          basic: [],
          enhanced: [],
          raw: { spans: [], words: [], empties: [], bad: block.bad },
          warnings: [],
          errors,
        });
        for (const error of errors) {
          issues.push(issueOf(error.code, block.startLine,
            { severity: 'error', sent_id: block.sentId, position, ...error }));
        }
      }
      return;
    }

    ordinal += 1;
    const position = `s${ordinal}`;
    const words = [];
    const spanRecords = [];
    const empties = [];
    const errors = [...block.bad];
    for (const row of block.rows) {
      if (row.id.kind === 'word') words.push(decodeNode(row.columns, row.id));
      else if (row.id.kind === 'range') {
        const width = row.id.end - row.id.start;
        if (width > 1023n) {
          errors.push({ code: 'range_too_wide', id: row.id.raw });
          continue;
        }
        spanRecords.push({
          id: row.id.raw,
          start: row.id.start,
          end: row.id.end,
          form: asField(row.columns[1]),
          words: Array.from({ length: Number(width) + 1 }, (_, offset) =>
            (row.id.start + BigInt(offset)).toString()),
          misc: asField(row.columns[9]),
        });
      } else empties.push(decodeNode(row.columns, row.id));
    }
    words.sort((left, right) => compareIds(parseId(left.id), parseId(right.id)));
    empties.sort((left, right) => compareIds(parseId(left.id), parseId(right.id)));
    spanRecords.sort((left, right) => {
      if (left.start !== right.start) return left.start < right.start ? -1 : 1;
      return 0;
    });
    const spans = spanRecords.map(record => ({
      id: record.id,
      start: record.start.toString(),
      end: record.end.toString(),
      form: record.form,
      words: record.words,
      misc: record.misc,
    }));

    const sentIdComment = block.metadata.find(comment => comment.name === 'sent_id');
    const textComment = block.metadata.find(comment => comment.name === 'text');
    const sentId = sentIdComment ? sentIdComment.value : null;
    const identity = {
      shard,
      doc: block.doc,
      doc_index: block.docIndex,
      position,
      sent_id: sentId,
    };

    const surface = buildSurface(words, spans);
    const warnings = [];
    if (textComment && textComment.value !== surface.text) {
      warnings.push({
        code: 'text_comment_mismatch',
        expected: textComment.value,
        actual: surface.text,
      });
    }

    const base = {
      identity,
      sent_id: sentId,
      doc: block.doc,
      doc_index: block.docIndex,
      position,
      comments: block.metadata,
      spans,
      words,
      empties,
    };
    const relations = validateSentence({ ...base, surface });
    errors.push(...relations.errors);

    // A malformed final row at end-of-file means the shard was truncated
    // inside the sentence. Its boundary is uncertain, so it stays an
    // unfinished tail rather than becoming a confirmed sentence.
    const truncated = !block.endedByBlank && block.bad.length > 0;
    if (truncated) errors.push({ code: 'incomplete_sentence' });

    const relationClosed = errors.length === 0;
    const sentence = {
      ...base,
      position,
      complete: !truncated,
      terminated_by: block.endedByBlank ? 'blank' : truncated ? 'truncated' : 'eof',
      layer: relationClosed ? 'sentence' : 'isolated',
      relationClosed,
      surface,
      basic: relations.basic,
      enhanced: relations.enhanced,
      warnings: warnings.map(warning => ({ line: block.startLine, ...warning })),
      errors: errors.map(error => ({ line: block.startLine, ...error })),
    };
    if (!relationClosed) {
      // Keep the raw rows for diagnosis; publish no displayable layer.
      sentence.raw = { spans, words, empties };
      sentence.spans = [];
      sentence.words = [];
      sentence.empties = [];
      sentence.surface = { text: '', segments: [], unspaced: [], source: 'none' };
      sentence.basic = [];
      sentence.enhanced = [];
    }
    sentences.push(sentence);
    for (const warning of warnings) {
      issues.push(issueOf(warning.code, block.startLine,
        { severity: 'warning', sent_id: sentId, position, ...warning }));
    }
    for (const error of errors) {
      issues.push(issueOf(error.code, block.startLine,
        { severity: 'error', sent_id: sentId, position, ...error }));
    }
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const lineNumber = lineIndex + 1;
    const line = lines[lineIndex];
    if (line === '') { finish(true, lineNumber); continue; }
    if (line.startsWith('#')) {
      if (!current) current = newBlock(lineNumber, documentId, documentIndex);
      const comment = parseComment(line);
      if (comment) {
        // `# newdoc id = d` parses as name `newdoc id`; the space-separated
        // spelling `# newdoc id d` parses as name `newdoc` and value `id d`.
        const isNewdoc = comment.name === 'newdoc id' || comment.name === 'newdoc';
        if (isNewdoc) {
          const value = comment.name === 'newdoc' && comment.value.startsWith('id ')
            ? comment.value.slice(3).trim()
            : comment.value;
          documentId = value || null;
          documentIndex += 1;
          current.doc = documentId;
          current.docIndex = documentIndex;
        }
        if (comment.name === 'sent_id') current.sentId = comment.value;
        current.metadata.push(comment);
      }
      continue;
    }
    const columns = line.split('\t');
    if (!current) current = newBlock(lineNumber, documentId, documentIndex);
    if (columns.length !== 10) {
      current.bad.push({ code: 'bad_columns', line: lineNumber, columns: columns.length });
      continue;
    }
    let id;
    try { id = parseId(columns[0]); } catch (error) {
      current.bad.push({ code: 'bad_id', line: lineNumber, value: columns[0], message: error.message });
      continue;
    }
    current.rows.push({ line: lineNumber, columns, id });
  }
  if (current) finish(false, lines.length || 1);

  const published = sentences.filter(sentence => sentence.relationClosed).length;
  return {
    shard,
    digest: createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'),
    sentences,
    issues,
    counts: {
      total: sentences.length,
      published,
      isolated: sentences.length - published,
    },
  };
}

/**
 * Stable provenance key. `sent_id` is only a source label: uniqueness is the
 * release shard plus the sentence position inside that shard. Two files that
 * both use `sent_id = s1` therefore never collide, and a revised shard can
 * replace exactly its own earlier sentences.
 */
export function sentenceKey(identity) {
  const shard = identity?.shard;
  const position = identity?.position;
  if (typeof shard !== 'string' || shard === '' || typeof position !== 'string' || position === '') {
    throw new Error('identity_incomplete');
  }
  return `${shard}\u0000${position}`;
}
