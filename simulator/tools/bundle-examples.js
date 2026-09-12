#!/usr/bin/env node
/*
 * bundle-examples.js - regenerate src/examples.js from examples/*.ino.
 *
 * The browser page is opened straight off disk (file://), where fetch() of a
 * sibling file is blocked, so the example sketches are inlined into a JS
 * module. The .ino files stay the source of truth -- edit those and re-run:
 *
 *   node simulator/tools/bundle-examples.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const examplesDir = path.join(__dirname, "..", "examples");
const outFile = path.join(__dirname, "..", "src", "examples.js");

const files = fs
  .readdirSync(examplesDir)
  .filter((f) => f.endsWith(".ino"))
  .sort();

// The first comment line of each sketch doubles as its one-line description.
function describe(source) {
  const m = source.match(/^\s*\/\*\s*\n\s*\*\s*\S+\s*-\s*(.+?)\s*$/m);
  return m ? m[1].replace(/\.$/, "") : "";
}

const entries = files.map((f) => {
  const source = fs.readFileSync(path.join(examplesDir, f), "utf8");
  return {
    file: f,
    name: f.replace(/^\d+-/, "").replace(/\.ino$/, "").replace(/-/g, " "),
    description: describe(source),
    source,
  };
});

const body = entries
  .map(
    (e) =>
      "    {\n" +
      "      file: " + JSON.stringify(e.file) + ",\n" +
      "      name: " + JSON.stringify(e.name) + ",\n" +
      "      description: " + JSON.stringify(e.description) + ",\n" +
      "      source: " + JSON.stringify(e.source) + ",\n" +
      "    }"
  )
  .join(",\n");

const out = `/*
 * examples.js - GENERATED FILE, do not edit.
 *
 * Inlined copies of simulator/examples/*.ino so the page works when opened
 * directly from disk. Regenerate with:
 *
 *   node simulator/tools/bundle-examples.js
 */
(function (root, factory) {
  var mod = factory();
  if (typeof module === "object" && module.exports) module.exports = mod;
  else (root.OLEDSim = root.OLEDSim || {}).examples = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  return {
    EXAMPLES: [
${body}
    ],
  };
});
`;

fs.writeFileSync(outFile, out);
console.log(
  "wrote " + path.relative(process.cwd(), outFile) +
    " (" + entries.length + " examples, " + out.length.toLocaleString() + " bytes)"
);
