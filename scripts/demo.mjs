import { resolveDeps } from '../lib/resolve.js';
import { createRegistry } from '../lib/registry.js';

const show = (out) => {
  const picked = Object.entries(out.packages)
    .map(([name, version]) => `${name}@${version}`)
    .join(' ');
  console.log(`    packages ${picked}`);
  console.log(`    order ${out.order.join(',')}`);
  console.log(
    `    stats considered=${out.stats.considered} backtracks=${out.stats.backtracks} ` +
      `constraints=${out.stats.constraints}`,
  );
};

const root = (deps) => ({ name: 'app', version: '0.0.0', deps });

console.log('solvemod demo');

console.log('[1] 直接依赖 + 依赖的依赖');
const basic = createRegistry({
  packages: {
    applib: { versions: { '1.0.0': { deps: { 'core-lib': '^1.0.0' } } } },
    'core-lib': { versions: { '1.3.0': {}, '1.4.0': {} } },
  },
});
show(resolveDeps({ registry: basic, root: root({ applib: '^1.0.0' }) }));

console.log('[2] 两个约束一起看，高的那个不满足就往下退');
const shared = createRegistry({
  packages: {
    cache: { versions: { '1.0.0': {}, '1.1.0': {}, '1.2.0': {}, '2.0.0': {} } },
    alpha: { versions: { '1.0.0': { deps: { cache: '<1.2.0' } } } },
    beta: { versions: { '1.0.0': { deps: { cache: '^1.0.0' } } } },
  },
});
show(resolveDeps({ registry: shared, root: root({ alpha: '^1.0.0', beta: '^1.0.0' }) }));

console.log('[3] 最新版是条死路，退一档再解');
const deadEnd = createRegistry({
  packages: {
    alpha: { versions: { '1.1.0': { deps: { core: '^9.0.0' } }, '1.0.0': { deps: { core: '^1.0.0' } } } },
    core: { versions: { '1.0.0': {} } },
  },
});
show(resolveDeps({ registry: deadEnd, root: root({ alpha: '^1.0.0' }) }));

console.log('[4] 钉住版本：cache 就停在 1.0.0，不去挑 1.1.0');
show(
  resolveDeps({
    registry: shared,
    root: root({ alpha: '^1.0.0', beta: '^1.0.0' }),
    pins: { cache: '1.0.0' },
  }),
);

console.log('[5] 怎么都解不出来，说清是谁卡住谁提的要求');
const clash = createRegistry({
  packages: {
    alpha: { versions: { '1.0.0': { deps: { cache: '^1.0.0' } } } },
    beta: { versions: { '2.0.0': { deps: { cache: '^3.0.0' } } } },
    cache: { versions: { '1.0.0': {}, '3.0.0': {} } },
  },
});
try {
  resolveDeps({
    registry: clash,
    root: root({ alpha: '^1.0.0', beta: '^2.0.0' }),
  });
} catch (err) {
  const chain = err.details.chain.map((item) => `${item.from} ${item.range}`).join(' / ');
  console.log(`    ${err.code} ${err.details.pkg} 卡住：${chain}`);
}
