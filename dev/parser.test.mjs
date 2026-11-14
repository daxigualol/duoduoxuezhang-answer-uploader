import fs from 'node:fs';

const src = fs.readFileSync(new URL('../answer-uploader.user.js', import.meta.url), 'utf8');
const start = src.indexOf('/* @testable:start */');
const end = src.indexOf('/* @testable:end */');
if (start < 0 || end < 0) throw new Error('testable markers not found');
const block = src.slice(start, end);
const api = new Function(block + '\nreturn { parseAnswerText, lettersOf, normalizeText, keyToOption };')();

const { parseAnswerText, lettersOf, keyToOption } = api;

let failed = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    console.log('PASS ' + name);
  } else {
    failed++;
    console.log('FAIL ' + name + '\n  got     ' + a + '\n  expected ' + b);
  }
}

const norm = (m) => {
  const o = {};
  Object.keys(m).map(Number).sort((x, y) => x - y).forEach((k) => { o[k] = m[k]; });
  return o;
};

eq('lines', norm(parseAnswerText('1.A\n2.B\n3.ABC', 1, 100)), { 1: 'A', 2: 'B', 3: 'ABC' });
eq('mixed separators', norm(parseAnswerText('1、ab 2 B 3:ABC', 1, 100)), { 1: 'AB', 2: 'B', 3: 'ABC' });
eq('unordered input', norm(parseAnswerText('5.D 2.C 1.A', 1, 100)), { 1: 'A', 2: 'C', 5: 'D' });
eq('no numbers / sequential', norm(parseAnswerText('A B AB C', 5, 100)), { 5: 'A', 6: 'B', 7: 'AB', 8: 'C' });
eq('fullwidth', norm(parseAnswerText('１．Ａ　２．Ｂ', 1, 100)), { 1: 'A', 2: 'B' });
eq('chinese prefix', norm(parseAnswerText('第1题 B 第2题 AC', 1, 100)), { 1: 'B', 2: 'AC' });
eq('out of range only', norm(parseAnswerText('101.A 102.B', 1, 100)), {});
eq('range clamp', norm(parseAnswerText('1.A 100.D', 1, 100)), { 1: 'A', 100: 'D' });
eq('dedupe + sort letters', norm(parseAnswerText('1.ccab', 1, 100)), { 1: 'ABC' });
eq('duplicate question last wins', norm(parseAnswerText('1.A 1.B', 1, 100)), { 1: 'B' });
eq('empty', norm(parseAnswerText('', 1, 100)), {});
eq('junk text', norm(parseAnswerText('还没做', 1, 100)), {});
eq('lettersOf keeps A-D only', lettersOf('aZbC中1'), 'ABC');

// 逐题一行、带前导零
eq('zero padded', norm(parseAnswerText('001 A\n002 B\n010 CD', 1, 100)), { 1: 'A', 2: 'B', 10: 'CD' });

// 100 题范围（81–100 多选，1–80 单选）
eq('total 100 upper bound', norm(parseAnswerText('100.D 101.A', 1, 100)), { 100: 'D' });
eq('multi range 81-100', norm(parseAnswerText('81.AB 100.CD 99.A', 1, 100)), { 81: 'AB', 100: 'CD', 99: 'A' });

// 快捷键映射
eq('keys num 1-4', ['1', '2', '3', '4'].map((k) => keyToOption(k, 'num')), ['A', 'B', 'C', 'D']);
eq('keys num ignores letters', keyToOption('a', 'num'), null);
eq('keys alpha A-D', ['a', 'B', 'c', 'D'].map((k) => keyToOption(k, 'alpha')), ['A', 'B', 'C', 'D']);
eq('keys alpha ignores digits', keyToOption('1', 'alpha'), null);
eq('keys ignores other keys', [keyToOption('m', 'num'), keyToOption('ArrowUp', 'alpha'), keyToOption('', 'num')], [null, null, null]);

console.log(failed ? '\n' + failed + ' test(s) failed' : '\nall tests passed');
process.exit(failed ? 1 : 0);
