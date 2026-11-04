// Returns { before, after } holding only the keys whose value really changed (for the audit log).
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function changes(before, after, keys) {
  const b = {};
  const a = {};
  for (const k of keys) {
    if (!same(before?.[k], after?.[k])) {
      b[k] = before?.[k] ?? null;
      a[k] = after?.[k] ?? null;
    }
  }
  return { before: b, after: a, changed: Object.keys(a).length > 0 };
}
module.exports = { changes };
