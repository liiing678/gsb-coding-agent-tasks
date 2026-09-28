import { createBuffer } from '../lib/pagetable.js';

const line = (label, value) => console.log(`  ${label} ${value}`);
const thrown = (fn) => {
  try {
    fn();
    return 'nothing';
  } catch (err) {
    return err.code ?? err.message;
  }
};

console.log('pagetable demo');

const buf = createBuffer('one\ntwo\n');
line('initial', JSON.stringify({ text: buf.text(), length: buf.length(), lines: buf.lineCount() }));
buf.insert(3, '!');
line('afterInsert', JSON.stringify({ text: buf.text(), pieces: buf.stats().pieces }));
buf.insert(0, '#');
line('addLength', String(buf.stats().addLength));
buf.delete(0, 1);
line('afterDeletePieces', String(buf.stats().pieces));
line('slice', JSON.stringify(buf.slice(4, 3)));
line('positionAt 4', JSON.stringify(buf.positionAt(4)));
line('offsetAt 1,2', String(buf.offsetAt(1, 2)));
line('lineAt 1', JSON.stringify(buf.lineAt(1)));
line('undo', String(buf.undo()));
line('afterUndo', JSON.stringify({
  text: buf.text(), pieces: buf.stats().pieces, addLength: buf.stats().addLength,
}));
line('redo', String(buf.redo()));
line('afterRedo', JSON.stringify(buf.text()));

const txn = createBuffer('abc');
txn.transaction(() => {
  txn.insert(3, 'd');
  txn.delete(0, 1);
});
line('transaction', JSON.stringify({ text: txn.text(), undoDepth: txn.stats().undoDepth }));
line('txnUndo', JSON.stringify((() => {
  txn.undo();
  return { text: txn.text(), undoDepth: txn.stats().undoDepth };
})()));
line('rollback', thrown(() => txn.transaction(() => {
  txn.insert(0, 'X');
  throw new Error('boom');
})));
line('afterRollback', txn.text());
line('nested', thrown(() => txn.transaction(() => txn.transaction(() => {}))));
