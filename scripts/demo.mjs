import { createMatcher, createScanner, scan } from '../lib/matchgrid.js';

const fmt = (match) => `${match.pattern}@${match.index}+${match.length}`;
const line = (label, value) => console.log(`  ${label} ${value}`);

console.log('matchgrid demo');
line('overlaps', scan(['aa'], 'aaa').matches.map(fmt).join(' '));
line('nested', scan(['a', 'aa'], 'aaa').matches.map(fmt).join(' '));
line('codepoints', scan(['😀b', '中'], 'a😀b中').matches.map(fmt).join(' '));
line('ignoreCase', scan(['Ab'], 'AB ab', { ignoreCase: true }).matches.map(fmt).join(' '));

const capped = scan(['a'], 'aaaa', { maxMatches: 2 });
line('maxMatches', `${capped.matches.map(fmt).join(' ')} truncated=${capped.truncated}`);

const matcher = createMatcher(['select', 'elect']);
line('matcher', matcher.scan('userselect').matches.map(fmt).join(' '));

const scanner = createScanner(['abc', 'c']);
line('chunk1', JSON.stringify(scanner.push('ab').map(fmt)));
line('chunk2', JSON.stringify(scanner.push('c').map(fmt)));
line('stream', JSON.stringify(scanner.state()));

const split = createScanner(['😀', 'a😀']);
split.push('a\uD83D');
line('splitPair', JSON.stringify(split.push('\uDE00').map(fmt)));

const hanging = createScanner(['abcd']);
hanging.push('xab');
line('pending', String(hanging.state().pending));
line('closed', JSON.stringify(hanging.end()));
