const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const html = fs.readFileSync(new URL("../index.html", `file://${__filename}`), "utf8");
const match = html.match(/function parseHeartRate\(value\) \{[\s\S]*?\n    \}/);
assert.ok(match, "parseHeartRate must exist in index.html");
const parseHeartRate = vm.runInNewContext("(" + match[0] + ")");

const bytes = Uint8Array.from([0x19, 0x3c, 0x00, 0x34, 0x12, 0x00, 0x04, 0x08, 0x04]);
const sample = parseHeartRate(new DataView(bytes.buffer));
assert.equal(sample.bpm, 60);
assert.deepEqual(Array.from(sample.rr), [1000, 1007.8125]);
assert.throws(() => parseHeartRate(new DataView(Uint8Array.from([0x11, 70]).buffer)), RangeError);
