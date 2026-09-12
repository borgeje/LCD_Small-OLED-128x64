/*
 * app.js - wiring for the browser simulator.
 *
 * The run loop is the interesting part. Each animation frame it asks the
 * sketch to advance by (elapsed real time x speed) of virtual time, with a
 * wall-clock budget so a heavy sketch degrades into slow motion instead of
 * freezing the tab. Whatever frame the sketch last latched is what gets
 * painted -- the same relationship the panel has with the MCU.
 */
(function () {
  "use strict";

  const { Sketch } = OLEDSim.runtime;
  const { PanelRenderer, toCBitmap } = OLEDSim.renderer;
  const { EXAMPLES } = OLEDSim.examples;

  const $ = (id) => document.getElementById(id);

  const el = {
    code: $("code"), gutter: $("gutter"), error: $("error"),
    canvas: $("screen"), run: $("run"), step: $("step"), reset: $("reset"),
    examples: $("examples"), file: $("file"), load: $("load"),
    sketchName: $("sketch-name"), frameLabel: $("frame-label"),
    speed: $("speed"), zoom: $("zoom"), theme: $("theme"),
    grid: $("grid"), glow: $("glow"), burn: $("burn"),
    png: $("png"), cbitmap: $("cbitmap"),
    stats: $("stats"), bus: $("bus"), serial: $("serial"),
    clearSerial: $("clear-serial"), io: $("io"), ioNote: $("io-note"),
    drop: $("drop"),
  };

  const renderer = new PanelRenderer(el.canvas);

  let sketch = null;
  let running = false;
  let lastWall = 0;
  let serialShown = 0;
  const ioValues = {};        // pin -> value, kept across resets
  let knownPins = "";

  /* ------------------------------------------------------------------ *
   * Editor chrome
   * ------------------------------------------------------------------ */

  function syncGutter(errorLine) {
    const lines = el.code.value.split("\n").length;
    const out = [];
    for (let i = 1; i <= lines; i++) {
      out.push(i === errorLine ? '<span class="err">' + i + "</span>" : i);
    }
    el.gutter.innerHTML = out.join("\n");
    // The textarea has overflow hidden and grows to fit, so the gutter and
    // the text can never drift apart.
    el.code.style.height = "auto";
    el.code.style.height = el.code.scrollHeight + "px";
  }

  function showError(e) {
    if (!e) {
      el.error.classList.remove("show");
      syncGutter(0);
      return;
    }
    const lines = el.code.value.split("\n");
    let context = "";
    if (e.line && lines[e.line - 1] !== undefined) {
      const start = Math.max(0, e.line - 3);
      const end = Math.min(lines.length, e.line + 2);
      for (let i = start; i < end; i++) {
        const marker = i + 1 === e.line ? " > " : "   ";
        context += marker + String(i + 1).padStart(4) + " | " + lines[i] + "\n";
      }
    }
    el.error.innerHTML =
      "<b>" + escapeHtml(e.name || "Error") +
      (e.line ? " on line " + e.line : "") + "</b>\n" +
      escapeHtml(e.message) + (context ? "\n\n" + escapeHtml(context) : "");
    el.error.classList.add("show");
    syncGutter(e.line || 0);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }

  /* ------------------------------------------------------------------ *
   * Lifecycle
   * ------------------------------------------------------------------ */

  function build() {
    stop();
    try {
      sketch = new Sketch(el.code.value);
    } catch (e) {
      sketch = null;
      showError(e);
      paintStats();
      return false;
    }
    for (const pin of Object.keys(ioValues)) {
      sketch.interp.io.analog[pin] = ioValues[pin];
      sketch.interp.io.digital[pin] = ioValues[pin] ? 1 : 0;
    }
    showError(null);
    renderer.resetBurn(128 * 64);
    serialShown = 0;
    knownPins = "";
    el.serial.innerHTML = '<span class="empty">nothing printed yet</span>';

    // Get to the first frame immediately so the panel is never blank on load.
    advance({ stopOnFrame: true, wallMs: 400 });

    // A blank panel with no explanation is the worst failure mode here, so
    // say plainly when the sketch never made a display to draw on.
    if (!sketch.error && !sketch.snapshot()) {
      showError({
        name: "No display",
        message:
          "This sketch ran but never constructed a display, so there is " +
          "nothing to show.\nExpected something like:\n\n" +
          "    Adafruit_SSD1306 display(128, 64, &Wire, -1);",
      });
    }

    paintAll();
    return true;
  }

  function advance(opts) {
    if (!sketch || sketch.error || sketch.finished) return null;
    const before = sketch.interp.micros;
    const r = sketch.advance(opts);
    if (sketch.error) {
      showError(sketch.error);
      stop();
    }
    // Age the burn-in map by however much virtual time just passed.
    const snap = sketch.snapshot();
    if (snap) renderer.accumulateBurn(snap.pixels, (sketch.interp.micros - before) / 1000);
    return r;
  }

  function start() {
    if (!sketch || sketch.error || sketch.finished) return;
    running = true;
    lastWall = performance.now();
    el.run.textContent = "Pause";
    requestAnimationFrame(tick);
  }

  function stop() {
    running = false;
    el.run.textContent = "Run";
  }

  function tick(now) {
    if (!running) return;
    const elapsed = Math.min(100, now - lastWall); // ignore tab-switch gaps
    lastWall = now;

    const speed = parseFloat(el.speed.value) || 1;
    const target = sketch.interp.micros + elapsed * 1000 * speed;

    // 12 ms of real work per animation frame leaves the UI responsive; a
    // sketch too heavy to keep up simply runs slower than real time.
    advance({ untilMicros: target, wallMs: 12 });

    paintAll();
    if (running) requestAnimationFrame(tick);
  }

  /* ------------------------------------------------------------------ *
   * Painting
   * ------------------------------------------------------------------ */

  function paintAll() {
    paintScreen();
    paintStats();
    paintSerial();
    paintIO();
  }

  function paintScreen() {
    if (!sketch) return;
    const snap = sketch.snapshot();
    if (!snap) return;

    if (el.zoom.value === "actual") {
      renderer.scale = renderer.actualSizeScale(snap.width);
      renderer.showGrid = false;
    } else {
      renderer.scale = parseInt(el.zoom.value, 10);
      renderer.showGrid = el.grid.checked;
    }
    renderer.showGlow = el.glow.checked;
    renderer.showBurn = el.burn.checked;
    renderer.theme = el.theme.value;
    renderer.render(snap);

    el.frameLabel.textContent =
      sketch.frames + (sketch.frames === 1 ? " frame" : " frames") +
      " · t = " + formatMs(sketch.millis);
  }

  function formatMs(ms) {
    if (ms < 1000) return ms + " ms";
    if (ms < 60000) return (ms / 1000).toFixed(1) + " s";
    return Math.floor(ms / 60000) + "m " + Math.round((ms % 60000) / 1000) + "s";
  }

  function stat(k, v, warn) {
    return (
      '<div class="stat"><div class="k">' + k + '</div><div class="v' +
      (warn ? " warn" : "") + '">' + v + "</div></div>"
    );
  }

  function paintStats() {
    if (!sketch) {
      el.stats.innerHTML = stat("status", "not running");
      el.bus.innerHTML = "";
      return;
    }
    const fps = sketch.fps();
    const panel = sketch.display;
    let status = "running";
    if (sketch.error) status = "error";
    else if (sketch.finished) status = "ended";
    else if (!running) status = "paused";

    el.stats.innerHTML =
      stat("status", status, status === "error") +
      stat("sketch time", formatMs(sketch.millis)) +
      stat("frames", sketch.frames) +
      stat("fps", fps ? fps.toFixed(1) : "–") +
      stat("loop() calls", sketch.loops.toLocaleString()) +
      stat("lit pixels", panel ? countLit(sketch.snapshot()) : "–");

    const clock = sketch.interp.i2c.clock;
    const frameUs = sketch.interp.i2cFrameMicros();
    el.bus.innerHTML =
      stat("I²C clock", (clock / 1000) + " kHz", clock < 400000) +
      stat("frame transfer", (frameUs / 1000).toFixed(1) + " ms") +
      stat("ceiling", (1e6 / frameUs).toFixed(0) + " fps") +
      stat("address", panel && panel.i2cAddress !== null
        ? "0x" + panel.i2cAddress.toString(16).toUpperCase()
        : "not opened", panel && panel.i2cAddress === null);
  }

  function countLit(snap) {
    if (!snap) return 0;
    let n = 0;
    for (let i = 0; i < snap.pixels.length; i++) n += snap.pixels[i];
    return n.toLocaleString() + " / 8,192";
  }

  function paintSerial() {
    if (!sketch) return;
    const lines = sketch.serial;
    if (lines.length === serialShown) return;
    if (!lines.length) return;

    if (serialShown === 0) el.serial.innerHTML = "";
    const atBottom =
      el.serial.scrollHeight - el.serial.scrollTop - el.serial.clientHeight < 24;

    const frag = document.createDocumentFragment();
    for (let i = serialShown; i < lines.length; i++) {
      const div = document.createElement("div");
      div.innerHTML =
        '<span class="t">[' + String(lines[i].t).padStart(6) + "ms]</span> " +
        escapeHtml(lines[i].text);
      frag.appendChild(div);
    }
    el.serial.appendChild(frag);
    serialShown = lines.length;
    if (atBottom) el.serial.scrollTop = el.serial.scrollHeight;
  }

  /*
   * Only pins the sketch has actually read get a control. That keeps the
   * panel empty for sketches with no inputs, and means the list is a true
   * account of what the sketch depends on.
   */
  function paintIO() {
    if (!sketch) return;
    const pins = Array.from(sketch.interp.io.pinsRead).sort((a, b) => a - b);
    const key = pins.join(",");
    if (key === knownPins) {
      for (const pin of pins) {
        const out = document.getElementById("io-val-" + pin);
        if (out && document.activeElement !== document.getElementById("io-in-" + pin)) {
          const v = sketch.interp.io.analog[pin];
          if (v !== undefined) out.textContent = v;
        }
      }
      return;
    }
    knownPins = key;

    if (!pins.length) {
      el.io.innerHTML = '<div class="io-empty">Pins appear here once the sketch reads one.</div>';
      el.ioNote.textContent = "";
      return;
    }
    el.ioNote.textContent = pins.length + (pins.length === 1 ? " pin" : " pins");

    el.io.innerHTML = pins
      .map((pin) => {
        const v = ioValues[pin] !== undefined ? ioValues[pin] : 0;
        return (
          '<div class="io-row">' +
          '<div class="name">GPIO ' + pin + "</div>" +
          '<input type="range" id="io-in-' + pin + '" min="0" max="4095" value="' + v + '">' +
          '<div class="val" id="io-val-' + pin + '">' + v + "</div>" +
          "</div>"
        );
      })
      .join("");

    for (const pin of pins) {
      const input = document.getElementById("io-in-" + pin);
      input.addEventListener("input", () => {
        const v = parseInt(input.value, 10);
        ioValues[pin] = v;
        document.getElementById("io-val-" + pin).textContent = v;
        if (sketch) {
          sketch.interp.io.analog[pin] = v;
          sketch.interp.io.digital[pin] = v > 2047 ? 1 : 0;
        }
        if (!running) {
          advance({ stopOnFrame: true, wallMs: 60 });
          paintScreen();
          paintStats();
        }
      });
    }
  }

  /* ------------------------------------------------------------------ *
   * Events
   * ------------------------------------------------------------------ */

  el.run.addEventListener("click", () => (running ? stop() : start()));

  el.step.addEventListener("click", () => {
    stop();
    advance({ stopOnFrame: true, wallMs: 500 });
    paintAll();
  });

  el.reset.addEventListener("click", () => {
    if (build()) start();
  });

  el.code.addEventListener("input", () => {
    syncGutter(0);
    scheduleRebuild();
  });

  let rebuildTimer = null;
  function scheduleRebuild() {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      const wasRunning = running;
      if (build() && wasRunning) start();
    }, 600);
  }

  // Tab inserts two spaces rather than leaving the editor.
  el.code.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const s = el.code.selectionStart;
      const t = el.code.selectionEnd;
      el.code.value = el.code.value.slice(0, s) + "  " + el.code.value.slice(t);
      el.code.selectionStart = el.code.selectionEnd = s + 2;
      syncGutter(0);
      scheduleRebuild();
    }
  });

  el.examples.addEventListener("change", () => {
    const ex = EXAMPLES[parseInt(el.examples.value, 10)];
    if (!ex) return;
    el.code.value = ex.source;
    el.sketchName.textContent = ex.file;
    syncGutter(0);
    if (build()) start();
  });

  el.load.addEventListener("click", () => el.file.click());
  el.file.addEventListener("change", () => {
    const f = el.file.files && el.file.files[0];
    if (f) loadFile(f);
  });

  function loadFile(f) {
    const reader = new FileReader();
    reader.onload = () => {
      el.code.value = String(reader.result);
      el.sketchName.textContent = f.name;
      el.examples.value = "";
      syncGutter(0);
      if (build()) start();
    };
    reader.readAsText(f);
  }

  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => {
    e.preventDefault();
    if (++dragDepth === 1) el.drop.classList.add("show");
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("dragleave", () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      el.drop.classList.remove("show");
    }
  });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    el.drop.classList.remove("show");
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  for (const id of ["zoom", "theme", "grid", "glow", "burn"]) {
    el[id].addEventListener("change", paintScreen);
  }

  el.clearSerial.addEventListener("click", () => {
    if (sketch) sketch.interp.serial.length = 0;
    serialShown = 0;
    el.serial.innerHTML = '<span class="empty">nothing printed yet</span>';
  });

  el.png.addEventListener("click", () => {
    if (!sketch || !sketch.snapshot()) return;
    const a = document.createElement("a");
    a.href = renderer.toDataURL();
    a.download = (el.sketchName.textContent || "frame").replace(/\.\w+$/, "") +
      "-" + sketch.millis + "ms.png";
    a.click();
  });

  el.cbitmap.addEventListener("click", async () => {
    const snap = sketch && sketch.snapshot();
    if (!snap) return;
    const text = toCBitmap(snap, "frame_" + sketch.millis + "ms");
    try {
      await navigator.clipboard.writeText(text);
      flash(el.cbitmap, "Copied");
    } catch (_) {
      // Clipboard is blocked on file:// in some browsers; fall back to a file.
      const blob = new Blob([text], { type: "text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "frame.h";
      a.click();
      flash(el.cbitmap, "Saved .h");
    }
  });

  function flash(button, text) {
    const original = button.textContent;
    button.textContent = text;
    setTimeout(() => (button.textContent = original), 1200);
  }

  document.addEventListener("keydown", (e) => {
    if (e.target === el.code) return;
    if (e.key === " ") {
      e.preventDefault();
      running ? stop() : start();
    } else if (e.key === ".") {
      e.preventDefault();
      el.step.click();
    } else if (e.key === "r" && !e.metaKey && !e.ctrlKey) {
      el.reset.click();
    }
  });

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  el.examples.innerHTML =
    EXAMPLES.map(
      (e, i) =>
        '<option value="' + i + '">' + escapeHtml(e.name) +
        (e.description ? " — " + escapeHtml(e.description) : "") + "</option>"
    ).join("");

  // Open on the CO2 monitor if it is present: it animates, so the simulator
  // demonstrates itself rather than showing a static "Hello".
  const startIndex = Math.min(1, EXAMPLES.length - 1);
  el.examples.value = String(startIndex);
  el.code.value = EXAMPLES[startIndex].source;
  el.sketchName.textContent = EXAMPLES[startIndex].file;
  syncGutter(0);
  if (build()) start();
})();
