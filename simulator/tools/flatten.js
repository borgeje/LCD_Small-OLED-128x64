#!/usr/bin/env node
/*
 * flatten.js - inline a sketch's local #includes into a single .ino.
 *
 *   node simulator/tools/flatten.js firmware/glance/glance.ino \
 *        simulator/examples/06-glance-framework.ino
 *
 * The CLI resolves local headers on its own, so this exists for the browser,
 * which has no filesystem to resolve them against. Unlike the preprocessor's
 * own inlining it preserves comments and formatting, because the result is
 * meant to be read in the editor pane.
 *
 * Headers are include-once, matching #pragma once.
 */
"use strict";

const fs = require("fs");
const path = require("path");

function flatten(entry) {
  const seen = new Set();

  function expand(file, depth) {
    const resolved = path.resolve(file);
    if (seen.has(resolved)) return null; // already inlined
    seen.add(resolved);
    if (depth > 16) throw new Error("include nesting too deep at " + file);

    const dir = path.dirname(resolved);
    const out = [];

    for (const line of fs.readFileSync(resolved, "utf8").split("\n")) {
      // Meaningless once inlined, and noise in the editor.
      if (/^\s*#\s*pragma\s+once\s*$/.test(line)) continue;

      const m = line.match(/^\s*#\s*include\s+"([^"]+)"/);
      if (!m) {
        out.push(line);
        continue;
      }

      const target = path.resolve(dir, m[1]);
      if (!fs.existsSync(target)) {
        out.push(line); // not ours to resolve; leave it for the preprocessor
        continue;
      }

      const body = expand(target, depth + 1);
      if (body === null) continue; // seen already
      out.push("/* ===== " + m[1] + " ===== */");
      out.push(body);
      out.push("/* ===== end " + m[1] + " ===== */");
    }

    return out.join("\n");
  }

  return expand(entry, 0);
}

function main() {
  const [entry, outFile] = process.argv.slice(2);
  if (!entry) {
    console.error("usage: node simulator/tools/flatten.js <sketch.ino> [out.ino]");
    process.exit(1);
  }

  const banner = [
    "/*",
    " * GENERATED FILE, do not edit.",
    " *",
    " * " + path.relative(process.cwd(), entry) + " with its local headers inlined, so the",
    " * browser simulator can run it without a filesystem. Edit the originals in",
    " * " + path.dirname(path.relative(process.cwd(), entry)) + "/ and regenerate:",
    " *",
    " *   node simulator/tools/flatten.js " + path.relative(process.cwd(), entry) +
      " " + (outFile ? path.relative(process.cwd(), outFile) : "out.ino"),
    " */",
    "",
  ].join("\n");

  const text = banner + flatten(entry) + "\n";

  if (!outFile) {
    process.stdout.write(text);
    return;
  }
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, text);
  console.log(
    "wrote " + path.relative(process.cwd(), outFile) +
      " (" + text.split("\n").length + " lines)"
  );
}

if (require.main === module) main();

module.exports = { flatten };
