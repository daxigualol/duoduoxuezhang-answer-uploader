import fs from 'node:fs';

const s = fs.readFileSync(new URL('../answer-uploader.user.js', import.meta.url), 'utf8');
const ids = new Set([...s.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
const used = new Set([...s.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]));

const missing = [...used].filter((x) => !ids.has(x));
const unused = [...ids].filter((x) => !used.has(x) && x !== 'ddsx-ba-host');

console.log('ids in template :', [...ids].sort().join(', '));
console.log('missing (used by $ but not in template):', missing.length ? missing.join(', ') : 'none');
console.log('never queried   :', unused.length ? unused.join(', ') : 'none');

// 检查 TEMPLATE 内是否残留未闭合的常见标签（粗查）
const tplStart = s.indexOf('const TEMPLATE = `');
const tplEnd = s.indexOf('`;', tplStart);
const tpl = s.slice(tplStart, tplEnd);
for (const tag of ['section', 'header', 'nav', 'div', 'footer', 'button']) {
  const open = (tpl.match(new RegExp('<' + tag + '\\b', 'g')) || []).length;
  const close = (tpl.match(new RegExp('</' + tag + '>', 'g')) || []).length;
  if (open !== close) console.log('TAG MISMATCH <' + tag + '>: open=' + open + ' close=' + close);
}
console.log('template tag balance check done (self-closing button/img expected to match)');

process.exit(missing.length ? 1 : 0);
