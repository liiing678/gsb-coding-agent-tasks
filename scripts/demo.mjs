import {
  createLog, leafHash, verifyConsistency, verifyInclusion,
} from '../lib/merkletree.js';

const line = (label, value) => console.log(`  ${label} ${value}`);

console.log('merkleproof demo');

const log = createLog();
for (let i = 0; i < 6; i += 1) log.append(`event-${i}`);
line('size', String(log.size()));
line('root', log.root());
line('leaf2', log.leafAt(2));

const proof = log.inclusionProof(2);
line('inclusion2', JSON.stringify(proof.path));
line('verify', String(verifyInclusion({
  leaf: log.leafAt(2), index: 2, size: 6, path: proof.path, root: log.root(),
})));
line('verifyTampered', String(verifyInclusion({
  leaf: leafHash('event-9'), index: 2, size: 6, path: proof.path, root: log.root(),
})));

const short = createLog();
for (let i = 0; i < 4; i += 1) short.append(`event-${i}`);
const consistency = log.consistencyProof(4);
line('consistency4', JSON.stringify(consistency));
line('consistencyOk', String(verifyConsistency({
  fromSize: 4, fromRoot: short.root(), toSize: 6, toRoot: log.root(), path: consistency,
})));
line('consistencyBad', String(verifyConsistency({
  fromSize: 4, fromRoot: short.root(), toSize: 6, toRoot: short.root(), path: consistency,
})));

line('emptyRoot', createLog().root());

const big = createLog();
big.appendAll(Array.from({ length: 64 }, (_, i) => `event-${i}`));
line('bigRoot', big.root());
line('bigVerify', String(verifyInclusion({
  leaf: big.leafAt(40), index: 40, size: 64, path: big.inclusionProof(40).path, root: big.root(),
})));
