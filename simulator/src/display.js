/*
 * display.js - SSD1306 + Adafruit_GFX emulation.
 *
 * The drawing primitives below are deliberate ports of the algorithms in
 * Adafruit_GFX / Adafruit_SSD1306, not lookalikes: same Bresenham stepping,
 * same circle helper, same integer truncation, same GDDRAM layout
 * (buffer[x + (y / 8) * WIDTH], bit y & 7). A sketch that renders here
 * renders the same way on the panel.
 */
(function (root, factory) {
  var mod = factory(
    typeof module === "object" && module.exports
      ? require("./glcdfont.js")
      : root.OLEDSim.glcdfont
  );
  if (typeof module === "object" && module.exports) module.exports = mod;
  else (root.OLEDSim = root.OLEDSim || {}).display = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function (glcdfont) {
  "use strict";

  var FONT = glcdfont.FONT;

  var BLACK = 0;
  var WHITE = 1;
  var INVERSE = 2;

  function trunc(n) {
    return Math.trunc(n);
  }

  function SSD1306(width, height) {
    this.WIDTH = width || 128;
    this.HEIGHT = height || 64;
    this._width = this.WIDTH;
    this._height = this.HEIGHT;
    this.rotation = 0;

    // 1 bit per pixel, page-major, exactly like the controller's GDDRAM.
    this.buffer = new Uint8Array((this.WIDTH * this.HEIGHT) / 8);

    this.cursor_x = 0;
    this.cursor_y = 0;
    this.textcolor = WHITE;
    this.textbgcolor = WHITE; // GFX starts opaque-equal, i.e. transparent
    this.textsize_x = 1;
    this.textsize_y = 1;
    this.wrap = true;
    this._cp437 = false;

    // Panel-level state. These do not touch the framebuffer; they change how
    // the glass looks, which is what the renderer consumes.
    this.inverted = false;
    this.contrast = 0x8f;
    this.dimmed = false;
    this.displayOn = true;

    // Hardware scroll (simplified: whole-panel horizontal, see README).
    this.scroll = null;

    this.initialised = false;
    this.i2cAddress = null;

    // Counters the UI surfaces, so a sketch that never calls display() or
    // that redraws 400 times a second is visible as such.
    this.stats = { displayCalls: 0, pixelWrites: 0, lastFlushSteps: 0 };
  }

  SSD1306.prototype.width = function () {
    return this._width;
  };
  SSD1306.prototype.height = function () {
    return this._height;
  };

  SSD1306.prototype.setRotation = function (r) {
    this.rotation = ((r % 4) + 4) % 4;
    if (this.rotation === 0 || this.rotation === 2) {
      this._width = this.WIDTH;
      this._height = this.HEIGHT;
    } else {
      this._width = this.HEIGHT;
      this._height = this.WIDTH;
    }
  };

  SSD1306.prototype.getRotation = function () {
    return this.rotation;
  };

  SSD1306.prototype.drawPixel = function (x, y, color) {
    x = trunc(x);
    y = trunc(y);
    if (x < 0 || x >= this._width || y < 0 || y >= this._height) return;

    var t;
    switch (this.rotation) {
      case 1:
        t = x;
        x = y;
        y = t;
        x = this.WIDTH - x - 1;
        break;
      case 2:
        x = this.WIDTH - x - 1;
        y = this.HEIGHT - y - 1;
        break;
      case 3:
        t = x;
        x = y;
        y = t;
        y = this.HEIGHT - y - 1;
        break;
    }

    var idx = x + (y >> 3) * this.WIDTH;
    var bit = 1 << (y & 7);
    switch (color) {
      case WHITE:
        this.buffer[idx] |= bit;
        break;
      case BLACK:
        this.buffer[idx] &= ~bit;
        break;
      case INVERSE:
        this.buffer[idx] ^= bit;
        break;
    }
    this.stats.pixelWrites++;
  };

  SSD1306.prototype.getPixel = function (x, y) {
    if (x < 0 || x >= this.WIDTH || y < 0 || y >= this.HEIGHT) return 0;
    return (this.buffer[x + (y >> 3) * this.WIDTH] >> (y & 7)) & 1;
  };

  SSD1306.prototype.clearDisplay = function () {
    this.buffer.fill(0);
  };

  SSD1306.prototype.fillScreen = function (color) {
    this.fillRect(0, 0, this._width, this._height, color);
  };

  SSD1306.prototype.drawFastVLine = function (x, y, h, color) {
    if (h < 0) {
      y += h + 1;
      h = -h;
    }
    for (var i = 0; i < h; i++) this.drawPixel(x, y + i, color);
  };

  SSD1306.prototype.drawFastHLine = function (x, y, w, color) {
    if (w < 0) {
      x += w + 1;
      w = -w;
    }
    for (var i = 0; i < w; i++) this.drawPixel(x + i, y, color);
  };

  SSD1306.prototype.drawLine = function (x0, y0, x1, y1, color) {
    x0 = trunc(x0);
    y0 = trunc(y0);
    x1 = trunc(x1);
    y1 = trunc(y1);
    if (x0 === x1) {
      if (y0 > y1) {
        var ty = y0;
        y0 = y1;
        y1 = ty;
      }
      this.drawFastVLine(x0, y0, y1 - y0 + 1, color);
      return;
    }
    if (y0 === y1) {
      if (x0 > x1) {
        var tx = x0;
        x0 = x1;
        x1 = tx;
      }
      this.drawFastHLine(x0, y0, x1 - x0 + 1, color);
      return;
    }

    var steep = Math.abs(y1 - y0) > Math.abs(x1 - x0);
    var t;
    if (steep) {
      t = x0; x0 = y0; y0 = t;
      t = x1; x1 = y1; y1 = t;
    }
    if (x0 > x1) {
      t = x0; x0 = x1; x1 = t;
      t = y0; y0 = y1; y1 = t;
    }

    var dx = x1 - x0;
    var dy = Math.abs(y1 - y0);
    var err = trunc(dx / 2);
    var ystep = y0 < y1 ? 1 : -1;

    for (; x0 <= x1; x0++) {
      if (steep) this.drawPixel(y0, x0, color);
      else this.drawPixel(x0, y0, color);
      err -= dy;
      if (err < 0) {
        y0 += ystep;
        err += dx;
      }
    }
  };

  SSD1306.prototype.drawRect = function (x, y, w, h, color) {
    this.drawFastHLine(x, y, w, color);
    this.drawFastHLine(x, y + h - 1, w, color);
    this.drawFastVLine(x, y, h, color);
    this.drawFastVLine(x + w - 1, y, h, color);
  };

  SSD1306.prototype.fillRect = function (x, y, w, h, color) {
    for (var i = x; i < x + w; i++) this.drawFastVLine(i, y, h, color);
  };

  SSD1306.prototype.drawCircle = function (x0, y0, r, color) {
    x0 = trunc(x0); y0 = trunc(y0); r = trunc(r);
    var f = 1 - r;
    var ddF_x = 1;
    var ddF_y = -2 * r;
    var x = 0;
    var y = r;

    this.drawPixel(x0, y0 + r, color);
    this.drawPixel(x0, y0 - r, color);
    this.drawPixel(x0 + r, y0, color);
    this.drawPixel(x0 - r, y0, color);

    while (x < y) {
      if (f >= 0) {
        y--;
        ddF_y += 2;
        f += ddF_y;
      }
      x++;
      ddF_x += 2;
      f += ddF_x;

      this.drawPixel(x0 + x, y0 + y, color);
      this.drawPixel(x0 - x, y0 + y, color);
      this.drawPixel(x0 + x, y0 - y, color);
      this.drawPixel(x0 - x, y0 - y, color);
      this.drawPixel(x0 + y, y0 + x, color);
      this.drawPixel(x0 - y, y0 + x, color);
      this.drawPixel(x0 + y, y0 - x, color);
      this.drawPixel(x0 - y, y0 - x, color);
    }
  };

  SSD1306.prototype.drawCircleHelper = function (x0, y0, r, cornername, color) {
    var f = 1 - r;
    var ddF_x = 1;
    var ddF_y = -2 * r;
    var x = 0;
    var y = r;

    while (x < y) {
      if (f >= 0) {
        y--;
        ddF_y += 2;
        f += ddF_y;
      }
      x++;
      ddF_x += 2;
      f += ddF_x;
      if (cornername & 0x4) {
        this.drawPixel(x0 + x, y0 + y, color);
        this.drawPixel(x0 + y, y0 + x, color);
      }
      if (cornername & 0x2) {
        this.drawPixel(x0 + x, y0 - y, color);
        this.drawPixel(x0 + y, y0 - x, color);
      }
      if (cornername & 0x8) {
        this.drawPixel(x0 - y, y0 + x, color);
        this.drawPixel(x0 - x, y0 + y, color);
      }
      if (cornername & 0x1) {
        this.drawPixel(x0 - y, y0 - x, color);
        this.drawPixel(x0 - x, y0 - y, color);
      }
    }
  };

  SSD1306.prototype.fillCircleHelper = function (x0, y0, r, corners, delta, color) {
    var f = 1 - r;
    var ddF_x = 1;
    var ddF_y = -2 * r;
    var x = 0;
    var y = r;
    var px = x;
    var py = y;

    delta++;

    while (x < y) {
      if (f >= 0) {
        y--;
        ddF_y += 2;
        f += ddF_y;
      }
      x++;
      ddF_x += 2;
      f += ddF_x;

      if (x < y + 1) {
        if (corners & 1) this.drawFastVLine(x0 + x, y0 - y, 2 * y + delta, color);
        if (corners & 2) this.drawFastVLine(x0 - x, y0 - y, 2 * y + delta, color);
      }
      if (y !== py) {
        if (corners & 1) this.drawFastVLine(x0 + py, y0 - px, 2 * px + delta, color);
        if (corners & 2) this.drawFastVLine(x0 - py, y0 - px, 2 * px + delta, color);
        py = y;
      }
      px = x;
    }
  };

  SSD1306.prototype.fillCircle = function (x0, y0, r, color) {
    x0 = trunc(x0); y0 = trunc(y0); r = trunc(r);
    this.drawFastVLine(x0, y0 - r, 2 * r + 1, color);
    this.fillCircleHelper(x0, y0, r, 3, 0, color);
  };

  SSD1306.prototype.drawRoundRect = function (x, y, w, h, r, color) {
    var max_radius = trunc((w < h ? w : h) / 2);
    if (r > max_radius) r = max_radius;
    this.drawFastHLine(x + r, y, w - 2 * r, color);
    this.drawFastHLine(x + r, y + h - 1, w - 2 * r, color);
    this.drawFastVLine(x, y + r, h - 2 * r, color);
    this.drawFastVLine(x + w - 1, y + r, h - 2 * r, color);
    this.drawCircleHelper(x + r, y + r, r, 1, color);
    this.drawCircleHelper(x + w - r - 1, y + r, r, 2, color);
    this.drawCircleHelper(x + w - r - 1, y + h - r - 1, r, 4, color);
    this.drawCircleHelper(x + r, y + h - r - 1, r, 8, color);
  };

  SSD1306.prototype.fillRoundRect = function (x, y, w, h, r, color) {
    var max_radius = trunc((w < h ? w : h) / 2);
    if (r > max_radius) r = max_radius;
    this.fillRect(x + r, y, w - 2 * r, h, color);
    this.fillCircleHelper(x + w - r - 1, y + r, r, 1, h - 2 * r - 1, color);
    this.fillCircleHelper(x + r, y + r, r, 2, h - 2 * r - 1, color);
  };

  SSD1306.prototype.drawTriangle = function (x0, y0, x1, y1, x2, y2, color) {
    this.drawLine(x0, y0, x1, y1, color);
    this.drawLine(x1, y1, x2, y2, color);
    this.drawLine(x2, y2, x0, y0, color);
  };

  SSD1306.prototype.fillTriangle = function (x0, y0, x1, y1, x2, y2, color) {
    x0 = trunc(x0); y0 = trunc(y0);
    x1 = trunc(x1); y1 = trunc(y1);
    x2 = trunc(x2); y2 = trunc(y2);
    var t;
    if (y0 > y1) {
      t = y0; y0 = y1; y1 = t;
      t = x0; x0 = x1; x1 = t;
    }
    if (y1 > y2) {
      t = y2; y2 = y1; y1 = t;
      t = x2; x2 = x1; x1 = t;
    }
    if (y0 > y1) {
      t = y0; y0 = y1; y1 = t;
      t = x0; x0 = x1; x1 = t;
    }

    var a, b, y, last;

    if (y0 === y2) {
      a = b = x0;
      if (x1 < a) a = x1;
      else if (x1 > b) b = x1;
      if (x2 < a) a = x2;
      else if (x2 > b) b = x2;
      this.drawFastHLine(a, y0, b - a + 1, color);
      return;
    }

    var dx01 = x1 - x0,
      dy01 = y1 - y0,
      dx02 = x2 - x0,
      dy02 = y2 - y0,
      dx12 = x2 - x1,
      dy12 = y2 - y1;
    var sa = 0,
      sb = 0;

    if (y1 === y2) last = y1;
    else last = y1 - 1;

    for (y = y0; y <= last; y++) {
      a = x0 + trunc(sa / dy01);
      b = x0 + trunc(sb / dy02);
      sa += dx01;
      sb += dx02;
      if (a > b) {
        t = a; a = b; b = t;
      }
      this.drawFastHLine(a, y, b - a + 1, color);
    }

    sa = dx12 * (y - y1);
    sb = dx02 * (y - y0);
    for (; y <= y2; y++) {
      a = x1 + trunc(sa / dy12);
      b = x0 + trunc(sb / dy02);
      sa += dx12;
      sb += dx02;
      if (a > b) {
        t = a; a = b; b = t;
      }
      this.drawFastHLine(a, y, b - a + 1, color);
    }
  };

  SSD1306.prototype.drawBitmap = function (x, y, bitmap, w, h, color, bg) {
    var byteWidth = (w + 7) >> 3;
    var b = 0;
    var hasBg = arguments.length > 6 && bg !== undefined && bg !== null;
    for (var j = 0; j < h; j++) {
      for (var i = 0; i < w; i++) {
        if (i & 7) b <<= 1;
        else b = bitmap[j * byteWidth + (i >> 3)] | 0;
        if (b & 0x80) this.drawPixel(x + i, y + j, color);
        else if (hasBg) this.drawPixel(x + i, y + j, bg);
      }
    }
  };

  // XBM bit order is LSB-first within each byte.
  SSD1306.prototype.drawXBitmap = function (x, y, bitmap, w, h, color) {
    var byteWidth = (w + 7) >> 3;
    var b = 0;
    for (var j = 0; j < h; j++) {
      for (var i = 0; i < w; i++) {
        if (i & 7) b >>= 1;
        else b = bitmap[j * byteWidth + (i >> 3)] | 0;
        if (b & 0x01) this.drawPixel(x + i, y + j, color);
      }
    }
  };

  SSD1306.prototype.drawChar = function (x, y, c, color, bg, size_x, size_y) {
    size_x = size_x || 1;
    size_y = size_y === undefined ? size_x : size_y;
    x = trunc(x);
    y = trunc(y);

    if (
      x >= this._width ||
      y >= this._height ||
      x + 6 * size_x - 1 < 0 ||
      y + 8 * size_y - 1 < 0
    )
      return;

    if (!this._cp437 && c >= 176) c++;

    for (var i = 0; i < 5; i++) {
      var line = FONT[c * 5 + i];
      for (var j = 0; j < 8; j++, line >>= 1) {
        if (line & 1) {
          if (size_x === 1 && size_y === 1) this.drawPixel(x + i, y + j, color);
          else
            this.fillRect(x + i * size_x, y + j * size_y, size_x, size_y, color);
        } else if (bg !== color) {
          if (size_x === 1 && size_y === 1) this.drawPixel(x + i, y + j, bg);
          else this.fillRect(x + i * size_x, y + j * size_y, size_x, size_y, bg);
        }
      }
    }
    if (bg !== color) {
      if (size_x === 1 && size_y === 1) this.drawFastVLine(x + 5, y, 8, bg);
      else this.fillRect(x + 5 * size_x, y, size_x, 8 * size_y, bg);
    }
  };

  SSD1306.prototype.write = function (ch) {
    if (ch === 10) {
      // \n
      this.cursor_x = 0;
      this.cursor_y += this.textsize_y * 8;
    } else if (ch !== 13) {
      // skip \r
      if (this.wrap && this.cursor_x + this.textsize_x * 6 > this._width) {
        this.cursor_x = 0;
        this.cursor_y += this.textsize_y * 8;
      }
      this.drawChar(
        this.cursor_x,
        this.cursor_y,
        ch,
        this.textcolor,
        this.textbgcolor,
        this.textsize_x,
        this.textsize_y
      );
      this.cursor_x += this.textsize_x * 6;
    }
  };

  SSD1306.prototype.printString = function (s) {
    for (var i = 0; i < s.length; i++) this.write(s.charCodeAt(i) & 0xff);
  };

  SSD1306.prototype.setCursor = function (x, y) {
    this.cursor_x = trunc(x);
    this.cursor_y = trunc(y);
  };
  SSD1306.prototype.getCursorX = function () {
    return this.cursor_x;
  };
  SSD1306.prototype.getCursorY = function () {
    return this.cursor_y;
  };

  SSD1306.prototype.setTextSize = function (sx, sy) {
    if (sy === undefined) sy = sx;
    this.textsize_x = sx < 1 ? 1 : trunc(sx);
    this.textsize_y = sy < 1 ? 1 : trunc(sy);
  };

  SSD1306.prototype.setTextColor = function (c, bg) {
    this.textcolor = c;
    this.textbgcolor = bg === undefined ? c : bg;
  };

  SSD1306.prototype.setTextWrap = function (w) {
    this.wrap = !!w;
  };
  SSD1306.prototype.cp437 = function (x) {
    this._cp437 = x === undefined ? true : !!x;
  };

  // Mirrors GFX getTextBounds for the classic font, which sketches use to
  // centre text. Returns {x, y, w, h}.
  SSD1306.prototype.getTextBounds = function (str, x, y) {
    var cx = x,
      cy = y;
    var minx = 0x7fff,
      miny = 0x7fff,
      maxx = -1,
      maxy = -1;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i) & 0xff;
      if (c === 10) {
        cx = x;
        cy += this.textsize_y * 8;
        continue;
      }
      if (c === 13) continue;
      if (this.wrap && cx + this.textsize_x * 6 > this._width) {
        cx = x;
        cy += this.textsize_y * 8;
      }
      var x2 = cx + this.textsize_x * 6 - 1,
        y2 = cy + this.textsize_y * 8 - 1;
      if (x2 > maxx) maxx = x2;
      if (y2 > maxy) maxy = y2;
      if (cx < minx) minx = cx;
      if (cy < miny) miny = cy;
      cx += this.textsize_x * 6;
    }
    if (maxx >= minx) {
      return { x: minx, y: miny, w: maxx - minx + 1, h: maxy - miny + 1 };
    }
    return { x: x, y: y, w: 0, h: 0 };
  };

  // --- Panel-level operations -------------------------------------------

  SSD1306.prototype.begin = function (vcs, addr) {
    this.initialised = true;
    this.i2cAddress = addr === undefined ? 0x3c : addr;
    this.clearDisplay();
    return true;
  };

  SSD1306.prototype.display = function () {
    this.stats.displayCalls++;
  };

  SSD1306.prototype.invertDisplay = function (i) {
    this.inverted = !!i;
  };
  SSD1306.prototype.dim = function (d) {
    this.dimmed = !!d;
    this.contrast = d ? 0x00 : 0x8f;
  };
  SSD1306.prototype.setContrast = function (c) {
    this.contrast = c & 0xff;
  };
  SSD1306.prototype.ssd1306_command = function (c) {
    // Sketches poke raw commands for contrast (0x81) and on/off (0xAE/0xAF).
    if (c === 0xae) this.displayOn = false;
    else if (c === 0xaf) this.displayOn = true;
  };

  SSD1306.prototype.startscrollright = function (start, stop) {
    this.scroll = { dir: 1, start: start, stop: stop, offset: 0 };
  };
  SSD1306.prototype.startscrollleft = function (start, stop) {
    this.scroll = { dir: -1, start: start, stop: stop, offset: 0 };
  };
  SSD1306.prototype.startscrolldiagright = function (start, stop) {
    this.scroll = { dir: 1, start: start, stop: stop, offset: 0, diag: 1 };
  };
  SSD1306.prototype.startscrolldiagleft = function (start, stop) {
    this.scroll = { dir: -1, start: start, stop: stop, offset: 0, diag: -1 };
  };
  SSD1306.prototype.stopscroll = function () {
    this.scroll = null;
  };

  /*
   * Snapshot of the glass as the eye would see it: panel inversion applied,
   * scroll offset applied, blanked if the panel is off. One byte per pixel
   * so the renderer and the PNG writer share a single format.
   */
  SSD1306.prototype.toPixels = function () {
    var out = new Uint8Array(this.WIDTH * this.HEIGHT);
    if (!this.displayOn) return out;

    var sc = this.scroll;
    for (var y = 0; y < this.HEIGHT; y++) {
      var page = y >> 3;
      var shift = 0;
      if (sc && page >= sc.start && page <= sc.stop) {
        shift = sc.dir * sc.offset;
      }
      for (var x = 0; x < this.WIDTH; x++) {
        var sx = (((x - shift) % this.WIDTH) + this.WIDTH) % this.WIDTH;
        var v = (this.buffer[sx + page * this.WIDTH] >> (y & 7)) & 1;
        out[y * this.WIDTH + x] = this.inverted ? v ^ 1 : v;
      }
    }
    return out;
  };

  SSD1306.prototype.snapshot = function () {
    return {
      width: this.WIDTH,
      height: this.HEIGHT,
      pixels: this.toPixels(),
      contrast: this.contrast,
      inverted: this.inverted,
      on: this.displayOn,
    };
  };

  return {
    SSD1306: SSD1306,
    BLACK: BLACK,
    WHITE: WHITE,
    INVERSE: INVERSE,
  };
});
