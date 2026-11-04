// Australian Business Number (11 digits) and Company Number (9 digits) checksums.
const digits = (s) => String(s || "").replace(/[\s-]/g, "");

function validAbn(value) {
  const d = digits(value);
  if (!/^\d{11}$/.test(d)) return false;
  const w = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const n = d.split("").map(Number);
  n[0] -= 1;
  return n.reduce((sum, v, i) => sum + v * w[i], 0) % 89 === 0;
}

function validAcn(value) {
  const d = digits(value);
  if (!/^\d{9}$/.test(d)) return false;
  const n = d.split("").map(Number);
  const sum = n.slice(0, 8).reduce((s, v, i) => s + v * (8 - i), 0);
  return (10 - (sum % 10)) % 10 === n[8];
}

const validAbnOrAcn = (value) => validAbn(value) || validAcn(value);

module.exports = { validAbn, validAcn, validAbnOrAcn };
