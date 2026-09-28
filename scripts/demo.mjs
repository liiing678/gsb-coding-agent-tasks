import { createTable, parsePrefix } from '../lib/cidrroute.js';

const line = (label, value) => console.log(`  ${label} ${value}`);
const hit = (result) => (result ? `${result.prefix} -> ${JSON.stringify(result.value)}` : 'null');

console.log('cidrroute demo');

const office = parsePrefix('10.1.0.0/16');
line('parsed', `${office.text} bits=${office.bits}`);
line('parsed6', parsePrefix('2001:0DB8:0000::/32').text);

const table = createTable();
table.insert('10.0.0.0/8', { via: 'backbone' });
table.insert('10.1.0.0/16', { via: 'office' });
table.insert('10.1.4.0/22', { via: 'lab' });
table.insert('192.168.0.0/16', { via: 'home' });
table.insert('2001:db8::/32', { via: 'dc6' });

line('lookup 10.1.4.9', hit(table.lookup('10.1.4.9')));
line('lookup 10.1.9.9', hit(table.lookup('10.1.9.9')));
line('lookup 10.9.9.9', hit(table.lookup('10.9.9.9')));
line('lookup 172.16.0.1', hit(table.lookup('172.16.0.1')));
line('lookup 2001:db8:1::1', hit(table.lookup('2001:db8:1::1')));
line('exact /16', hit(table.exact('10.1.0.0/16')));
line('exact /12', String(table.exact('10.1.0.0/12')));
line('entries', JSON.stringify(table.entries().map((row) => row.prefix)));
line('size', String(table.size()));

line('remove /22', String(table.remove('10.1.4.0/22')));
line('lookup 10.1.4.9 again', hit(table.lookup('10.1.4.9')));
line('remove /22 again', String(table.remove('10.1.4.0/22')));

const agg = createTable();
agg.insert('10.0.0.0/10', { via: 'east' });
agg.insert('10.64.0.0/10', { via: 'east' });
agg.insert('10.128.0.0/10', { via: 'west' });
agg.insert('10.192.0.0/10', { via: 'west' });
line('beforeAggregate', JSON.stringify(agg.entries().map((row) => row.prefix)));
line('aggregate', String(agg.aggregate()));
line('afterAggregate', JSON.stringify(agg.entries().map((row) => row.prefix)));
line('aggLookup 10.200.1.1', hit(agg.lookup('10.200.1.1')));
