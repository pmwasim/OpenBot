function linesOf(text) {
  const value = String(text ?? '');
  if (value === '') return [];
  const lines = value.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function lcsTable(a, b) {
  const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      table[i][j] = a[i - 1] === b[j - 1]
        ? table[i - 1][j - 1] + 1
        : Math.max(table[i - 1][j], table[i][j - 1]);
    }
  }
  return table;
}

export function unifiedDiff(before, after, filename = 'file') {
  const a = linesOf(before);
  const b = linesOf(after);
  const table = lcsTable(a, b);
  const ops = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ type: ' ', line: a[i - 1] });
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || table[i][j - 1] >= table[i - 1][j])) {
      ops.push({ type: '+', line: b[j - 1] });
      j -= 1;
    } else {
      ops.push({ type: '-', line: a[i - 1] });
      i -= 1;
    }
  }
  ops.reverse();
  const header = [
    `--- a/${filename}`,
    `+++ b/${filename}`,
    `@@ -1,${a.length} +1,${b.length} @@`
  ];
  return `${header.concat(ops.map((op) => `${op.type}${op.line}`)).join('\n')}\n`;
}
