export function inspect(bytes) {
  const lines = bytes.toString('utf8').replace(/\r\n/g, '\n').trim().split('\n');
  const comments = []; const rows = [];
  if (!lines[0]) throw new Error('sentence_empty');
  for (const line of lines) {
    if (line.startsWith('#')) { comments.push(line.slice(1).trim()); continue; }
    const columns = line.split('\t');
    if (columns.length !== 10 || !/^\d+(?:[-.]\d+)?$/.test(columns[0])) throw new Error('conllu_columns');
    rows.push({ id: columns[0], form: columns[1], lemma: columns[2], upos: columns[3],
      xpos: columns[4], feats: columns[5], head: columns[6], relation: columns[7], deps: columns[8], misc: columns[9] });
  }
  if (!rows.length) throw new Error('sentence_rows_missing');
  return { kind: 'conllu-sentence', comments, rows };
}
