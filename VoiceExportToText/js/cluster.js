// Speaker clustering: average-linkage agglomerative clustering (cosine distance)
// using the nearest-neighbor-chain algorithm — O(n^2) time, fine for thousands of segments.

export function l2normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const inv = s > 0 ? 1 / Math.sqrt(s) : 0;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv;
  return out;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Returns merges sorted by distance: [{ a, b, dist }] where a/b are leaf representatives. */
export function linkage(X) {
  const n = X.length;
  const merges = [];
  if (n < 2) return merges;
  const D = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = 1 - dot(X[i], X[j]);
      D[i * n + j] = d;
      D[j * n + i] = d;
    }
  }
  const size = new Float64Array(n).fill(1);
  const active = new Uint8Array(n).fill(1);
  const chain = [];
  let remaining = n;

  while (remaining > 1) {
    if (!chain.length) {
      for (let i = 0; i < n; i++) if (active[i]) { chain.push(i); break; }
    }
    const a = chain[chain.length - 1];
    const prev = chain.length > 1 ? chain[chain.length - 2] : -1;
    let b = -1;
    let best = Infinity;
    for (let k = 0; k < n; k++) {
      if (!active[k] || k === a) continue;
      const d = D[a * n + k];
      if (d < best || (d === best && k === prev)) { best = d; b = k; }
    }
    if (b === prev) {
      chain.pop(); chain.pop();
      merges.push({ a, b, dist: best });
      const sa = size[a], sb = size[b];
      for (let k = 0; k < n; k++) {
        if (!active[k] || k === a || k === b) continue;
        const nd = (sa * D[a * n + k] + sb * D[b * n + k]) / (sa + sb);
        D[a * n + k] = nd;
        D[k * n + a] = nd;
      }
      active[b] = 0;
      size[a] = sa + sb;
      remaining--;
    } else {
      chain.push(b);
    }
  }
  merges.sort((x, y) => x.dist - y.dist);
  return merges;
}

/** Cut the dendrogram either at a distance threshold or into exactly k clusters. */
export function cutTree(n, merges, { threshold = 0.6, k = null } = {}) {
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  let count = n;
  for (const m of merges) {
    const stop = k != null ? count <= k : m.dist > threshold;
    if (stop) break;
    const ra = find(m.a), rb = find(m.b);
    if (ra !== rb) { parent[rb] = ra; count--; }
  }
  const map = new Map();
  const labels = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!map.has(r)) map.set(r, map.size);
    labels[i] = map.get(r);
  }
  return { labels, count: map.size };
}

export function centroids(X, labels, count, weights) {
  const dim = X[0].length;
  const C = Array.from({ length: count }, () => new Float32Array(dim));
  for (let i = 0; i < X.length; i++) {
    const w = weights ? weights[i] : 1;
    const c = C[labels[i]];
    for (let d = 0; d < dim; d++) c[d] += X[i][d] * w;
  }
  return C.map(l2normalize);
}

export function nearest(v, C) {
  let best = -1, bestSim = -Infinity;
  for (let c = 0; c < C.length; c++) {
    const s = dot(v, C[c]);
    if (s > bestSim) { bestSim = s; best = c; }
  }
  return best;
}

/**
 * Full speaker clustering.
 * @param X normalized embeddings
 * @param durations seconds of speech behind each embedding
 * @param opts { threshold, minSpeakers, maxSpeakers }
 * @returns labels (0..K-1, ordered by first appearance index) and K
 */
export function clusterSpeakers(X, durations, { threshold = 0.6, minSpeakers = 1, maxSpeakers = 20 } = {}) {
  const n = X.length;
  if (n === 0) return { labels: new Int32Array(0), count: 0 };
  if (n === 1) return { labels: new Int32Array(1), count: 1 };
  minSpeakers = Math.max(1, Math.min(minSpeakers, n));
  maxSpeakers = Math.max(minSpeakers, Math.min(maxSpeakers, n));

  const merges = linkage(X);
  let { labels, count } = cutTree(n, merges, { threshold });
  if (count < minSpeakers || count > maxSpeakers) {
    ({ labels, count } = cutTree(n, merges, { k: Math.min(Math.max(count, minSpeakers), maxSpeakers) }));
  }

  // Absorb tiny clusters (noise / short interjections) into the nearest large cluster.
  const totalDur = durations.reduce((a, b) => a + b, 0);
  const minDur = Math.max(4, totalDur * 0.02);
  for (let guard = 0; guard < 50 && count > minSpeakers; guard++) {
    const dur = new Float64Array(count);
    for (let i = 0; i < n; i++) dur[labels[i]] += durations[i];
    let smallest = -1;
    for (let c = 0; c < count; c++) if (dur[c] < minDur && (smallest < 0 || dur[c] < dur[smallest])) smallest = c;
    if (smallest < 0) break;
    const C = centroids(X, labels, count, durations);
    const others = C.map((c, i) => (i === smallest ? null : c));
    for (let i = 0; i < n; i++) {
      if (labels[i] !== smallest) continue;
      let best = -1, bs = -Infinity;
      others.forEach((c, j) => { if (c) { const s = dot(X[i], c); if (s > bs) { bs = s; best = j; } } });
      labels[i] = best;
    }
    ({ labels, count } = relabel(labels));
  }

  // Refinement: reassign each item to its nearest centroid (fixes chaining errors).
  for (let it = 0; it < 3; it++) {
    const C = centroids(X, labels, count, durations);
    let changed = 0;
    for (let i = 0; i < n; i++) {
      const c = nearest(X[i], C);
      if (c !== labels[i]) { labels[i] = c; changed++; }
    }
    ({ labels, count } = relabel(labels));
    if (!changed) break;
  }
  return relabel(labels);
}

/** Compact labels to 0..K-1 in order of first appearance. */
export function relabel(labels) {
  const map = new Map();
  const out = new Int32Array(labels.length);
  for (let i = 0; i < labels.length; i++) {
    if (!map.has(labels[i])) map.set(labels[i], map.size);
    out[i] = map.get(labels[i]);
  }
  return { labels: out, count: map.size };
}
