// 自平衡有序表：整数键 + 任意值，每个节点记自己的子树大小，名次查询顺着子树走。
import { AvlError } from './errors.js';

const heightOf = (node) => (node ? node.height : 0);
const sizeOf = (node) => (node ? node.size : 0);

function checkKey(key, what = '键') {
  if (!Number.isSafeInteger(key)) {
    throw new AvlError('ERR_BAD_ARGUMENT', `${what}必须是安全整数`);
  }
  return key;
}

class Node {
  constructor(key, value) {
    this.key = key;
    this.value = value;
    this.left = null;
    this.right = null;
    this.height = 1;
    this.size = 1;
  }
}

function update(node) {
  node.height = 1 + Math.max(heightOf(node.left), heightOf(node.right));
  node.size = 1 + sizeOf(node.left) + sizeOf(node.right);
  return node;
}

function rotateRight(node) {
  const top = node.left;
  node.left = top.right;
  top.right = node;
  update(node);
  update(top);
  return top;
}

function rotateLeft(node) {
  const top = node.right;
  node.right = top.left;
  top.left = node;
  update(node);
  update(top);
  return top;
}

function rebalance(node) {
  update(node);
  const factor = heightOf(node.left) - heightOf(node.right);
  if (factor > 1) {
    if (heightOf(node.left.left) < heightOf(node.left.right)) {
      node.left = rotateLeft(node.left);
    }
    return rotateRight(node);
  }
  return node;
}

export class AvlMap {
  constructor() {
    this.root = null;
    this.count = 0;
    this.touched = 0;
  }

  size() {
    return this.count;
  }

  height() {
    return heightOf(this.root);
  }

  stats() {
    return { nodes: this.count, height: this.height(), visited: this.touched };
  }

  clear() {
    this.root = null;
    this.count = 0;
    this.touched = 0;
  }

  has(key) {
    return this.#find(key, this.root) !== null;
  }

  get(key) {
    const found = this.#find(checkKey(key), this.root);
    return found === null ? undefined : found.value;
  }

  set(key, value) {
    this.root = this.#insert(this.root, checkKey(key), value);
    return this;
  }

  remove(key) {
    checkKey(key);
    const before = this.count;
    this.root = this.#remove(this.root, key);
    return this.count < before;
  }

  min() {
    if (this.root === null) return null;
    let node = this.root;
    while (node.left !== null) node = node.left;
    return [node.key, node.value];
  }

  max() {
    if (this.root === null) return null;
    let node = this.root;
    while (node.right !== null) node = node.right;
    return [node.key, node.value];
  }

  at(index) {
    if (!Number.isInteger(index)) {
      throw new AvlError('ERR_BAD_ARGUMENT', '下标必须是整数');
    }
    this.touched = 0;
    let found = null;
    let seen = 0;
    const walk = (node) => {
      if (node === null || found !== null) return;
      this.touched += 1;
      walk(node.left);
      if (found !== null) return;
      if (seen === index) {
        found = [node.key, node.value];
        return;
      }
      seen += 1;
      walk(node.right);
    };
    walk(this.root);
    return found;
  }

  indexOf(key) {
    checkKey(key);
    this.touched = 0;
    let node = this.root;
    let rank = 0;
    while (node !== null) {
      this.touched += 1;
      if (key === node.key) return rank;
      if (key < node.key) {
        node = node.left;
      } else {
        rank += sizeOf(node.left) + 1;
        node = node.right;
      }
    }
    return -1;
  }

  range(from, to) {
    checkKey(from, '区间左端');
    checkKey(to, '区间右端');
    const out = [];
    if (from > to) return out;
    const walk = (node) => {
      if (node === null) return;
      if (node.key > from) walk(node.left);
      if (node.key >= from && node.key < to) out.push([node.key, node.value]);
      if (node.key < to) walk(node.right);
    };
    walk(this.root);
    return out;
  }

  entries() {
    const out = [];
    const walk = (node) => {
      if (node === null) return;
      walk(node.left);
      out.push([node.key, node.value]);
      walk(node.right);
    };
    walk(this.root);
    return out;
  }

  #find(key, node) {
    while (node !== null) {
      if (key === node.key) return node;
      node = key < node.key ? node.left : node.right;
    }
    return null;
  }

  #insert(node, key, value) {
    if (node === null) {
      this.count += 1;
      return new Node(key, value);
    }
    if (key === node.key) {
      node.value = value;
      return node;
    }
    if (key < node.key) node.left = this.#insert(node.left, key, value);
    else node.right = this.#insert(node.right, key, value);
    return rebalance(node);
  }

  #remove(node, key) {
    if (node === null) return null;
    if (key < node.key) {
      node.left = this.#remove(node.left, key);
      return rebalance(node);
    }
    if (key > node.key) {
      node.right = this.#remove(node.right, key);
      return rebalance(node);
    }
    this.count -= 1;
    if (node.left === null) return node.right;
    if (node.right === null) return node.left;
    let successor = node.right;
    while (successor.left !== null) successor = successor.left;
    node.key = successor.key;
    node.value = successor.value;
    node.right = this.#remove(node.right, successor.key);
    return rebalance(node);
  }
}

export function createMap() {
  return new AvlMap();
}