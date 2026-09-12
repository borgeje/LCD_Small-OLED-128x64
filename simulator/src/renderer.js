/*
 * renderer.js - paints a framebuffer snapshot onto a canvas so it reads like
 * the actual panel rather than like a bitmap.
 *
 * The lit pixels go into a 128x64 ImageData that is then scaled up with
 * smoothing off, which keeps every pixel a hard square. Glow is a second,
 * blurred copy drawn underneath -- cheap, and it is what makes a white OLED
 * look self-luminous instead of like white-on-grey.
 *
 * Also maintains the burn-in accumulator: OLED pixels age with on-time, and
 * an always-on office display is exactly where that bites. Toggling the
 * burn-in view shows which pixels have been lit longest.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === "object" && module.exports) module.exports = mod;
  else (root.OLEDSim = root.OLEDSim || {}).renderer = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Physical dimensions of the 0.96" module's active area, in millimetres.
  const ACTIVE_W_MM = 21.7;
  const ACTIVE_H_MM = 10.9;
  const CSS_PX_PER_MM = 96 / 25.4; // nominal, for the 1:1 view

  const THEMES = {
    white: { lit: "#e8f4ff", glow: "rgba(180, 215, 255, 0.55)" },
    blue: { lit: "#4ec3ff", glow: "rgba(60, 160, 255, 0.6)" },
    yellow: { lit: "#ffd24a", glow: "rgba(255, 190, 60, 0.55)" },
  };

  class PanelRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.scale = 5;
      this.showGrid = true;
      this.showGlow = true;
      this.showBurn = false;
      this.theme = "white";
      this.bezel = 14;

      this.buf = document.createElement("canvas");
      this.bufCtx = this.buf.getContext("2d");
      this.imageData = null;
      this.burn = null;
      this.burnPeak = 1;
    }

    resetBurn(size) {
      this.burn = new Float32Array(size);
      this.burnPeak = 1;
    }

    /** Accumulate on-time. dtMs is how long this frame was displayed. */
    accumulateBurn(pixels, dtMs) {
      if (!this.burn || this.burn.length !== pixels.length) this.resetBurn(pixels.length);
      const w = Math.min(dtMs, 1000) / 1000;
      for (let i = 0; i < pixels.length; i++) {
        if (pixels[i]) {
          this.burn[i] += w;
          if (this.burn[i] > this.burnPeak) this.burnPeak = this.burn[i];
        }
      }
    }

    /** Size the canvas for a given snapshot and zoom, honouring the DPR. */
    layout(width, height) {
      const dpr = window.devicePixelRatio || 1;
      const cssW = width * this.scale + this.bezel * 2;
      const cssH = height * this.scale + this.bezel * 2;
      this.canvas.style.width = cssW + "px";
      this.canvas.style.height = cssH + "px";
      this.canvas.width = Math.round(cssW * dpr);
      this.canvas.height = Math.round(cssH * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { cssW, cssH };
    }

    /** Zoom that makes the canvas match the module's real size on screen. */
    actualSizeScale(width) {
      return (ACTIVE_W_MM * CSS_PX_PER_MM) / width;
    }

    render(snap) {
      if (!snap) return;
      const { width, height, pixels } = snap;
      const ctx = this.ctx;
      const { cssW, cssH } = this.layout(width, height);
      const s = this.scale;
      const b = this.bezel;
      const colors = THEMES[this.theme] || THEMES.white;

      // Module body.
      ctx.clearRect(0, 0, cssW, cssH);
      roundRect(ctx, 0, 0, cssW, cssH, 8);
      ctx.fillStyle = "#0a0c10";
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.07)";
      ctx.lineWidth = 1;
      ctx.stroke();

      // Glass.
      ctx.fillStyle = "#05060a";
      ctx.fillRect(b, b, width * s, height * s);

      if (this.buf.width !== width || this.buf.height !== height) {
        this.buf.width = width;
        this.buf.height = height;
        this.imageData = this.bufCtx.createImageData(width, height);
      }

      const img = this.imageData;
      const data = img.data;

      if (this.showBurn && this.burn) {
        // Heat map of accumulated on-time rather than the live frame.
        const peak = this.burnPeak || 1;
        for (let i = 0; i < width * height; i++) {
          const v = Math.min(1, this.burn[i] / peak);
          const o = i * 4;
          data[o] = Math.round(30 + v * 225);
          data[o + 1] = Math.round(30 + (1 - v) * 120);
          data[o + 2] = Math.round(60 + (1 - v) * 120);
          data[o + 3] = 255;
        }
      } else {
        const rgb = hexToRgb(colors.lit);
        const dim = snap.contrast === undefined ? 1 : Math.max(0.4, snap.contrast / 0x8f);
        for (let i = 0; i < width * height; i++) {
          const on = pixels[i];
          const o = i * 4;
          if (on) {
            data[o] = Math.min(255, Math.round(rgb[0] * dim));
            data[o + 1] = Math.min(255, Math.round(rgb[1] * dim));
            data[o + 2] = Math.min(255, Math.round(rgb[2] * dim));
            data[o + 3] = 255;
          } else {
            data[o] = 0;
            data[o + 1] = 0;
            data[o + 2] = 0;
            data[o + 3] = 0;
          }
        }
      }
      this.bufCtx.putImageData(img, 0, 0);

      ctx.imageSmoothingEnabled = false;

      // Glow: the same frame, blurred, underneath the crisp one.
      if (this.showGlow && !this.showBurn) {
        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.filter = "blur(" + Math.max(1, s * 0.7) + "px)";
        ctx.drawImage(this.buf, b, b, width * s, height * s);
        ctx.restore();
        ctx.filter = "none";
      }

      ctx.drawImage(this.buf, b, b, width * s, height * s);

      // The dark lattice between pixels, only where it would be visible.
      if (this.showGrid && s >= 4) {
        ctx.strokeStyle = "rgba(0,0,0,0.38)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = 0; x <= width; x++) {
          ctx.moveTo(b + x * s + 0.5, b);
          ctx.lineTo(b + x * s + 0.5, b + height * s);
        }
        for (let y = 0; y <= height; y++) {
          ctx.moveTo(b, b + y * s + 0.5);
          ctx.lineTo(b + width * s, b + y * s + 0.5);
        }
        ctx.stroke();
      }

      // Glass edge.
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      ctx.strokeRect(b - 0.5, b - 0.5, width * s + 1, height * s + 1);
    }

    /** Current frame as a PNG data URL, at the on-screen zoom. */
    toDataURL() {
      return this.canvas.toDataURL("image/png");
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return m
      ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
      : [232, 244, 255];
  }

  /*
   * The current frame as a PROGMEM bitmap, ready to paste back into a sketch
   * and hand to display.drawBitmap(). Round-trips a design out of the
   * simulator and into firmware.
   */
  function toCBitmap(snap, name) {
    name = name || "frame";
    const { width, height, pixels } = snap;
    const byteWidth = (width + 7) >> 3;
    const bytes = [];
    for (let y = 0; y < height; y++) {
      for (let bx = 0; bx < byteWidth; bx++) {
        let b = 0;
        for (let bit = 0; bit < 8; bit++) {
          const x = bx * 8 + bit;
          if (x < width && pixels[y * width + x]) b |= 0x80 >> bit;
        }
        bytes.push(b);
      }
    }
    const lines = [];
    for (let i = 0; i < bytes.length; i += 16) {
      lines.push(
        "  " + bytes.slice(i, i + 16)
          .map((b) => "0x" + b.toString(16).toUpperCase().padStart(2, "0"))
          .join(", ") + ","
      );
    }
    return (
      "// " + width + "x" + height + ", " + bytes.length + " bytes\n" +
      "const uint8_t " + name + "[] PROGMEM = {\n" +
      lines.join("\n").replace(/,$/, "") + "\n};\n\n" +
      "// display.drawBitmap(0, 0, " + name + ", " + width + ", " + height +
      ", SSD1306_WHITE);\n"
    );
  }

  return { PanelRenderer, toCBitmap, ACTIVE_W_MM, ACTIVE_H_MM, THEMES };
});
