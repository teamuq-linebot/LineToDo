#!/usr/bin/env node
import { createRequire as __teamuqCreateRequire } from 'node:module'; const require = __teamuqCreateRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key2 of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key2) && key2 !== except)
        __defProp(to, key2, { get: () => from[key2], enumerable: !(desc = __getOwnPropDesc(from, key2)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/pend/index.js
var require_pend = __commonJS({
  "node_modules/pend/index.js"(exports, module) {
    "use strict";
    module.exports = Pend;
    function Pend() {
      this.pending = 0;
      this.max = Infinity;
      this.listeners = [];
      this.waiting = [];
      this.error = null;
    }
    Pend.prototype.go = function(fn) {
      if (this.pending < this.max) {
        pendGo(this, fn);
      } else {
        this.waiting.push(fn);
      }
    };
    Pend.prototype.wait = function(cb) {
      if (this.pending === 0) {
        cb(this.error);
      } else {
        this.listeners.push(cb);
      }
    };
    Pend.prototype.hold = function() {
      return pendHold(this);
    };
    function pendHold(self) {
      self.pending += 1;
      var called = false;
      return onCb;
      function onCb(err) {
        if (called) throw new Error("callback called twice");
        called = true;
        self.error = self.error || err;
        self.pending -= 1;
        if (self.waiting.length > 0 && self.pending < self.max) {
          pendGo(self, self.waiting.shift());
        } else if (self.pending === 0) {
          var listeners = self.listeners;
          self.listeners = [];
          listeners.forEach(cbListener);
        }
      }
      function cbListener(listener) {
        listener(self.error);
      }
    }
    function pendGo(self, fn) {
      fn(pendHold(self));
    }
  }
});

// node_modules/yauzl/fd-slicer.js
var require_fd_slicer = __commonJS({
  "node_modules/yauzl/fd-slicer.js"(exports) {
    "use strict";
    var fs13 = __require("fs");
    var util2 = __require("util");
    var stream = __require("stream");
    var Readable = stream.Readable;
    var PassThrough = stream.PassThrough;
    var Pend = require_pend();
    var EventEmitter = __require("events").EventEmitter;
    exports.BufferSlicer = BufferSlicer;
    exports.FdSlicer = FdSlicer;
    util2.inherits(FdSlicer, EventEmitter);
    function FdSlicer(fd) {
      EventEmitter.call(this);
      this.fd = fd;
      this.pend = new Pend();
      this.pend.max = 1;
      this.refCount = 0;
    }
    FdSlicer.prototype.read = function(buffer, offset, length, position, callback) {
      var self = this;
      self.pend.go(function(cb) {
        fs13.read(self.fd, buffer, offset, length, position, function(err, bytesRead, buffer2) {
          cb();
          callback(err, bytesRead, buffer2);
        });
      });
    };
    FdSlicer.prototype.createReadStream = function(options2) {
      return new ReadStream(this, options2);
    };
    FdSlicer.prototype.ref = function() {
      this.refCount += 1;
    };
    FdSlicer.prototype.unref = function() {
      var self = this;
      self.refCount -= 1;
      if (self.refCount < 0) throw new Error("invalid unref");
      if (self.refCount > 0) return;
      fs13.close(self.fd, onCloseDone);
      function onCloseDone(err) {
        if (err) {
          self.emit("error", err);
        } else {
          self.emit("close");
        }
      }
    };
    util2.inherits(ReadStream, Readable);
    function ReadStream(context, options2) {
      options2 = options2 || {};
      Readable.call(this, options2);
      this.context = context;
      this.context.ref();
      this.start = options2.start || 0;
      this.endOffset = options2.end;
      this.pos = this.start;
    }
    ReadStream.prototype._read = function(n) {
      var self = this;
      var toRead = Math.min(self._readableState.highWaterMark, n);
      if (self.endOffset != null) {
        toRead = Math.min(toRead, self.endOffset - self.pos);
      }
      if (toRead <= 0) {
        self.push(null);
        this._cleanup();
        return;
      }
      self.context.pend.go(function(cb) {
        var buffer = Buffer.allocUnsafe(toRead);
        fs13.read(self.context.fd, buffer, 0, toRead, self.pos, function(err, bytesRead) {
          if (err) {
            self.destroy(err);
          } else if (bytesRead === 0) {
            self.push(null);
            self._cleanup();
          } else {
            self.pos += bytesRead;
            self.push(buffer.slice(0, bytesRead));
          }
          cb();
        });
      });
    };
    ReadStream.prototype._destroy = function(err, cb) {
      this._cleanup();
      cb(err);
    };
    ReadStream.prototype._cleanup = function() {
      if (this.context != null) {
        this.context.unref();
        this.context = null;
      }
    };
    util2.inherits(BufferSlicer, EventEmitter);
    function BufferSlicer(buffer) {
      EventEmitter.call(this);
      this.refCount = 0;
      this.buffer = buffer;
    }
    BufferSlicer.prototype.read = function(buffer, offset, length, position, callback) {
      if (!(0 <= offset && offset <= buffer.length)) throw new RangeError("offset outside buffer: 0 <= " + offset + " <= " + buffer.length);
      if (position < 0) throw new RangeError("position is negative: " + position);
      if (offset + length > buffer.length) {
        length = buffer.length - offset;
      }
      if (position + length > this.buffer.length) {
        length = this.buffer.length - position;
      }
      if (length <= 0) {
        setImmediate(function() {
          callback(null, 0);
        });
        return;
      }
      this.buffer.copy(buffer, offset, position, position + length);
      setImmediate(function() {
        callback(null, length);
      });
    };
    BufferSlicer.prototype.createReadStream = function(options2) {
      options2 = options2 || {};
      var readStream = new PassThrough(options2);
      readStream.start = options2.start || 0;
      readStream.endOffset = options2.end;
      readStream.pos = readStream.endOffset || this.buffer.length;
      var entireSlice = this.buffer.slice(readStream.start, readStream.pos);
      var maxChunkSize = 65536;
      var offset = 0;
      while (true) {
        var nextOffset = offset + maxChunkSize;
        if (nextOffset >= entireSlice.length) {
          if (offset < entireSlice.length) {
            readStream.write(entireSlice.slice(offset, entireSlice.length));
          }
          break;
        }
        readStream.write(entireSlice.slice(offset, nextOffset));
        offset = nextOffset;
      }
      readStream.end();
      return readStream;
    };
    BufferSlicer.prototype.ref = function() {
      this.refCount += 1;
    };
    BufferSlicer.prototype.unref = function() {
      this.refCount -= 1;
      if (this.refCount < 0) {
        throw new Error("invalid unref");
      }
    };
  }
});

// node_modules/yauzl/crc32.js
var require_crc32 = __commonJS({
  "node_modules/yauzl/crc32.js"(exports, module) {
    "use strict";
    var CRC_TABLE = new Int32Array([
      0,
      1996959894,
      3993919788,
      2567524794,
      124634137,
      1886057615,
      3915621685,
      2657392035,
      249268274,
      2044508324,
      3772115230,
      2547177864,
      162941995,
      2125561021,
      3887607047,
      2428444049,
      498536548,
      1789927666,
      4089016648,
      2227061214,
      450548861,
      1843258603,
      4107580753,
      2211677639,
      325883990,
      1684777152,
      4251122042,
      2321926636,
      335633487,
      1661365465,
      4195302755,
      2366115317,
      997073096,
      1281953886,
      3579855332,
      2724688242,
      1006888145,
      1258607687,
      3524101629,
      2768942443,
      901097722,
      1119000684,
      3686517206,
      2898065728,
      853044451,
      1172266101,
      3705015759,
      2882616665,
      651767980,
      1373503546,
      3369554304,
      3218104598,
      565507253,
      1454621731,
      3485111705,
      3099436303,
      671266974,
      1594198024,
      3322730930,
      2970347812,
      795835527,
      1483230225,
      3244367275,
      3060149565,
      1994146192,
      31158534,
      2563907772,
      4023717930,
      1907459465,
      112637215,
      2680153253,
      3904427059,
      2013776290,
      251722036,
      2517215374,
      3775830040,
      2137656763,
      141376813,
      2439277719,
      3865271297,
      1802195444,
      476864866,
      2238001368,
      4066508878,
      1812370925,
      453092731,
      2181625025,
      4111451223,
      1706088902,
      314042704,
      2344532202,
      4240017532,
      1658658271,
      366619977,
      2362670323,
      4224994405,
      1303535960,
      984961486,
      2747007092,
      3569037538,
      1256170817,
      1037604311,
      2765210733,
      3554079995,
      1131014506,
      879679996,
      2909243462,
      3663771856,
      1141124467,
      855842277,
      2852801631,
      3708648649,
      1342533948,
      654459306,
      3188396048,
      3373015174,
      1466479909,
      544179635,
      3110523913,
      3462522015,
      1591671054,
      702138776,
      2966460450,
      3352799412,
      1504918807,
      783551873,
      3082640443,
      3233442989,
      3988292384,
      2596254646,
      62317068,
      1957810842,
      3939845945,
      2647816111,
      81470997,
      1943803523,
      3814918930,
      2489596804,
      225274430,
      2053790376,
      3826175755,
      2466906013,
      167816743,
      2097651377,
      4027552580,
      2265490386,
      503444072,
      1762050814,
      4150417245,
      2154129355,
      426522225,
      1852507879,
      4275313526,
      2312317920,
      282753626,
      1742555852,
      4189708143,
      2394877945,
      397917763,
      1622183637,
      3604390888,
      2714866558,
      953729732,
      1340076626,
      3518719985,
      2797360999,
      1068828381,
      1219638859,
      3624741850,
      2936675148,
      906185462,
      1090812512,
      3747672003,
      2825379669,
      829329135,
      1181335161,
      3412177804,
      3160834842,
      628085408,
      1382605366,
      3423369109,
      3138078467,
      570562233,
      1426400815,
      3317316542,
      2998733608,
      733239954,
      1555261956,
      3268935591,
      3050360625,
      752459403,
      1541320221,
      2607071920,
      3965973030,
      1969922972,
      40735498,
      2617837225,
      3943577151,
      1913087877,
      83908371,
      2512341634,
      3803740692,
      2075208622,
      213261112,
      2463272603,
      3855990285,
      2094854071,
      198958881,
      2262029012,
      4057260610,
      1759359992,
      534414190,
      2176718541,
      4139329115,
      1873836001,
      414664567,
      2282248934,
      4279200368,
      1711684554,
      285281116,
      2405801727,
      4167216745,
      1634467795,
      376229701,
      2685067896,
      3608007406,
      1308918612,
      956543938,
      2808555105,
      3495958263,
      1231636301,
      1047427035,
      2932959818,
      3654703836,
      1088359270,
      936918e3,
      2847714899,
      3736837829,
      1202900863,
      817233897,
      3183342108,
      3401237130,
      1404277552,
      615818150,
      3134207493,
      3453421203,
      1423857449,
      601450431,
      3009837614,
      3294710456,
      1567103746,
      711928724,
      3020668471,
      3272380065,
      1510334235,
      755167117
    ]);
    function crc322(buf) {
      let crc = -1;
      for (let x of buf) {
        crc = CRC_TABLE[(crc ^ x) & 255] ^ crc >>> 8;
      }
      return (crc ^ -1) >>> 0;
    }
    module.exports = crc322;
  }
});

// node_modules/yauzl/index.js
var require_yauzl = __commonJS({
  "node_modules/yauzl/index.js"(exports) {
    "use strict";
    var fs13 = __require("fs");
    var zlib = __require("zlib");
    var fd_slicer = require_fd_slicer();
    var util2 = __require("util");
    var EventEmitter = __require("events").EventEmitter;
    var Transform2 = __require("stream").Transform;
    var PassThrough = __require("stream").PassThrough;
    var Writable = __require("stream").Writable;
    var crc322 = typeof zlib.crc32 === "function" ? zlib.crc32 : require_crc32();
    exports.open = open;
    exports.fromFd = fromFd;
    exports.fromBuffer = fromBuffer;
    exports.fromRandomAccessReader = fromRandomAccessReader;
    exports.openPromise = openPromise2;
    exports.fromFdPromise = fromFdPromise;
    exports.fromBufferPromise = fromBufferPromise;
    exports.fromRandomAccessReaderPromise = fromRandomAccessReaderPromise;
    exports.dosDateTimeToDate = dosDateTimeToDate;
    exports.getFileNameLowLevel = getFileNameLowLevel;
    exports.validateFileName = validateFileName;
    exports.parseExtraFields = parseExtraFields;
    exports.ZipFile = ZipFile;
    exports.Entry = Entry;
    exports.LocalFileHeader = LocalFileHeader;
    exports.RandomAccessReader = RandomAccessReader;
    function openPromise2(path12, options2) {
      return new Promise((resolve, reject) => {
        open(path12, { ...options2, lazyEntries: true }, function(err, zipfile) {
          if (err) return reject(err);
          resolve(zipfile);
        });
      });
    }
    function fromFdPromise(fd, options2) {
      return new Promise((resolve, reject) => {
        fromFd(fd, { ...options2, lazyEntries: true }, function(err, zipfile) {
          if (err) return reject(err);
          resolve(zipfile);
        });
      });
    }
    function fromBufferPromise(buffer, options2) {
      return new Promise((resolve, reject) => {
        fromBuffer(buffer, { ...options2, lazyEntries: true }, function(err, zipfile) {
          if (err) return reject(err);
          resolve(zipfile);
        });
      });
    }
    function fromRandomAccessReaderPromise(reader, totalSize, options2) {
      return new Promise((resolve, reject) => {
        fromRandomAccessReader(reader, totalSize, { ...options2, lazyEntries: true }, function(err, zipfile) {
          if (err) return reject(err);
          resolve(zipfile);
        });
      });
    }
    function open(path12, options2, callback) {
      if (typeof options2 === "function") {
        callback = options2;
        options2 = null;
      }
      if (options2 == null) options2 = {};
      if (options2.autoClose == null) options2.autoClose = true;
      if (options2.lazyEntries == null) options2.lazyEntries = false;
      if (options2.decodeStrings == null) options2.decodeStrings = true;
      if (options2.validateEntrySizes == null) options2.validateEntrySizes = true;
      if (options2.strictFileNames == null) options2.strictFileNames = false;
      if (callback == null) callback = defaultCallback;
      fs13.open(path12, "r", function(err, fd) {
        if (err) return callback(err);
        fromFd(fd, options2, function(err2, zipfile) {
          if (err2) fs13.close(fd, defaultCallback);
          callback(err2, zipfile);
        });
      });
    }
    function fromFd(fd, options2, callback) {
      if (typeof options2 === "function") {
        callback = options2;
        options2 = null;
      }
      if (options2 == null) options2 = {};
      if (options2.autoClose == null) options2.autoClose = false;
      if (options2.lazyEntries == null) options2.lazyEntries = false;
      if (options2.decodeStrings == null) options2.decodeStrings = true;
      if (options2.validateEntrySizes == null) options2.validateEntrySizes = true;
      if (options2.strictFileNames == null) options2.strictFileNames = false;
      if (callback == null) callback = defaultCallback;
      fs13.fstat(fd, function(err, stats) {
        if (err) return callback(err);
        var reader = new fd_slicer.FdSlicer(fd);
        fromRandomAccessReader(reader, stats.size, options2, callback);
      });
    }
    function fromBuffer(buffer, options2, callback) {
      if (typeof options2 === "function") {
        callback = options2;
        options2 = null;
      }
      if (options2 == null) options2 = {};
      options2.autoClose = false;
      if (options2.lazyEntries == null) options2.lazyEntries = false;
      if (options2.decodeStrings == null) options2.decodeStrings = true;
      if (options2.validateEntrySizes == null) options2.validateEntrySizes = true;
      if (options2.strictFileNames == null) options2.strictFileNames = false;
      var reader = new fd_slicer.BufferSlicer(buffer);
      fromRandomAccessReader(reader, buffer.length, options2, callback);
    }
    function fromRandomAccessReader(reader, totalSize, options2, callback) {
      if (typeof options2 === "function") {
        callback = options2;
        options2 = null;
      }
      if (options2 == null) options2 = {};
      if (options2.autoClose == null) options2.autoClose = true;
      if (options2.lazyEntries == null) options2.lazyEntries = false;
      if (options2.decodeStrings == null) options2.decodeStrings = true;
      var decodeStrings = !!options2.decodeStrings;
      if (options2.validateEntrySizes == null) options2.validateEntrySizes = true;
      if (options2.strictFileNames == null) options2.strictFileNames = false;
      if (callback == null) callback = defaultCallback;
      if (typeof totalSize !== "number") throw new Error("expected totalSize parameter to be a number");
      if (totalSize > Number.MAX_SAFE_INTEGER) {
        throw new Error("zip file too large. only file sizes up to 2^52 are supported due to JavaScript's Number type being an IEEE 754 double.");
      }
      reader.ref();
      var eocdrWithoutCommentSize = 22;
      var zip64EocdlSize = 20;
      var maxCommentSize = 65535;
      var bufferSize = Math.min(zip64EocdlSize + eocdrWithoutCommentSize + maxCommentSize, totalSize);
      var buffer = newBuffer(bufferSize);
      var bufferReadStart = totalSize - buffer.length;
      readAndAssertNoEof(reader, buffer, 0, bufferSize, bufferReadStart, function(err) {
        if (err) return callback(err);
        for (var i = bufferSize - eocdrWithoutCommentSize; i >= 0; i -= 1) {
          if (buffer.readUInt32LE(i) !== 101010256) continue;
          var eocdrBuffer = buffer.subarray(i);
          var diskNumber = eocdrBuffer.readUInt16LE(4);
          var entryCount = eocdrBuffer.readUInt16LE(10);
          var centralDirectoryOffset = eocdrBuffer.readUInt32LE(16);
          var commentLength = eocdrBuffer.readUInt16LE(20);
          var expectedCommentLength = eocdrBuffer.length - eocdrWithoutCommentSize;
          if (commentLength !== expectedCommentLength) {
            return callback(new Error("Invalid comment length. Expected: " + expectedCommentLength + ". Found: " + commentLength + ". Are there extra bytes at the end of the file? Or is the end of central dir signature `PK☺☻` in the comment?"));
          }
          var comment = decodeStrings ? decodeBuffer(eocdrBuffer.subarray(22), false) : eocdrBuffer.subarray(22);
          if (i - zip64EocdlSize >= 0 && buffer.readUInt32LE(i - zip64EocdlSize) === 117853008) {
            var zip64EocdlBuffer = buffer.subarray(i - zip64EocdlSize, i - zip64EocdlSize + zip64EocdlSize);
            var zip64EocdrOffset = readUInt64LE(zip64EocdlBuffer, 8);
            var zip64EocdrBuffer = newBuffer(56);
            return readAndAssertNoEof(reader, zip64EocdrBuffer, 0, zip64EocdrBuffer.length, zip64EocdrOffset, function(err2) {
              if (err2) return callback(err2);
              if (zip64EocdrBuffer.readUInt32LE(0) !== 101075792) {
                return callback(new Error("invalid zip64 end of central directory record signature"));
              }
              diskNumber = zip64EocdrBuffer.readUInt32LE(16);
              if (diskNumber !== 0) {
                return callback(new Error("multi-disk zip files are not supported: found disk number: " + diskNumber));
              }
              entryCount = readUInt64LE(zip64EocdrBuffer, 32);
              centralDirectoryOffset = readUInt64LE(zip64EocdrBuffer, 48);
              return callback(null, new ZipFile(reader, centralDirectoryOffset, totalSize, entryCount, comment, options2.autoClose, options2.lazyEntries, decodeStrings, options2.validateEntrySizes, options2.strictFileNames));
            });
          }
          if (diskNumber !== 0) {
            return callback(new Error("multi-disk zip files are not supported: found disk number: " + diskNumber));
          }
          return callback(null, new ZipFile(reader, centralDirectoryOffset, totalSize, entryCount, comment, options2.autoClose, options2.lazyEntries, decodeStrings, options2.validateEntrySizes, options2.strictFileNames));
        }
        callback(new Error("End of central directory record signature not found. Either not a zip file, or file is truncated."));
      });
    }
    util2.inherits(ZipFile, EventEmitter);
    function ZipFile(reader, centralDirectoryOffset, fileSize, entryCount, comment, autoClose, lazyEntries, decodeStrings, validateEntrySizes, strictFileNames) {
      var self = this;
      EventEmitter.call(self);
      self.reader = reader;
      self.reader.on("error", function(err) {
        emitError(self, err);
      });
      self.reader.once("close", function() {
        self.emit("close");
      });
      self.readEntryCursor = centralDirectoryOffset;
      self.fileSize = fileSize;
      self.entryCount = entryCount;
      self.comment = comment;
      self.entriesRead = 0;
      self.autoClose = !!autoClose;
      self.lazyEntries = !!lazyEntries;
      self.decodeStrings = !!decodeStrings;
      self.validateEntrySizes = !!validateEntrySizes;
      self.strictFileNames = !!strictFileNames;
      self.isOpen = true;
      self.emittedError = false;
      self.hasEachEntryBeenCalled = false;
      if (!self.lazyEntries) self._readEntry();
    }
    ZipFile.prototype.close = function() {
      if (!this.isOpen) return;
      this.isOpen = false;
      this.reader.unref();
    };
    function emitErrorAndAutoClose(self, err) {
      if (self.autoClose) self.close();
      emitError(self, err);
    }
    function emitError(self, err) {
      if (self.emittedError) return;
      self.emittedError = true;
      self.emit("error", err);
    }
    ZipFile.prototype.readEntry = function() {
      if (!this.lazyEntries) throw new Error("readEntry() called without lazyEntries:true");
      this._readEntry();
    };
    ZipFile.prototype._readEntry = function() {
      var self = this;
      if (self.entryCount === self.entriesRead) {
        setImmediate(function() {
          if (self.autoClose) self.close();
          if (self.emittedError) return;
          self.emit("end");
        });
        return;
      }
      if (self.emittedError) return;
      var buffer = newBuffer(46);
      readAndAssertNoEof(self.reader, buffer, 0, buffer.length, self.readEntryCursor, function(err) {
        if (err) return emitErrorAndAutoClose(self, err);
        if (self.emittedError) return;
        var entry = new Entry();
        var signature = buffer.readUInt32LE(0);
        if (signature !== 33639248) return emitErrorAndAutoClose(self, new Error("invalid central directory file header signature: 0x" + signature.toString(16)));
        entry.versionMadeBy = buffer.readUInt16LE(4);
        entry.versionNeededToExtract = buffer.readUInt16LE(6);
        entry.generalPurposeBitFlag = buffer.readUInt16LE(8);
        entry.compressionMethod = buffer.readUInt16LE(10);
        entry.lastModFileTime = buffer.readUInt16LE(12);
        entry.lastModFileDate = buffer.readUInt16LE(14);
        entry.crc32 = buffer.readUInt32LE(16);
        entry.compressedSize = buffer.readUInt32LE(20);
        entry.uncompressedSize = buffer.readUInt32LE(24);
        entry.fileNameLength = buffer.readUInt16LE(28);
        entry.extraFieldLength = buffer.readUInt16LE(30);
        entry.fileCommentLength = buffer.readUInt16LE(32);
        entry.internalFileAttributes = buffer.readUInt16LE(36);
        entry.externalFileAttributes = buffer.readUInt32LE(38);
        entry.relativeOffsetOfLocalHeader = buffer.readUInt32LE(42);
        if (entry.generalPurposeBitFlag & 64) return emitErrorAndAutoClose(self, new Error("strong encryption is not supported"));
        self.readEntryCursor += 46;
        buffer = newBuffer(entry.fileNameLength + entry.extraFieldLength + entry.fileCommentLength);
        readAndAssertNoEof(self.reader, buffer, 0, buffer.length, self.readEntryCursor, function(err2) {
          if (err2) return emitErrorAndAutoClose(self, err2);
          if (self.emittedError) return;
          entry.fileNameRaw = buffer.subarray(0, entry.fileNameLength);
          var fileCommentStart = entry.fileNameLength + entry.extraFieldLength;
          entry.extraFieldRaw = buffer.subarray(entry.fileNameLength, fileCommentStart);
          entry.fileCommentRaw = buffer.subarray(fileCommentStart, fileCommentStart + entry.fileCommentLength);
          try {
            entry.extraFields = parseExtraFields(entry.extraFieldRaw);
          } catch (err3) {
            return emitErrorAndAutoClose(self, err3);
          }
          if (self.decodeStrings) {
            var isUtf8 = (entry.generalPurposeBitFlag & 2048) !== 0;
            entry.fileComment = decodeBuffer(entry.fileCommentRaw, isUtf8);
            entry.fileName = getFileNameLowLevel(entry.generalPurposeBitFlag, entry.fileNameRaw, entry.extraFields, self.strictFileNames);
            var errorMessage = validateFileName(entry.fileName);
            if (errorMessage != null) return emitErrorAndAutoClose(self, new Error(errorMessage));
          } else {
            entry.fileComment = entry.fileCommentRaw;
            entry.fileName = entry.fileNameRaw;
          }
          entry.comment = entry.fileComment;
          self.readEntryCursor += buffer.length;
          self.entriesRead += 1;
          for (var i = 0; i < entry.extraFields.length; i++) {
            var extraField = entry.extraFields[i];
            if (extraField.id !== 1) continue;
            var zip64EiefBuffer = extraField.data;
            var index = 0;
            if (entry.uncompressedSize === 4294967295) {
              if (index + 8 > zip64EiefBuffer.length) {
                return emitErrorAndAutoClose(self, new Error("zip64 extended information extra field does not include uncompressed size"));
              }
              entry.uncompressedSize = readUInt64LE(zip64EiefBuffer, index);
              index += 8;
            }
            if (entry.compressedSize === 4294967295) {
              if (index + 8 > zip64EiefBuffer.length) {
                return emitErrorAndAutoClose(self, new Error("zip64 extended information extra field does not include compressed size"));
              }
              entry.compressedSize = readUInt64LE(zip64EiefBuffer, index);
              index += 8;
            }
            if (entry.relativeOffsetOfLocalHeader === 4294967295) {
              if (index + 8 > zip64EiefBuffer.length) {
                return emitErrorAndAutoClose(self, new Error("zip64 extended information extra field does not include relative header offset"));
              }
              entry.relativeOffsetOfLocalHeader = readUInt64LE(zip64EiefBuffer, index);
              index += 8;
            }
            break;
          }
          if (self.validateEntrySizes && entry.compressionMethod === 0) {
            var expectedCompressedSize = entry.uncompressedSize;
            if (entry.isEncrypted()) {
              expectedCompressedSize += 12;
            }
            if (entry.compressedSize !== expectedCompressedSize) {
              var msg = "compressed/uncompressed size mismatch for stored file: " + entry.compressedSize + " != " + entry.uncompressedSize;
              return emitErrorAndAutoClose(self, new Error(msg));
            }
          }
          self.emit("entry", entry);
          if (!self.lazyEntries) self._readEntry();
        });
      });
    };
    ZipFile.prototype.eachEntry = function() {
      const self = this;
      if (!self.lazyEntries) throw new Error("eachEntry() requires lazyEntries: true");
      if (self.hasEachEntryBeenCalled) throw new Error("eachEntry() must only be called once per ZipFile");
      self.hasEachEntryBeenCalled = true;
      let pendingResolveReject = null;
      self.on("entry", onEntry);
      self.on("end", onEnd);
      self.on("error", onError);
      function cleanup() {
        self.removeListener("entry", onEntry);
        self.removeListener("end", onEnd);
        self.removeListener("error", onError);
        if (self.autoClose) self.close();
      }
      function onEntry(entry) {
        let { resolve } = pendingResolveReject;
        pendingResolveReject = null;
        resolve({ value: entry });
      }
      function onEnd() {
        let { resolve } = pendingResolveReject;
        pendingResolveReject = null;
        cleanup();
        resolve({ done: true });
      }
      function onError(err) {
        let { reject } = pendingResolveReject;
        pendingResolveReject = null;
        cleanup();
        reject(err);
      }
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next() {
          const promise = new Promise((resolve, reject) => {
            if (pendingResolveReject != null) throw new Error("next() called before previous Promise was resolved.");
            pendingResolveReject = { resolve, reject };
          });
          self.readEntry();
          return promise;
        },
        return(value) {
          cleanup();
          return Promise.resolve({ done: true, value });
        },
        throw(value) {
          cleanup();
          return Promise.reject(value);
        }
      };
    };
    ZipFile.prototype.openReadStream = function(entry, options2, callback) {
      var self = this;
      var relativeStart = 0;
      var relativeEnd = entry.compressedSize;
      if (callback == null) {
        callback = options2;
        options2 = null;
      }
      if (options2 == null) {
        options2 = {};
      } else {
        if (options2.decodeFileData === false) {
          if (options2.decrypt != null) {
            throw new Error("cannot use options.decrypt when options.decodeFileData === false");
          }
          if (options2.decompress != null) {
            throw new Error("cannot use options.decompress when options.decodeFileData === false");
          }
        } else {
          if (options2.decrypt != null) {
            if (!entry.isEncrypted()) {
              throw new Error("options.decrypt can only be specified for encrypted entries. See also option decodeFileData.");
            }
            if (options2.decrypt !== false) throw new Error("invalid options.decrypt value: " + options2.decrypt);
            if (entry.isCompressed()) {
              if (options2.decompress !== false) throw new Error("entry is encrypted and compressed, and options.decompress !== false. See also option decodeFileData.");
            }
          }
          if (options2.decompress != null) {
            if (!entry.isCompressed()) {
              throw new Error("options.decompress can only be specified for compressed entries. See also option decodeFileData.");
            }
            if (!(options2.decompress === false || options2.decompress === true)) {
              throw new Error("invalid options.decompress value: " + options2.decompress);
            }
            decompress = options2.decompress;
          }
        }
        if (options2.start != null) {
          relativeStart = options2.start;
          if (relativeStart < 0) throw new Error("options.start < 0");
          if (relativeStart > entry.compressedSize) throw new Error("options.start > entry.compressedSize");
        }
        if (options2.end != null) {
          relativeEnd = options2.end;
          if (relativeEnd < 0) throw new Error("options.end < 0");
          if (relativeEnd > entry.compressedSize) throw new Error("options.end > entry.compressedSize");
          if (relativeEnd < relativeStart) throw new Error("options.end < options.start");
        }
      }
      var rawMode = options2.decodeFileData === false || // Explicitly requested raw.
      (entry.compressionMethod === 0 || // Naturally without compression.
      entry.compressionMethod === 8 && options2.decompress === false) && (!entry.isEncrypted() || // Naturally without encryption.
      options2.decrypt === false);
      if (options2.start != null || options2.end != null) {
        if (!rawMode) throw new Error("start/end range require options.decodeFileData === false for non-trivial encoded entries.");
      }
      if (!self.isOpen) return callback(new Error("closed"));
      if (entry.isEncrypted() && !rawMode) {
        if (options2.decrypt !== false) return callback(new Error("entry is encrypted, and options.decodeFileData !== false"));
      }
      var decompress;
      if (rawMode) {
        decompress = false;
      } else if (entry.compressionMethod === 8) {
        decompress = options2.decodeFileData !== true;
      } else {
        return callback(new Error("unsupported compression method: " + entry.compressionMethod));
      }
      self.readLocalFileHeader(entry, { minimal: true }, function(err, localFileHeader) {
        if (err) return callback(err);
        self.openReadStreamLowLevel(
          localFileHeader.fileDataStart,
          entry.compressedSize,
          relativeStart,
          relativeEnd,
          decompress,
          entry.uncompressedSize,
          callback
        );
      });
    };
    ZipFile.prototype.openReadStreamLowLevel = function(fileDataStart, compressedSize, relativeStart, relativeEnd, decompress, uncompressedSize, callback) {
      var self = this;
      var fileDataEnd = fileDataStart + compressedSize;
      var readStream = self.reader.createReadStream({
        start: fileDataStart + relativeStart,
        end: fileDataStart + relativeEnd
      });
      var endpointStream = readStream;
      if (decompress) {
        var destroyed = false;
        var inflateFilter = zlib.createInflateRaw();
        readStream.on("error", function(err) {
          setImmediate(function() {
            if (!destroyed) inflateFilter.emit("error", err);
          });
        });
        readStream.pipe(inflateFilter);
        if (self.validateEntrySizes) {
          endpointStream = new AssertByteCountStream(uncompressedSize);
          inflateFilter.on("error", function(err) {
            setImmediate(function() {
              if (!destroyed) endpointStream.emit("error", err);
            });
          });
          inflateFilter.pipe(endpointStream);
        } else {
          endpointStream = inflateFilter;
        }
        installDestroyFn(endpointStream, function() {
          destroyed = true;
          if (inflateFilter !== endpointStream) inflateFilter.unpipe(endpointStream);
          readStream.unpipe(inflateFilter);
          readStream.destroy();
        });
      }
      callback(null, endpointStream);
    };
    ZipFile.prototype.readLocalFileHeader = function(entry, options2, callback) {
      var self = this;
      if (callback == null) {
        callback = options2;
        options2 = null;
      }
      if (options2 == null) options2 = {};
      self.reader.ref();
      var buffer = newBuffer(30);
      readAndAssertNoEof(self.reader, buffer, 0, buffer.length, entry.relativeOffsetOfLocalHeader, function(err) {
        try {
          if (err) return callback(err);
          var signature = buffer.readUInt32LE(0);
          if (signature !== 67324752) {
            return callback(new Error("invalid local file header signature: 0x" + signature.toString(16)));
          }
          var fileNameLength = buffer.readUInt16LE(26);
          var extraFieldLength = buffer.readUInt16LE(28);
          var fileDataStart = entry.relativeOffsetOfLocalHeader + 30 + fileNameLength + extraFieldLength;
          if (fileDataStart + entry.compressedSize > self.fileSize) {
            return callback(new Error("file data overflows file bounds: " + fileDataStart + " + " + entry.compressedSize + " > " + self.fileSize));
          }
          if (options2.minimal) {
            return callback(null, { fileDataStart });
          }
          var localFileHeader = new LocalFileHeader();
          localFileHeader.fileDataStart = fileDataStart;
          localFileHeader.versionNeededToExtract = buffer.readUInt16LE(4);
          localFileHeader.generalPurposeBitFlag = buffer.readUInt16LE(6);
          localFileHeader.compressionMethod = buffer.readUInt16LE(8);
          localFileHeader.lastModFileTime = buffer.readUInt16LE(10);
          localFileHeader.lastModFileDate = buffer.readUInt16LE(12);
          localFileHeader.crc32 = buffer.readUInt32LE(14);
          localFileHeader.compressedSize = buffer.readUInt32LE(18);
          localFileHeader.uncompressedSize = buffer.readUInt32LE(22);
          localFileHeader.fileNameLength = fileNameLength;
          localFileHeader.extraFieldLength = extraFieldLength;
          buffer = newBuffer(fileNameLength + extraFieldLength);
          self.reader.ref();
          readAndAssertNoEof(self.reader, buffer, 0, buffer.length, entry.relativeOffsetOfLocalHeader + 30, function(err2) {
            try {
              if (err2) return callback(err2);
              localFileHeader.fileName = buffer.subarray(0, fileNameLength);
              localFileHeader.extraField = buffer.subarray(fileNameLength);
              return callback(null, localFileHeader);
            } finally {
              self.reader.unref();
            }
          });
        } finally {
          self.reader.unref();
        }
      });
    };
    ZipFile.prototype.openReadStreamPromise = function(entry, options2) {
      return new Promise((resolve, reject) => {
        this.openReadStream(entry, options2, function(err, readStream) {
          if (err) return reject(err);
          resolve(readStream);
        });
      });
    };
    ZipFile.prototype.openReadStreamLowLevelPromise = function(fileDataStart, compressedSize, relativeStart, relativeEnd, decompress, uncompressedSize) {
      return new Promise((resolve, reject) => {
        this.openReadStream(fileDataStart, compressedSize, relativeStart, relativeEnd, decompress, uncompressedSize, function(err, readStream) {
          if (err) return reject(err);
          resolve(readStream);
        });
      });
    };
    ZipFile.prototype.readLocalFileHeaderPromise = function(entry, options2) {
      return new Promise((resolve, reject) => {
        this.readLocalFileHeader(entry, options2, function(err, localFileHeader) {
          if (err) return reject(err);
          resolve(localFileHeader);
        });
      });
    };
    function Entry() {
    }
    Entry.prototype.getLastModDate = function(options2) {
      if (options2 == null) options2 = {};
      if (!options2.forceDosFormat) {
        for (var i = 0; i < this.extraFields.length; i++) {
          var extraField = this.extraFields[i];
          if (extraField.id === 21589) {
            var data = extraField.data;
            if (data.length < 5) continue;
            var flags = data[0];
            var HAS_MTIME = 1;
            if (!(flags & HAS_MTIME)) continue;
            var posixTimestamp = data.readInt32LE(1);
            return new Date(posixTimestamp * 1e3);
          } else if (extraField.id === 10) {
            var data = extraField.data;
            if (data.length !== 32) continue;
            if (data.readUInt16LE(4) !== 1) continue;
            if (data.readUInt16LE(6) !== 24) continue;
            var hundredNanoSecondsSince1601 = data.readUInt32LE(8) + 4294967296 * data.readInt32LE(12);
            var millisecondsSince1970 = hundredNanoSecondsSince1601 / 1e4 - 116444736e5;
            return new Date(millisecondsSince1970);
          }
        }
      }
      return dosDateTimeToDate(this.lastModFileDate, this.lastModFileTime, options2.timezone);
    };
    Entry.prototype.canDecodeFileData = function() {
      return !this.isEncrypted() && (this.compressionMethod === 0 || this.compressionMethod === 8);
    };
    Entry.prototype.isEncrypted = function() {
      return (this.generalPurposeBitFlag & 1) !== 0;
    };
    Entry.prototype.isCompressed = function() {
      return this.compressionMethod === 8;
    };
    function LocalFileHeader() {
    }
    function dosDateTimeToDate(date, time, timezone) {
      var day = date & 31;
      var month = (date >> 5 & 15) - 1;
      var year = (date >> 9 & 127) + 1980;
      var millisecond = 0;
      var second = (time & 31) * 2;
      var minute = time >> 5 & 63;
      var hour = time >> 11 & 31;
      if (timezone == null || timezone === "local") {
        return new Date(year, month, day, hour, minute, second, millisecond);
      } else if (timezone === "UTC") {
        return new Date(Date.UTC(year, month, day, hour, minute, second, millisecond));
      } else {
        throw new Error("unrecognized options.timezone: " + options.timezone);
      }
    }
    function getFileNameLowLevel(generalPurposeBitFlag, fileNameBuffer, extraFields, strictFileNames) {
      var fileName = null;
      for (var i = 0; i < extraFields.length; i++) {
        var extraField = extraFields[i];
        if (extraField.id === 28789) {
          if (extraField.data.length < 6) {
            continue;
          }
          if (extraField.data.readUInt8(0) !== 1) {
            continue;
          }
          var oldNameCrc32 = extraField.data.readUInt32LE(1);
          if (crc322(fileNameBuffer) !== oldNameCrc32) {
            continue;
          }
          fileName = decodeBuffer(extraField.data.subarray(5), true);
          break;
        }
      }
      if (fileName == null) {
        var isUtf8 = (generalPurposeBitFlag & 2048) !== 0;
        fileName = decodeBuffer(fileNameBuffer, isUtf8);
      }
      if (!strictFileNames) {
        fileName = fileName.replace(/\\/g, "/");
      }
      return fileName;
    }
    function validateFileName(fileName) {
      if (fileName.indexOf("\\") !== -1) {
        return "invalid characters in fileName: " + fileName;
      }
      if (/^[a-zA-Z]:/.test(fileName) || /^\//.test(fileName)) {
        return "absolute path: " + fileName;
      }
      if (fileName.split("/").indexOf("..") !== -1) {
        return "invalid relative path: " + fileName;
      }
      return null;
    }
    function parseExtraFields(extraFieldBuffer) {
      var extraFields = [];
      var i = 0;
      while (i < extraFieldBuffer.length - 3) {
        var headerId = extraFieldBuffer.readUInt16LE(i + 0);
        var dataSize = extraFieldBuffer.readUInt16LE(i + 2);
        var dataStart = i + 4;
        var dataEnd = dataStart + dataSize;
        if (dataEnd > extraFieldBuffer.length) throw new Error("extra field length exceeds extra field buffer size");
        var dataBuffer = extraFieldBuffer.subarray(dataStart, dataEnd);
        extraFields.push({
          id: headerId,
          data: dataBuffer
        });
        i = dataEnd;
      }
      return extraFields;
    }
    function readAndAssertNoEof(reader, buffer, offset, length, position, callback) {
      if (length === 0) {
        return setImmediate(function() {
          callback(null, newBuffer(0));
        });
      }
      reader.read(buffer, offset, length, position, function(err, bytesRead) {
        if (err) return callback(err);
        if (bytesRead < length) {
          return callback(new Error("unexpected EOF"));
        }
        callback();
      });
    }
    util2.inherits(AssertByteCountStream, Transform2);
    function AssertByteCountStream(byteCount) {
      Transform2.call(this);
      this.actualByteCount = 0;
      this.expectedByteCount = byteCount;
    }
    AssertByteCountStream.prototype._transform = function(chunk, encoding, cb) {
      this.actualByteCount += chunk.length;
      if (this.actualByteCount > this.expectedByteCount) {
        var msg = "too many bytes in the stream. expected " + this.expectedByteCount + ". got at least " + this.actualByteCount;
        return cb(new Error(msg));
      }
      cb(null, chunk);
    };
    AssertByteCountStream.prototype._flush = function(cb) {
      if (this.actualByteCount < this.expectedByteCount) {
        var msg = "not enough bytes in the stream. expected " + this.expectedByteCount + ". got only " + this.actualByteCount;
        return cb(new Error(msg));
      }
      cb();
    };
    util2.inherits(RandomAccessReader, EventEmitter);
    function RandomAccessReader() {
      EventEmitter.call(this);
      this.refCount = 0;
    }
    RandomAccessReader.prototype.ref = function() {
      this.refCount += 1;
    };
    RandomAccessReader.prototype.unref = function() {
      var self = this;
      self.refCount -= 1;
      if (self.refCount > 0) return;
      if (self.refCount < 0) throw new Error("invalid unref");
      self.close(onCloseDone);
      function onCloseDone(err) {
        if (err) return self.emit("error", err);
        self.emit("close");
      }
    };
    RandomAccessReader.prototype.createReadStream = function(options2) {
      if (options2 == null) options2 = {};
      var start = options2.start;
      var end = options2.end;
      if (start === end) {
        var emptyStream = new PassThrough();
        setImmediate(function() {
          emptyStream.end();
        });
        return emptyStream;
      }
      var stream = this._readStreamForRange(start, end);
      var destroyed = false;
      var refUnrefFilter = new RefUnrefFilter(this);
      stream.on("error", function(err) {
        setImmediate(function() {
          if (!destroyed) refUnrefFilter.emit("error", err);
        });
      });
      installDestroyFn(refUnrefFilter, function() {
        stream.unpipe(refUnrefFilter);
        refUnrefFilter.unref();
        stream.destroy();
      });
      var byteCounter = new AssertByteCountStream(end - start);
      refUnrefFilter.on("error", function(err) {
        setImmediate(function() {
          if (!destroyed) byteCounter.emit("error", err);
        });
      });
      installDestroyFn(byteCounter, function() {
        destroyed = true;
        refUnrefFilter.unpipe(byteCounter);
        refUnrefFilter.destroy();
      });
      return stream.pipe(refUnrefFilter).pipe(byteCounter);
    };
    RandomAccessReader.prototype._readStreamForRange = function(start, end) {
      throw new Error("not implemented");
    };
    RandomAccessReader.prototype.read = function(buffer, offset, length, position, callback) {
      var readStream = this.createReadStream({ start: position, end: position + length });
      var writeStream = new Writable();
      var written = 0;
      writeStream._write = function(chunk, encoding, cb) {
        chunk.copy(buffer, offset + written, 0, chunk.length);
        written += chunk.length;
        cb();
      };
      writeStream.on("finish", callback);
      readStream.on("error", function(error) {
        callback(error);
      });
      readStream.pipe(writeStream);
    };
    RandomAccessReader.prototype.close = function(callback) {
      setImmediate(callback);
    };
    util2.inherits(RefUnrefFilter, PassThrough);
    function RefUnrefFilter(context) {
      PassThrough.call(this);
      this.context = context;
      this.context.ref();
      this.unreffedYet = false;
    }
    RefUnrefFilter.prototype._flush = function(cb) {
      this.unref();
      cb();
    };
    RefUnrefFilter.prototype.unref = function(cb) {
      if (this.unreffedYet) return;
      this.unreffedYet = true;
      this.context.unref();
    };
    var cp437 = "\0☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼ !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~⌂ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";
    function decodeBuffer(buffer, isUtf8) {
      if (isUtf8) {
        return buffer.toString("utf8");
      } else {
        var result = "";
        for (var i = 0; i < buffer.length; i++) {
          result += cp437[buffer[i]];
        }
        return result;
      }
    }
    function readUInt64LE(buffer, offset) {
      var lower32 = buffer.readUInt32LE(offset);
      var upper32 = buffer.readUInt32LE(offset + 4);
      return upper32 * 4294967296 + lower32;
    }
    var newBuffer;
    if (typeof Buffer.allocUnsafe === "function") {
      newBuffer = function(len) {
        return Buffer.allocUnsafe(len);
      };
    } else {
      newBuffer = function(len) {
        return new Buffer(len);
      };
    }
    function installDestroyFn(stream, fn) {
      if (typeof stream.destroy === "function") {
        stream._destroy = function(err, cb) {
          fn();
          if (cb != null) cb(err);
        };
      } else {
        stream.destroy = fn;
      }
    }
    function defaultCallback(err) {
      if (err) throw err;
    }
  }
});

// .teamuq/scripts/plugin-tools/tuq-plugin-tool.entry.ts
import { createHash as createHash9, createPublicKey as createPublicKey6, randomBytes as randomBytes6 } from "node:crypto";
import { promises as fs12, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os3 from "node:os";
import path11 from "node:path";
import { fileURLToPath } from "node:url";

// node_modules/zod/v3/external.js
var external_exports = {};
__export(external_exports, {
  BRAND: () => BRAND,
  DIRTY: () => DIRTY,
  EMPTY_PATH: () => EMPTY_PATH,
  INVALID: () => INVALID,
  NEVER: () => NEVER,
  OK: () => OK,
  ParseStatus: () => ParseStatus,
  Schema: () => ZodType,
  ZodAny: () => ZodAny,
  ZodArray: () => ZodArray,
  ZodBigInt: () => ZodBigInt,
  ZodBoolean: () => ZodBoolean,
  ZodBranded: () => ZodBranded,
  ZodCatch: () => ZodCatch,
  ZodDate: () => ZodDate,
  ZodDefault: () => ZodDefault,
  ZodDiscriminatedUnion: () => ZodDiscriminatedUnion,
  ZodEffects: () => ZodEffects,
  ZodEnum: () => ZodEnum,
  ZodError: () => ZodError,
  ZodFirstPartyTypeKind: () => ZodFirstPartyTypeKind,
  ZodFunction: () => ZodFunction,
  ZodIntersection: () => ZodIntersection,
  ZodIssueCode: () => ZodIssueCode,
  ZodLazy: () => ZodLazy,
  ZodLiteral: () => ZodLiteral,
  ZodMap: () => ZodMap,
  ZodNaN: () => ZodNaN,
  ZodNativeEnum: () => ZodNativeEnum,
  ZodNever: () => ZodNever,
  ZodNull: () => ZodNull,
  ZodNullable: () => ZodNullable,
  ZodNumber: () => ZodNumber,
  ZodObject: () => ZodObject,
  ZodOptional: () => ZodOptional,
  ZodParsedType: () => ZodParsedType,
  ZodPipeline: () => ZodPipeline,
  ZodPromise: () => ZodPromise,
  ZodReadonly: () => ZodReadonly,
  ZodRecord: () => ZodRecord,
  ZodSchema: () => ZodType,
  ZodSet: () => ZodSet,
  ZodString: () => ZodString,
  ZodSymbol: () => ZodSymbol,
  ZodTransformer: () => ZodEffects,
  ZodTuple: () => ZodTuple,
  ZodType: () => ZodType,
  ZodUndefined: () => ZodUndefined,
  ZodUnion: () => ZodUnion,
  ZodUnknown: () => ZodUnknown,
  ZodVoid: () => ZodVoid,
  addIssueToContext: () => addIssueToContext,
  any: () => anyType,
  array: () => arrayType,
  bigint: () => bigIntType,
  boolean: () => booleanType,
  coerce: () => coerce,
  custom: () => custom,
  date: () => dateType,
  datetimeRegex: () => datetimeRegex,
  defaultErrorMap: () => en_default,
  discriminatedUnion: () => discriminatedUnionType,
  effect: () => effectsType,
  enum: () => enumType,
  function: () => functionType,
  getErrorMap: () => getErrorMap,
  getParsedType: () => getParsedType,
  instanceof: () => instanceOfType,
  intersection: () => intersectionType,
  isAborted: () => isAborted,
  isAsync: () => isAsync,
  isDirty: () => isDirty,
  isValid: () => isValid,
  late: () => late,
  lazy: () => lazyType,
  literal: () => literalType,
  makeIssue: () => makeIssue,
  map: () => mapType,
  nan: () => nanType,
  nativeEnum: () => nativeEnumType,
  never: () => neverType,
  null: () => nullType,
  nullable: () => nullableType,
  number: () => numberType,
  object: () => objectType,
  objectUtil: () => objectUtil,
  oboolean: () => oboolean,
  onumber: () => onumber,
  optional: () => optionalType,
  ostring: () => ostring,
  pipeline: () => pipelineType,
  preprocess: () => preprocessType,
  promise: () => promiseType,
  quotelessJson: () => quotelessJson,
  record: () => recordType,
  set: () => setType,
  setErrorMap: () => setErrorMap,
  strictObject: () => strictObjectType,
  string: () => stringType,
  symbol: () => symbolType,
  transformer: () => effectsType,
  tuple: () => tupleType,
  undefined: () => undefinedType,
  union: () => unionType,
  unknown: () => unknownType,
  util: () => util,
  void: () => voidType
});

// node_modules/zod/v3/helpers/util.js
var util;
(function(util2) {
  util2.assertEqual = (_) => {
  };
  function assertIs(_arg) {
  }
  util2.assertIs = assertIs;
  function assertNever(_x) {
    throw new Error();
  }
  util2.assertNever = assertNever;
  util2.arrayToEnum = (items) => {
    const obj = {};
    for (const item of items) {
      obj[item] = item;
    }
    return obj;
  };
  util2.getValidEnumValues = (obj) => {
    const validKeys = util2.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
    const filtered = {};
    for (const k of validKeys) {
      filtered[k] = obj[k];
    }
    return util2.objectValues(filtered);
  };
  util2.objectValues = (obj) => {
    return util2.objectKeys(obj).map(function(e) {
      return obj[e];
    });
  };
  util2.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object) => {
    const keys = [];
    for (const key2 in object) {
      if (Object.prototype.hasOwnProperty.call(object, key2)) {
        keys.push(key2);
      }
    }
    return keys;
  };
  util2.find = (arr, checker) => {
    for (const item of arr) {
      if (checker(item))
        return item;
    }
    return void 0;
  };
  util2.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
  function joinValues(array, separator = " | ") {
    return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
  }
  util2.joinValues = joinValues;
  util2.jsonStringifyReplacer = (_, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };
})(util || (util = {}));
var objectUtil;
(function(objectUtil2) {
  objectUtil2.mergeShapes = (first, second) => {
    return {
      ...first,
      ...second
      // second overwrites first
    };
  };
})(objectUtil || (objectUtil = {}));
var ZodParsedType = util.arrayToEnum([
  "string",
  "nan",
  "number",
  "integer",
  "float",
  "boolean",
  "date",
  "bigint",
  "symbol",
  "function",
  "undefined",
  "null",
  "array",
  "object",
  "unknown",
  "promise",
  "void",
  "never",
  "map",
  "set"
]);
var getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return ZodParsedType.undefined;
    case "string":
      return ZodParsedType.string;
    case "number":
      return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
    case "boolean":
      return ZodParsedType.boolean;
    case "function":
      return ZodParsedType.function;
    case "bigint":
      return ZodParsedType.bigint;
    case "symbol":
      return ZodParsedType.symbol;
    case "object":
      if (Array.isArray(data)) {
        return ZodParsedType.array;
      }
      if (data === null) {
        return ZodParsedType.null;
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return ZodParsedType.promise;
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return ZodParsedType.map;
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return ZodParsedType.set;
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return ZodParsedType.date;
      }
      return ZodParsedType.object;
    default:
      return ZodParsedType.unknown;
  }
};

// node_modules/zod/v3/ZodError.js
var ZodIssueCode = util.arrayToEnum([
  "invalid_type",
  "invalid_literal",
  "custom",
  "invalid_union",
  "invalid_union_discriminator",
  "invalid_enum_value",
  "unrecognized_keys",
  "invalid_arguments",
  "invalid_return_type",
  "invalid_date",
  "invalid_string",
  "too_small",
  "too_big",
  "invalid_intersection_types",
  "not_multiple_of",
  "not_finite"
]);
var quotelessJson = (obj) => {
  const json = JSON.stringify(obj, null, 2);
  return json.replace(/"([^"]+)":/g, "$1:");
};
var ZodError = class _ZodError extends Error {
  get errors() {
    return this.issues;
  }
  constructor(issues) {
    super();
    this.issues = [];
    this.addIssue = (sub) => {
      this.issues = [...this.issues, sub];
    };
    this.addIssues = (subs = []) => {
      this.issues = [...this.issues, ...subs];
    };
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(this, actualProto);
    } else {
      this.__proto__ = actualProto;
    }
    this.name = "ZodError";
    this.issues = issues;
  }
  format(_mapper) {
    const mapper = _mapper || function(issue2) {
      return issue2.message;
    };
    const fieldErrors = { _errors: [] };
    const processError = (error) => {
      for (const issue2 of error.issues) {
        if (issue2.code === "invalid_union") {
          issue2.unionErrors.map(processError);
        } else if (issue2.code === "invalid_return_type") {
          processError(issue2.returnTypeError);
        } else if (issue2.code === "invalid_arguments") {
          processError(issue2.argumentsError);
        } else if (issue2.path.length === 0) {
          fieldErrors._errors.push(mapper(issue2));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < issue2.path.length) {
            const el = issue2.path[i];
            const terminal = i === issue2.path.length - 1;
            if (!terminal) {
              curr[el] = curr[el] || { _errors: [] };
            } else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue2));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    };
    processError(this);
    return fieldErrors;
  }
  static assert(value) {
    if (!(value instanceof _ZodError)) {
      throw new Error(`Not a ZodError: ${value}`);
    }
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten(mapper = (issue2) => issue2.message) {
    const fieldErrors = {};
    const formErrors = [];
    for (const sub of this.issues) {
      if (sub.path.length > 0) {
        const firstEl = sub.path[0];
        fieldErrors[firstEl] = fieldErrors[firstEl] || [];
        fieldErrors[firstEl].push(mapper(sub));
      } else {
        formErrors.push(mapper(sub));
      }
    }
    return { formErrors, fieldErrors };
  }
  get formErrors() {
    return this.flatten();
  }
};
ZodError.create = (issues) => {
  const error = new ZodError(issues);
  return error;
};

// node_modules/zod/v3/locales/en.js
var errorMap = (issue2, _ctx) => {
  let message;
  switch (issue2.code) {
    case ZodIssueCode.invalid_type:
      if (issue2.received === ZodParsedType.undefined) {
        message = "Required";
      } else {
        message = `Expected ${issue2.expected}, received ${issue2.received}`;
      }
      break;
    case ZodIssueCode.invalid_literal:
      message = `Invalid literal value, expected ${JSON.stringify(issue2.expected, util.jsonStringifyReplacer)}`;
      break;
    case ZodIssueCode.unrecognized_keys:
      message = `Unrecognized key(s) in object: ${util.joinValues(issue2.keys, ", ")}`;
      break;
    case ZodIssueCode.invalid_union:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_union_discriminator:
      message = `Invalid discriminator value. Expected ${util.joinValues(issue2.options)}`;
      break;
    case ZodIssueCode.invalid_enum_value:
      message = `Invalid enum value. Expected ${util.joinValues(issue2.options)}, received '${issue2.received}'`;
      break;
    case ZodIssueCode.invalid_arguments:
      message = `Invalid function arguments`;
      break;
    case ZodIssueCode.invalid_return_type:
      message = `Invalid function return type`;
      break;
    case ZodIssueCode.invalid_date:
      message = `Invalid date`;
      break;
    case ZodIssueCode.invalid_string:
      if (typeof issue2.validation === "object") {
        if ("includes" in issue2.validation) {
          message = `Invalid input: must include "${issue2.validation.includes}"`;
          if (typeof issue2.validation.position === "number") {
            message = `${message} at one or more positions greater than or equal to ${issue2.validation.position}`;
          }
        } else if ("startsWith" in issue2.validation) {
          message = `Invalid input: must start with "${issue2.validation.startsWith}"`;
        } else if ("endsWith" in issue2.validation) {
          message = `Invalid input: must end with "${issue2.validation.endsWith}"`;
        } else {
          util.assertNever(issue2.validation);
        }
      } else if (issue2.validation !== "regex") {
        message = `Invalid ${issue2.validation}`;
      } else {
        message = "Invalid";
      }
      break;
    case ZodIssueCode.too_small:
      if (issue2.type === "array")
        message = `Array must contain ${issue2.exact ? "exactly" : issue2.inclusive ? `at least` : `more than`} ${issue2.minimum} element(s)`;
      else if (issue2.type === "string")
        message = `String must contain ${issue2.exact ? "exactly" : issue2.inclusive ? `at least` : `over`} ${issue2.minimum} character(s)`;
      else if (issue2.type === "number")
        message = `Number must be ${issue2.exact ? `exactly equal to ` : issue2.inclusive ? `greater than or equal to ` : `greater than `}${issue2.minimum}`;
      else if (issue2.type === "bigint")
        message = `Number must be ${issue2.exact ? `exactly equal to ` : issue2.inclusive ? `greater than or equal to ` : `greater than `}${issue2.minimum}`;
      else if (issue2.type === "date")
        message = `Date must be ${issue2.exact ? `exactly equal to ` : issue2.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue2.minimum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.too_big:
      if (issue2.type === "array")
        message = `Array must contain ${issue2.exact ? `exactly` : issue2.inclusive ? `at most` : `less than`} ${issue2.maximum} element(s)`;
      else if (issue2.type === "string")
        message = `String must contain ${issue2.exact ? `exactly` : issue2.inclusive ? `at most` : `under`} ${issue2.maximum} character(s)`;
      else if (issue2.type === "number")
        message = `Number must be ${issue2.exact ? `exactly` : issue2.inclusive ? `less than or equal to` : `less than`} ${issue2.maximum}`;
      else if (issue2.type === "bigint")
        message = `BigInt must be ${issue2.exact ? `exactly` : issue2.inclusive ? `less than or equal to` : `less than`} ${issue2.maximum}`;
      else if (issue2.type === "date")
        message = `Date must be ${issue2.exact ? `exactly` : issue2.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue2.maximum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.custom:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_intersection_types:
      message = `Intersection results could not be merged`;
      break;
    case ZodIssueCode.not_multiple_of:
      message = `Number must be a multiple of ${issue2.multipleOf}`;
      break;
    case ZodIssueCode.not_finite:
      message = "Number must be finite";
      break;
    default:
      message = _ctx.defaultError;
      util.assertNever(issue2);
  }
  return { message };
};
var en_default = errorMap;

// node_modules/zod/v3/errors.js
var overrideErrorMap = en_default;
function setErrorMap(map) {
  overrideErrorMap = map;
}
function getErrorMap() {
  return overrideErrorMap;
}

// node_modules/zod/v3/helpers/parseUtil.js
var makeIssue = (params) => {
  const { data, path: path12, errorMaps, issueData } = params;
  const fullPath = [...path12, ...issueData.path || []];
  const fullIssue = {
    ...issueData,
    path: fullPath
  };
  if (issueData.message !== void 0) {
    return {
      ...issueData,
      path: fullPath,
      message: issueData.message
    };
  }
  let errorMessage = "";
  const maps = errorMaps.filter((m) => !!m).slice().reverse();
  for (const map of maps) {
    errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
  }
  return {
    ...issueData,
    path: fullPath,
    message: errorMessage
  };
};
var EMPTY_PATH = [];
function addIssueToContext(ctx, issueData) {
  const overrideMap = getErrorMap();
  const issue2 = makeIssue({
    issueData,
    data: ctx.data,
    path: ctx.path,
    errorMaps: [
      ctx.common.contextualErrorMap,
      // contextual error map is first priority
      ctx.schemaErrorMap,
      // then schema-bound map if available
      overrideMap,
      // then global override map
      overrideMap === en_default ? void 0 : en_default
      // then global default map
    ].filter((x) => !!x)
  });
  ctx.common.issues.push(issue2);
}
var ParseStatus = class _ParseStatus {
  constructor() {
    this.value = "valid";
  }
  dirty() {
    if (this.value === "valid")
      this.value = "dirty";
  }
  abort() {
    if (this.value !== "aborted")
      this.value = "aborted";
  }
  static mergeArray(status, results) {
    const arrayValue = [];
    for (const s of results) {
      if (s.status === "aborted")
        return INVALID;
      if (s.status === "dirty")
        status.dirty();
      arrayValue.push(s.value);
    }
    return { status: status.value, value: arrayValue };
  }
  static async mergeObjectAsync(status, pairs) {
    const syncPairs = [];
    for (const pair of pairs) {
      const key2 = await pair.key;
      const value = await pair.value;
      syncPairs.push({
        key: key2,
        value
      });
    }
    return _ParseStatus.mergeObjectSync(status, syncPairs);
  }
  static mergeObjectSync(status, pairs) {
    const finalObject = {};
    for (const pair of pairs) {
      const { key: key2, value } = pair;
      if (key2.status === "aborted")
        return INVALID;
      if (value.status === "aborted")
        return INVALID;
      if (key2.status === "dirty")
        status.dirty();
      if (value.status === "dirty")
        status.dirty();
      if (key2.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
        finalObject[key2.value] = value.value;
      }
    }
    return { status: status.value, value: finalObject };
  }
};
var INVALID = Object.freeze({
  status: "aborted"
});
var DIRTY = (value) => ({ status: "dirty", value });
var OK = (value) => ({ status: "valid", value });
var isAborted = (x) => x.status === "aborted";
var isDirty = (x) => x.status === "dirty";
var isValid = (x) => x.status === "valid";
var isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;

// node_modules/zod/v3/helpers/errorUtil.js
var errorUtil;
(function(errorUtil2) {
  errorUtil2.errToObj = (message) => typeof message === "string" ? { message } : message || {};
  errorUtil2.toString = (message) => typeof message === "string" ? message : message?.message;
})(errorUtil || (errorUtil = {}));

// node_modules/zod/v3/types.js
var ParseInputLazyPath = class {
  constructor(parent, value, path12, key2) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path12;
    this._key = key2;
  }
  get path() {
    if (!this._cachedPath.length) {
      if (Array.isArray(this._key)) {
        this._cachedPath.push(...this._path, ...this._key);
      } else {
        this._cachedPath.push(...this._path, this._key);
      }
    }
    return this._cachedPath;
  }
};
var handleResult = (ctx, result) => {
  if (isValid(result)) {
    return { success: true, data: result.value };
  } else {
    if (!ctx.common.issues.length) {
      throw new Error("Validation failed but no issues detected.");
    }
    return {
      success: false,
      get error() {
        if (this._error)
          return this._error;
        const error = new ZodError(ctx.common.issues);
        this._error = error;
        return this._error;
      }
    };
  }
};
function processCreateParams(params) {
  if (!params)
    return {};
  const { errorMap: errorMap2, invalid_type_error, required_error, description } = params;
  if (errorMap2 && (invalid_type_error || required_error)) {
    throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  }
  if (errorMap2)
    return { errorMap: errorMap2, description };
  const customMap = (iss, ctx) => {
    const { message } = params;
    if (iss.code === "invalid_enum_value") {
      return { message: message ?? ctx.defaultError };
    }
    if (typeof ctx.data === "undefined") {
      return { message: message ?? required_error ?? ctx.defaultError };
    }
    if (iss.code !== "invalid_type")
      return { message: ctx.defaultError };
    return { message: message ?? invalid_type_error ?? ctx.defaultError };
  };
  return { errorMap: customMap, description };
}
var ZodType = class {
  get description() {
    return this._def.description;
  }
  _getType(input) {
    return getParsedType(input.data);
  }
  _getOrReturnCtx(input, ctx) {
    return ctx || {
      common: input.parent.common,
      data: input.data,
      parsedType: getParsedType(input.data),
      schemaErrorMap: this._def.errorMap,
      path: input.path,
      parent: input.parent
    };
  }
  _processInputParams(input) {
    return {
      status: new ParseStatus(),
      ctx: {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent
      }
    };
  }
  _parseSync(input) {
    const result = this._parse(input);
    if (isAsync(result)) {
      throw new Error("Synchronous parse encountered promise.");
    }
    return result;
  }
  _parseAsync(input) {
    const result = this._parse(input);
    return Promise.resolve(result);
  }
  parse(data, params) {
    const result = this.safeParse(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  safeParse(data, params) {
    const ctx = {
      common: {
        issues: [],
        async: params?.async ?? false,
        contextualErrorMap: params?.errorMap
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const result = this._parseSync({ data, path: ctx.path, parent: ctx });
    return handleResult(ctx, result);
  }
  "~validate"(data) {
    const ctx = {
      common: {
        issues: [],
        async: !!this["~standard"].async
      },
      path: [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    if (!this["~standard"].async) {
      try {
        const result = this._parseSync({ data, path: [], parent: ctx });
        return isValid(result) ? {
          value: result.value
        } : {
          issues: ctx.common.issues
        };
      } catch (err) {
        if (err?.message?.toLowerCase()?.includes("encountered")) {
          this["~standard"].async = true;
        }
        ctx.common = {
          issues: [],
          async: true
        };
      }
    }
    return this._parseAsync({ data, path: [], parent: ctx }).then((result) => isValid(result) ? {
      value: result.value
    } : {
      issues: ctx.common.issues
    });
  }
  async parseAsync(data, params) {
    const result = await this.safeParseAsync(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  async safeParseAsync(data, params) {
    const ctx = {
      common: {
        issues: [],
        contextualErrorMap: params?.errorMap,
        async: true
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
    const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
    return handleResult(ctx, result);
  }
  refine(check, message) {
    const getIssueProperties = (val) => {
      if (typeof message === "string" || typeof message === "undefined") {
        return { message };
      } else if (typeof message === "function") {
        return message(val);
      } else {
        return message;
      }
    };
    return this._refinement((val, ctx) => {
      const result = check(val);
      const setError = () => ctx.addIssue({
        code: ZodIssueCode.custom,
        ...getIssueProperties(val)
      });
      if (typeof Promise !== "undefined" && result instanceof Promise) {
        return result.then((data) => {
          if (!data) {
            setError();
            return false;
          } else {
            return true;
          }
        });
      }
      if (!result) {
        setError();
        return false;
      } else {
        return true;
      }
    });
  }
  refinement(check, refinementData) {
    return this._refinement((val, ctx) => {
      if (!check(val)) {
        ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
        return false;
      } else {
        return true;
      }
    });
  }
  _refinement(refinement) {
    return new ZodEffects({
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "refinement", refinement }
    });
  }
  superRefine(refinement) {
    return this._refinement(refinement);
  }
  constructor(def) {
    this.spa = this.safeParseAsync;
    this._def = def;
    this.parse = this.parse.bind(this);
    this.safeParse = this.safeParse.bind(this);
    this.parseAsync = this.parseAsync.bind(this);
    this.safeParseAsync = this.safeParseAsync.bind(this);
    this.spa = this.spa.bind(this);
    this.refine = this.refine.bind(this);
    this.refinement = this.refinement.bind(this);
    this.superRefine = this.superRefine.bind(this);
    this.optional = this.optional.bind(this);
    this.nullable = this.nullable.bind(this);
    this.nullish = this.nullish.bind(this);
    this.array = this.array.bind(this);
    this.promise = this.promise.bind(this);
    this.or = this.or.bind(this);
    this.and = this.and.bind(this);
    this.transform = this.transform.bind(this);
    this.brand = this.brand.bind(this);
    this.default = this.default.bind(this);
    this.catch = this.catch.bind(this);
    this.describe = this.describe.bind(this);
    this.pipe = this.pipe.bind(this);
    this.readonly = this.readonly.bind(this);
    this.isNullable = this.isNullable.bind(this);
    this.isOptional = this.isOptional.bind(this);
    this["~standard"] = {
      version: 1,
      vendor: "zod",
      validate: (data) => this["~validate"](data)
    };
  }
  optional() {
    return ZodOptional.create(this, this._def);
  }
  nullable() {
    return ZodNullable.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return ZodArray.create(this);
  }
  promise() {
    return ZodPromise.create(this, this._def);
  }
  or(option) {
    return ZodUnion.create([this, option], this._def);
  }
  and(incoming) {
    return ZodIntersection.create(this, incoming, this._def);
  }
  transform(transform) {
    return new ZodEffects({
      ...processCreateParams(this._def),
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "transform", transform }
    });
  }
  default(def) {
    const defaultValueFunc = typeof def === "function" ? def : () => def;
    return new ZodDefault({
      ...processCreateParams(this._def),
      innerType: this,
      defaultValue: defaultValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodDefault
    });
  }
  brand() {
    return new ZodBranded({
      typeName: ZodFirstPartyTypeKind.ZodBranded,
      type: this,
      ...processCreateParams(this._def)
    });
  }
  catch(def) {
    const catchValueFunc = typeof def === "function" ? def : () => def;
    return new ZodCatch({
      ...processCreateParams(this._def),
      innerType: this,
      catchValue: catchValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodCatch
    });
  }
  describe(description) {
    const This = this.constructor;
    return new This({
      ...this._def,
      description
    });
  }
  pipe(target) {
    return ZodPipeline.create(this, target);
  }
  readonly() {
    return ZodReadonly.create(this);
  }
  isOptional() {
    return this.safeParse(void 0).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
};
var cuidRegex = /^c[^\s-]{8,}$/i;
var cuid2Regex = /^[0-9a-z]+$/;
var ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
var uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
var nanoidRegex = /^[a-z0-9_-]{21}$/i;
var jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
var durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
var _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
var emojiRegex;
var ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
var ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
var ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
var base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
var dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
var dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
  let secondsRegexSource = `[0-5]\\d`;
  if (args.precision) {
    secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
  } else if (args.precision == null) {
    secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
  }
  const secondsQuantifier = args.precision ? "+" : "?";
  return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
  return new RegExp(`^${timeRegexSource(args)}$`);
}
function datetimeRegex(args) {
  let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
  const opts = [];
  opts.push(args.local ? `Z?` : `Z`);
  if (args.offset)
    opts.push(`([+-]\\d{2}:?\\d{2})`);
  regex = `${regex}(${opts.join("|")})`;
  return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version2) {
  if ((version2 === "v4" || !version2) && ipv4Regex.test(ip)) {
    return true;
  }
  if ((version2 === "v6" || !version2) && ipv6Regex.test(ip)) {
    return true;
  }
  return false;
}
function isValidJWT(jwt, alg) {
  if (!jwtRegex.test(jwt))
    return false;
  try {
    const [header] = jwt.split(".");
    if (!header)
      return false;
    const base642 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
    const decoded = JSON.parse(atob(base642));
    if (typeof decoded !== "object" || decoded === null)
      return false;
    if ("typ" in decoded && decoded?.typ !== "JWT")
      return false;
    if (!decoded.alg)
      return false;
    if (alg && decoded.alg !== alg)
      return false;
    return true;
  } catch {
    return false;
  }
}
function isValidCidr(ip, version2) {
  if ((version2 === "v4" || !version2) && ipv4CidrRegex.test(ip)) {
    return true;
  }
  if ((version2 === "v6" || !version2) && ipv6CidrRegex.test(ip)) {
    return true;
  }
  return false;
}
var ZodString = class _ZodString extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = String(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.string) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.string,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.length < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.length > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "length") {
        const tooBig = input.data.length > check.value;
        const tooSmall = input.data.length < check.value;
        if (tooBig || tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          if (tooBig) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          } else if (tooSmall) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          }
          status.dirty();
        }
      } else if (check.kind === "email") {
        if (!emailRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "email",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "emoji") {
        if (!emojiRegex) {
          emojiRegex = new RegExp(_emojiRegex, "u");
        }
        if (!emojiRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "emoji",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "uuid") {
        if (!uuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "uuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "nanoid") {
        if (!nanoidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "nanoid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid") {
        if (!cuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid2") {
        if (!cuid2Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid2",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ulid") {
        if (!ulidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ulid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "url") {
        try {
          new URL(input.data);
        } catch {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "regex") {
        check.regex.lastIndex = 0;
        const testResult = check.regex.test(input.data);
        if (!testResult) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "regex",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "trim") {
        input.data = input.data.trim();
      } else if (check.kind === "includes") {
        if (!input.data.includes(check.value, check.position)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { includes: check.value, position: check.position },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "toLowerCase") {
        input.data = input.data.toLowerCase();
      } else if (check.kind === "toUpperCase") {
        input.data = input.data.toUpperCase();
      } else if (check.kind === "startsWith") {
        if (!input.data.startsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { startsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "endsWith") {
        if (!input.data.endsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { endsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "datetime") {
        const regex = datetimeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "datetime",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "date") {
        const regex = dateRegex;
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "date",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "time") {
        const regex = timeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "time",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "duration") {
        if (!durationRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "duration",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ip") {
        if (!isValidIP(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ip",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "jwt") {
        if (!isValidJWT(input.data, check.alg)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "jwt",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cidr") {
        if (!isValidCidr(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cidr",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64") {
        if (!base64Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64url") {
        if (!base64urlRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _regex(regex, validation, message) {
    return this.refinement((data) => regex.test(data), {
      validation,
      code: ZodIssueCode.invalid_string,
      ...errorUtil.errToObj(message)
    });
  }
  _addCheck(check) {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  email(message) {
    return this._addCheck({ kind: "email", ...errorUtil.errToObj(message) });
  }
  url(message) {
    return this._addCheck({ kind: "url", ...errorUtil.errToObj(message) });
  }
  emoji(message) {
    return this._addCheck({ kind: "emoji", ...errorUtil.errToObj(message) });
  }
  uuid(message) {
    return this._addCheck({ kind: "uuid", ...errorUtil.errToObj(message) });
  }
  nanoid(message) {
    return this._addCheck({ kind: "nanoid", ...errorUtil.errToObj(message) });
  }
  cuid(message) {
    return this._addCheck({ kind: "cuid", ...errorUtil.errToObj(message) });
  }
  cuid2(message) {
    return this._addCheck({ kind: "cuid2", ...errorUtil.errToObj(message) });
  }
  ulid(message) {
    return this._addCheck({ kind: "ulid", ...errorUtil.errToObj(message) });
  }
  base64(message) {
    return this._addCheck({ kind: "base64", ...errorUtil.errToObj(message) });
  }
  base64url(message) {
    return this._addCheck({
      kind: "base64url",
      ...errorUtil.errToObj(message)
    });
  }
  jwt(options2) {
    return this._addCheck({ kind: "jwt", ...errorUtil.errToObj(options2) });
  }
  ip(options2) {
    return this._addCheck({ kind: "ip", ...errorUtil.errToObj(options2) });
  }
  cidr(options2) {
    return this._addCheck({ kind: "cidr", ...errorUtil.errToObj(options2) });
  }
  datetime(options2) {
    if (typeof options2 === "string") {
      return this._addCheck({
        kind: "datetime",
        precision: null,
        offset: false,
        local: false,
        message: options2
      });
    }
    return this._addCheck({
      kind: "datetime",
      precision: typeof options2?.precision === "undefined" ? null : options2?.precision,
      offset: options2?.offset ?? false,
      local: options2?.local ?? false,
      ...errorUtil.errToObj(options2?.message)
    });
  }
  date(message) {
    return this._addCheck({ kind: "date", message });
  }
  time(options2) {
    if (typeof options2 === "string") {
      return this._addCheck({
        kind: "time",
        precision: null,
        message: options2
      });
    }
    return this._addCheck({
      kind: "time",
      precision: typeof options2?.precision === "undefined" ? null : options2?.precision,
      ...errorUtil.errToObj(options2?.message)
    });
  }
  duration(message) {
    return this._addCheck({ kind: "duration", ...errorUtil.errToObj(message) });
  }
  regex(regex, message) {
    return this._addCheck({
      kind: "regex",
      regex,
      ...errorUtil.errToObj(message)
    });
  }
  includes(value, options2) {
    return this._addCheck({
      kind: "includes",
      value,
      position: options2?.position,
      ...errorUtil.errToObj(options2?.message)
    });
  }
  startsWith(value, message) {
    return this._addCheck({
      kind: "startsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  endsWith(value, message) {
    return this._addCheck({
      kind: "endsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  min(minLength, message) {
    return this._addCheck({
      kind: "min",
      value: minLength,
      ...errorUtil.errToObj(message)
    });
  }
  max(maxLength, message) {
    return this._addCheck({
      kind: "max",
      value: maxLength,
      ...errorUtil.errToObj(message)
    });
  }
  length(len, message) {
    return this._addCheck({
      kind: "length",
      value: len,
      ...errorUtil.errToObj(message)
    });
  }
  /**
   * Equivalent to `.min(1)`
   */
  nonempty(message) {
    return this.min(1, errorUtil.errToObj(message));
  }
  trim() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "trim" }]
    });
  }
  toLowerCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toLowerCase" }]
    });
  }
  toUpperCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toUpperCase" }]
    });
  }
  get isDatetime() {
    return !!this._def.checks.find((ch) => ch.kind === "datetime");
  }
  get isDate() {
    return !!this._def.checks.find((ch) => ch.kind === "date");
  }
  get isTime() {
    return !!this._def.checks.find((ch) => ch.kind === "time");
  }
  get isDuration() {
    return !!this._def.checks.find((ch) => ch.kind === "duration");
  }
  get isEmail() {
    return !!this._def.checks.find((ch) => ch.kind === "email");
  }
  get isURL() {
    return !!this._def.checks.find((ch) => ch.kind === "url");
  }
  get isEmoji() {
    return !!this._def.checks.find((ch) => ch.kind === "emoji");
  }
  get isUUID() {
    return !!this._def.checks.find((ch) => ch.kind === "uuid");
  }
  get isNANOID() {
    return !!this._def.checks.find((ch) => ch.kind === "nanoid");
  }
  get isCUID() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid");
  }
  get isCUID2() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid2");
  }
  get isULID() {
    return !!this._def.checks.find((ch) => ch.kind === "ulid");
  }
  get isIP() {
    return !!this._def.checks.find((ch) => ch.kind === "ip");
  }
  get isCIDR() {
    return !!this._def.checks.find((ch) => ch.kind === "cidr");
  }
  get isBase64() {
    return !!this._def.checks.find((ch) => ch.kind === "base64");
  }
  get isBase64url() {
    return !!this._def.checks.find((ch) => ch.kind === "base64url");
  }
  get minLength() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxLength() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodString.create = (params) => {
  return new ZodString({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodString,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepDecCount = (step.toString().split(".")[1] || "").length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}
var ZodNumber = class _ZodNumber extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
    this.step = this.multipleOf;
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = Number(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.number) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.number,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "int") {
        if (!util.isInteger(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: "integer",
            received: "float",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (floatSafeRemainder(input.data, check.value) !== 0) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "finite") {
        if (!Number.isFinite(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_finite,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodNumber({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodNumber({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  int(message) {
    return this._addCheck({
      kind: "int",
      message: errorUtil.toString(message)
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  finite(message) {
    return this._addCheck({
      kind: "finite",
      message: errorUtil.toString(message)
    });
  }
  safe(message) {
    return this._addCheck({
      kind: "min",
      inclusive: true,
      value: Number.MIN_SAFE_INTEGER,
      message: errorUtil.toString(message)
    })._addCheck({
      kind: "max",
      inclusive: true,
      value: Number.MAX_SAFE_INTEGER,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
  get isInt() {
    return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util.isInteger(ch.value));
  }
  get isFinite() {
    let max = null;
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
        return true;
      } else if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      } else if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return Number.isFinite(min) && Number.isFinite(max);
  }
};
ZodNumber.create = (params) => {
  return new ZodNumber({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodNumber,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodBigInt = class _ZodBigInt extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
  }
  _parse(input) {
    if (this._def.coerce) {
      try {
        input.data = BigInt(input.data);
      } catch {
        return this._getInvalidInput(input);
      }
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.bigint) {
      return this._getInvalidInput(input);
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            type: "bigint",
            minimum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            type: "bigint",
            maximum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (input.data % check.value !== BigInt(0)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _getInvalidInput(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.bigint,
      received: ctx.parsedType
    });
    return INVALID;
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodBigInt({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodBigInt({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodBigInt.create = (params) => {
  return new ZodBigInt({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodBigInt,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
var ZodBoolean = class extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = Boolean(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.boolean) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.boolean,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodBoolean.create = (params) => {
  return new ZodBoolean({
    typeName: ZodFirstPartyTypeKind.ZodBoolean,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodDate = class _ZodDate extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = new Date(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.date) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.date,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    if (Number.isNaN(input.data.getTime())) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_date
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.getTime() < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            message: check.message,
            inclusive: true,
            exact: false,
            minimum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.getTime() > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            message: check.message,
            inclusive: true,
            exact: false,
            maximum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return {
      status: status.value,
      value: new Date(input.data.getTime())
    };
  }
  _addCheck(check) {
    return new _ZodDate({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  min(minDate, message) {
    return this._addCheck({
      kind: "min",
      value: minDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  max(maxDate, message) {
    return this._addCheck({
      kind: "max",
      value: maxDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  get minDate() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min != null ? new Date(min) : null;
  }
  get maxDate() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max != null ? new Date(max) : null;
  }
};
ZodDate.create = (params) => {
  return new ZodDate({
    checks: [],
    coerce: params?.coerce || false,
    typeName: ZodFirstPartyTypeKind.ZodDate,
    ...processCreateParams(params)
  });
};
var ZodSymbol = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.symbol) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.symbol,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodSymbol.create = (params) => {
  return new ZodSymbol({
    typeName: ZodFirstPartyTypeKind.ZodSymbol,
    ...processCreateParams(params)
  });
};
var ZodUndefined = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.undefined,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodUndefined.create = (params) => {
  return new ZodUndefined({
    typeName: ZodFirstPartyTypeKind.ZodUndefined,
    ...processCreateParams(params)
  });
};
var ZodNull = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.null) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.null,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodNull.create = (params) => {
  return new ZodNull({
    typeName: ZodFirstPartyTypeKind.ZodNull,
    ...processCreateParams(params)
  });
};
var ZodAny = class extends ZodType {
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodAny.create = (params) => {
  return new ZodAny({
    typeName: ZodFirstPartyTypeKind.ZodAny,
    ...processCreateParams(params)
  });
};
var ZodUnknown = class extends ZodType {
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodUnknown.create = (params) => {
  return new ZodUnknown({
    typeName: ZodFirstPartyTypeKind.ZodUnknown,
    ...processCreateParams(params)
  });
};
var ZodNever = class extends ZodType {
  _parse(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.never,
      received: ctx.parsedType
    });
    return INVALID;
  }
};
ZodNever.create = (params) => {
  return new ZodNever({
    typeName: ZodFirstPartyTypeKind.ZodNever,
    ...processCreateParams(params)
  });
};
var ZodVoid = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.void,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodVoid.create = (params) => {
  return new ZodVoid({
    typeName: ZodFirstPartyTypeKind.ZodVoid,
    ...processCreateParams(params)
  });
};
var ZodArray = class _ZodArray extends ZodType {
  _parse(input) {
    const { ctx, status } = this._processInputParams(input);
    const def = this._def;
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (def.exactLength !== null) {
      const tooBig = ctx.data.length > def.exactLength.value;
      const tooSmall = ctx.data.length < def.exactLength.value;
      if (tooBig || tooSmall) {
        addIssueToContext(ctx, {
          code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
          minimum: tooSmall ? def.exactLength.value : void 0,
          maximum: tooBig ? def.exactLength.value : void 0,
          type: "array",
          inclusive: true,
          exact: true,
          message: def.exactLength.message
        });
        status.dirty();
      }
    }
    if (def.minLength !== null) {
      if (ctx.data.length < def.minLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.minLength.message
        });
        status.dirty();
      }
    }
    if (def.maxLength !== null) {
      if (ctx.data.length > def.maxLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.maxLength.message
        });
        status.dirty();
      }
    }
    if (ctx.common.async) {
      return Promise.all([...ctx.data].map((item, i) => {
        return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
      })).then((result2) => {
        return ParseStatus.mergeArray(status, result2);
      });
    }
    const result = [...ctx.data].map((item, i) => {
      return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
    });
    return ParseStatus.mergeArray(status, result);
  }
  get element() {
    return this._def.type;
  }
  min(minLength, message) {
    return new _ZodArray({
      ...this._def,
      minLength: { value: minLength, message: errorUtil.toString(message) }
    });
  }
  max(maxLength, message) {
    return new _ZodArray({
      ...this._def,
      maxLength: { value: maxLength, message: errorUtil.toString(message) }
    });
  }
  length(len, message) {
    return new _ZodArray({
      ...this._def,
      exactLength: { value: len, message: errorUtil.toString(message) }
    });
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodArray.create = (schema, params) => {
  return new ZodArray({
    type: schema,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: ZodFirstPartyTypeKind.ZodArray,
    ...processCreateParams(params)
  });
};
function deepPartialify(schema) {
  if (schema instanceof ZodObject) {
    const newShape = {};
    for (const key2 in schema.shape) {
      const fieldSchema = schema.shape[key2];
      newShape[key2] = ZodOptional.create(deepPartialify(fieldSchema));
    }
    return new ZodObject({
      ...schema._def,
      shape: () => newShape
    });
  } else if (schema instanceof ZodArray) {
    return new ZodArray({
      ...schema._def,
      type: deepPartialify(schema.element)
    });
  } else if (schema instanceof ZodOptional) {
    return ZodOptional.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodNullable) {
    return ZodNullable.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodTuple) {
    return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
  } else {
    return schema;
  }
}
var ZodObject = class _ZodObject extends ZodType {
  constructor() {
    super(...arguments);
    this._cached = null;
    this.nonstrict = this.passthrough;
    this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null)
      return this._cached;
    const shape = this._def.shape();
    const keys = util.objectKeys(shape);
    this._cached = { shape, keys };
    return this._cached;
  }
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.object) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const { status, ctx } = this._processInputParams(input);
    const { shape, keys: shapeKeys } = this._getCached();
    const extraKeys = [];
    if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
      for (const key2 in ctx.data) {
        if (!shapeKeys.includes(key2)) {
          extraKeys.push(key2);
        }
      }
    }
    const pairs = [];
    for (const key2 of shapeKeys) {
      const keyValidator = shape[key2];
      const value = ctx.data[key2];
      pairs.push({
        key: { status: "valid", value: key2 },
        value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key2)),
        alwaysSet: key2 in ctx.data
      });
    }
    if (this._def.catchall instanceof ZodNever) {
      const unknownKeys = this._def.unknownKeys;
      if (unknownKeys === "passthrough") {
        for (const key2 of extraKeys) {
          pairs.push({
            key: { status: "valid", value: key2 },
            value: { status: "valid", value: ctx.data[key2] }
          });
        }
      } else if (unknownKeys === "strict") {
        if (extraKeys.length > 0) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.unrecognized_keys,
            keys: extraKeys
          });
          status.dirty();
        }
      } else if (unknownKeys === "strip") {
      } else {
        throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
      }
    } else {
      const catchall = this._def.catchall;
      for (const key2 of extraKeys) {
        const value = ctx.data[key2];
        pairs.push({
          key: { status: "valid", value: key2 },
          value: catchall._parse(
            new ParseInputLazyPath(ctx, value, ctx.path, key2)
            //, ctx.child(key), value, getParsedType(value)
          ),
          alwaysSet: key2 in ctx.data
        });
      }
    }
    if (ctx.common.async) {
      return Promise.resolve().then(async () => {
        const syncPairs = [];
        for (const pair of pairs) {
          const key2 = await pair.key;
          const value = await pair.value;
          syncPairs.push({
            key: key2,
            value,
            alwaysSet: pair.alwaysSet
          });
        }
        return syncPairs;
      }).then((syncPairs) => {
        return ParseStatus.mergeObjectSync(status, syncPairs);
      });
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get shape() {
    return this._def.shape();
  }
  strict(message) {
    errorUtil.errToObj;
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strict",
      ...message !== void 0 ? {
        errorMap: (issue2, ctx) => {
          const defaultError = this._def.errorMap?.(issue2, ctx).message ?? ctx.defaultError;
          if (issue2.code === "unrecognized_keys")
            return {
              message: errorUtil.errToObj(message).message ?? defaultError
            };
          return {
            message: defaultError
          };
        }
      } : {}
    });
  }
  strip() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strip"
    });
  }
  passthrough() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "passthrough"
    });
  }
  // const AugmentFactory =
  //   <Def extends ZodObjectDef>(def: Def) =>
  //   <Augmentation extends ZodRawShape>(
  //     augmentation: Augmentation
  //   ): ZodObject<
  //     extendShape<ReturnType<Def["shape"]>, Augmentation>,
  //     Def["unknownKeys"],
  //     Def["catchall"]
  //   > => {
  //     return new ZodObject({
  //       ...def,
  //       shape: () => ({
  //         ...def.shape(),
  //         ...augmentation,
  //       }),
  //     }) as any;
  //   };
  extend(augmentation) {
    return new _ZodObject({
      ...this._def,
      shape: () => ({
        ...this._def.shape(),
        ...augmentation
      })
    });
  }
  /**
   * Prior to zod@1.0.12 there was a bug in the
   * inferred type of merged objects. Please
   * upgrade if you are experiencing issues.
   */
  merge(merging) {
    const merged = new _ZodObject({
      unknownKeys: merging._def.unknownKeys,
      catchall: merging._def.catchall,
      shape: () => ({
        ...this._def.shape(),
        ...merging._def.shape()
      }),
      typeName: ZodFirstPartyTypeKind.ZodObject
    });
    return merged;
  }
  // merge<
  //   Incoming extends AnyZodObject,
  //   Augmentation extends Incoming["shape"],
  //   NewOutput extends {
  //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
  //       ? Augmentation[k]["_output"]
  //       : k extends keyof Output
  //       ? Output[k]
  //       : never;
  //   },
  //   NewInput extends {
  //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
  //       ? Augmentation[k]["_input"]
  //       : k extends keyof Input
  //       ? Input[k]
  //       : never;
  //   }
  // >(
  //   merging: Incoming
  // ): ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"],
  //   NewOutput,
  //   NewInput
  // > {
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  setKey(key2, schema) {
    return this.augment({ [key2]: schema });
  }
  // merge<Incoming extends AnyZodObject>(
  //   merging: Incoming
  // ): //ZodObject<T & Incoming["_shape"], UnknownKeys, Catchall> = (merging) => {
  // ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"]
  // > {
  //   // const mergedShape = objectUtil.mergeShapes(
  //   //   this._def.shape(),
  //   //   merging._def.shape()
  //   // );
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  catchall(index) {
    return new _ZodObject({
      ...this._def,
      catchall: index
    });
  }
  pick(mask) {
    const shape = {};
    for (const key2 of util.objectKeys(mask)) {
      if (mask[key2] && this.shape[key2]) {
        shape[key2] = this.shape[key2];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  omit(mask) {
    const shape = {};
    for (const key2 of util.objectKeys(this.shape)) {
      if (!mask[key2]) {
        shape[key2] = this.shape[key2];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  /**
   * @deprecated
   */
  deepPartial() {
    return deepPartialify(this);
  }
  partial(mask) {
    const newShape = {};
    for (const key2 of util.objectKeys(this.shape)) {
      const fieldSchema = this.shape[key2];
      if (mask && !mask[key2]) {
        newShape[key2] = fieldSchema;
      } else {
        newShape[key2] = fieldSchema.optional();
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  required(mask) {
    const newShape = {};
    for (const key2 of util.objectKeys(this.shape)) {
      if (mask && !mask[key2]) {
        newShape[key2] = this.shape[key2];
      } else {
        const fieldSchema = this.shape[key2];
        let newField = fieldSchema;
        while (newField instanceof ZodOptional) {
          newField = newField._def.innerType;
        }
        newShape[key2] = newField;
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  keyof() {
    return createZodEnum(util.objectKeys(this.shape));
  }
};
ZodObject.create = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.strictCreate = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strict",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.lazycreate = (shape, params) => {
  return new ZodObject({
    shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
var ZodUnion = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const options2 = this._def.options;
    function handleResults(results) {
      for (const result of results) {
        if (result.result.status === "valid") {
          return result.result;
        }
      }
      for (const result of results) {
        if (result.result.status === "dirty") {
          ctx.common.issues.push(...result.ctx.common.issues);
          return result.result;
        }
      }
      const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return Promise.all(options2.map(async (option) => {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        return {
          result: await option._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: childCtx
          }),
          ctx: childCtx
        };
      })).then(handleResults);
    } else {
      let dirty = void 0;
      const issues = [];
      for (const option of options2) {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        const result = option._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: childCtx
        });
        if (result.status === "valid") {
          return result;
        } else if (result.status === "dirty" && !dirty) {
          dirty = { result, ctx: childCtx };
        }
        if (childCtx.common.issues.length) {
          issues.push(childCtx.common.issues);
        }
      }
      if (dirty) {
        ctx.common.issues.push(...dirty.ctx.common.issues);
        return dirty.result;
      }
      const unionErrors = issues.map((issues2) => new ZodError(issues2));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
  }
  get options() {
    return this._def.options;
  }
};
ZodUnion.create = (types, params) => {
  return new ZodUnion({
    options: types,
    typeName: ZodFirstPartyTypeKind.ZodUnion,
    ...processCreateParams(params)
  });
};
var getDiscriminator = (type) => {
  if (type instanceof ZodLazy) {
    return getDiscriminator(type.schema);
  } else if (type instanceof ZodEffects) {
    return getDiscriminator(type.innerType());
  } else if (type instanceof ZodLiteral) {
    return [type.value];
  } else if (type instanceof ZodEnum) {
    return type.options;
  } else if (type instanceof ZodNativeEnum) {
    return util.objectValues(type.enum);
  } else if (type instanceof ZodDefault) {
    return getDiscriminator(type._def.innerType);
  } else if (type instanceof ZodUndefined) {
    return [void 0];
  } else if (type instanceof ZodNull) {
    return [null];
  } else if (type instanceof ZodOptional) {
    return [void 0, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodNullable) {
    return [null, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodBranded) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodReadonly) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodCatch) {
    return getDiscriminator(type._def.innerType);
  } else {
    return [];
  }
};
var ZodDiscriminatedUnion = class _ZodDiscriminatedUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const discriminator = this.discriminator;
    const discriminatorValue = ctx.data[discriminator];
    const option = this.optionsMap.get(discriminatorValue);
    if (!option) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union_discriminator,
        options: Array.from(this.optionsMap.keys()),
        path: [discriminator]
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return option._parseAsync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    } else {
      return option._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    }
  }
  get discriminator() {
    return this._def.discriminator;
  }
  get options() {
    return this._def.options;
  }
  get optionsMap() {
    return this._def.optionsMap;
  }
  /**
   * The constructor of the discriminated union schema. Its behaviour is very similar to that of the normal z.union() constructor.
   * However, it only allows a union of objects, all of which need to share a discriminator property. This property must
   * have a different value for each object in the union.
   * @param discriminator the name of the discriminator property
   * @param types an array of object schemas
   * @param params
   */
  static create(discriminator, options2, params) {
    const optionsMap = /* @__PURE__ */ new Map();
    for (const type of options2) {
      const discriminatorValues = getDiscriminator(type.shape[discriminator]);
      if (!discriminatorValues.length) {
        throw new Error(`A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`);
      }
      for (const value of discriminatorValues) {
        if (optionsMap.has(value)) {
          throw new Error(`Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`);
        }
        optionsMap.set(value, type);
      }
    }
    return new _ZodDiscriminatedUnion({
      typeName: ZodFirstPartyTypeKind.ZodDiscriminatedUnion,
      discriminator,
      options: options2,
      optionsMap,
      ...processCreateParams(params)
    });
  }
};
function mergeValues(a, b) {
  const aType = getParsedType(a);
  const bType = getParsedType(b);
  if (a === b) {
    return { valid: true, data: a };
  } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
    const bKeys = util.objectKeys(b);
    const sharedKeys = util.objectKeys(a).filter((key2) => bKeys.indexOf(key2) !== -1);
    const newObj = { ...a, ...b };
    for (const key2 of sharedKeys) {
      const sharedValue = mergeValues(a[key2], b[key2]);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newObj[key2] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
    if (a.length !== b.length) {
      return { valid: false };
    }
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
    return { valid: true, data: a };
  } else {
    return { valid: false };
  }
}
var ZodIntersection = class extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const handleParsed = (parsedLeft, parsedRight) => {
      if (isAborted(parsedLeft) || isAborted(parsedRight)) {
        return INVALID;
      }
      const merged = mergeValues(parsedLeft.value, parsedRight.value);
      if (!merged.valid) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_intersection_types
        });
        return INVALID;
      }
      if (isDirty(parsedLeft) || isDirty(parsedRight)) {
        status.dirty();
      }
      return { status: status.value, value: merged.data };
    };
    if (ctx.common.async) {
      return Promise.all([
        this._def.left._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }),
        this._def.right._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        })
      ]).then(([left, right]) => handleParsed(left, right));
    } else {
      return handleParsed(this._def.left._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }), this._def.right._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }));
    }
  }
};
ZodIntersection.create = (left, right, params) => {
  return new ZodIntersection({
    left,
    right,
    typeName: ZodFirstPartyTypeKind.ZodIntersection,
    ...processCreateParams(params)
  });
};
var ZodTuple = class _ZodTuple extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (ctx.data.length < this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_small,
        minimum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      return INVALID;
    }
    const rest = this._def.rest;
    if (!rest && ctx.data.length > this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_big,
        maximum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      status.dirty();
    }
    const items = [...ctx.data].map((item, itemIndex) => {
      const schema = this._def.items[itemIndex] || this._def.rest;
      if (!schema)
        return null;
      return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
    }).filter((x) => !!x);
    if (ctx.common.async) {
      return Promise.all(items).then((results) => {
        return ParseStatus.mergeArray(status, results);
      });
    } else {
      return ParseStatus.mergeArray(status, items);
    }
  }
  get items() {
    return this._def.items;
  }
  rest(rest) {
    return new _ZodTuple({
      ...this._def,
      rest
    });
  }
};
ZodTuple.create = (schemas, params) => {
  if (!Array.isArray(schemas)) {
    throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
  }
  return new ZodTuple({
    items: schemas,
    typeName: ZodFirstPartyTypeKind.ZodTuple,
    rest: null,
    ...processCreateParams(params)
  });
};
var ZodRecord = class _ZodRecord extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const pairs = [];
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    for (const key2 in ctx.data) {
      pairs.push({
        key: keyType._parse(new ParseInputLazyPath(ctx, key2, ctx.path, key2)),
        value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key2], ctx.path, key2)),
        alwaysSet: key2 in ctx.data
      });
    }
    if (ctx.common.async) {
      return ParseStatus.mergeObjectAsync(status, pairs);
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get element() {
    return this._def.valueType;
  }
  static create(first, second, third) {
    if (second instanceof ZodType) {
      return new _ZodRecord({
        keyType: first,
        valueType: second,
        typeName: ZodFirstPartyTypeKind.ZodRecord,
        ...processCreateParams(third)
      });
    }
    return new _ZodRecord({
      keyType: ZodString.create(),
      valueType: first,
      typeName: ZodFirstPartyTypeKind.ZodRecord,
      ...processCreateParams(second)
    });
  }
};
var ZodMap = class extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.map) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.map,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    const pairs = [...ctx.data.entries()].map(([key2, value], index) => {
      return {
        key: keyType._parse(new ParseInputLazyPath(ctx, key2, ctx.path, [index, "key"])),
        value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"]))
      };
    });
    if (ctx.common.async) {
      const finalMap = /* @__PURE__ */ new Map();
      return Promise.resolve().then(async () => {
        for (const pair of pairs) {
          const key2 = await pair.key;
          const value = await pair.value;
          if (key2.status === "aborted" || value.status === "aborted") {
            return INVALID;
          }
          if (key2.status === "dirty" || value.status === "dirty") {
            status.dirty();
          }
          finalMap.set(key2.value, value.value);
        }
        return { status: status.value, value: finalMap };
      });
    } else {
      const finalMap = /* @__PURE__ */ new Map();
      for (const pair of pairs) {
        const key2 = pair.key;
        const value = pair.value;
        if (key2.status === "aborted" || value.status === "aborted") {
          return INVALID;
        }
        if (key2.status === "dirty" || value.status === "dirty") {
          status.dirty();
        }
        finalMap.set(key2.value, value.value);
      }
      return { status: status.value, value: finalMap };
    }
  }
};
ZodMap.create = (keyType, valueType, params) => {
  return new ZodMap({
    valueType,
    keyType,
    typeName: ZodFirstPartyTypeKind.ZodMap,
    ...processCreateParams(params)
  });
};
var ZodSet = class _ZodSet extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.set) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.set,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const def = this._def;
    if (def.minSize !== null) {
      if (ctx.data.size < def.minSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.minSize.message
        });
        status.dirty();
      }
    }
    if (def.maxSize !== null) {
      if (ctx.data.size > def.maxSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.maxSize.message
        });
        status.dirty();
      }
    }
    const valueType = this._def.valueType;
    function finalizeSet(elements2) {
      const parsedSet = /* @__PURE__ */ new Set();
      for (const element of elements2) {
        if (element.status === "aborted")
          return INVALID;
        if (element.status === "dirty")
          status.dirty();
        parsedSet.add(element.value);
      }
      return { status: status.value, value: parsedSet };
    }
    const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
    if (ctx.common.async) {
      return Promise.all(elements).then((elements2) => finalizeSet(elements2));
    } else {
      return finalizeSet(elements);
    }
  }
  min(minSize, message) {
    return new _ZodSet({
      ...this._def,
      minSize: { value: minSize, message: errorUtil.toString(message) }
    });
  }
  max(maxSize, message) {
    return new _ZodSet({
      ...this._def,
      maxSize: { value: maxSize, message: errorUtil.toString(message) }
    });
  }
  size(size, message) {
    return this.min(size, message).max(size, message);
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodSet.create = (valueType, params) => {
  return new ZodSet({
    valueType,
    minSize: null,
    maxSize: null,
    typeName: ZodFirstPartyTypeKind.ZodSet,
    ...processCreateParams(params)
  });
};
var ZodFunction = class _ZodFunction extends ZodType {
  constructor() {
    super(...arguments);
    this.validate = this.implement;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.function) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.function,
        received: ctx.parsedType
      });
      return INVALID;
    }
    function makeArgsIssue(args, error) {
      return makeIssue({
        data: args,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_arguments,
          argumentsError: error
        }
      });
    }
    function makeReturnsIssue(returns, error) {
      return makeIssue({
        data: returns,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_return_type,
          returnTypeError: error
        }
      });
    }
    const params = { errorMap: ctx.common.contextualErrorMap };
    const fn = ctx.data;
    if (this._def.returns instanceof ZodPromise) {
      const me = this;
      return OK(async function(...args) {
        const error = new ZodError([]);
        const parsedArgs = await me._def.args.parseAsync(args, params).catch((e) => {
          error.addIssue(makeArgsIssue(args, e));
          throw error;
        });
        const result = await Reflect.apply(fn, this, parsedArgs);
        const parsedReturns = await me._def.returns._def.type.parseAsync(result, params).catch((e) => {
          error.addIssue(makeReturnsIssue(result, e));
          throw error;
        });
        return parsedReturns;
      });
    } else {
      const me = this;
      return OK(function(...args) {
        const parsedArgs = me._def.args.safeParse(args, params);
        if (!parsedArgs.success) {
          throw new ZodError([makeArgsIssue(args, parsedArgs.error)]);
        }
        const result = Reflect.apply(fn, this, parsedArgs.data);
        const parsedReturns = me._def.returns.safeParse(result, params);
        if (!parsedReturns.success) {
          throw new ZodError([makeReturnsIssue(result, parsedReturns.error)]);
        }
        return parsedReturns.data;
      });
    }
  }
  parameters() {
    return this._def.args;
  }
  returnType() {
    return this._def.returns;
  }
  args(...items) {
    return new _ZodFunction({
      ...this._def,
      args: ZodTuple.create(items).rest(ZodUnknown.create())
    });
  }
  returns(returnType) {
    return new _ZodFunction({
      ...this._def,
      returns: returnType
    });
  }
  implement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  strictImplement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  static create(args, returns, params) {
    return new _ZodFunction({
      args: args ? args : ZodTuple.create([]).rest(ZodUnknown.create()),
      returns: returns || ZodUnknown.create(),
      typeName: ZodFirstPartyTypeKind.ZodFunction,
      ...processCreateParams(params)
    });
  }
};
var ZodLazy = class extends ZodType {
  get schema() {
    return this._def.getter();
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const lazySchema = this._def.getter();
    return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
  }
};
ZodLazy.create = (getter, params) => {
  return new ZodLazy({
    getter,
    typeName: ZodFirstPartyTypeKind.ZodLazy,
    ...processCreateParams(params)
  });
};
var ZodLiteral = class extends ZodType {
  _parse(input) {
    if (input.data !== this._def.value) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_literal,
        expected: this._def.value
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
  get value() {
    return this._def.value;
  }
};
ZodLiteral.create = (value, params) => {
  return new ZodLiteral({
    value,
    typeName: ZodFirstPartyTypeKind.ZodLiteral,
    ...processCreateParams(params)
  });
};
function createZodEnum(values, params) {
  return new ZodEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodEnum,
    ...processCreateParams(params)
  });
}
var ZodEnum = class _ZodEnum extends ZodType {
  _parse(input) {
    if (typeof input.data !== "string") {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(this._def.values);
    }
    if (!this._cache.has(input.data)) {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Values() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  extract(values, newDef = this._def) {
    return _ZodEnum.create(values, {
      ...this._def,
      ...newDef
    });
  }
  exclude(values, newDef = this._def) {
    return _ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
      ...this._def,
      ...newDef
    });
  }
};
ZodEnum.create = createZodEnum;
var ZodNativeEnum = class extends ZodType {
  _parse(input) {
    const nativeEnumValues = util.getValidEnumValues(this._def.values);
    const ctx = this._getOrReturnCtx(input);
    if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(util.getValidEnumValues(this._def.values));
    }
    if (!this._cache.has(input.data)) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get enum() {
    return this._def.values;
  }
};
ZodNativeEnum.create = (values, params) => {
  return new ZodNativeEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
    ...processCreateParams(params)
  });
};
var ZodPromise = class extends ZodType {
  unwrap() {
    return this._def.type;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.promise,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
    return OK(promisified.then((data) => {
      return this._def.type.parseAsync(data, {
        path: ctx.path,
        errorMap: ctx.common.contextualErrorMap
      });
    }));
  }
};
ZodPromise.create = (schema, params) => {
  return new ZodPromise({
    type: schema,
    typeName: ZodFirstPartyTypeKind.ZodPromise,
    ...processCreateParams(params)
  });
};
var ZodEffects = class extends ZodType {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const effect = this._def.effect || null;
    const checkCtx = {
      addIssue: (arg) => {
        addIssueToContext(ctx, arg);
        if (arg.fatal) {
          status.abort();
        } else {
          status.dirty();
        }
      },
      get path() {
        return ctx.path;
      }
    };
    checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
    if (effect.type === "preprocess") {
      const processed = effect.transform(ctx.data, checkCtx);
      if (ctx.common.async) {
        return Promise.resolve(processed).then(async (processed2) => {
          if (status.value === "aborted")
            return INVALID;
          const result = await this._def.schema._parseAsync({
            data: processed2,
            path: ctx.path,
            parent: ctx
          });
          if (result.status === "aborted")
            return INVALID;
          if (result.status === "dirty")
            return DIRTY(result.value);
          if (status.value === "dirty")
            return DIRTY(result.value);
          return result;
        });
      } else {
        if (status.value === "aborted")
          return INVALID;
        const result = this._def.schema._parseSync({
          data: processed,
          path: ctx.path,
          parent: ctx
        });
        if (result.status === "aborted")
          return INVALID;
        if (result.status === "dirty")
          return DIRTY(result.value);
        if (status.value === "dirty")
          return DIRTY(result.value);
        return result;
      }
    }
    if (effect.type === "refinement") {
      const executeRefinement = (acc) => {
        const result = effect.refinement(acc, checkCtx);
        if (ctx.common.async) {
          return Promise.resolve(result);
        }
        if (result instanceof Promise) {
          throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
        }
        return acc;
      };
      if (ctx.common.async === false) {
        const inner = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inner.status === "aborted")
          return INVALID;
        if (inner.status === "dirty")
          status.dirty();
        executeRefinement(inner.value);
        return { status: status.value, value: inner.value };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
          if (inner.status === "aborted")
            return INVALID;
          if (inner.status === "dirty")
            status.dirty();
          return executeRefinement(inner.value).then(() => {
            return { status: status.value, value: inner.value };
          });
        });
      }
    }
    if (effect.type === "transform") {
      if (ctx.common.async === false) {
        const base = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (!isValid(base))
          return INVALID;
        const result = effect.transform(base.value, checkCtx);
        if (result instanceof Promise) {
          throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
        }
        return { status: status.value, value: result };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base) => {
          if (!isValid(base))
            return INVALID;
          return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
            status: status.value,
            value: result
          }));
        });
      }
    }
    util.assertNever(effect);
  }
};
ZodEffects.create = (schema, effect, params) => {
  return new ZodEffects({
    schema,
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    effect,
    ...processCreateParams(params)
  });
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
  return new ZodEffects({
    schema,
    effect: { type: "preprocess", transform: preprocess },
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    ...processCreateParams(params)
  });
};
var ZodOptional = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.undefined) {
      return OK(void 0);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodOptional.create = (type, params) => {
  return new ZodOptional({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodOptional,
    ...processCreateParams(params)
  });
};
var ZodNullable = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.null) {
      return OK(null);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodNullable.create = (type, params) => {
  return new ZodNullable({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodNullable,
    ...processCreateParams(params)
  });
};
var ZodDefault = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    let data = ctx.data;
    if (ctx.parsedType === ZodParsedType.undefined) {
      data = this._def.defaultValue();
    }
    return this._def.innerType._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  removeDefault() {
    return this._def.innerType;
  }
};
ZodDefault.create = (type, params) => {
  return new ZodDefault({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodDefault,
    defaultValue: typeof params.default === "function" ? params.default : () => params.default,
    ...processCreateParams(params)
  });
};
var ZodCatch = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const newCtx = {
      ...ctx,
      common: {
        ...ctx.common,
        issues: []
      }
    };
    const result = this._def.innerType._parse({
      data: newCtx.data,
      path: newCtx.path,
      parent: {
        ...newCtx
      }
    });
    if (isAsync(result)) {
      return result.then((result2) => {
        return {
          status: "valid",
          value: result2.status === "valid" ? result2.value : this._def.catchValue({
            get error() {
              return new ZodError(newCtx.common.issues);
            },
            input: newCtx.data
          })
        };
      });
    } else {
      return {
        status: "valid",
        value: result.status === "valid" ? result.value : this._def.catchValue({
          get error() {
            return new ZodError(newCtx.common.issues);
          },
          input: newCtx.data
        })
      };
    }
  }
  removeCatch() {
    return this._def.innerType;
  }
};
ZodCatch.create = (type, params) => {
  return new ZodCatch({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodCatch,
    catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
    ...processCreateParams(params)
  });
};
var ZodNaN = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.nan) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.nan,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
};
ZodNaN.create = (params) => {
  return new ZodNaN({
    typeName: ZodFirstPartyTypeKind.ZodNaN,
    ...processCreateParams(params)
  });
};
var BRAND = Symbol("zod_brand");
var ZodBranded = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const data = ctx.data;
    return this._def.type._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  unwrap() {
    return this._def.type;
  }
};
var ZodPipeline = class _ZodPipeline extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.common.async) {
      const handleAsync = async () => {
        const inResult = await this._def.in._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inResult.status === "aborted")
          return INVALID;
        if (inResult.status === "dirty") {
          status.dirty();
          return DIRTY(inResult.value);
        } else {
          return this._def.out._parseAsync({
            data: inResult.value,
            path: ctx.path,
            parent: ctx
          });
        }
      };
      return handleAsync();
    } else {
      const inResult = this._def.in._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
      if (inResult.status === "aborted")
        return INVALID;
      if (inResult.status === "dirty") {
        status.dirty();
        return {
          status: "dirty",
          value: inResult.value
        };
      } else {
        return this._def.out._parseSync({
          data: inResult.value,
          path: ctx.path,
          parent: ctx
        });
      }
    }
  }
  static create(a, b) {
    return new _ZodPipeline({
      in: a,
      out: b,
      typeName: ZodFirstPartyTypeKind.ZodPipeline
    });
  }
};
var ZodReadonly = class extends ZodType {
  _parse(input) {
    const result = this._def.innerType._parse(input);
    const freeze = (data) => {
      if (isValid(data)) {
        data.value = Object.freeze(data.value);
      }
      return data;
    };
    return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodReadonly.create = (type, params) => {
  return new ZodReadonly({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodReadonly,
    ...processCreateParams(params)
  });
};
function cleanParams(params, data) {
  const p = typeof params === "function" ? params(data) : typeof params === "string" ? { message: params } : params;
  const p2 = typeof p === "string" ? { message: p } : p;
  return p2;
}
function custom(check, _params = {}, fatal) {
  if (check)
    return ZodAny.create().superRefine((data, ctx) => {
      const r = check(data);
      if (r instanceof Promise) {
        return r.then((r2) => {
          if (!r2) {
            const params = cleanParams(_params, data);
            const _fatal = params.fatal ?? fatal ?? true;
            ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
          }
        });
      }
      if (!r) {
        const params = cleanParams(_params, data);
        const _fatal = params.fatal ?? fatal ?? true;
        ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
      }
      return;
    });
  return ZodAny.create();
}
var late = {
  object: ZodObject.lazycreate
};
var ZodFirstPartyTypeKind;
(function(ZodFirstPartyTypeKind2) {
  ZodFirstPartyTypeKind2["ZodString"] = "ZodString";
  ZodFirstPartyTypeKind2["ZodNumber"] = "ZodNumber";
  ZodFirstPartyTypeKind2["ZodNaN"] = "ZodNaN";
  ZodFirstPartyTypeKind2["ZodBigInt"] = "ZodBigInt";
  ZodFirstPartyTypeKind2["ZodBoolean"] = "ZodBoolean";
  ZodFirstPartyTypeKind2["ZodDate"] = "ZodDate";
  ZodFirstPartyTypeKind2["ZodSymbol"] = "ZodSymbol";
  ZodFirstPartyTypeKind2["ZodUndefined"] = "ZodUndefined";
  ZodFirstPartyTypeKind2["ZodNull"] = "ZodNull";
  ZodFirstPartyTypeKind2["ZodAny"] = "ZodAny";
  ZodFirstPartyTypeKind2["ZodUnknown"] = "ZodUnknown";
  ZodFirstPartyTypeKind2["ZodNever"] = "ZodNever";
  ZodFirstPartyTypeKind2["ZodVoid"] = "ZodVoid";
  ZodFirstPartyTypeKind2["ZodArray"] = "ZodArray";
  ZodFirstPartyTypeKind2["ZodObject"] = "ZodObject";
  ZodFirstPartyTypeKind2["ZodUnion"] = "ZodUnion";
  ZodFirstPartyTypeKind2["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
  ZodFirstPartyTypeKind2["ZodIntersection"] = "ZodIntersection";
  ZodFirstPartyTypeKind2["ZodTuple"] = "ZodTuple";
  ZodFirstPartyTypeKind2["ZodRecord"] = "ZodRecord";
  ZodFirstPartyTypeKind2["ZodMap"] = "ZodMap";
  ZodFirstPartyTypeKind2["ZodSet"] = "ZodSet";
  ZodFirstPartyTypeKind2["ZodFunction"] = "ZodFunction";
  ZodFirstPartyTypeKind2["ZodLazy"] = "ZodLazy";
  ZodFirstPartyTypeKind2["ZodLiteral"] = "ZodLiteral";
  ZodFirstPartyTypeKind2["ZodEnum"] = "ZodEnum";
  ZodFirstPartyTypeKind2["ZodEffects"] = "ZodEffects";
  ZodFirstPartyTypeKind2["ZodNativeEnum"] = "ZodNativeEnum";
  ZodFirstPartyTypeKind2["ZodOptional"] = "ZodOptional";
  ZodFirstPartyTypeKind2["ZodNullable"] = "ZodNullable";
  ZodFirstPartyTypeKind2["ZodDefault"] = "ZodDefault";
  ZodFirstPartyTypeKind2["ZodCatch"] = "ZodCatch";
  ZodFirstPartyTypeKind2["ZodPromise"] = "ZodPromise";
  ZodFirstPartyTypeKind2["ZodBranded"] = "ZodBranded";
  ZodFirstPartyTypeKind2["ZodPipeline"] = "ZodPipeline";
  ZodFirstPartyTypeKind2["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
var instanceOfType = (cls, params = {
  message: `Input not instance of ${cls.name}`
}) => custom((data) => data instanceof cls, params);
var stringType = ZodString.create;
var numberType = ZodNumber.create;
var nanType = ZodNaN.create;
var bigIntType = ZodBigInt.create;
var booleanType = ZodBoolean.create;
var dateType = ZodDate.create;
var symbolType = ZodSymbol.create;
var undefinedType = ZodUndefined.create;
var nullType = ZodNull.create;
var anyType = ZodAny.create;
var unknownType = ZodUnknown.create;
var neverType = ZodNever.create;
var voidType = ZodVoid.create;
var arrayType = ZodArray.create;
var objectType = ZodObject.create;
var strictObjectType = ZodObject.strictCreate;
var unionType = ZodUnion.create;
var discriminatedUnionType = ZodDiscriminatedUnion.create;
var intersectionType = ZodIntersection.create;
var tupleType = ZodTuple.create;
var recordType = ZodRecord.create;
var mapType = ZodMap.create;
var setType = ZodSet.create;
var functionType = ZodFunction.create;
var lazyType = ZodLazy.create;
var literalType = ZodLiteral.create;
var enumType = ZodEnum.create;
var nativeEnumType = ZodNativeEnum.create;
var promiseType = ZodPromise.create;
var effectsType = ZodEffects.create;
var optionalType = ZodOptional.create;
var nullableType = ZodNullable.create;
var preprocessType = ZodEffects.createWithPreprocess;
var pipelineType = ZodPipeline.create;
var ostring = () => stringType().optional();
var onumber = () => numberType().optional();
var oboolean = () => booleanType().optional();
var coerce = {
  string: (arg) => ZodString.create({ ...arg, coerce: true }),
  number: (arg) => ZodNumber.create({ ...arg, coerce: true }),
  boolean: (arg) => ZodBoolean.create({
    ...arg,
    coerce: true
  }),
  bigint: (arg) => ZodBigInt.create({ ...arg, coerce: true }),
  date: (arg) => ZodDate.create({ ...arg, coerce: true })
};
var NEVER = INVALID;

// packages/plugin-sdk/src/contracts.ts
var PLUGIN_MANIFEST_SCHEMA_VERSION = 1;
var PLUGIN_RUNTIME_PROTOCOL_VERSION = 1;
var IDENTIFIER_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
var CAPABILITY_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*@[1-9][0-9]*$/;
var PERMISSION_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?::[a-z0-9]+(?:-[a-z0-9]+)*)+$/;
var VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
var RANGE_PATTERN = /^(?:\^|>=)?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
var unique = (values) => new Set(values).size === values.length;
var PluginManifestV1Schema = external_exports.object({
  schemaVersion: external_exports.literal(PLUGIN_MANIFEST_SCHEMA_VERSION),
  id: external_exports.string().min(3).max(96).regex(IDENTIFIER_PATTERN),
  name: external_exports.string().min(1).max(96),
  version: external_exports.string().regex(VERSION_PATTERN),
  pluginApi: external_exports.string().regex(RANGE_PATTERN),
  minCoreVersion: external_exports.string().regex(RANGE_PATTERN),
  capabilities: external_exports.array(external_exports.string().regex(CAPABILITY_PATTERN)).max(32),
  requiredCapabilities: external_exports.array(external_exports.string().regex(CAPABILITY_PATTERN)).max(32),
  permissions: external_exports.array(external_exports.string().regex(PERMISSION_PATTERN)).max(64)
}).strict().superRefine((value, context) => {
  for (const [field, values] of [
    ["capabilities", value.capabilities],
    ["requiredCapabilities", value.requiredCapabilities],
    ["permissions", value.permissions]
  ]) {
    if (!unique(values)) context.addIssue({ code: external_exports.ZodIssueCode.custom, path: [field], message: `${field} must not contain duplicates` });
  }
});
var PLUGIN_LIFECYCLE_STATES = ["REGISTERED", "ACTIVATING", "READY", "DEACTIVATING", "INACTIVE", "DISABLED", "FAILED", "NEEDS_ASSETS", "BLOCKED_DEPENDENCY"];
var CAPABILITY_DEPENDENCY_STATUSES = ["available", "provider_not_ready", "provider_not_allowed", "unresolved"];
var PLUGIN_SIGNER_KINDS = ["teamuq", "dev", "unsigned"];
var PluginRuntimeSnapshotRequestV1Schema = external_exports.object({
  protocolVersion: external_exports.literal(PLUGIN_RUNTIME_PROTOCOL_VERSION)
}).strict();
var PluginRuntimeSetEnabledRequestV1Schema = external_exports.object({
  protocolVersion: external_exports.literal(PLUGIN_RUNTIME_PROTOCOL_VERSION),
  pluginId: external_exports.string().regex(IDENTIFIER_PATTERN),
  enabled: external_exports.boolean()
}).strict();
var PluginRuntimeReactivateRequestV1Schema = external_exports.object({
  protocolVersion: external_exports.literal(PLUGIN_RUNTIME_PROTOCOL_VERSION),
  pluginId: external_exports.string().regex(IDENTIFIER_PATTERN)
}).strict();
var PluginViewDeclarationV1Schema = external_exports.object({
  id: external_exports.string().regex(IDENTIFIER_PATTERN).max(32),
  title: external_exports.string().min(1).max(48),
  presentations: external_exports.array(external_exports.enum(["tab", "window", "fullpage", "overlay", "settings"])).min(1).max(5),
  defaultPresentation: external_exports.enum(["tab", "window", "fullpage", "overlay", "settings"])
}).strict();
var PluginDependencyProviderV1Schema = external_exports.object({
  id: external_exports.string().regex(IDENTIFIER_PATTERN),
  version: external_exports.string().regex(VERSION_PATTERN),
  name: external_exports.string().max(96),
  signer: external_exports.enum(PLUGIN_SIGNER_KINDS),
  state: external_exports.enum(PLUGIN_LIFECYCLE_STATES),
  allowed: external_exports.boolean(),
  selected: external_exports.boolean()
}).strict();
var PluginDependencyStatusV1Schema = external_exports.object({
  capability: external_exports.string().regex(CAPABILITY_PATTERN),
  required: external_exports.boolean(),
  status: external_exports.enum(CAPABILITY_DEPENDENCY_STATUSES),
  providers: external_exports.array(PluginDependencyProviderV1Schema).max(16)
}).strict();
var PluginRuntimeEntrySnapshotV1Schema = external_exports.object({
  id: external_exports.string().regex(IDENTIFIER_PATTERN),
  version: external_exports.string().regex(VERSION_PATTERN),
  enabled: external_exports.boolean(),
  state: external_exports.enum(PLUGIN_LIFECYCLE_STATES),
  health: external_exports.enum(["ready", "failed", "unknown"]),
  capabilities: external_exports.array(external_exports.string().regex(CAPABILITY_PATTERN)),
  permissions: external_exports.array(external_exports.string().regex(PERMISSION_PATTERN)),
  revision: external_exports.number().int().nonnegative(),
  errorCode: external_exports.string().min(1).max(96).nullable(),
  views: external_exports.array(PluginViewDeclarationV1Schema).max(3).default([]),
  dependencies: external_exports.array(PluginDependencyStatusV1Schema).max(64).default([])
}).strict();
var PluginRuntimeSnapshotV1Schema = external_exports.object({
  protocolVersion: external_exports.literal(PLUGIN_RUNTIME_PROTOCOL_VERSION),
  revision: external_exports.number().int().nonnegative(),
  plugins: external_exports.array(PluginRuntimeEntrySnapshotV1Schema)
}).strict();
var PluginRuntimeChangedEventV1Schema = external_exports.object({
  protocolVersion: external_exports.literal(PLUGIN_RUNTIME_PROTOCOL_VERSION),
  snapshot: PluginRuntimeSnapshotV1Schema
}).strict();
var PluginRuntimeErrorV1Schema = external_exports.object({
  code: external_exports.string().min(1).max(96).regex(/^[a-z0-9_]+$/),
  message: external_exports.string().min(1).max(512)
}).strict();
var PluginRuntimeSnapshotEnvelopeV1Schema = external_exports.discriminatedUnion("ok", [
  external_exports.object({
    protocolVersion: external_exports.literal(PLUGIN_RUNTIME_PROTOCOL_VERSION),
    ok: external_exports.literal(true),
    value: PluginRuntimeSnapshotV1Schema
  }).strict(),
  external_exports.object({
    protocolVersion: external_exports.literal(PLUGIN_RUNTIME_PROTOCOL_VERSION),
    ok: external_exports.literal(false),
    error: PluginRuntimeErrorV1Schema
  }).strict()
]);
var PLUGIN_RUNTIME_CHANNELS = Object.freeze({
  SNAPSHOT: "plugin-runtime:snapshot",
  SET_ENABLED: "plugin-runtime:setEnabled",
  REACTIVATE: "plugin-runtime:reactivate",
  CHANGED: "plugin-runtime:changed"
});
function parseVersion(value) {
  const match = VERSION_PATTERN.exec(value);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}
function versionSatisfies(version2, range) {
  const parsed = parseVersion(version2);
  const target = parseVersion(range.replace(/^(?:\^|>=)/, ""));
  if (parsed === null || target === null) return false;
  const compare = parsed[0] - target[0] || parsed[1] - target[1] || parsed[2] - target[2];
  if (range.startsWith(">=")) return compare >= 0;
  if (range.startsWith("^")) {
    if (compare < 0) return false;
    if (target[0] > 0) return parsed[0] === target[0];
    if (target[1] > 0) return parsed[0] === 0 && parsed[1] === target[1];
    return parsed[0] === 0 && parsed[1] === 0 && parsed[2] === target[2];
  }
  return compare === 0;
}

// packages/plugin-sdk/src/hostProtocol.ts
var PLUGIN_HOST_PROTOCOL_VERSION = 1;
var protocolVersion = external_exports.literal(PLUGIN_HOST_PROTOCOL_VERSION);
var requestId = external_exports.string();
var pluginId = external_exports.string();
var hostResponseErrorShape = external_exports.object({
  code: external_exports.string().min(1).max(96).regex(/^[a-z0-9_]+$/),
  message: external_exports.string().min(1).max(512)
}).strict();
var HostActivateCommandV1Schema = external_exports.object({
  protocolVersion,
  requestId,
  kind: external_exports.literal("activate"),
  pluginId,
  grantedPermissions: external_exports.array(external_exports.string())
}).strict();
var HostHealthCommandV1Schema = external_exports.object({ protocolVersion, requestId, kind: external_exports.literal("health"), pluginId }).strict();
var HostDeactivateCommandV1Schema = external_exports.object({ protocolVersion, requestId, kind: external_exports.literal("deactivate"), pluginId }).strict();
var HostShutdownCommandV1Schema = external_exports.object({ protocolVersion, requestId, kind: external_exports.literal("shutdown") }).strict();
var HostCommandEnvelopeV1Schema = external_exports.discriminatedUnion("kind", [
  HostActivateCommandV1Schema,
  HostHealthCommandV1Schema,
  HostDeactivateCommandV1Schema,
  HostShutdownCommandV1Schema
]);
var HostResponseEnvelopeV1Schema = external_exports.discriminatedUnion("ok", [
  external_exports.object({ protocolVersion, requestId, ok: external_exports.literal(true), value: external_exports.unknown() }).strict(),
  external_exports.object({ protocolVersion, requestId, ok: external_exports.literal(false), error: hostResponseErrorShape }).strict()
]);
var HostHeartbeatV1Schema = external_exports.object({ protocolVersion, kind: external_exports.literal("heartbeat"), sentAt: external_exports.number() }).strict();
var HostResourceObservationV1Schema = external_exports.object({
  protocolVersion,
  kind: external_exports.literal("resource-observation"),
  eventId: external_exports.string().min(1),
  operationId: external_exports.string().min(1),
  rssKb: external_exports.number().nonnegative(),
  limitKb: external_exports.number().nonnegative()
}).strict();
var HostResourceObservationAckV1Schema = external_exports.object({
  protocolVersion,
  kind: external_exports.literal("resource-observation-ack"),
  eventId: external_exports.string().min(1),
  operationId: external_exports.string().min(1),
  accepted: external_exports.boolean()
}).strict();
var HostBootAckV1Schema = external_exports.object({
  protocolVersion,
  kind: external_exports.literal("boot-ack"),
  pluginHostVersion: external_exports.string(),
  corePackaged: external_exports.boolean()
}).strict();
var HostBootFailedV1Schema = external_exports.object({ protocolVersion, kind: external_exports.literal("boot-failed"), reason: external_exports.string() }).strict();
var HostCapabilityCallV1Schema = external_exports.object({
  protocolVersion,
  requestId,
  kind: external_exports.literal("capability-call"),
  pluginId,
  capabilityId: external_exports.string(),
  method: external_exports.string(),
  args: external_exports.array(external_exports.unknown())
}).strict();
var HostIdentityTaskChangedV1Schema = external_exports.object({
  protocolVersion,
  kind: external_exports.literal("identity-task-changed"),
  event: external_exports.object({
    task: external_exports.object({
      id: external_exports.string(),
      sourceKey: external_exports.string(),
      name: external_exports.string().optional(),
      nativeStatus: external_exports.string().nullable().optional(),
      authoredRevision: external_exports.number().optional(),
      readOnly: external_exports.boolean().optional(),
      unowned: external_exports.boolean().optional(),
      archived: external_exports.boolean().optional()
    }).strict(),
    source: external_exports.enum(["native", "pm-sync"])
  }).strict()
}).strict();

// packages/plugin-sdk/src/aiChatContracts.ts
var PLUGIN_AI_CHANNELS = Object.freeze({
  REQUEST: "plugin-view:ai",
  EVENT: "plugin-view:ai-event"
});
var AI_CHAT_LIMITS = Object.freeze({
  systemChars: 16e3,
  transcriptLines: 40,
  transcriptLineChars: 8e3,
  transcriptChars: 6e4,
  inputChars: 8e3,
  imageBytes: 2 * 1024 * 1024,
  replyChars: 32e3,
  sessionsPerPlugin: 1,
  sessionsTotal: 8,
  concurrentTurnsTotal: 4,
  turnsPerMinute: 20,
  turnsPerHour: 400,
  turnTimeoutMs: 3e5,
  attachGraceMs: 6e4,
  quotaCooldownMs: 5 * 6e4,
  hiddenWindowMs: 2 * 6e4,
  hiddenOpensPerInput: 2,
  hiddenTurnsPerInput: 2
});
var AI_CHAT_EFFORTS = Object.freeze(["minimal", "low", "medium", "high", "xhigh"]);
var AI_CHAT_ERROR_CODES = Object.freeze([
  "plugin_not_active",
  "not_granted",
  "request_invalid",
  "input_too_large",
  "provider_not_found",
  "provider_not_ready",
  "model_unavailable",
  "unsupported_image",
  "session_limit",
  "session_not_found",
  "turn_in_progress",
  "rate_limited",
  "quota_exhausted",
  "busy",
  "view_not_visible",
  "unavailable"
]);
var sessionId = external_exports.string().regex(/^[0-9a-f]{32}$/);
var providerId = external_exports.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
var modelId = external_exports.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/);
var effort = external_exports.enum(AI_CHAT_EFFORTS);
var line = external_exports.object({ role: external_exports.enum(["user", "assistant"]), text: external_exports.string().max(AI_CHAT_LIMITS.transcriptLineChars) }).strict();
var AiChatImageSchema = external_exports.object({
  mime: external_exports.enum(["image/jpeg", "image/png"]),
  data: external_exports.custom((value) => value instanceof Uint8Array && value.byteLength > 0 && value.byteLength <= AI_CHAT_LIMITS.imageBytes)
}).strict();
var AiChatRequestVariants = external_exports.discriminatedUnion("op", [
  external_exports.object({ op: external_exports.literal("getOptions") }).strict(),
  external_exports.object({
    op: external_exports.literal("openSession"),
    providerId: providerId.optional(),
    modelId: modelId.optional(),
    effort: effort.optional(),
    system: external_exports.string().min(1).max(AI_CHAT_LIMITS.systemChars),
    transcript: external_exports.array(line).max(AI_CHAT_LIMITS.transcriptLines).optional()
  }).strict(),
  external_exports.object({ op: external_exports.literal("send"), sessionId, text: external_exports.string().max(AI_CHAT_LIMITS.inputChars), image: AiChatImageSchema.optional() }).strict(),
  external_exports.object({ op: external_exports.literal("interrupt"), sessionId }).strict(),
  external_exports.object({ op: external_exports.literal("close"), sessionId }).strict(),
  external_exports.object({ op: external_exports.literal("attachSession"), sessionId }).strict()
]);
var AiChatRequestSchema = AiChatRequestVariants.refine((value) => value.op !== "send" || value.text.trim() !== "" || value.image !== void 0, { message: "a turn needs text or an image" });
var modelView = external_exports.object({
  id: external_exports.string().max(96),
  label: external_exports.string().max(96),
  efforts: external_exports.array(external_exports.string().max(16)).max(8),
  defaultEffort: external_exports.string().max(16).nullable(),
  supportsImages: external_exports.boolean(),
  isDefault: external_exports.boolean()
}).strict();
var AiChatProviderViewSchema = external_exports.object({
  id: providerId,
  label: external_exports.string().max(48),
  state: external_exports.enum(["ready", "not_installed", "not_logged_in", "unsupported_version", "unavailable", "not_supported_yet"]),
  models: external_exports.array(modelView).max(32)
}).strict();
var AiChatOptionsSchema = external_exports.object({
  providers: external_exports.array(AiChatProviderViewSchema).max(8),
  defaultProviderId: providerId.nullable(),
  limits: external_exports.object({
    systemChars: external_exports.number().int(),
    transcriptLines: external_exports.number().int(),
    transcriptChars: external_exports.number().int(),
    inputChars: external_exports.number().int(),
    imageBytes: external_exports.number().int(),
    turnsPerMinute: external_exports.number().int()
  }).strict(),
  quota: external_exports.object({ state: external_exports.enum(["ok", "exhausted"]), retryAfterMs: external_exports.number().int().nonnegative().nullable() }).strict()
}).strict();
var effective = external_exports.object({ providerId, modelId: external_exports.string().max(96), effort: external_exports.string().max(16).nullable() }).strict();
var AiChatOpenedSchema = external_exports.object({ sessionId, effective }).strict();
var AiChatSentSchema = external_exports.object({ turnId: external_exports.string().regex(/^[0-9a-f]{16}$/) }).strict();
var AiChatFailureSchema = external_exports.object({
  kind: external_exports.literal("failed"),
  code: external_exports.enum(["provider_unavailable", "unsupported_version", "quota_exhausted", "stalled", "provider_error", "empty_reply", "session_closed", "reply_too_long", "turn_timeout", "access_revoked"]),
  retryable: external_exports.boolean(),
  fallbackUsed: external_exports.boolean(),
  partialDelivered: external_exports.boolean()
}).strict();
var AiChatTurnEventSchema = external_exports.discriminatedUnion("kind", [
  external_exports.object({ kind: external_exports.literal("started") }).strict(),
  external_exports.object({ kind: external_exports.literal("textDelta"), text: external_exports.string().max(AI_CHAT_LIMITS.replyChars) }).strict(),
  external_exports.object({ kind: external_exports.literal("completed") }).strict(),
  external_exports.object({ kind: external_exports.literal("interrupted") }).strict(),
  AiChatFailureSchema
]);
var AiChatAttachedSchema = external_exports.object({
  sessionId,
  effective,
  turn: external_exports.object({ turnId: external_exports.string().regex(/^[0-9a-f]{16}$/), text: external_exports.string().max(AI_CHAT_LIMITS.replyChars), terminal: AiChatTurnEventSchema.nullable() }).strict().nullable()
}).strict();
var AiChatEnvelopeSchema = external_exports.discriminatedUnion("ok", [
  external_exports.object({ ok: external_exports.literal(true), value: external_exports.unknown() }).strict(),
  external_exports.object({ ok: external_exports.literal(false), error: external_exports.enum(AI_CHAT_ERROR_CODES) }).strict()
]);
var AiChatViewEventSchema = external_exports.object({ sessionId, turnId: external_exports.string().regex(/^[0-9a-f]{16}$/), event: AiChatTurnEventSchema }).strict();
var AiChatUsageSchema = external_exports.object({
  activeSessions: external_exports.number().int().nonnegative(),
  sessionsOpened: external_exports.number().int().nonnegative(),
  turns: external_exports.number().int().nonnegative(),
  imageTurns: external_exports.number().int().nonnegative(),
  failedTurns: external_exports.number().int().nonnegative(),
  rateLimited: external_exports.number().int().nonnegative(),
  inputChars: external_exports.number().int().nonnegative(),
  outputChars: external_exports.number().int().nonnegative(),
  lastTurnAt: external_exports.string().max(40).nullable()
}).strict();

// packages/plugin-sdk/src/textInputContracts.ts
var TEXT_INPUT_CAPABILITY = "teamuq.text-input@1";
var TEXT_INPUT_PERMISSION = "input:text";
var CORE_CALLER_ID = "core";
var TEXT_INPUT_CHANNELS = Object.freeze({
  STATE: "plugin-text-input:state",
  SUBMIT: "plugin-text-input:submit"
});
var TEXT_INPUT_LIMITS = Object.freeze({
  textBytes: 4096,
  inputsPerSecond: 5,
  pendingInputs: 64,
  pendingTtlMs: 3e4,
  ackTimeoutMs: 5e3
});
var CORE_INPUT_SOURCES = Object.freeze(["voice", "typed", "schedule"]);
var TEXT_INPUT_INTERRUPT_REASONS = Object.freeze(["escape"]);
var TEXT_INPUT_ACK_RESULTS = Object.freeze(["accepted", "dropped", "busy"]);
var TEXT_INPUT_SUBMIT_ERRORS = Object.freeze([
  "no_input_target",
  "input_invalid",
  "ack_timeout",
  "provider_not_ready",
  "provider_not_allowed",
  "provider_selection_required",
  "capability_unresolved",
  "capability_busy",
  "consumer_limit",
  "rate_limited",
  "message_too_large",
  "open_timeout",
  "provider_error",
  "session_closed",
  "plugin_text_input_forbidden",
  "plugin_text_input_validation",
  "plugin_text_input_failed"
]);
var protocolVersion2 = external_exports.literal(PLUGIN_RUNTIME_PROTOCOL_VERSION);
var pluginId2 = external_exports.string().min(3).max(96).regex(IDENTIFIER_PATTERN);
var inputId = external_exports.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
var reason = external_exports.string().regex(/^[a-z0-9_]{1,32}$/);
var utterance = external_exports.object({ startMs: external_exports.number().int().min(0), endMs: external_exports.number().int().min(0) }).strict().refine((value) => value.endMs >= value.startMs, { message: "endMs must not precede startMs" });
var utf8Bytes = (value) => new TextEncoder().encode(value).length;
var textInputText = external_exports.string().min(1).refine((value) => utf8Bytes(value) <= TEXT_INPUT_LIMITS.textBytes, { message: "text too large" });
var TextInputSourceSchema = external_exports.union([external_exports.enum(CORE_INPUT_SOURCES), external_exports.string().max(104).regex(/^plugin:[a-z0-9]+(?:[.-][a-z0-9]+)*$/)]);
var TextInputCallerMessageSchema = external_exports.object({ type: external_exports.literal("input"), inputId, text: textInputText }).strict();
var TextInputDeliveredSchema = external_exports.object({
  type: external_exports.literal("input"),
  inputId,
  text: textInputText,
  source: TextInputSourceSchema,
  callerId: external_exports.union([external_exports.literal(CORE_CALLER_ID), pluginId2]),
  receivedAtMs: external_exports.number().int().min(0),
  arrivedWhileSpeaking: external_exports.boolean(),
  utterance: utterance.optional()
}).strict();
var TextInputInterruptRequestSchema = external_exports.object({ type: external_exports.literal("interrupt"), reason: external_exports.enum(TEXT_INPUT_INTERRUPT_REASONS) }).strict();
var TextInputInterruptDeliveredSchema = external_exports.object({ type: external_exports.literal("interrupt"), reason: external_exports.enum(TEXT_INPUT_INTERRUPT_REASONS), receivedAtMs: external_exports.number().int().min(0) }).strict();
var TextInputAckSchema = external_exports.object({ type: external_exports.literal("ack"), inputId, result: external_exports.enum(TEXT_INPUT_ACK_RESULTS), reason: reason.optional() }).strict();
var TextInputStateSchema = external_exports.object({ type: external_exports.literal("state"), speaking: external_exports.boolean() }).strict();
var TextInputStateRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion2 }).strict();
var TextInputSubmitRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion2, text: textInputText }).strict();
var ProviderRowSchema = external_exports.object({
  id: pluginId2,
  name: external_exports.string().max(96),
  version: external_exports.string().max(32),
  signer: external_exports.enum(PLUGIN_SIGNER_KINDS),
  state: external_exports.enum(PLUGIN_LIFECYCLE_STATES),
  ready: external_exports.boolean(),
  live: external_exports.boolean(),
  selected: external_exports.boolean()
}).strict();
var TextInputStateV1Schema = external_exports.object({
  protocolVersion: protocolVersion2,
  status: external_exports.enum(CAPABILITY_DEPENDENCY_STATUSES),
  target: external_exports.object({ id: pluginId2, name: external_exports.string().max(96), version: external_exports.string().max(32), signer: external_exports.enum(PLUGIN_SIGNER_KINDS), live: external_exports.boolean() }).strict().nullable(),
  explicitTargetId: pluginId2.nullable(),
  providers: external_exports.array(ProviderRowSchema).max(16)
}).strict();
var TextInputSubmitValueV1Schema = external_exports.object({
  result: external_exports.enum(TEXT_INPUT_ACK_RESULTS),
  reason: reason.optional(),
  target: external_exports.object({ id: pluginId2, name: external_exports.string().max(96) }).strict()
}).strict();
var errorBody = external_exports.object({ code: external_exports.string().min(1).max(96).regex(/^[a-z0-9_]+$/), message: external_exports.string().min(1).max(512) }).strict();
var TextInputStateEnvelopeV1Schema = external_exports.discriminatedUnion("ok", [
  external_exports.object({ protocolVersion: protocolVersion2, ok: external_exports.literal(true), value: TextInputStateV1Schema }).strict(),
  external_exports.object({ protocolVersion: protocolVersion2, ok: external_exports.literal(false), error: errorBody }).strict()
]);
var TextInputSubmitEnvelopeV1Schema = external_exports.discriminatedUnion("ok", [
  external_exports.object({ protocolVersion: protocolVersion2, ok: external_exports.literal(true), value: TextInputSubmitValueV1Schema }).strict(),
  external_exports.object({ protocolVersion: protocolVersion2, ok: external_exports.literal(false), error: errorBody }).strict()
]);

// packages/plugin-sdk/src/capabilityContracts.ts
var PLUGIN_CAPABILITY_CHANNELS = Object.freeze({
  REQUEST: "plugin-view:capability",
  SEND: "plugin-view:capability-send",
  EVENT: "plugin-view:capability-event",
  PROVIDE: "plugin-view:capability-provide",
  PROVIDER_EVENT: "plugin-view:capability-provider-event"
});
var CAPABILITY_GATE_PERMISSIONS = Object.freeze(["speech:transcribe", "speech:synthesize", TEXT_INPUT_PERMISSION]);
var CAPABILITY_LIMITS = Object.freeze({
  messageBytes: 16 * 1024,
  dataBytes: 64 * 1024,
  optionsBytes: 4 * 1024,
  sessionsPerConsumer: 2,
  bytesPerSecond: 256 * 1024,
  burstBytes: 512 * 1024,
  messagesPerSecond: 200,
  burstMessages: 100,
  openTimeoutMs: 15e3,
  idleSessionMs: 5 * 6e4,
  consentCooldownMs: 8e3,
  hiddenWindowMs: AI_CHAT_LIMITS.hiddenWindowMs,
  hiddenOpensPerInput: AI_CHAT_LIMITS.hiddenOpensPerInput
});
var CAPABILITY_ERROR_CODES = Object.freeze([
  "capability_request_invalid",
  "capability_undeclared",
  "capability_unresolved",
  "provider_not_ready",
  "provider_not_allowed",
  "provider_selection_required",
  "not_granted",
  "consent_denied",
  "capability_busy",
  "consumer_limit",
  "view_not_visible",
  "session_not_found",
  "message_too_large",
  "data_too_large",
  "rate_limited",
  "provider_error",
  "open_timeout",
  "plugin_not_active",
  "capability_unavailable",
  "not_configured",
  "auth_failed",
  "quota_exceeded",
  "network_unreachable",
  "unsupported_options"
]);
var CAPABILITY_PROVIDER_OPEN_ERRORS = Object.freeze(["not_configured", "auth_failed", "quota_exceeded", "network_unreachable", "unsupported_options"]);
var CAPABILITY_CLOSE_REASONS = Object.freeze([
  "consumer_closed",
  "view_hidden",
  "view_occluded",
  "view_closed",
  "view_reloaded",
  "provider_gone",
  "provider_crashed",
  "provider_closed",
  "consumer_gone",
  "rate_limited",
  "idle_timeout",
  "target_changed",
  "permission_revoked",
  "protocol_error",
  "shutdown"
]);
var CAPABILITY_VIEW_STATUSES = Object.freeze([...CAPABILITY_DEPENDENCY_STATUSES, "not_granted"]);
var capabilityId = external_exports.string().regex(CAPABILITY_PATTERN).max(96);
var sessionId2 = external_exports.string().regex(/^[0-9a-f]{32}$/);
var closeReason = external_exports.enum(CAPABILITY_CLOSE_REASONS);
var viewStatus = external_exports.enum(CAPABILITY_VIEW_STATUSES);
var pluginId3 = external_exports.string().regex(IDENTIFIER_PATTERN).max(96);
var jsonBytes = (value) => {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};
var CapabilityMessageSchema = external_exports.record(external_exports.string().max(64), external_exports.unknown()).refine((value) => typeof value["type"] === "string" && value["type"].length >= 1 && value["type"].length <= 48, { message: "message.type is required" }).refine((value) => jsonBytes(value) <= CAPABILITY_LIMITS.messageBytes, { message: "message too large" });
var CapabilityOptionsSchema = external_exports.record(external_exports.string().max(64), external_exports.unknown()).refine((value) => jsonBytes(value) <= CAPABILITY_LIMITS.optionsBytes, { message: "options too large" });
var CapabilityBytesSchema = external_exports.custom((value) => value instanceof Uint8Array);
var CapabilityRequestSchema = external_exports.discriminatedUnion("op", [
  external_exports.object({ op: external_exports.literal("list") }).strict(),
  external_exports.object({ op: external_exports.literal("open"), capability: capabilityId, options: CapabilityOptionsSchema.optional() }).strict(),
  external_exports.object({ op: external_exports.literal("close"), sessionId: sessionId2 }).strict()
]);
var CapabilitySendSchema = external_exports.object({ sessionId: sessionId2, message: CapabilityMessageSchema, data: CapabilityBytesSchema.optional() }).strict();
var CapabilityProviderViewSchema = external_exports.object({
  id: pluginId3,
  version: external_exports.string().max(32),
  name: external_exports.string().max(96),
  signer: external_exports.enum(PLUGIN_SIGNER_KINDS)
}).strict();
var CapabilityEntrySchema = external_exports.object({
  capability: capabilityId,
  required: external_exports.boolean(),
  status: viewStatus,
  provider: CapabilityProviderViewSchema.nullable(),
  permission: external_exports.string().max(64).nullable()
}).strict();
var CapabilityEntryListSchema = external_exports.array(CapabilityEntrySchema).max(64);
var CapabilityOpenedSchema = external_exports.object({ sessionId: sessionId2, capability: capabilityId, provider: CapabilityProviderViewSchema }).strict();
var CapabilityErrorEnvelopeSchema = external_exports.object({ ok: external_exports.literal(false), error: external_exports.enum(CAPABILITY_ERROR_CODES), message: external_exports.string().max(160).optional() }).strict();
var CapabilityEnvelopeSchema = external_exports.discriminatedUnion("ok", [
  external_exports.object({ ok: external_exports.literal(true), value: external_exports.unknown() }).strict(),
  CapabilityErrorEnvelopeSchema
]);
var CapabilityEventSchema = external_exports.discriminatedUnion("kind", [
  external_exports.object({ kind: external_exports.literal("message"), sessionId: sessionId2, message: CapabilityMessageSchema, data: CapabilityBytesSchema.optional() }).strict(),
  external_exports.object({ kind: external_exports.literal("closed"), sessionId: sessionId2, reason: closeReason }).strict(),
  external_exports.object({ kind: external_exports.literal("change"), capability: capabilityId, status: viewStatus, provider: CapabilityProviderViewSchema.nullable(), reason: external_exports.string().max(48).optional() }).strict()
]);
var CapabilityProvideRequestSchema = external_exports.discriminatedUnion("op", [
  external_exports.object({ op: external_exports.literal("register"), capability: capabilityId }).strict(),
  external_exports.object({ op: external_exports.literal("unregister"), capability: capabilityId }).strict(),
  external_exports.object({ op: external_exports.literal("send"), sessionId: sessionId2, message: CapabilityMessageSchema }).strict(),
  external_exports.object({ op: external_exports.literal("close"), sessionId: sessionId2 }).strict()
]);
var CapabilityProviderEventSchema = external_exports.discriminatedUnion("kind", [
  external_exports.object({ kind: external_exports.literal("open"), sessionId: sessionId2, capability: capabilityId, callerId: external_exports.string().min(3).max(96).regex(IDENTIFIER_PATTERN), options: CapabilityOptionsSchema }).strict(),
  external_exports.object({ kind: external_exports.literal("message"), sessionId: sessionId2, message: CapabilityMessageSchema }).strict(),
  external_exports.object({ kind: external_exports.literal("closed"), sessionId: sessionId2, reason: closeReason }).strict()
]);
var protocolVersion3 = external_exports.literal(1);
var externalErrorCode = external_exports.string().min(3).max(96).regex(/^[a-z0-9_]+$/);
var base64Data = external_exports.string().max(Math.ceil(CAPABILITY_LIMITS.dataBytes * 4 / 3) + 8).regex(/^[A-Za-z0-9+/]*={0,2}$/);
var ExternalSessionOpenSchema = external_exports.object({
  protocolVersion: protocolVersion3,
  kind: external_exports.literal("ext-session-open"),
  sessionId: sessionId2,
  capability: capabilityId,
  callerPluginId: pluginId3,
  options: CapabilityOptionsSchema
}).strict();
var ExternalSessionOpenedSchema = external_exports.discriminatedUnion("ok", [
  external_exports.object({ protocolVersion: protocolVersion3, kind: external_exports.literal("ext-session-opened"), sessionId: sessionId2, ok: external_exports.literal(true) }).strict(),
  external_exports.object({ protocolVersion: protocolVersion3, kind: external_exports.literal("ext-session-opened"), sessionId: sessionId2, ok: external_exports.literal(false), error: external_exports.object({ code: externalErrorCode, message: external_exports.string().max(240) }).strict() }).strict()
]);
var ExternalSessionMessageSchema = external_exports.object({
  protocolVersion: protocolVersion3,
  kind: external_exports.literal("ext-session-message"),
  sessionId: sessionId2,
  message: CapabilityMessageSchema,
  data: base64Data.optional()
}).strict();
var ExternalSessionCloseSchema = external_exports.object({
  protocolVersion: protocolVersion3,
  kind: external_exports.literal("ext-session-close"),
  sessionId: sessionId2,
  reason: external_exports.string().min(3).max(48).regex(/^[a-z0-9_]+$/)
}).strict();

// packages/plugin-sdk/src/networkOrigins.ts
var ALLOWED_SCHEMES = ["https:", "wss:"];
var LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa"];
function isIpLiteral(hostname) {
  return hostname.startsWith("[") || /^\d+(?:\.\d+){0,3}$/.test(hostname) || /^0x[0-9a-f]+$/i.test(hostname);
}
function isPublicDnsHost(hostname) {
  const host = hostname.toLowerCase();
  if (host.length === 0 || host.includes("*") || isIpLiteral(host)) return false;
  if (host === "localhost" || !host.includes(".")) return false;
  return !LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}
function parseDeclaredNetworkOrigin(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!ALLOWED_SCHEMES.includes(url.protocol)) return null;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
  if (url.pathname !== "/" || raw !== url.origin && raw !== `${url.origin}/`) return null;
  return isPublicDnsHost(url.hostname) ? url.origin : null;
}

// packages/plugin-sdk/src/plainText.ts
var UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
function isPlainText(value) {
  return !UNSAFE_TEXT.test(value);
}

// packages/plugin-sdk/src/settingsSchema.ts
var SETTINGS_SCHEMA_LIMITS = Object.freeze({ fields: 16, options: 16, labelChars: 48, helpChars: 200, textChars: 200, unitChars: 12 });
var KEY_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
var OPTION_VALUE_PATTERN = /^[A-Za-z0-9._-]{1,48}$/;
var FORBIDDEN_KEYS = /* @__PURE__ */ new Set(["__proto__", "constructor", "prototype"]);
var plainText = (max) => external_exports.string().min(1).max(max).refine(isPlainText, { message: "must be plain text without control, bidi or zero-width characters" });
var key = external_exports.string().regex(KEY_PATTERN).refine((value) => !FORBIDDEN_KEYS.has(value), { message: "must not be a reserved object key" });
var finite = external_exports.number().finite().min(-1e9).max(1e9);
var common = { key, label: plainText(SETTINGS_SCHEMA_LIMITS.labelChars), help: plainText(SETTINGS_SCHEMA_LIMITS.helpChars).optional() };
var ToggleField = external_exports.object({ ...common, type: external_exports.literal("toggle"), default: external_exports.boolean() }).strict();
var ChoiceField = external_exports.object({
  ...common,
  type: external_exports.literal("choice"),
  options: external_exports.array(external_exports.object({ value: external_exports.string().regex(OPTION_VALUE_PATTERN), label: plainText(SETTINGS_SCHEMA_LIMITS.labelChars) }).strict()).min(2).max(SETTINGS_SCHEMA_LIMITS.options),
  default: external_exports.string().regex(OPTION_VALUE_PATTERN)
}).strict();
var RangeField = external_exports.object({
  ...common,
  type: external_exports.literal("range"),
  min: finite,
  max: finite,
  step: external_exports.number().finite().positive().max(1e9).default(1),
  unit: plainText(SETTINGS_SCHEMA_LIMITS.unitChars).optional(),
  default: finite
}).strict();
var TextField = external_exports.object({
  ...common,
  type: external_exports.literal("text"),
  maxLength: external_exports.number().int().min(1).max(SETTINGS_SCHEMA_LIMITS.textChars).default(100),
  default: external_exports.string().max(SETTINGS_SCHEMA_LIMITS.textChars)
}).strict();
var PluginSettingFieldSchema = external_exports.discriminatedUnion("type", [ToggleField, ChoiceField, RangeField, TextField]);
function validateSettingValue(field, value) {
  switch (field.type) {
    case "toggle":
      return typeof value === "boolean" ? { ok: true, value } : { ok: false, issue: "type" };
    case "choice":
      if (typeof value !== "string") return { ok: false, issue: "type" };
      return field.options.some((option) => option.value === value) ? { ok: true, value } : { ok: false, issue: "option" };
    case "range": {
      if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, issue: "type" };
      if (value < field.min || value > field.max) return { ok: false, issue: "range" };
      const steps = (value - field.min) / field.step;
      return Math.abs(steps - Math.round(steps)) > 1e-9 ? { ok: false, issue: "step" } : { ok: true, value };
    }
    case "text":
      if (typeof value !== "string") return { ok: false, issue: "type" };
      if (!isPlainText(value)) return { ok: false, issue: "chars" };
      return [...value].length > field.maxLength ? { ok: false, issue: "length" } : { ok: true, value };
  }
}
var PluginSettingsSchemaSchema = external_exports.object({
  title: plainText(SETTINGS_SCHEMA_LIMITS.labelChars).optional(),
  summary: plainText(SETTINGS_SCHEMA_LIMITS.helpChars).optional(),
  fields: external_exports.array(PluginSettingFieldSchema).min(1).max(SETTINGS_SCHEMA_LIMITS.fields)
}).strict().superRefine((schema, context) => {
  const seen = /* @__PURE__ */ new Set();
  schema.fields.forEach((field, index) => {
    const fail = (path12, message) => {
      context.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["fields", index, path12], message });
    };
    if (seen.has(field.key)) fail("key", "setting keys must be unique");
    seen.add(field.key);
    if (field.type === "range" && field.min >= field.max) fail("max", "max must be greater than min");
    if (field.type === "choice" && new Set(field.options.map((option) => option.value)).size !== field.options.length) fail("options", "option values must be unique");
    const verdict = validateSettingValue(field, field.default);
    if (!verdict.ok) fail("default", `default is not a valid value (${verdict.issue})`);
  });
});
var SETTINGS_SCHEMA_PERMISSION = "settings:plugin";
var NAMESPACE_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*-$/u;
function assetPackNamespaceOf(pluginId8) {
  const dot = pluginId8.indexOf(".");
  if (dot <= 0 || dot === pluginId8.length - 1 || !IDENTIFIER_PATTERN.test(pluginId8)) return null;
  return `${pluginId8.slice(0, dot)}.asset.${pluginId8.slice(dot + 1)}-`;
}
function isAssetPackPrefixOf(pluginId8, prefix) {
  const namespace = assetPackNamespaceOf(pluginId8);
  return namespace !== null && prefix.length <= 90 && NAMESPACE_PATTERN.test(prefix) && prefix.startsWith(namespace);
}

// packages/plugin-sdk/src/hostData/contracts.ts
var pluginId4 = external_exports.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/).max(96);
var identifier = external_exports.string().min(1).max(128).regex(/^[A-Za-z0-9._:/-]+$/);
var cursor = external_exports.string().min(1).max(512);
var generation = external_exports.string().min(1).max(96);
var permission = external_exports.string().min(1).max(96);
var presentStateValue = external_exports.custom((value) => value !== void 0);
var PLUGIN_HOST_DATA_CAPABILITIES = Object.freeze({
  workRecords: "teamuq.work-records@1",
  agentDirectory: "teamuq.agent-directory@1",
  projectDirectory: "teamuq.project-directory@1",
  pluginState: "teamuq.plugin-state@1"
});
var PLUGIN_HOST_DATA_API = "teamuq.host-data";
var PLUGIN_HOST_DATA_API_VERSION = "1.0.0";
var PLUGIN_HOST_DATA_PERMISSIONS = Object.freeze({
  workRecords: "work-records:read",
  agentDirectory: "agent-directory:read",
  projectDirectory: "project-directory:read",
  pluginStateRead: "plugin-state:read",
  pluginStateWrite: "plugin-state:write"
});
var PLUGIN_HOST_DATA_LIMITS = Object.freeze({
  pageSize: 100,
  payloadBytes: 256 * 1024,
  stateValueBytes: 32 * 1024,
  stateBatchBytes: 256 * 1024
});
var PLUGIN_HOST_DATA_METHODS = Object.freeze({
  workRecords: Object.freeze({ openSnapshot: "openSettledSnapshot", readPage: "readSettledPage" }),
  agentDirectory: Object.freeze({ openSnapshot: "openSnapshot", readPage: "readPage" }),
  projectDirectory: Object.freeze({ openSnapshot: "openSnapshot", readPage: "readPage" }),
  pluginState: Object.freeze({ readPage: "readPage", writeBatch: "writeBatch", deleteBatch: "deleteBatch" })
});
var PluginHostDataRequestV1Schema = external_exports.object({
  protocolVersion: external_exports.literal(1),
  requestId: external_exports.string().min(1).max(64),
  kind: external_exports.literal("capability-call"),
  pluginId: pluginId4,
  capabilityId: external_exports.enum([
    PLUGIN_HOST_DATA_CAPABILITIES.workRecords,
    PLUGIN_HOST_DATA_CAPABILITIES.agentDirectory,
    PLUGIN_HOST_DATA_CAPABILITIES.projectDirectory,
    PLUGIN_HOST_DATA_CAPABILITIES.pluginState
  ]),
  method: external_exports.string().min(1).max(64).regex(/^[A-Za-z0-9._@-]+$/),
  args: external_exports.array(external_exports.unknown()).max(8)
}).strict();
var PluginHostDataPermissionsV1Schema = external_exports.array(permission).max(64);
var PluginDataPageRequestV1Schema = external_exports.object({
  snapshotId: identifier,
  cursor: cursor.nullable(),
  limit: external_exports.number().int().min(1).max(100)
}).strict();
var PluginHostSnapshotV1Schema = external_exports.object({
  snapshotId: identifier,
  generation,
  highWatermark: external_exports.string().max(40).nullable()
}).strict();
var PluginHostWorkRecordV1Schema = external_exports.object({
  id: identifier,
  agentId: identifier,
  projectId: identifier.nullable(),
  sessionId: identifier.nullable(),
  providerId: identifier.nullable(),
  punchId: identifier,
  punchType: external_exports.enum(["main", "subagent"]),
  startedAtMs: external_exports.number().int().nonnegative(),
  endedAtMs: external_exports.number().int().nonnegative(),
  model: external_exports.string().max(256).nullable(),
  name: external_exports.string().max(32768).nullable(),
  description: external_exports.string().max(32768).nullable()
}).strict();
var PluginHostWorkRecordPageV1Schema = external_exports.object({
  snapshot: PluginHostSnapshotV1Schema,
  records: external_exports.array(PluginHostWorkRecordV1Schema).max(100),
  nextCursor: cursor.nullable()
}).strict();
var PluginHostAgentV1Schema = external_exports.object({
  id: identifier,
  name: external_exports.string().max(512),
  teamKey: external_exports.string().max(128),
  teamName: external_exports.string().max(512).nullable(),
  title: external_exports.string().max(512),
  enabled: external_exports.boolean()
}).strict();
var PluginHostProjectV1Schema = external_exports.object({
  id: identifier,
  name: external_exports.string().max(512),
  archived: external_exports.boolean()
}).strict();
var PluginHostDirectoryPageV1Schema = external_exports.object({
  snapshot: PluginHostSnapshotV1Schema,
  entries: external_exports.array(external_exports.union([PluginHostAgentV1Schema, PluginHostProjectV1Schema])).max(100),
  nextCursor: cursor.nullable()
}).strict();
var PluginHostAgentPageV1Schema = external_exports.object({
  snapshot: PluginHostSnapshotV1Schema,
  entries: external_exports.array(PluginHostAgentV1Schema).max(100),
  nextCursor: cursor.nullable()
}).strict();
var PluginHostProjectPageV1Schema = external_exports.object({
  snapshot: PluginHostSnapshotV1Schema,
  entries: external_exports.array(PluginHostProjectV1Schema).max(100),
  nextCursor: cursor.nullable()
}).strict();
var PluginStateRecordV1Schema = external_exports.object({
  key: identifier,
  value: presentStateValue,
  sourceKind: external_exports.string().regex(/^[a-z][a-z0-9-]{0,31}$/).nullable().optional(),
  sourceId: identifier.nullable().optional(),
  revision: external_exports.number().int().nonnegative()
}).strict();
var PluginStateWriteRecordV1Schema = external_exports.object({
  key: identifier,
  value: presentStateValue,
  sourceKind: external_exports.string().regex(/^[a-z][a-z0-9-]{0,31}$/).nullable().optional(),
  sourceId: identifier.nullable().optional(),
  expectedRevision: external_exports.number().int().nonnegative().nullable().optional()
}).strict();
var PluginStateReadPageV1Schema = external_exports.object({
  records: external_exports.array(PluginStateRecordV1Schema).max(100),
  nextCursor: cursor.nullable()
}).strict();
var PluginStateBatchV1Schema = external_exports.object({
  namespace: identifier,
  records: external_exports.array(PluginStateWriteRecordV1Schema).min(1).max(100)
}).strict().refine((batch) => new Set(batch.records.map((record) => record.key)).size === batch.records.length);
var PluginStateDeleteBatchV1Schema = external_exports.object({
  namespace: identifier,
  keys: external_exports.array(identifier).min(1).max(100)
}).strict().refine((batch) => new Set(batch.keys).size === batch.keys.length);
var PluginStateBatchResultV1Schema = external_exports.object({
  written: external_exports.number().int().nonnegative().max(100),
  deleted: external_exports.number().int().nonnegative().max(100)
}).strict();
var PluginHostWorkChangedEventV1Schema = external_exports.object({
  protocolVersion: external_exports.literal(1),
  kind: external_exports.literal("ext-capability-event"),
  capabilityId: external_exports.literal(PLUGIN_HOST_DATA_CAPABILITIES.workRecords),
  event: external_exports.literal("settled-changed"),
  generation,
  highWatermark: external_exports.string().max(40).nullable()
}).strict();
var PluginLegacyDataMigrationV1Schema = external_exports.object({
  id: external_exports.string().min(1).max(96).regex(/^[a-z0-9][a-z0-9._-]*$/),
  source: external_exports.string().min(1).max(96).regex(/^[a-z0-9][a-z0-9._-]*$/),
  target: external_exports.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._/-]*$/)
}).strict().refine((entry) => !entry.target.split("/").some((part) => part === "." || part === ".."));

// packages/plugin-sdk/src/manifestV2.ts
var PLUGIN_MANIFEST_V2_SCHEMA_VERSION = 2;
var PLUGIN_API_EXTERNAL_VERSION = "2.0.0";
var KNOWN_PLUGIN_PERMISSIONS = Object.freeze([
  "ui:view",
  "ui:window",
  "ui:overlay",
  "storage:plugin-data",
  "assets:plugin-data",
  "filesystem:user-folder",
  "network:fetch",
  "network:loopback",
  "network:webrtc",
  "media:microphone",
  "media:camera",
  "ai:chat",
  "speech:transcribe",
  "speech:synthesize",
  "input:text",
  "native:addons",
  "asset:pack",
  "secrets:plugin",
  "settings:plugin",
  "process:spawn",
  "backend:invoke",
  "store:browse",
  "agent:avatar-read",
  "work-records:read",
  "agent-directory:read",
  "project-directory:read",
  "plugin-state:read",
  "plugin-state:write",
  "data:legacy-migrate"
]);
var CORE_SUPPORTED_PLUGIN_PERMISSIONS = Object.freeze(["ui:view", "storage:plugin-data", "assets:plugin-data", "settings:plugin", "secrets:plugin", "asset:pack", "media:microphone", "media:camera", "network:fetch", "ai:chat", "speech:transcribe", "speech:synthesize", "input:text", "native:addons", "backend:invoke", "store:browse", "agent:avatar-read", "work-records:read", "agent-directory:read", "project-directory:read", "plugin-state:read", "plugin-state:write", "data:legacy-migrate"]);
var BACKEND_UI_ONLY_PERMISSION_PREFIXES = Object.freeze(["ui:", "media:", "assets:", "store:"]);
var REVOCABLE_PLUGIN_PERMISSION_PREFIXES = Object.freeze(["media:", "network:", "ai:", "input:", "backend:", "store:"]);
var REVOCABLE_PLUGIN_EXACT_PERMISSIONS = Object.freeze(["agent:avatar-read", "work-records:read", "agent-directory:read", "project-directory:read", "plugin-state:read", "plugin-state:write", "data:legacy-migrate"]);
var CORE_SUPPORTED_PRESENTATIONS = Object.freeze(["tab", "fullpage", "settings"]);
var CORE_IMPLEMENTED_PLATFORM_IDS = Object.freeze(["win32-x64", "darwin-arm64", "darwin-x64", "linux-x64"]);
var PLATFORM_ID_PATTERN = /^[a-z0-9]+-[a-z0-9]+$/;
var DOTTED_PATTERN = /^\d{1,6}(?:\.\d{1,6}){0,2}$/;
var MAX_CORE_PATTERN = /^[1-9][0-9]*\.x$/;
var PRESENTATIONS = ["tab", "window", "fullpage", "overlay", "settings"];
var unique2 = (values) => new Set(values).size === values.length;
function isSafeRelativePath(value) {
  if (value.length === 0 || value.length > 200) return false;
  if (!/^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/.test(value)) return false;
  return value.split("/").every((segment) => segment !== "." && segment !== "..");
}
var relativePath = external_exports.string().refine(isSafeRelativePath, { message: "must be a safe relative path" });
var HostApiSchema = external_exports.object({ id: external_exports.string().min(3).max(64).regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/), range: external_exports.string().regex(RANGE_PATTERN) }).strict();
var pngPath = relativePath.refine((value) => /\.png$/iu.test(value), { message: "icon must be a .png file" });
var ViewSchema = external_exports.object({
  id: external_exports.string().regex(IDENTIFIER_PATTERN).max(32),
  title: external_exports.string().min(1).max(48).refine(isPlainText, { message: "must be plain text" }),
  icon: relativePath.optional(),
  entry: relativePath,
  remote: external_exports.boolean().optional(),
  presentations: external_exports.array(external_exports.enum(PRESENTATIONS)).min(1).max(5),
  defaultPresentation: external_exports.enum(PRESENTATIONS),
  window: external_exports.object({
    width: external_exports.number().int().min(160).max(8192),
    height: external_exports.number().int().min(120).max(8192),
    minWidth: external_exports.number().int().min(160).max(8192).optional(),
    minHeight: external_exports.number().int().min(120).max(8192).optional(),
    resizable: external_exports.boolean().optional()
  }).strict().optional()
}).strict().superRefine((view, context) => {
  if (!unique2(view.presentations)) context.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["presentations"], message: "presentations must not contain duplicates" });
  if (!view.presentations.includes(view.defaultPresentation)) context.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["defaultPresentation"], message: "defaultPresentation must be one of presentations" });
  if (view.presentations.includes("settings") && (view.presentations.length !== 1 || view.window !== void 0)) context.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["presentations"], message: "a settings view has no other presentation and no window" });
});
var ProvidesSchema = external_exports.object({
  capability: external_exports.string().regex(CAPABILITY_PATTERN),
  permission: external_exports.string().regex(PERMISSION_PATTERN),
  transport: external_exports.literal("port"),
  maxSessions: external_exports.number().int().min(1).max(16)
}).strict();
var PlatformSchema = external_exports.object({
  id: external_exports.string().regex(PLATFORM_ID_PATTERN),
  minOs: external_exports.string().regex(DOTTED_PATTERN).optional(),
  minGlibc: external_exports.string().regex(DOTTED_PATTERN).optional()
}).strict();
var NativeSchema = external_exports.object({
  allowAddons: external_exports.boolean(),
  files: external_exports.array(external_exports.object({ path: relativePath, platform: external_exports.string().regex(PLATFORM_ID_PATTERN) }).strict()).max(64)
}).strict();
var ResourcesSchema = external_exports.object({
  memoryMB: external_exports.number().int().min(1).max(8192),
  cpuThreads: external_exports.number().int().min(1).max(32),
  maxSessions: external_exports.number().int().min(1).max(16),
  idleUnloadSec: external_exports.number().int().min(0).max(86400),
  bootTimeoutSec: external_exports.number().int().min(1).max(120)
}).strict();
var BACKEND_RESOURCE_DEFAULTS = Object.freeze({ memoryMB: 256, cpuThreads: 1, maxSessions: 1, idleUnloadSec: 300, bootTimeoutSec: 10 });
var BACKEND_RESOURCE_CORE_LIMITS = Object.freeze({ memoryMB: 1024, cpuThreads: 4, maxSessions: 4, idleUnloadSecMin: 5, idleUnloadSecMax: 3600, bootTimeoutSec: 60 });
function resolveBackendResources(declared) {
  return declared ?? BACKEND_RESOURCE_DEFAULTS;
}
function backendResourceIssues(resources) {
  const limits = BACKEND_RESOURCE_CORE_LIMITS;
  const issues = [];
  if (resources.memoryMB > limits.memoryMB) issues.push(`memoryMB ${resources.memoryMB} exceeds the Core limit ${limits.memoryMB}`);
  if (resources.cpuThreads > limits.cpuThreads) issues.push(`cpuThreads ${resources.cpuThreads} exceeds the Core limit ${limits.cpuThreads}`);
  if (resources.maxSessions > limits.maxSessions) issues.push(`maxSessions ${resources.maxSessions} exceeds the Core limit ${limits.maxSessions}`);
  if (resources.bootTimeoutSec > limits.bootTimeoutSec) issues.push(`bootTimeoutSec ${resources.bootTimeoutSec} exceeds the Core limit ${limits.bootTimeoutSec}`);
  if (resources.idleUnloadSec < limits.idleUnloadSecMin || resources.idleUnloadSec > limits.idleUnloadSecMax) issues.push(`idleUnloadSec ${resources.idleUnloadSec} is outside ${limits.idleUnloadSecMin}..${limits.idleUnloadSecMax}`);
  return issues;
}
var BACKEND_ENTRY_PATTERN = /\.(?:mjs|cjs)$/;
var AssetPackRefSchema = external_exports.object({
  id: external_exports.string().regex(IDENTIFIER_PATTERN).min(3).max(96),
  range: external_exports.string().regex(RANGE_PATTERN),
  required: external_exports.boolean()
}).strict();
var PluginManifestV2Schema = external_exports.object({
  schemaVersion: external_exports.literal(PLUGIN_MANIFEST_V2_SCHEMA_VERSION),
  kind: external_exports.enum(["plugin", "asset-pack"]),
  id: external_exports.string().min(3).max(96).regex(IDENTIFIER_PATTERN),
  name: external_exports.string().min(1).max(96).refine(isPlainText, { message: "must be plain text" }),
  version: external_exports.string().regex(VERSION_PATTERN),
  publisher: external_exports.string().regex(IDENTIFIER_PATTERN).min(2).max(48),
  description: external_exports.string().max(512).refine(isPlainText, { message: "must be plain text" }).optional(),
  icon: pngPath.optional(),
  pluginApi: external_exports.string().regex(RANGE_PATTERN),
  hostApis: external_exports.array(HostApiSchema).max(16).default([]),
  minCoreVersion: external_exports.string().regex(RANGE_PATTERN),
  maxCoreVersion: external_exports.string().regex(MAX_CORE_PATTERN).optional(),
  platforms: external_exports.array(PlatformSchema).max(8).default([]),
  trustTier: external_exports.enum(["sandboxed", "full-trust"]).default("sandboxed"),
  entry: external_exports.object({ ui: relativePath.optional(), backend: relativePath.optional() }).strict().default({}),
  backendMethods: external_exports.array(external_exports.string().min(1).max(64).regex(/^[A-Za-z0-9._@-]+$/)).min(1).max(32).optional(),
  native: NativeSchema.optional(),
  resources: ResourcesSchema.optional(),
  provides: external_exports.array(ProvidesSchema).max(16).default([]),
  requiredCapabilities: external_exports.array(external_exports.string().regex(CAPABILITY_PATTERN)).max(32).default([]),
  optionalCapabilities: external_exports.array(external_exports.string().regex(CAPABILITY_PATTERN)).max(32).default([]),
  assetPacks: external_exports.array(AssetPackRefSchema).max(16).default([]),
  assetPackPrefixes: external_exports.array(external_exports.string().min(3).max(90)).max(4).default([]),
  settingsSchema: PluginSettingsSchemaSchema.optional(),
  permissions: external_exports.array(external_exports.string().regex(PERMISSION_PATTERN)).max(64).default([]),
  network: external_exports.object({ allow: external_exports.array(external_exports.string().url().max(200)).max(32) }).strict().default({ allow: [] }),
  contributes: external_exports.object({ views: external_exports.array(ViewSchema).max(3) }).strict().default({ views: [] }),
  data: external_exports.object({ uninstall: external_exports.enum(["keep", "delete", "ask"]), legacyMigrations: external_exports.array(PluginLegacyDataMigrationV1Schema).max(8).default([]) }).strict().default({ uninstall: "ask", legacyMigrations: [] }),
  provenance: external_exports.object({ upstream: external_exports.string().max(300), upstreamSha256: external_exports.string().regex(/^[0-9a-f]{64}$/), license: external_exports.string().max(64) }).strict().optional()
}).strict().superRefine((manifest, context) => {
  const fail = (path12, message) => {
    context.addIssue({ code: external_exports.ZodIssueCode.custom, path: [path12], message });
  };
  for (const [field, values] of [
    ["requiredCapabilities", manifest.requiredCapabilities],
    ["hostApis", manifest.hostApis.map((entry) => entry.id)],
    ["optionalCapabilities", manifest.optionalCapabilities],
    ["permissions", manifest.permissions],
    ["network", manifest.network.allow],
    ["provides", manifest.provides.map((entry) => entry.capability)],
    ["platforms", manifest.platforms.map((entry) => entry.id)],
    ["assetPacks", manifest.assetPacks.map((entry) => entry.id)],
    ["assetPackPrefixes", manifest.assetPackPrefixes],
    ["views", manifest.contributes.views.map((view) => view.id)]
  ]) {
    if (!unique2(values)) fail(field, `${field} must not contain duplicates`);
  }
  const capabilities = [...manifest.requiredCapabilities, ...manifest.optionalCapabilities, ...manifest.provides.map((entry) => entry.capability)];
  if (!unique2(capabilities)) fail("provides", "a capability may appear only once across provides, requiredCapabilities and optionalCapabilities");
  const fullTrust = manifest.trustTier === "full-trust";
  if (manifest.kind === "asset-pack") {
    if (manifest.backendMethods !== void 0) fail("backendMethods", "asset-pack cannot declare backendMethods");
    if (fullTrust) fail("trustTier", "asset-pack cannot be full-trust");
    if (manifest.icon !== void 0) fail("icon", "asset-pack cannot declare icon");
    if (manifest.entry.ui !== void 0 || manifest.entry.backend !== void 0) fail("entry", "asset-pack cannot declare entry");
    if (manifest.native !== void 0 || manifest.resources !== void 0) fail("native", "asset-pack cannot declare native or resources");
    if (manifest.provides.length > 0 || manifest.permissions.length > 0 || manifest.assetPacks.length > 0) fail("permissions", "asset-pack cannot declare provides, permissions or assetPacks");
    if (manifest.assetPackPrefixes.length > 0 || manifest.settingsSchema !== void 0) fail("assetPackPrefixes", "asset-pack cannot declare assetPackPrefixes or settingsSchema");
    if (manifest.contributes.views.length > 0) fail("contributes", "asset-pack cannot contribute views");
    return;
  }
  if (manifest.provenance !== void 0) fail("provenance", "provenance is only allowed on asset-pack");
  if (manifest.entry.ui === void 0 && manifest.entry.backend === void 0) fail("entry", "plugin must declare entry.ui or entry.backend");
  if (!fullTrust && manifest.entry.backend !== void 0) fail("entry", "entry.backend requires full-trust");
  if (fullTrust && manifest.entry.backend === void 0) fail("entry", "full-trust plugin must declare entry.backend");
  const composed = fullTrust && manifest.entry.ui !== void 0 && manifest.entry.backend !== void 0;
  if (manifest.backendMethods !== void 0 && !composed) fail("backendMethods", "backendMethods requires a full-trust plugin with both entry.ui and entry.backend");
  if (composed && manifest.backendMethods === void 0) fail("backendMethods", "a composed plugin must declare backendMethods");
  if (manifest.backendMethods !== void 0 && !unique2(manifest.backendMethods)) fail("backendMethods", "backendMethods must not contain duplicates");
  if (composed && !manifest.permissions.includes("backend:invoke")) fail("permissions", "a composed plugin requires backend:invoke");
  if (!composed && manifest.permissions.includes("backend:invoke")) fail("permissions", "backend:invoke requires a composed plugin");
  if (manifest.entry.backend !== void 0 && !BACKEND_ENTRY_PATTERN.test(manifest.entry.backend)) fail("entry", "entry.backend must be an .mjs or .cjs file");
  if (fullTrust) {
    if (!composed && manifest.permissions.some((permission2) => BACKEND_UI_ONLY_PERMISSION_PREFIXES.some((prefix) => permission2.startsWith(prefix)))) fail("permissions", "backend-only plugins have no view and cannot request ui, media or assets permissions");
    if (manifest.native !== void 0 && manifest.platforms.length === 0) fail("platforms", "native files require an explicit platforms list");
    if (manifest.native !== void 0 && !unique2(manifest.native.files.map((file) => `${file.platform}:${file.path}`))) fail("native", "native files must not contain duplicates");
    if (manifest.native?.allowAddons === true !== manifest.permissions.includes("native:addons")) fail("permissions", "native.allowAddons and the native:addons permission must be declared together");
    if (manifest.native?.files.some((file) => file.path === manifest.entry.backend)) fail("native", "the backend entry cannot be a native file");
  } else if (manifest.permissions.includes("native:addons")) fail("permissions", "native:addons requires full-trust");
  if (!fullTrust && (manifest.native !== void 0 || manifest.resources !== void 0)) fail("trustTier", "native and resources require full-trust");
  if (!fullTrust && manifest.provides.some((entry) => entry.capability !== TEXT_INPUT_CAPABILITY)) fail("provides", `a sandboxed plugin may provide only ${TEXT_INPUT_CAPABILITY}`);
  const settingsViews = manifest.contributes.views.filter((view) => view.presentations.includes("settings"));
  if (settingsViews.length > 1) fail("contributes", "a plugin may contribute only one settings view");
  if (settingsViews.length > 0 && manifest.settingsSchema !== void 0) fail("settingsSchema", "a plugin with a settings view cannot also declare settingsSchema");
  if (manifest.settingsSchema !== void 0 && !manifest.permissions.includes(SETTINGS_SCHEMA_PERMISSION)) fail("permissions", `settingsSchema requires the ${SETTINGS_SCHEMA_PERMISSION} permission`);
  if (manifest.data.legacyMigrations.length > 0 && !manifest.permissions.includes("data:legacy-migrate")) fail("permissions", "data.legacyMigrations requires data:legacy-migrate");
  if (manifest.data.legacyMigrations.length > 0 && !fullTrust) fail("trustTier", "data.legacyMigrations requires full-trust");
  if (!unique2(manifest.data.legacyMigrations.map((entry) => entry.id)) || !unique2(manifest.data.legacyMigrations.map((entry) => entry.source)) || !unique2(manifest.data.legacyMigrations.map((entry) => entry.target))) fail("data", "legacy data migration ids, sources and targets must be unique");
  if (!fullTrust && manifest.provides.length > 0 && manifest.contributes.views.length === settingsViews.length) fail("provides", "a sandboxed provider receives its input in a view, so it must contribute one that is not a settings view");
  for (const prefix of manifest.assetPackPrefixes) {
    if (!isAssetPackPrefixOf(manifest.id, prefix)) fail("assetPackPrefixes", `prefix ${prefix} must start with this plugin's own namespace ${assetPackNamespaceOf(manifest.id) ?? "(none: the plugin id has no publisher part)"}`);
  }
  if (manifest.assetPackPrefixes.length > 0 && !manifest.permissions.includes("asset:pack")) fail("permissions", "assetPackPrefixes require the asset:pack permission");
  for (const entry of manifest.provides) {
    if (entry.capability === TEXT_INPUT_CAPABILITY && entry.permission !== TEXT_INPUT_PERMISSION) fail("provides", `${TEXT_INPUT_CAPABILITY} is gated by ${TEXT_INPUT_PERMISSION}`);
    if (entry.capability === TEXT_INPUT_CAPABILITY && !manifest.permissions.includes(TEXT_INPUT_PERMISSION)) fail("permissions", `providing ${TEXT_INPUT_CAPABILITY} requires the ${TEXT_INPUT_PERMISSION} permission`);
  }
  if (manifest.contributes.views.length > 0 && manifest.entry.ui === void 0) fail("contributes", "views require entry.ui");
  if (manifest.assetPacks.length > 0 && !manifest.permissions.includes("asset:pack")) fail("permissions", "assetPacks require the asset:pack permission");
  if (manifest.network.allow.length > 0 && !manifest.permissions.includes("network:fetch") && !manifest.permissions.includes("network:loopback")) fail("permissions", "network.allow requires the network:fetch permission");
  const platformIds = new Set(manifest.platforms.map((entry) => entry.id));
  for (const file of manifest.native?.files ?? []) {
    if (platformIds.size > 0 && !platformIds.has(file.platform)) fail("native", `native file platform ${file.platform} is not listed in platforms`);
  }
  const required = { tab: "ui:view", fullpage: "ui:view", settings: "ui:view", window: "ui:window", overlay: "ui:overlay" };
  for (const view of manifest.contributes.views) {
    for (const presentation of view.presentations) {
      if (!manifest.permissions.includes(required[presentation])) fail("permissions", `presentation ${presentation} requires ${required[presentation]}`);
    }
  }
});
function compareDotted(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}
function evaluateManifestSupport(manifest, context) {
  const issues = [];
  const add = (code, field, message) => {
    issues.push({ code, field, message });
  };
  const unsupported = (field, message) => add("unsupported_in_this_core", field, message);
  if (!versionSatisfies(PLUGIN_API_EXTERNAL_VERSION, manifest.pluginApi)) add("plugin_api_incompatible", "pluginApi", manifest.pluginApi);
  for (const requirement of manifest.hostApis) {
    if (requirement.id !== PLUGIN_HOST_DATA_API || !versionSatisfies(PLUGIN_HOST_DATA_API_VERSION, requirement.range)) add("unsupported_in_this_core", "hostApis", requirement.id);
  }
  if (!versionSatisfies(context.coreVersion, manifest.minCoreVersion)) add("core_version_incompatible", "minCoreVersion", manifest.minCoreVersion);
  if (manifest.maxCoreVersion !== void 0 && context.coreVersion.split(".")[0] !== manifest.maxCoreVersion.split(".")[0]) add("core_version_too_new", "maxCoreVersion", manifest.maxCoreVersion);
  if (manifest.trustTier === "full-trust") {
    for (const message of backendResourceIssues(resolveBackendResources(manifest.resources))) add("resources_exceed_core_limit", "resources", message);
  }
  for (const view of manifest.contributes.views) {
    for (const presentation of view.presentations) {
      if (!CORE_SUPPORTED_PRESENTATIONS.includes(presentation)) unsupported("contributes.views", `presentation ${presentation} of view ${view.id} is not supported by this Core`);
    }
  }
  for (const origin of manifest.network.allow) {
    if (parseDeclaredNetworkOrigin(origin) === null) unsupported("network.allow", `origin ${origin} is not a public https or wss origin`);
  }
  for (const platform of manifest.platforms) {
    if (!CORE_IMPLEMENTED_PLATFORM_IDS.includes(platform.id)) unsupported("platforms", `platform ${platform.id} is not implemented by this Core`);
  }
  for (const provided of manifest.provides) {
    if (!CAPABILITY_GATE_PERMISSIONS.includes(provided.permission)) unsupported("provides", `capability ${provided.capability} is gated by ${provided.permission}, which is not a capability permission of this Core`);
  }
  if (manifest.trustTier === "full-trust" && (manifest.requiredCapabilities.length > 0 || manifest.optionalCapabilities.length > 0)) unsupported("requiredCapabilities", "only a plugin with a view can consume a capability, and a provider cannot depend on other plugins");
  for (const permission2 of manifest.permissions) {
    if (!KNOWN_PLUGIN_PERMISSIONS.includes(permission2)) add("permission_unknown", "permissions", permission2);
    else if (!CORE_SUPPORTED_PLUGIN_PERMISSIONS.includes(permission2)) unsupported("permissions", `permission ${permission2} is not supported by this Core`);
  }
  if (manifest.platforms.length > 0) {
    const entry = manifest.platforms.find((candidate) => candidate.id === context.platform.id);
    if (entry === void 0) add("platform_unsupported", "platforms", context.platform.id);
    else {
      if (entry.minOs !== void 0 && (context.platform.osVersion === void 0 || compareDotted(context.platform.osVersion, entry.minOs) < 0)) add("platform_os_too_old", "platforms", `minOs ${entry.minOs}`);
      if (entry.minGlibc !== void 0 && (context.platform.glibc === void 0 || compareDotted(context.platform.glibc, entry.minGlibc) < 0)) add("platform_os_too_old", "platforms", `minGlibc ${entry.minGlibc}`);
    }
  }
  return issues;
}

// packages/plugin-sdk/src/storeContracts.ts
var PLUGIN_STORE_ERROR_CODES = Object.freeze([
  "store_unavailable",
  "store_untrusted",
  "store_entry_unknown",
  "store_not_owned",
  "store_not_free",
  "store_withdrawn",
  "store_incompatible",
  "store_too_large",
  "store_disk_insufficient",
  "store_download_failed",
  "store_hash_mismatch",
  "store_busy",
  "store_client_outdated"
]);
var PLUGIN_STORE_LIMITS = Object.freeze({
  pageSize: 50,
  queryChars: 100,
  queryTags: 8,
  tagChars: 48,
  pendingEntries: 50,
  installedEntries: 200,
  updateEntries: 200,
  retainedChanges: 32
});
var entryId = external_exports.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/);
var packId = external_exports.string().min(3).max(96);
var version = external_exports.string().max(32);
var bytes = external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
var PluginStoreReadRequestSchema = external_exports.discriminatedUnion("op", [
  external_exports.object({ op: external_exports.literal("status"), refresh: external_exports.boolean().optional() }).strict(),
  external_exports.object({
    op: external_exports.literal("list"),
    text: external_exports.string().max(PLUGIN_STORE_LIMITS.queryChars).optional(),
    tags: external_exports.array(external_exports.string().min(1).max(PLUGIN_STORE_LIMITS.tagChars)).max(PLUGIN_STORE_LIMITS.queryTags).optional(),
    cursor: external_exports.string().max(16).nullable().optional(),
    limit: external_exports.number().int().min(1).max(PLUGIN_STORE_LIMITS.pageSize).optional()
  }).strict(),
  external_exports.object({ op: external_exports.literal("get"), entryId }).strict(),
  external_exports.object({ op: external_exports.literal("installed") }).strict(),
  external_exports.object({ op: external_exports.literal("pending") }).strict(),
  external_exports.object({ op: external_exports.literal("updates") }).strict(),
  external_exports.object({ op: external_exports.literal("preflight"), entryId }).strict(),
  external_exports.object({ op: external_exports.literal("errorText"), code: external_exports.string().max(64) }).strict()
]);
var PluginStoreActRequestSchema = external_exports.discriminatedUnion("op", [
  external_exports.object({ op: external_exports.literal("acquire"), entryId }).strict(),
  external_exports.object({ op: external_exports.literal("cancel"), entryId }).strict(),
  external_exports.object({ op: external_exports.literal("discard"), entryId }).strict(),
  external_exports.object({ op: external_exports.literal("rollback"), entryId }).strict()
]);
var PLUGIN_STORE_CATALOG_STATES = ["disabled", "fresh", "stale", "offline", "untrusted"];
var PLUGIN_STORE_STAGES = ["downloading", "verifying", "installing"];
var PLUGIN_STORE_CHANGE_STATES = ["installed", "updated", "hidden", "disabled", "removed"];
var PluginStoreStatusViewV1Schema = external_exports.object({
  state: external_exports.enum(PLUGIN_STORE_CATALOG_STATES),
  ageSec: external_exports.number().int().nonnegative().nullable(),
  acquirable: external_exports.boolean()
}).strict();
var PreviewViewSchema = external_exports.object({
  role: external_exports.enum(["cover", "video", "voice"]),
  mime: external_exports.string().max(40),
  sizeBytes: bytes,
  width: external_exports.number().int().positive().nullable(),
  height: external_exports.number().int().positive().nullable(),
  durationMs: external_exports.number().int().positive().nullable(),
  url: external_exports.string().max(400)
}).strict();
var EntryViewShape = {
  entryId,
  packId,
  version,
  name: external_exports.string().max(200),
  summary: external_exports.string().max(500),
  tags: external_exports.array(external_exports.string().max(60)).max(8),
  creator: external_exports.string().max(200),
  downloadBytes: bytes,
  installedBytes: bytes,
  consentLabel: external_exports.string().max(80).nullable()
};
var PluginStoreEntryViewV1Schema = external_exports.object(EntryViewShape).strict();
var PluginStoreEntryDetailViewV1Schema = external_exports.object({ ...EntryViewShape, description: external_exports.string().max(3e3), previews: external_exports.array(PreviewViewSchema).max(3) }).strict();
var PluginStoreListViewV1Schema = external_exports.object({ entries: external_exports.array(PluginStoreEntryViewV1Schema).max(PLUGIN_STORE_LIMITS.pageSize), nextCursor: external_exports.string().max(16).nullable() }).strict();
var NoticeSchema = external_exports.object({ title: external_exports.string().max(200), body: external_exports.string().max(600) }).strict();
var PluginStoreInstalledViewV1Schema = external_exports.object({
  entryId,
  packId,
  version,
  state: external_exports.enum(["ready", "hidden", "disabled", "removed"]),
  withdrawnReason: external_exports.string().max(40).nullable(),
  notice: NoticeSchema.nullable(),
  previousVersion: version.nullable()
}).strict();
var PluginStorePendingViewV1Schema = external_exports.object({
  entryId,
  version,
  bytesReceived: bytes,
  bytesTotal: bytes.nullable(),
  stale: external_exports.boolean(),
  active: external_exports.boolean()
}).strict();
var PluginStoreUpdateViewV1Schema = external_exports.object({ entryId, packId, installedVersion: version, version }).strict();
var PluginStorePreflightViewV1Schema = external_exports.object({
  downloadBytes: bytes,
  installedBytes: bytes,
  neededBytes: bytes,
  reserveBytes: bytes,
  freeBytes: bytes,
  enough: external_exports.boolean()
}).strict();
var PluginStoreErrorTextViewV1Schema = external_exports.object({
  title: external_exports.string().max(200),
  body: external_exports.string().max(800),
  steps: external_exports.array(external_exports.string().max(400)).max(8),
  named: external_exports.boolean()
}).strict();
var PluginStoreAcquireOutcomeV1Schema = external_exports.discriminatedUnion("status", [
  external_exports.object({ status: external_exports.enum(["installed", "updated"]), packId, version, name: external_exports.string().max(200) }).strict(),
  external_exports.object({ status: external_exports.literal("cancelled") }).strict()
]);
var PluginStoreProgressViewV1Schema = external_exports.object({
  entryId,
  stage: external_exports.enum(PLUGIN_STORE_STAGES),
  bytesReceived: bytes,
  bytesTotal: bytes.nullable(),
  retry: external_exports.object({ attempt: external_exports.number().int().min(1).max(10), max: external_exports.number().int().min(1).max(10) }).strict().nullable()
}).strict();
var PluginStoreChangeViewV1Schema = external_exports.object({
  entryId,
  state: external_exports.enum(PLUGIN_STORE_CHANGE_STATES),
  withdrawnReason: external_exports.string().max(40).nullable(),
  notice: NoticeSchema.nullable()
}).strict();
var PluginStoreRollbackOutcomeV1Schema = external_exports.discriminatedUnion("status", [
  external_exports.object({ status: external_exports.literal("rolled_back"), packId, version, name: external_exports.string().max(200) }).strict(),
  external_exports.object({ status: external_exports.literal("cancelled") }).strict(),
  external_exports.object({ status: external_exports.literal("no_previous") }).strict()
]);

// packages/plugin-sdk/src/coreApiContracts.ts
var PLUGIN_CORE_CHANNELS = Object.freeze({
  AGENT_AVATAR: "plugin-view:agent-avatar",
  STORAGE: "plugin-view:storage",
  SETTINGS: "plugin-view:settings",
  SECRETS: "plugin-view:secrets",
  ASSET_PACKS: "plugin-view:asset-packs",
  ASSET_PACK_MANAGE: "plugin-view:asset-pack-manage",
  STORE: "plugin-view:store",
  STORE_ACQUIRE: "plugin-view:store-acquire",
  STORE_PROGRESS: "plugin-view:store-progress",
  STORE_CHANGED: "plugin-view:store-changed"
});
var PLUGIN_CORE_PERMISSIONS = Object.freeze({
  AGENT_AVATAR_READ: "agent:avatar-read",
  STORAGE: "storage:plugin-data",
  ASSETS: "assets:plugin-data",
  SETTINGS: "settings:plugin",
  SECRETS: "secrets:plugin",
  ASSET_PACK: "asset:pack",
  STORE_BROWSE: "store:browse"
});
var PLUGIN_CORE_LIMITS = Object.freeze({
  agentAvatarBytes: 5 * 1024 * 1024,
  pathChars: 240,
  segmentChars: 100,
  chunkBytes: 8 * 1024 * 1024,
  fileBytes: 4 * 1024 * 1024 * 1024,
  listEntries: 1e3,
  settingsKeys: 256,
  settingsBytes: 256 * 1024,
  secretNames: 64,
  secretBytes: 8 * 1024
});
var PLUGIN_CORE_ERROR_CODES = Object.freeze([
  "plugin_permission_denied",
  "plugin_not_active",
  "plugin_request_invalid",
  "agent_avatar_unavailable",
  "storage_path_invalid",
  "storage_path_escapes",
  "storage_not_found",
  "storage_not_a_file",
  "storage_too_large",
  "storage_failed",
  "settings_too_large",
  "settings_failed",
  "secrets_unavailable",
  "secrets_too_large",
  "secrets_corrupt",
  "secrets_failed",
  "asset_pack_not_declared",
  "asset_pack_unavailable",
  "asset_pack_failed",
  "asset_pack_wrong_kind",
  "asset_pack_not_owned",
  "asset_pack_version_mismatch",
  "asset_pack_signer_mismatch",
  "asset_pack_already_installed",
  "asset_pack_rejected",
  "asset_pack_busy",
  ...PLUGIN_STORE_ERROR_CODES
]);
var relativePath2 = external_exports.string().max(PLUGIN_CORE_LIMITS.pathChars);
var settingsKey = external_exports.string().regex(/^[A-Za-z0-9._-]{1,64}$/);
var secretName = external_exports.string().regex(/^[A-Za-z0-9._-]{1,64}$/);
var bytes2 = external_exports.instanceof(Uint8Array).refine((value) => value.byteLength <= PLUGIN_CORE_LIMITS.chunkBytes, { message: "chunk too large" });
var PluginAgentAvatarRequestV1Schema = external_exports.object({ protocolVersion: external_exports.literal(1), agentId: external_exports.string().min(1).max(200) }).strict();
var PluginAgentAvatarResultV1Schema = external_exports.object({ protocolVersion: external_exports.literal(1), image: external_exports.object({ mimeType: external_exports.enum(["image/png", "image/jpeg", "image/webp"]), bytes: external_exports.instanceof(Uint8Array).refine((value) => value.byteLength <= PLUGIN_CORE_LIMITS.agentAvatarBytes) }).strict().nullable() }).strict();
var PluginStorageRequestSchema = external_exports.discriminatedUnion("op", [
  external_exports.object({ op: external_exports.literal("read"), path: relativePath2, offset: external_exports.number().int().nonnegative().optional(), length: external_exports.number().int().positive().max(PLUGIN_CORE_LIMITS.chunkBytes).optional() }).strict(),
  external_exports.object({ op: external_exports.literal("write"), path: relativePath2, data: bytes2, append: external_exports.boolean().optional() }).strict(),
  external_exports.object({ op: external_exports.literal("list"), path: relativePath2.optional() }).strict(),
  external_exports.object({ op: external_exports.literal("stat"), path: relativePath2 }).strict(),
  external_exports.object({ op: external_exports.literal("remove"), path: relativePath2, recursive: external_exports.boolean().optional() }).strict()
]);
var PluginSettingsRequestSchema = external_exports.discriminatedUnion("op", [
  external_exports.object({ op: external_exports.literal("get"), key: settingsKey }).strict(),
  external_exports.object({ op: external_exports.literal("set"), key: settingsKey, value: external_exports.unknown() }).strict(),
  external_exports.object({ op: external_exports.literal("remove"), key: settingsKey }).strict(),
  external_exports.object({ op: external_exports.literal("all") }).strict()
]);
var PluginSecretsRequestSchema = external_exports.discriminatedUnion("op", [
  external_exports.object({ op: external_exports.literal("get"), name: secretName }).strict(),
  external_exports.object({ op: external_exports.literal("set"), name: secretName, value: external_exports.string().max(PLUGIN_CORE_LIMITS.secretBytes) }).strict(),
  external_exports.object({ op: external_exports.literal("remove"), name: secretName }).strict(),
  external_exports.object({ op: external_exports.literal("list") }).strict(),
  external_exports.object({ op: external_exports.literal("available") }).strict()
]);
var PluginAssetPacksRequestSchema = external_exports.discriminatedUnion("op", [
  external_exports.object({ op: external_exports.literal("list") }).strict(),
  external_exports.object({ op: external_exports.literal("files"), packId: external_exports.string().regex(IDENTIFIER_PATTERN).max(96) }).strict()
]);
var PluginAssetPackManageRequestSchema = external_exports.discriminatedUnion("op", [
  external_exports.object({ op: external_exports.literal("import") }).strict(),
  external_exports.object({ op: external_exports.literal("installed") }).strict(),
  external_exports.object({ op: external_exports.literal("remove"), packId: external_exports.string().regex(IDENTIFIER_PATTERN).max(96) }).strict()
]);
var PluginAssetPackStatusSchema = external_exports.enum(["ready", "missing", "version_mismatch", "signer_mismatch", "invalid"]);
var PluginAssetPackStateSchema = external_exports.object({
  id: external_exports.string(),
  range: external_exports.string(),
  required: external_exports.boolean(),
  status: PluginAssetPackStatusSchema,
  version: external_exports.string().nullable()
}).strict();
var PluginAssetPackFileSchema = external_exports.object({ path: external_exports.string(), size: external_exports.number().int().nonnegative() }).strict();
var PluginOwnedAssetPackSchema = external_exports.object({
  id: external_exports.string(),
  version: external_exports.string(),
  name: external_exports.string(),
  sizeBytes: external_exports.number().int().nonnegative(),
  fileCount: external_exports.number().int().nonnegative(),
  status: external_exports.enum(["ready", "invalid"])
}).strict();
var PluginOwnedAssetPacksSchema = external_exports.array(PluginOwnedAssetPackSchema).max(64);
var PluginAssetPackImportResultSchema = external_exports.discriminatedUnion("status", [
  external_exports.object({ status: external_exports.literal("installed"), pack: PluginOwnedAssetPackSchema }).strict(),
  external_exports.object({ status: external_exports.literal("cancelled") }).strict()
]);
var PluginAssetPackRemoveResultSchema = external_exports.discriminatedUnion("status", [
  external_exports.object({ status: external_exports.literal("removed"), packId: external_exports.string() }).strict(),
  external_exports.object({ status: external_exports.literal("cancelled") }).strict()
]);
var PluginCoreEnvelopeSchema = external_exports.discriminatedUnion("ok", [
  external_exports.object({ ok: external_exports.literal(true), value: external_exports.unknown() }).strict(),
  external_exports.object({ ok: external_exports.literal(false), error: external_exports.enum(PLUGIN_CORE_ERROR_CODES) }).strict()
]);

// packages/plugin-sdk/src/surfaceContracts.ts
var PluginSurfaceInstallRecordV1Schema = external_exports.object({
  id: external_exports.string().min(3).max(96),
  version: external_exports.string().min(5).max(32),
  name: external_exports.string().min(1).max(96),
  publisher: external_exports.string().min(2).max(48),
  signer: external_exports.discriminatedUnion("kind", [external_exports.object({ kind: external_exports.literal("teamuq"), keyId: external_exports.string().min(3).max(64) }).strict(), external_exports.object({ kind: external_exports.literal("dev"), keyId: external_exports.string().min(3).max(64), label: external_exports.string().min(1).max(48) }).strict(), external_exports.object({ kind: external_exports.literal("unsigned") }).strict()]),
  manifestSha256: external_exports.string().regex(/^[0-9a-f]{64}$/),
  integritySha256: external_exports.string().regex(/^[0-9a-f]{64}$/),
  grants: external_exports.array(external_exports.string().min(3).max(64)).max(64),
  revoked: external_exports.array(external_exports.string().min(3).max(64)).max(64),
  enabled: external_exports.boolean(),
  installedAt: external_exports.string().min(1).max(40),
  dataUninstall: external_exports.enum(["keep", "delete", "ask"]),
  assetPacks: external_exports.array(external_exports.object({ id: external_exports.string().min(3).max(96), range: external_exports.string().max(32), required: external_exports.boolean() }).strict()).max(16),
  assetPackPrefixes: external_exports.array(external_exports.string().min(3).max(90)).max(4),
  trustTier: external_exports.enum(["sandboxed", "full-trust"]),
  backend: external_exports.object({ resources: external_exports.object({ memoryMB: external_exports.number().int().positive(), cpuThreads: external_exports.number().int().positive(), maxSessions: external_exports.number().int().positive(), idleUnloadSec: external_exports.number().int().nonnegative(), bootTimeoutSec: external_exports.number().int().positive() }).strict(), allowAddons: external_exports.boolean(), nativeFiles: external_exports.array(external_exports.string().max(200)).max(64) }).strict().nullable()
}).strict();
var PLUGIN_SURFACE_CHANNELS = Object.freeze({
  SYNC: "plugin-runtime:surface-sync",
  PRESENTATION_SET: "plugin-runtime:presentation-set",
  CLOSE: "plugin-runtime:surface-close",
  RELOAD: "plugin-runtime:surface-reload",
  MASK: "plugin-runtime:surface-mask",
  FOCUS: "plugin-runtime:surface-focus",
  STATE: "plugin-runtime:surface-state"
});
var PLUGIN_VIEW_CHANNELS = Object.freeze({
  PRESENTATION_GET: "plugin-view:presentation-get",
  PRESENTATION_REQUEST: "plugin-view:presentation-request",
  PRESENTATION_CHANGED: "plugin-view:presentation-changed",
  VISIBILITY: "plugin-view:visibility",
  MEDIA_REPORT: "plugin-view:media-report",
  MEDIA_COMMAND: "plugin-view:media-command"
});
var PRESENTATION_ERROR_CODES = Object.freeze([
  "presentation_not_declared",
  "presentation_not_granted",
  "presentation_requires_focus",
  "presentation_rate_limited",
  "presentation_requires_fullpage",
  "presentation_not_visible",
  "presentation_view_unavailable"
]);
var protocolVersion4 = external_exports.literal(PLUGIN_RUNTIME_PROTOCOL_VERSION);
var pluginId5 = external_exports.string().min(3).max(96).regex(IDENTIFIER_PATTERN);
var viewId = external_exports.string().min(1).max(32).regex(IDENTIFIER_PATTERN);
var coordinate = external_exports.number().finite().min(-1e5).max(1e5);
var extent = external_exports.number().finite().min(0).max(1e5);
var PluginPresentationModeSchema = external_exports.enum(["tab", "fullpage"]);
var PluginRequestedModeSchema = external_exports.enum(["tab", "window", "fullpage", "overlay"]);
var PluginSurfaceRectV1Schema = external_exports.object({ x: coordinate, y: coordinate, width: extent, height: extent }).strict();
var PluginSurfaceSyncRequestV1Schema = external_exports.object({
  protocolVersion: protocolVersion4,
  pluginId: pluginId5,
  viewId,
  active: external_exports.boolean(),
  rect: PluginSurfaceRectV1Schema.nullable(),
  coreOverlay: external_exports.boolean(),
  keyboardExit: external_exports.boolean().optional()
}).strict();
var PluginPresentationSetRequestV1Schema = external_exports.object({
  protocolVersion: protocolVersion4,
  pluginId: pluginId5,
  viewId,
  mode: PluginPresentationModeSchema,
  fullscreen: external_exports.boolean()
}).strict();
var PluginSurfaceMaskRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion4, masked: external_exports.boolean() }).strict();
var PluginSurfaceTargetRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion4, pluginId: pluginId5, viewId }).strict();
var PluginCaptureStateSchema = external_exports.object({ microphone: external_exports.boolean(), camera: external_exports.boolean() }).strict();
var PluginSurfaceStateV1Schema = external_exports.object({
  pluginId: pluginId5,
  viewId,
  mode: PluginPresentationModeSchema,
  fullscreen: external_exports.boolean(),
  status: external_exports.enum(["idle", "loading", "ready", "covered", "hidden", "crashed", "closed"]),
  errorCode: external_exports.string().min(1).max(96).nullable(),
  capture: PluginCaptureStateSchema.default({ microphone: false, camera: false })
}).strict();
var PluginSurfaceStateEventV1Schema = external_exports.object({ protocolVersion: protocolVersion4, state: PluginSurfaceStateV1Schema }).strict();
var errorEnvelope = external_exports.object({ code: external_exports.string().min(1).max(96).regex(/^[a-z0-9_]+$/), message: external_exports.string().min(1).max(512) }).strict();
var PluginSurfaceResultEnvelopeV1Schema = external_exports.discriminatedUnion("ok", [
  external_exports.object({ protocolVersion: protocolVersion4, ok: external_exports.literal(true), value: PluginSurfaceStateV1Schema }).strict(),
  external_exports.object({ protocolVersion: protocolVersion4, ok: external_exports.literal(false), error: errorEnvelope }).strict()
]);
var PluginSurfaceMaskValueV1Schema = external_exports.object({ masked: external_exports.boolean(), hiddenViews: external_exports.number().int().min(0).max(1024) }).strict();
var PluginSurfaceMaskEnvelopeV1Schema = external_exports.discriminatedUnion("ok", [
  external_exports.object({ protocolVersion: protocolVersion4, ok: external_exports.literal(true), value: PluginSurfaceMaskValueV1Schema }).strict(),
  external_exports.object({ protocolVersion: protocolVersion4, ok: external_exports.literal(false), error: errorEnvelope }).strict()
]);
var PluginViewPresentationStateSchema = external_exports.object({
  mode: PluginPresentationModeSchema,
  fullscreen: external_exports.boolean(),
  visible: external_exports.boolean()
}).strict();
var PluginViewPresentationRequestSchema = external_exports.object({
  mode: PluginRequestedModeSchema,
  fullscreen: external_exports.boolean().optional()
}).strict();
var PluginViewPresentationResultSchema = external_exports.discriminatedUnion("ok", [
  external_exports.object({ ok: external_exports.literal(true), state: PluginViewPresentationStateSchema }).strict(),
  external_exports.object({ ok: external_exports.literal(false), error: external_exports.enum(PRESENTATION_ERROR_CODES) }).strict()
]);
var PluginViewPresentationChangeSchema = external_exports.object({
  phase: external_exports.enum(["before", "after"]),
  from: PluginPresentationModeSchema,
  to: PluginPresentationModeSchema,
  fullscreen: external_exports.boolean(),
  visible: external_exports.boolean(),
  reason: external_exports.enum(["user", "plugin", "core", "escape", "window"])
}).strict();
var PluginViewVisibilityReportSchema = external_exports.object({ state: external_exports.enum(["visible", "hidden"]) }).strict();
var counter = external_exports.number().int().min(0).max(1e6);
var PluginViewMediaReportSchema = external_exports.object({ requestId: counter.nullable(), live: counter, calls: counter, successes: counter }).strict();
var PluginViewMediaCommandSchema = external_exports.object({ requestId: counter, action: external_exports.enum(["stop", "resume"]) }).strict();

// packages/plugin-sdk/src/pluginIcon.ts
var PLUGIN_ICON_MAX_BYTES = 64 * 1024;
var PLUGIN_ICON_MAX_EDGE = 1024;
var PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
var PNG_END = [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130];
var DATA_URL_PREFIX = "data:image/png;base64,";
var PLUGIN_ICON_DATA_URL_MAX_CHARS = Math.ceil(PLUGIN_ICON_MAX_BYTES / 3) * 4 + DATA_URL_PREFIX.length;
var PLUGIN_ICON_DATA_URL_PATTERN = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
var startsWith = (bytes4, at, expected) => expected.every((value, index) => bytes4[at + index] === value);
function isPngIcon(bytes4) {
  if (bytes4.length < 33 + PNG_END.length || bytes4.length > PLUGIN_ICON_MAX_BYTES) return false;
  if (!startsWith(bytes4, 0, PNG_SIGNATURE) || !startsWith(bytes4, 12, [73, 72, 68, 82]) || !startsWith(bytes4, 8, [0, 0, 0, 13])) return false;
  if (!startsWith(bytes4, bytes4.length - PNG_END.length, PNG_END)) return false;
  const view = new DataView(bytes4.buffer, bytes4.byteOffset, bytes4.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width >= 1 && height >= 1 && width <= PLUGIN_ICON_MAX_EDGE && height <= PLUGIN_ICON_MAX_EDGE;
}

// packages/plugin-sdk/src/installContracts.ts
var PLUGIN_INSTALL_CHANNELS = Object.freeze({
  LIST: "plugin-install:list",
  BEGIN: "plugin-install:begin",
  UNINSTALL: "plugin-install:uninstall",
  IMPORT_DEV_KEY: "plugin-install:import-dev-key",
  REMOVE_DEV_KEY: "plugin-install:remove-dev-key",
  PICK_DEV_KEY: "plugin-install:pick-dev-key",
  DECIDE_DEV_KEY: "plugin-install:decide-dev-key",
  REMOVE_ASSET_PACK: "plugin-install:remove-asset-pack",
  SET_PERMISSION: "plugin-install:set-permission",
  SET_PROVIDER: "plugin-install:set-provider",
  BUNDLED_RESTORE: "plugin-install:bundled-restore",
  BEGIN_ASSET_PACK: "plugin-install:begin-asset-pack",
  NATIVE_CONFIRM: "plugin-install:native-confirm",
  SETTINGS_GET: "plugin-install:settings-get",
  SETTINGS_SET: "plugin-install:settings-set",
  SETTINGS_RESET: "plugin-install:settings-reset",
  STORE_CATALOG: "plugin-install:store-catalog",
  STORE_ACQUIRE: "plugin-install:store-acquire",
  STORE_CANCEL: "plugin-install:store-cancel",
  STORE_DISCARD: "plugin-install:store-discard",
  STORE_DOWNLOADS: "plugin-install:store-downloads",
  STORE_PROGRESS: "plugin-install:store-progress",
  STORE_OUTCOME: "plugin-install:store-outcome",
  STORE_CONFIRM: "plugin-install:store-confirm",
  STORE_CONFIRM_REPLY: "plugin-install:store-confirm-reply",
  STORE_LIBRARY: "plugin-install:store-library",
  STORE_NOTICES_CHANGED: "plugin-install:store-notices-changed"
});
var protocolVersion5 = external_exports.literal(PLUGIN_RUNTIME_PROTOCOL_VERSION);
var installId = external_exports.string().regex(/^[0-9a-f]{32}$/);
var keyId = external_exports.string().regex(/^dev-[0-9a-f]{16}$/);
var PluginInstallListRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion5 }).strict();
var PluginInstallBeginRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion5 }).strict();
var PluginUninstallRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion5, pluginId: external_exports.string().regex(IDENTIFIER_PATTERN), deleteData: external_exports.boolean() }).strict();
var PluginDevKeyImportRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion5, publicKey: external_exports.string().min(1).max(4096), label: external_exports.string().min(1).max(48) }).strict();
var settingValue = external_exports.union([external_exports.boolean(), external_exports.number().finite(), external_exports.string().max(1024)]);
var PluginSettingsGetRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion5, pluginId: external_exports.string().regex(IDENTIFIER_PATTERN).max(96) }).strict();
var PluginSettingsSetRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion5, pluginId: external_exports.string().regex(IDENTIFIER_PATTERN).max(96), values: external_exports.record(external_exports.string().regex(/^[A-Za-z0-9._-]{1,64}$/), settingValue).refine((values) => Object.keys(values).length <= 16) }).strict();
var SETTINGS_FORM_ISSUES = ["type", "range", "step", "option", "length", "chars", "unknown_key", "missing"];
var PluginSettingsFormResultV1Schema = external_exports.object({
  pluginId: external_exports.string().regex(IDENTIFIER_PATTERN).max(96),
  saved: external_exports.boolean(),
  values: external_exports.record(external_exports.string(), settingValue),
  errors: external_exports.record(external_exports.string().max(64), external_exports.enum(SETTINGS_FORM_ISSUES))
}).strict();
var PluginAssetPackBeginRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion5, pluginId: external_exports.string().regex(IDENTIFIER_PATTERN).max(96) }).strict();
var PluginAssetPackRemoveRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion5, packId: external_exports.string().regex(IDENTIFIER_PATTERN) }).strict();
var PluginPermissionSetRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion5, pluginId: external_exports.string().regex(IDENTIFIER_PATTERN), permission: external_exports.string().min(3).max(64), revoked: external_exports.boolean() }).strict();
var PluginDevKeyRemoveRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion5, keyId }).strict();
var PluginDevKeyPickRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion5 }).strict();
var DEV_KEY_TRUST_DECISIONS = ["trust", "decline"];
var PluginDevKeyDecideRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion5, trustId: installId, decision: external_exports.enum(DEV_KEY_TRUST_DECISIONS), label: external_exports.string().min(1).max(48).optional() }).strict();
var pluginIdField = external_exports.string().regex(IDENTIFIER_PATTERN).max(96);
var PluginNativeConfirmRequestV1Schema = external_exports.object({
  protocolVersion: protocolVersion5,
  title: external_exports.string().min(1).max(80),
  message: external_exports.string().min(1).max(400),
  detail: external_exports.string().max(800).optional(),
  confirmLabel: external_exports.string().min(1).max(24),
  cancelLabel: external_exports.string().min(1).max(24)
}).strict();
var BUNDLED_LISTED_STATES = ["removed", "verification_failed"];
var PluginBundledRestoreRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion5, pluginId: pluginIdField }).strict();
var PluginProviderSetRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion5, capability: external_exports.string().regex(CAPABILITY_PATTERN).max(96), providerId: external_exports.string().regex(IDENTIFIER_PATTERN).max(96).nullable() }).strict();
var PLUGIN_RISK_NOTICES = ["full_trust", "native_code", "network_unrestricted", "dev_key_local_only", "file_sandbox_bypassable"];
var RiskNoticeSchema = external_exports.enum(PLUGIN_RISK_NOTICES);
var BackendViewSchema = external_exports.object({
  resources: external_exports.object({
    memoryMB: external_exports.number().int().positive(),
    cpuThreads: external_exports.number().int().positive(),
    maxSessions: external_exports.number().int().positive(),
    idleUnloadSec: external_exports.number().int().nonnegative(),
    bootTimeoutSec: external_exports.number().int().positive()
  }).strict(),
  allowAddons: external_exports.boolean(),
  nativeFiles: external_exports.array(external_exports.string().max(200)).max(64)
}).strict();
var PluginSignerViewV1Schema = external_exports.discriminatedUnion("kind", [
  external_exports.object({ kind: external_exports.literal("teamuq"), keyId: external_exports.string().min(3).max(64), label: external_exports.null() }).strict(),
  external_exports.object({ kind: external_exports.literal("dev"), keyId: external_exports.string().min(3).max(64), label: external_exports.string().max(48).nullable() }).strict(),
  external_exports.object({ kind: external_exports.literal("unsigned"), keyId: external_exports.null(), label: external_exports.null() }).strict()
]);
var AssetPackRefViewSchema = external_exports.object({
  id: external_exports.string().max(96),
  range: external_exports.string().max(32),
  required: external_exports.boolean(),
  status: PluginAssetPackStatusSchema,
  version: external_exports.string().max(32).nullable(),
  name: external_exports.string().max(96).nullable().default(null),
  sizeBytes: external_exports.number().int().nonnegative().nullable().default(null)
}).strict();
var CapabilityConsentViewSchema = external_exports.object({
  capability: external_exports.string().regex(CAPABILITY_PATTERN).max(96),
  providerId: external_exports.string().regex(IDENTIFIER_PATTERN).max(96),
  providerVersion: external_exports.string().max(32),
  grantedAt: external_exports.string().max(40)
}).strict();
var InstalledPluginViewV1Schema = external_exports.object({
  id: external_exports.string().regex(IDENTIFIER_PATTERN),
  name: external_exports.string().max(96),
  version: external_exports.string().max(32),
  publisher: external_exports.string().max(48),
  signer: PluginSignerViewV1Schema,
  permissions: external_exports.array(external_exports.string().max(64)).max(64),
  revokedPermissions: external_exports.array(external_exports.string().max(64)).max(64).default([]),
  dataUninstall: external_exports.enum(["keep", "delete", "ask"]),
  installedAt: external_exports.string().max(40),
  blockedCode: external_exports.string().max(96).nullable(),
  hasView: external_exports.boolean().default(false),
  description: external_exports.string().max(512).nullable().default(null),
  provides: external_exports.array(external_exports.string().regex(CAPABILITY_PATTERN).max(96)).max(16).default([]),
  networkOrigins: external_exports.array(external_exports.string().max(200)).max(32).default([]),
  iconDataUrl: external_exports.string().max(PLUGIN_ICON_DATA_URL_MAX_CHARS).regex(PLUGIN_ICON_DATA_URL_PATTERN).nullable().default(null),
  assetPacks: external_exports.array(AssetPackRefViewSchema).max(16).default([]),
  trustTier: external_exports.enum(["sandboxed", "full-trust"]).default("sandboxed"),
  backend: BackendViewSchema.nullable().default(null),
  riskNotices: external_exports.array(RiskNoticeSchema).max(8).default([]),
  capabilityConsents: external_exports.array(CapabilityConsentViewSchema).max(64).default([]),
  aiUsage: AiChatUsageSchema.nullable().default(null),
  settingsSchema: PluginSettingsSchemaSchema.nullable().default(null),
  hasSettingsView: external_exports.boolean().default(false)
}).strict();
var InstalledAssetPackViewV1Schema = external_exports.object({
  id: external_exports.string().regex(IDENTIFIER_PATTERN),
  version: external_exports.string().max(32),
  name: external_exports.string().max(96),
  publisher: external_exports.string().max(48),
  signer: PluginSignerViewV1Schema,
  installedAt: external_exports.string().max(40),
  sizeBytes: external_exports.number().int().nonnegative(),
  fileCount: external_exports.number().int().nonnegative(),
  blockedCode: external_exports.string().max(96).nullable(),
  dependents: external_exports.array(external_exports.string().regex(IDENTIFIER_PATTERN)).max(256)
}).strict();
var DevKeyViewV1Schema = external_exports.object({
  keyId,
  fingerprint: external_exports.string().regex(/^[0-9a-f]{64}$/),
  label: external_exports.string().max(48),
  importedAt: external_exports.string().max(40),
  trustedHere: external_exports.boolean()
}).strict();
var DevKeyTrustReviewV1Schema = external_exports.object({
  trustId: installId,
  keyId,
  fingerprint: external_exports.string().regex(/^[0-9a-f]{64}$/),
  fileName: external_exports.string().max(200),
  defaultLabel: external_exports.string().min(1).max(48),
  alreadyTrusted: external_exports.boolean()
}).strict();
var BundledPluginEntryViewV1Schema = external_exports.object({
  id: pluginIdField,
  name: external_exports.string().max(96),
  state: external_exports.enum(BUNDLED_LISTED_STATES),
  offeredVersion: external_exports.string().regex(VERSION_PATTERN),
  installedVersion: external_exports.string().regex(VERSION_PATTERN).nullable(),
  failureCode: external_exports.string().max(96).nullable()
}).strict();
var PluginInstallListV1Schema = external_exports.object({
  protocolVersion: protocolVersion5,
  plugins: external_exports.array(InstalledPluginViewV1Schema),
  developerPanelEnabled: external_exports.boolean().default(false),
  developerViews: external_exports.array(PluginSurfaceStateV1Schema).max(1024).default([]),
  assetPacks: external_exports.array(InstalledAssetPackViewV1Schema).default([]),
  bundledPlugins: external_exports.array(BundledPluginEntryViewV1Schema).max(16).default([]),
  coreConsents: external_exports.array(CapabilityConsentViewSchema).max(64).default([]),
  devKeys: external_exports.array(DevKeyViewV1Schema)
}).strict();
var ReviewPermissionSchema = external_exports.object({ permission: external_exports.string().max(64), description: external_exports.string().max(200) }).strict();
var PluginInstalledSummaryV1Schema = external_exports.object({
  kind: external_exports.enum(["plugin", "asset-pack"]).default("plugin"),
  sizeBytes: external_exports.number().int().nonnegative().default(0),
  assetPacks: external_exports.array(external_exports.object({ id: external_exports.string().max(96), range: external_exports.string().max(32), required: external_exports.boolean(), installed: external_exports.boolean() }).strict()).max(16).default([]),
  fileName: external_exports.string().max(200),
  id: external_exports.string().regex(IDENTIFIER_PATTERN),
  name: external_exports.string().max(96),
  version: external_exports.string().max(32),
  publisher: external_exports.string().max(48),
  description: external_exports.string().max(512).nullable(),
  signer: PluginSignerViewV1Schema,
  permissions: external_exports.array(ReviewPermissionSchema).max(64),
  updateFrom: external_exports.object({ id: external_exports.string().regex(IDENTIFIER_PATTERN), version: external_exports.string().max(32) }).strict().nullable().default(null),
  addedPermissions: external_exports.array(ReviewPermissionSchema).max(64).default([]),
  removedPermissions: external_exports.array(ReviewPermissionSchema).max(64).default([]),
  networkOrigins: external_exports.array(external_exports.string().max(200)).max(32),
  dataUninstall: external_exports.enum(["keep", "delete", "ask"]),
  dependencies: external_exports.array(external_exports.object({ capability: external_exports.string().max(96), provided: external_exports.boolean(), required: external_exports.boolean().default(false), providerName: external_exports.string().max(96).nullable().default(null), allowed: external_exports.boolean().default(true) }).strict()).max(64),
  trustTier: external_exports.enum(["sandboxed", "full-trust"]).default("sandboxed"),
  backend: BackendViewSchema.nullable().default(null),
  riskNotices: external_exports.array(RiskNoticeSchema).max(8).default([])
}).strict();
var PluginAssetPackRedirectV1Schema = external_exports.object({
  status: external_exports.literal("asset_pack_redirect"),
  packId: external_exports.string().regex(IDENTIFIER_PATTERN).max(96),
  packName: external_exports.string().max(96),
  owners: external_exports.array(external_exports.object({ id: external_exports.string().regex(IDENTIFIER_PATTERN).max(96), name: external_exports.string().max(96), hasView: external_exports.boolean() }).strict()).max(16)
}).strict();
var PluginInstallBeginResultV1Schema = external_exports.discriminatedUnion("status", [
  PluginAssetPackRedirectV1Schema,
  external_exports.object({ status: external_exports.literal("cancelled") }).strict(),
  external_exports.object({ status: external_exports.literal("installed"), installed: PluginInstalledSummaryV1Schema, list: PluginInstallListV1Schema }).strict()
]);
var PluginDevKeyPickResultV1Schema = external_exports.discriminatedUnion("status", [
  external_exports.object({ status: external_exports.literal("cancelled") }).strict(),
  external_exports.object({ status: external_exports.literal("review"), review: DevKeyTrustReviewV1Schema }).strict()
]);
var PluginDevKeyDecideResultV1Schema = external_exports.discriminatedUnion("status", [
  external_exports.object({ status: external_exports.literal("declined") }).strict(),
  external_exports.object({ status: external_exports.literal("trusted"), keyId }).strict()
]);
var PluginBundledRestoreResultV1Schema = external_exports.object({ pluginId: pluginIdField, status: external_exports.literal("consented") }).strict();
var PluginStoreCatalogRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion5, refresh: external_exports.boolean() }).strict();
var STORE_CATALOG_STATES = ["disabled", "fresh", "stale", "offline", "untrusted"];
var STORE_CATALOG_SOURCES = ["production", "dev-local"];
var STORE_CATALOG_VIEW_MAX_ENTRIES = 50;
var StoreCatalogEntryViewSchema = external_exports.object({
  entryId: external_exports.string().max(64),
  kind: external_exports.enum(["asset-pack", "plugin"]),
  id: external_exports.string().max(96),
  version: external_exports.string().max(32),
  name: external_exports.string().max(200),
  summary: external_exports.string().max(500),
  tags: external_exports.array(external_exports.string().max(60)).max(8),
  creator: external_exports.string().max(200),
  sizeBytes: external_exports.number().int().nonnegative()
}).strict();
var PluginStoreCatalogViewV1Schema = external_exports.object({
  state: external_exports.enum(STORE_CATALOG_STATES),
  source: external_exports.enum(STORE_CATALOG_SOURCES).nullable(),
  sequence: external_exports.number().int().nonnegative().nullable(),
  issuedAt: external_exports.string().max(40).nullable(),
  expiresAt: external_exports.string().max(40).nullable(),
  expired: external_exports.boolean(),
  acquirable: external_exports.boolean(),
  ageSec: external_exports.number().int().nonnegative().nullable(),
  entryCount: external_exports.number().int().nonnegative(),
  skipped: external_exports.number().int().nonnegative(),
  lastError: external_exports.string().max(96).nullable(),
  entries: external_exports.array(StoreCatalogEntryViewSchema).max(STORE_CATALOG_VIEW_MAX_ENTRIES)
}).strict();
var storeEntryId = external_exports.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/);
var storeErrorCode = external_exports.string().regex(/^store_[a-z_]{3,40}$/);
var STORE_PROGRESS_STAGES = ["downloading", "verifying", "installing"];
var PluginStoreEntryRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion5, entryId: storeEntryId }).strict();
var PluginStoreDownloadsRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion5 }).strict();
var StoreRetrySchema = external_exports.object({ attempt: external_exports.number().int().min(1).max(10), max: external_exports.number().int().min(1).max(10) }).strict();
var byteField = external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
var PluginStoreProgressEventV1Schema = external_exports.object({
  entryId: storeEntryId,
  name: external_exports.string().max(200),
  ownerId: pluginIdField.nullable(),
  stage: external_exports.enum(STORE_PROGRESS_STAGES),
  bytesReceived: byteField,
  bytesTotal: byteField.nullable(),
  retry: StoreRetrySchema.nullable()
}).strict();
var STORE_OUTCOME_STATUSES = ["installed", "updated", "cancelled", "failed"];
var PluginStoreOutcomeEventV1Schema = external_exports.object({
  entryId: storeEntryId,
  name: external_exports.string().max(200),
  ownerId: pluginIdField.nullable(),
  status: external_exports.enum(STORE_OUTCOME_STATUSES)
}).strict();
var STORE_CONFIRM_OUTCOMES = ["shown", "agreed", "declined", "mask_failed"];
var confirmRequestId = external_exports.string().regex(/^[A-Za-z0-9-]{8,64}$/);
var STORE_COVER_DATA_URL_MAX = 72e4;
var storeCoverDataUrl = external_exports.string().max(STORE_COVER_DATA_URL_MAX).regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/);
var PluginStoreConfirmPromptV1Schema = external_exports.object({
  name: external_exports.string().min(1).max(200),
  version: external_exports.string().max(32),
  previousVersion: external_exports.string().max(32).nullable(),
  summary: external_exports.string().max(240),
  ownerName: external_exports.string().max(200).nullable(),
  requestedBy: external_exports.enum(["plugin", "core"]),
  realPerson: external_exports.boolean(),
  reconfirm: external_exports.boolean(),
  downloadBytes: byteField,
  installedBytes: byteField,
  neededBytes: byteField,
  freeBytes: byteField,
  packId: external_exports.string().max(96),
  signerKeyId: external_exports.string().max(64),
  sha256: external_exports.string().regex(/^[0-9a-f]{64}$/),
  coverDataUrl: storeCoverDataUrl.nullable().optional()
}).strict();
var STORE_MB = 1024 * 1024;
var STORE_GB = 1024 * STORE_MB;
var PluginStoreRollbackPromptV1Schema = external_exports.object({
  name: external_exports.string().min(1).max(200),
  from: external_exports.string().max(32),
  to: external_exports.string().max(32),
  freedBytes: byteField,
  packId: external_exports.string().max(96)
}).strict();
var PluginStoreConfirmRequestV1Schema = external_exports.discriminatedUnion("kind", [
  external_exports.object({ kind: external_exports.literal("ask"), requestId: confirmRequestId, prompt: PluginStoreConfirmPromptV1Schema }).strict(),
  external_exports.object({ kind: external_exports.literal("ask-rollback"), requestId: confirmRequestId, prompt: PluginStoreRollbackPromptV1Schema }).strict(),
  external_exports.object({ kind: external_exports.literal("cancel"), requestId: confirmRequestId }).strict()
]);
var PluginStoreConfirmReplyRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion5, requestId: confirmRequestId, outcome: external_exports.enum(STORE_CONFIRM_OUTCOMES) }).strict();
var PluginStoreAcquireResultV1Schema = external_exports.discriminatedUnion("status", [
  external_exports.object({ status: external_exports.enum(["installed", "updated"]), packId: external_exports.string().max(96), version: external_exports.string().max(32), name: external_exports.string().max(200) }).strict(),
  external_exports.object({ status: external_exports.literal("cancelled") }).strict()
]);
var PluginStoreDownloadsViewV1Schema = external_exports.object({
  active: PluginStoreProgressEventV1Schema.extend({ stage: external_exports.enum(["confirming", ...STORE_PROGRESS_STAGES]) }).strict().nullable(),
  pending: external_exports.array(external_exports.object({ entryId: storeEntryId, name: external_exports.string().max(200), version: external_exports.string().max(32), ownerId: pluginIdField.nullable(), bytesReceived: byteField, bytesTotal: byteField, stale: external_exports.boolean() }).strict()).max(50),
  recent: external_exports.object({ entryId: storeEntryId, name: external_exports.string().max(200), ownerId: pluginIdField.nullable(), code: storeErrorCode }).strict().nullable(),
  installed: external_exports.array(external_exports.object({ entryId: storeEntryId, version: external_exports.string().max(32) }).strict()).max(1e3)
}).strict();
var libraryNotice = external_exports.object({ title: external_exports.string().max(200), body: external_exports.string().max(600) }).strict();
var noticeId = external_exports.string().regex(/^[0-9a-f]{24}-(?:disable|remove)$/);
var PluginStoreLibraryRequestV1Schema = external_exports.discriminatedUnion("op", [
  external_exports.object({ protocolVersion: protocolVersion5, op: external_exports.literal("characters"), ownerId: pluginIdField }).strict(),
  external_exports.object({ protocolVersion: protocolVersion5, op: external_exports.literal("rollback"), ownerId: pluginIdField, entryId: storeEntryId, expectedVersion: external_exports.string().max(32) }).strict(),
  external_exports.object({ protocolVersion: protocolVersion5, op: external_exports.literal("notices") }).strict(),
  external_exports.object({ protocolVersion: protocolVersion5, op: external_exports.literal("seen"), noticeId }).strict(),
  external_exports.object({ protocolVersion: protocolVersion5, op: external_exports.literal("dismiss"), entryId: storeEntryId }).strict()
]);
var PluginStoreCharacterViewV1Schema = external_exports.object({
  entryId: storeEntryId,
  packId: external_exports.string().max(96),
  name: external_exports.string().max(200),
  version: external_exports.string().max(32),
  sizeBytes: byteField.nullable(),
  addedAt: external_exports.string().max(40).nullable(),
  state: external_exports.enum(["ready", "hidden", "disabled", "removed"]),
  withdrawnReason: external_exports.string().max(40).nullable(),
  notice: libraryNotice.nullable(),
  previousVersion: external_exports.string().max(32).nullable(),
  update: external_exports.object({ version: external_exports.string().max(32), downloadBytes: byteField.nullable() }).strict().nullable(),
  daysLeft: external_exports.number().int().min(0).max(30).nullable()
}).strict();
var PluginStoreNoticeViewV1Schema = external_exports.object({
  noticeId,
  ownerId: pluginIdField.nullable(),
  entryId: storeEntryId.nullable(),
  severity: external_exports.enum(["disable", "remove"]),
  name: external_exports.string().max(200),
  title: external_exports.string().max(200),
  body: external_exports.string().max(600)
}).strict();
var PluginStoreLibraryResultV1Schema = external_exports.discriminatedUnion("kind", [
  external_exports.object({ kind: external_exports.literal("characters"), items: external_exports.array(PluginStoreCharacterViewV1Schema).max(200) }).strict(),
  external_exports.object({ kind: external_exports.literal("rollback"), outcome: external_exports.discriminatedUnion("status", [
    external_exports.object({ status: external_exports.literal("rolled_back"), packId: external_exports.string().max(96), version: external_exports.string().max(32), name: external_exports.string().max(200) }).strict(),
    external_exports.object({ status: external_exports.literal("cancelled") }).strict(),
    external_exports.object({ status: external_exports.literal("no_previous") }).strict()
  ]) }).strict(),
  external_exports.object({ kind: external_exports.literal("notices"), items: external_exports.array(PluginStoreNoticeViewV1Schema).max(50) }).strict(),
  external_exports.object({ kind: external_exports.literal("done") }).strict()
]);
var envelope = (value) => external_exports.discriminatedUnion("ok", [
  external_exports.object({ protocolVersion: protocolVersion5, ok: external_exports.literal(true), value }).strict(),
  external_exports.object({ protocolVersion: protocolVersion5, ok: external_exports.literal(false), error: PluginRuntimeErrorV1Schema }).strict()
]);
var PluginInstallListEnvelopeV1Schema = envelope(PluginInstallListV1Schema);
var PluginInstallBeginEnvelopeV1Schema = envelope(PluginInstallBeginResultV1Schema);
var PluginDevKeyPickEnvelopeV1Schema = envelope(PluginDevKeyPickResultV1Schema);
var PluginDevKeyDecideEnvelopeV1Schema = envelope(PluginDevKeyDecideResultV1Schema);
var PluginBundledRestoreEnvelopeV1Schema = envelope(PluginBundledRestoreResultV1Schema);
var PluginNativeConfirmEnvelopeV1Schema = envelope(external_exports.object({ confirmed: external_exports.boolean() }).strict());
var PluginSettingsFormEnvelopeV1Schema = envelope(PluginSettingsFormResultV1Schema);
var PluginStoreCatalogEnvelopeV1Schema = envelope(PluginStoreCatalogViewV1Schema);
var PluginStoreAcquireEnvelopeV1Schema = envelope(PluginStoreAcquireResultV1Schema);
var PluginStoreDownloadsEnvelopeV1Schema = envelope(PluginStoreDownloadsViewV1Schema);
var PluginStoreLibraryEnvelopeV1Schema = envelope(PluginStoreLibraryResultV1Schema);
var PluginStoreDoneEnvelopeV1Schema = envelope(external_exports.object({ done: external_exports.literal(true) }).strict());

// packages/plugin-sdk/src/backendContracts.ts
var PLUGIN_BACKEND_CHANNELS = Object.freeze({
  STATUS: "plugin-backend:status",
  PROBE: "plugin-backend:probe"
});
var EXTERNAL_HOST_PROTOCOL_VERSION = 1;
var EXTERNAL_HOST_MAX_RESULT_BYTES = 64 * 1024;
var protocolVersion6 = external_exports.literal(PLUGIN_RUNTIME_PROTOCOL_VERSION);
var hostVersion = external_exports.literal(EXTERNAL_HOST_PROTOCOL_VERSION);
var pluginId6 = external_exports.string().regex(IDENTIFIER_PATTERN);
var methodName = external_exports.string().min(1).max(64).regex(/^[A-Za-z0-9._@-]+$/);
var errorCode = external_exports.string().min(3).max(96).regex(/^[a-z0-9_]+$/);
var settingValues = external_exports.record(external_exports.string().regex(/^[A-Za-z0-9._-]{1,64}$/), external_exports.union([external_exports.boolean(), external_exports.number().finite(), external_exports.string().max(1024)])).refine((values) => Object.keys(values).length <= 16);
var ExternalSettingsMessageSchema = external_exports.object({ protocolVersion: hostVersion, kind: external_exports.literal("ext-settings"), values: settingValues }).strict();
var ExternalHostInitSchema = external_exports.object({
  version: hostVersion,
  pluginId: pluginId6,
  installDir: external_exports.string().min(1).max(1024),
  dataDir: external_exports.string().min(1).max(1024),
  entry: external_exports.string().min(1).max(1024),
  assetPacks: external_exports.record(external_exports.string().min(1).max(96), external_exports.string().min(1).max(1024)),
  allowAddons: external_exports.boolean(),
  corePackaged: external_exports.boolean(),
  grantedPermissions: external_exports.array(external_exports.string().min(1).max(96)).max(64).default([]),
  heartbeatMs: external_exports.number().int().min(50).max(3e4).optional(),
  settings: settingValues.optional()
}).strict();
var ExternalSelfCheckReportSchema = external_exports.object({
  ok: external_exports.boolean(),
  code: errorCode.nullable(),
  allowAddons: external_exports.boolean(),
  probes: external_exports.record(external_exports.string().max(48), external_exports.string().max(64))
}).strict();
var ExternalSelfCheckMessageSchema = external_exports.object({
  protocolVersion: hostVersion,
  kind: external_exports.literal("ext-self-check"),
  report: ExternalSelfCheckReportSchema
}).strict();
var ExternalStatsMessageSchema = external_exports.object({
  protocolVersion: hostVersion,
  kind: external_exports.literal("ext-stats"),
  rssKb: external_exports.number().nonnegative()
}).strict();
var ExternalCallMessageSchema = external_exports.object({
  protocolVersion: hostVersion,
  kind: external_exports.literal("ext-call"),
  requestId: external_exports.string().min(1).max(64),
  method: methodName,
  params: external_exports.unknown()
}).strict();
var ExternalResultMessageSchema = external_exports.discriminatedUnion("ok", [
  external_exports.object({ protocolVersion: hostVersion, kind: external_exports.literal("ext-result"), requestId: external_exports.string().min(1).max(64), ok: external_exports.literal(true), value: external_exports.unknown() }).strict(),
  external_exports.object({ protocolVersion: hostVersion, kind: external_exports.literal("ext-result"), requestId: external_exports.string().min(1).max(64), ok: external_exports.literal(false), error: external_exports.object({ code: errorCode, message: external_exports.string().max(512) }).strict() }).strict()
]);
var BACKEND_STATES = ["idle", "starting", "running", "stopping", "failed"];
var BACKEND_STOP_REASONS = ["idle", "memory_exceeded", "disabled", "crashed", "shutdown", "uninstalled", "hung"];
var PluginBackendStatusV1Schema = external_exports.object({
  pluginId: pluginId6,
  state: external_exports.enum(BACKEND_STATES),
  pid: external_exports.number().int().nonnegative().nullable(),
  startedAt: external_exports.string().max(40).nullable(),
  lastActiveAt: external_exports.string().max(40).nullable(),
  starts: external_exports.number().int().nonnegative(),
  crashes: external_exports.number().int().nonnegative(),
  lastStartMs: external_exports.number().nonnegative().nullable(),
  lastVerifyMs: external_exports.number().nonnegative().nullable(),
  rssMB: external_exports.number().nonnegative().nullable(),
  memoryLimitMB: external_exports.number().int().positive(),
  idleUnloadSec: external_exports.number().int().nonnegative(),
  maxSessions: external_exports.number().int().positive(),
  inFlight: external_exports.number().int().nonnegative(),
  allowAddons: external_exports.boolean(),
  failureCode: errorCode.nullable(),
  lastStopReason: external_exports.enum(BACKEND_STOP_REASONS).nullable(),
  selfCheck: ExternalSelfCheckReportSchema.nullable()
}).strict();
var PluginBackendStatusListV1Schema = external_exports.object({
  protocolVersion: protocolVersion6,
  backends: external_exports.array(PluginBackendStatusV1Schema).max(256)
}).strict();
var PluginBackendProbeResultV1Schema = external_exports.object({
  pluginId: pluginId6,
  coldStart: external_exports.boolean(),
  totalMs: external_exports.number().nonnegative(),
  core: external_exports.unknown(),
  plugin: external_exports.discriminatedUnion("ok", [
    external_exports.object({ ok: external_exports.literal(true), value: external_exports.unknown() }).strict(),
    external_exports.object({ ok: external_exports.literal(false), code: errorCode, message: external_exports.string().max(240).optional() }).strict()
  ]),
  status: PluginBackendStatusV1Schema
}).strict();
var PluginBackendStatusRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion6 }).strict();
var PluginBackendProbeRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion6, pluginId: pluginId6 }).strict();
var envelope2 = (value) => external_exports.discriminatedUnion("ok", [
  external_exports.object({ protocolVersion: protocolVersion6, ok: external_exports.literal(true), value }).strict(),
  external_exports.object({ protocolVersion: protocolVersion6, ok: external_exports.literal(false), error: PluginRuntimeErrorV1Schema }).strict()
]);
var PluginBackendStatusEnvelopeV1Schema = envelope2(PluginBackendStatusListV1Schema);
var PluginBackendProbeEnvelopeV1Schema = envelope2(PluginBackendProbeResultV1Schema);

// packages/plugin-sdk/src/voiceInputContracts.ts
var VOICE_INPUT_CHANNELS = Object.freeze({
  STATE: "plugin-voice-input:state",
  SET_ENABLED: "plugin-voice-input:set-enabled",
  CHANGED: "plugin-voice-input:changed",
  PLUGIN: "plugin-view:voice-input"
});
var VOICE_INPUT_LIMITS = Object.freeze({
  chunkMs: 80,
  sampleRate: 16e3,
  pauseTimeoutMs: 3e4,
  pauseMaxTotalMs: 12e4,
  pauseCooldownMs: 3e4,
  pauseReasonChars: 64,
  restartsPerMinute: 3
});
var VOICE_INPUT_STATUSES = Object.freeze(["off", "starting", "listening", "paused", "unavailable"]);
var VOICE_INPUT_REASONS = Object.freeze([
  "no_recognizer",
  "recognizer_selection_required",
  "recognizer_not_ready",
  "recognizer_not_allowed",
  "recognizer_busy",
  "recognizer_gone",
  "recognizer_error",
  "model_missing",
  "no_input_target",
  "consent_denied",
  "os_denied",
  "no_microphone",
  "capture_failed"
]);
var PLUGIN_VOICE_ERRORS = Object.freeze(["plugin_not_active", "not_input_target", "pause_limited", "request_invalid", "unavailable"]);
var protocolVersion7 = external_exports.literal(PLUGIN_RUNTIME_PROTOCOL_VERSION);
var pluginId7 = external_exports.string().min(3).max(96).regex(IDENTIFIER_PATTERN);
var pauseReason = external_exports.string().max(VOICE_INPUT_LIMITS.pauseReasonChars);
var count = external_exports.number().int().min(0);
var VoiceInputStateV1Schema = external_exports.object({
  protocolVersion: protocolVersion7,
  status: external_exports.enum(VOICE_INPUT_STATUSES),
  enabled: external_exports.boolean(),
  capturing: external_exports.boolean(),
  available: external_exports.boolean(),
  reason: external_exports.enum(VOICE_INPUT_REASONS).nullable(),
  recognizer: external_exports.object({ id: pluginId7, name: external_exports.string().max(96), version: external_exports.string().max(32), signer: external_exports.enum(PLUGIN_SIGNER_KINDS) }).strict().nullable(),
  target: external_exports.object({ id: pluginId7, name: external_exports.string().max(96) }).strict().nullable(),
  pause: external_exports.object({ by: pluginId7, name: external_exports.string().max(96), reason: pauseReason, remainingMs: count }).strict().nullable(),
  lastDeliveryError: external_exports.string().max(96).nullable(),
  stats: external_exports.object({ chunksSent: count, chunksDroppedPaused: count, finals: count, delivered: count }).strict()
}).strict();
var VoiceInputStateRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion7 }).strict();
var VoiceInputSetEnabledRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion7, enabled: external_exports.boolean(), consented: external_exports.boolean().optional() }).strict();
var errorBody2 = external_exports.object({ code: external_exports.string().min(1).max(96).regex(/^[a-z0-9_]+$/), message: external_exports.string().min(1).max(512) }).strict();
var VoiceInputStateEnvelopeV1Schema = external_exports.discriminatedUnion("ok", [
  external_exports.object({ protocolVersion: protocolVersion7, ok: external_exports.literal(true), value: VoiceInputStateV1Schema }).strict(),
  external_exports.object({ protocolVersion: protocolVersion7, ok: external_exports.literal(false), error: errorBody2 }).strict()
]);
var PluginVoiceRequestSchema = external_exports.discriminatedUnion("op", [
  external_exports.object({ op: external_exports.literal("state") }).strict(),
  external_exports.object({ op: external_exports.literal("pause"), reason: pauseReason.optional() }).strict(),
  external_exports.object({ op: external_exports.literal("resume") }).strict()
]);
var PluginVoiceStateSchema = external_exports.object({
  status: external_exports.enum(VOICE_INPUT_STATUSES),
  isInputTarget: external_exports.boolean(),
  paused: external_exports.boolean(),
  remainingMs: count.nullable()
}).strict();
var PluginVoiceEnvelopeSchema = external_exports.discriminatedUnion("ok", [
  external_exports.object({ ok: external_exports.literal(true), value: PluginVoiceStateSchema }).strict(),
  external_exports.object({ ok: external_exports.literal(false), error: external_exports.enum(PLUGIN_VOICE_ERRORS) }).strict()
]);
var VOICE_CAPTURE_CHANNELS = Object.freeze({
  COMMAND: "voice-capture:command",
  EVENT: "voice-capture:event"
});
var VoiceCaptureCommandSchema = external_exports.discriminatedUnion("op", [
  external_exports.object({ op: external_exports.literal("start"), chunkMs: external_exports.number().int().min(20).max(200), echoCancellation: external_exports.boolean() }).strict(),
  external_exports.object({ op: external_exports.literal("stop") }).strict()
]);
var VoiceCaptureEventSchema = external_exports.discriminatedUnion("kind", [
  external_exports.object({ kind: external_exports.literal("started"), label: external_exports.string().max(200), echoCancellation: external_exports.boolean().nullable() }).strict(),
  external_exports.object({ kind: external_exports.literal("failed"), reason: external_exports.enum(["os_denied", "no_microphone", "capture_failed"]) }).strict(),
  external_exports.object({ kind: external_exports.literal("ended"), reason: external_exports.enum(["device_lost", "stopped", "capture_failed"]) }).strict(),
  external_exports.object({ kind: external_exports.literal("chunk"), seq: count, bytes: external_exports.custom((value) => value instanceof Uint8Array && value.byteLength >= 2 && value.byteLength <= 16384) }).strict()
]);

// packages/plugin-sdk/src/backendInvokeContracts.ts
var PLUGIN_BACKEND_INVOKE_LIMITS = Object.freeze({ methods: 32, methodLength: 64, payloadBytes: 64 * 1024, inFlight: 8, timeoutMs: 3e4 });
var PLUGIN_BACKEND_INVOKE_ERROR_CODES = Object.freeze([
  "plugin_not_installed",
  "plugin_disabled",
  "plugin_permission_denied",
  "backend_method_not_allowed",
  "backend_invoke_invalid",
  "backend_invoke_too_large",
  "backend_invoke_timeout",
  "plugin_backend_crashed",
  "plugin_backend_unavailable"
]);
var method = external_exports.string().min(1).max(PLUGIN_BACKEND_INVOKE_LIMITS.methodLength).regex(/^[A-Za-z0-9._@-]+$/);
var jsonValue = external_exports.lazy(() => external_exports.union([
  external_exports.null(),
  external_exports.boolean(),
  external_exports.number().finite(),
  external_exports.string(),
  external_exports.array(jsonValue).max(4096),
  external_exports.record(external_exports.string(), jsonValue)
]));
var PluginBackendInvokeRequestV1Schema = external_exports.object({ method, params: jsonValue }).strict();
var PluginBackendInvokeResultV1Schema = external_exports.discriminatedUnion("ok", [
  external_exports.object({ ok: external_exports.literal(true), value: jsonValue }).strict(),
  external_exports.object({ ok: external_exports.literal(false), error: external_exports.enum(PLUGIN_BACKEND_INVOKE_ERROR_CODES) }).strict()
]);

// packages/plugin-sdk/src/keyIdentity.ts
var FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
var SHORT_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
var GRID_SIZE = 5;
var FREE_COLUMNS = 3;
function normalizeKeyFingerprint(input) {
  const compact = input.replace(/\s+/gu, "").toLowerCase().replace(/^sha256:/u, "");
  if (!FINGERPRINT_PATTERN.test(compact)) throw new Error("key_fingerprint_invalid");
  return compact;
}
function deriveKeyIdentity(fingerprint) {
  const normalized = normalizeKeyFingerprint(fingerprint);
  const bytes4 = Array.from({ length: 32 }, (_, index) => Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16));
  const symbols = [];
  for (let index = 0; index < 8; index += 1) {
    const bitOffset = index * 5;
    const window = (bytes4[bitOffset >> 3] << 8 | (bytes4[(bitOffset >> 3) + 1] ?? 0)) >> 11 - (bitOffset & 7);
    symbols.push(SHORT_CODE_ALPHABET[window & 31]);
  }
  const grid = bytes4[5] << 8 | bytes4[6];
  const cells = new Array(GRID_SIZE * GRID_SIZE).fill(false);
  for (let row = 0; row < GRID_SIZE; row += 1) {
    for (let column = 0; column < FREE_COLUMNS; column += 1) {
      const on = (grid >> 15 - (row * FREE_COLUMNS + column) & 1) === 1;
      cells[row * GRID_SIZE + column] = on;
      cells[row * GRID_SIZE + (GRID_SIZE - 1 - column)] = on;
    }
  }
  if (!cells.includes(true)) cells[2 * GRID_SIZE + 2] = true;
  return { fingerprint: normalized, shortCode: `${symbols.slice(0, 4).join("")}-${symbols.slice(4).join("")}`, hue: Math.floor(bytes4[7] * 360 / 256), cells };
}
function renderKeyIdentityText(identity) {
  const lines = [];
  for (let row = 0; row < GRID_SIZE; row += 1) {
    let line2 = "";
    for (let column = 0; column < GRID_SIZE; column += 1) line2 += identity.cells[row * GRID_SIZE + column] ? "██" : "  ";
    lines.push(line2.trimEnd());
  }
  return lines.join("\n");
}

// packages/plugin-sdk/src/kitContracts.ts
var PLUGIN_KIT_CHANNELS = Object.freeze({
  LIST: "plugin-install:kit-list",
  REVIEW: "plugin-install:kit-review",
  INSTALL: "plugin-install:kit-install",
  CANCEL: "plugin-install:kit-cancel",
  PROGRESS: "plugin-install:kit-progress"
});
var PLUGIN_KIT_ITEM_STATES = ["not_installed", "installed", "installed_older", "file_missing", "file_size_mismatch"];
var PLUGIN_KIT_STATES = ["unavailable", "not_installed", "partial", "installed"];
var PLUGIN_KIT_PROGRESS_STAGES = ["checking", "installing", "enabling", "rolling_back", "done", "failed"];
var protocolVersion8 = external_exports.literal(PLUGIN_RUNTIME_PROTOCOL_VERSION);
var kitId = external_exports.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(48);
var consentId = external_exports.string().regex(/^[0-9a-f]{32}$/);
var itemId = external_exports.string().regex(IDENTIFIER_PATTERN).max(96);
var itemKind = external_exports.enum(["plugin", "asset-pack"]);
var bytes3 = external_exports.number().int().nonnegative();
var PluginKitListRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion8 }).strict();
var PluginKitReviewRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion8, kitId }).strict();
var PluginKitDecisionRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion8, consentId }).strict();
var KitItemViewSchema = external_exports.object({
  id: itemId,
  version: external_exports.string().max(32),
  kind: itemKind,
  sizeBytes: bytes3,
  state: external_exports.enum(PLUGIN_KIT_ITEM_STATES),
  installedVersion: external_exports.string().max(32).nullable()
}).strict();
var PluginKitViewV1Schema = external_exports.object({
  kitId,
  title: external_exports.string().min(1).max(60),
  state: external_exports.enum(PLUGIN_KIT_STATES),
  totalBytes: bytes3,
  items: external_exports.array(KitItemViewSchema).max(8)
}).strict();
var PluginKitListV1Schema = external_exports.object({
  index: external_exports.enum(["ok", "missing", "invalid"]),
  kits: external_exports.array(PluginKitViewV1Schema).max(8)
}).strict();
var ConsentPluginSchema = PluginInstalledSummaryV1Schema.omit({ kind: true, fileName: true });
var PluginKitConsentV1Schema = external_exports.object({
  consentId,
  kitId,
  title: external_exports.string().min(1).max(60),
  plugins: external_exports.array(ConsentPluginSchema).max(8),
  assetPacks: external_exports.array(external_exports.object({ id: itemId, name: external_exports.string().max(96), version: external_exports.string().max(32), publisher: external_exports.string().max(48), sizeBytes: bytes3 }).strict()).max(8),
  skipped: external_exports.array(external_exports.object({ id: itemId, name: external_exports.string().max(96), kind: itemKind, reason: external_exports.literal("already_installed") }).strict()).max(8),
  riskNotices: external_exports.array(external_exports.enum(PLUGIN_RISK_NOTICES)).max(8),
  networkOrigins: external_exports.array(external_exports.string().max(200)).max(32),
  diskBytesNeeded: bytes3,
  expiresInSec: external_exports.number().int().positive()
}).strict();
var PluginKitFailureV1Schema = external_exports.object({
  code: external_exports.string().min(3).max(96),
  message: external_exports.string().min(1).max(400),
  itemId: itemId.nullable(),
  rolledBack: external_exports.boolean(),
  leftover: external_exports.array(itemId).max(8)
}).strict();
var PluginKitReviewResultV1Schema = external_exports.discriminatedUnion("status", [
  external_exports.object({ status: external_exports.literal("ready"), consent: PluginKitConsentV1Schema }).strict(),
  external_exports.object({ status: external_exports.literal("nothing_to_install"), kitId }).strict(),
  external_exports.object({ status: external_exports.literal("failed"), kitId, failure: PluginKitFailureV1Schema }).strict()
]);
var PluginKitInstallResultV1Schema = external_exports.discriminatedUnion("status", [
  external_exports.object({ status: external_exports.literal("installed"), kitId, installed: external_exports.array(itemId).max(8), skipped: external_exports.array(itemId).max(8) }).strict(),
  external_exports.object({ status: external_exports.literal("failed"), kitId, failure: PluginKitFailureV1Schema }).strict()
]);
var PluginKitProgressEventV1Schema = external_exports.object({
  kitId,
  stage: external_exports.enum(PLUGIN_KIT_PROGRESS_STAGES),
  itemId: itemId.nullable(),
  itemName: external_exports.string().max(96).nullable(),
  itemIndex: external_exports.number().int().nonnegative(),
  itemCount: external_exports.number().int().nonnegative(),
  bytesDone: bytes3,
  bytesTotal: bytes3
}).strict();
var envelope3 = (value) => external_exports.discriminatedUnion("ok", [
  external_exports.object({ protocolVersion: protocolVersion8, ok: external_exports.literal(true), value }).strict(),
  external_exports.object({ protocolVersion: protocolVersion8, ok: external_exports.literal(false), error: PluginRuntimeErrorV1Schema }).strict()
]);
var PluginKitListEnvelopeV1Schema = envelope3(PluginKitListV1Schema);
var PluginKitReviewEnvelopeV1Schema = envelope3(PluginKitReviewResultV1Schema);
var PluginKitInstallEnvelopeV1Schema = envelope3(PluginKitInstallResultV1Schema);
var PluginKitCancelEnvelopeV1Schema = envelope3(external_exports.object({ done: external_exports.literal(true) }).strict());

// packages/plugin-sdk/src/contracts/remoteSurfaceContracts.ts
var PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION = PLUGIN_RUNTIME_PROTOCOL_VERSION;
var PLUGIN_REMOTE_SURFACE_PATH = "/web/v1/plugin-surfaces";
var PLUGIN_REMOTE_SURFACE_API_FAMILIES = Object.freeze([
  "storage",
  "settings",
  "secrets",
  "assetPacks",
  "agentAvatar",
  "backend",
  "capability",
  "ai",
  "store"
]);
var PLUGIN_REMOTE_SURFACE_ERROR_CODES = Object.freeze([
  "unauthorized",
  "forbidden",
  "invalid_request",
  "not_found",
  "not_ready",
  "not_remote_visible",
  "ticket_expired",
  "ticket_invalid",
  "artifact_invalid",
  "grant_denied",
  "api_unavailable",
  "surface_closed"
]);
var PluginRemoteSurfaceByteArrayV1Schema = external_exports.array(external_exports.number().int().min(0).max(255)).max(32 * 1024);
var boundedCapabilityMessage = CapabilityMessageSchema.refine((value) => {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= 8 * 1024;
  } catch {
    return false;
  }
});
var storageUploadPath = external_exports.string().min(1).max(240).refine((value) => !value.startsWith("/") && !/[\\:\u0000-\u001f]/u.test(value) && value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".."));
var PluginRemoteSurfaceUploadTargetV1Schema = external_exports.discriminatedUnion("api", [
  external_exports.object({ api: external_exports.literal("storage"), op: external_exports.literal("write"), path: storageUploadPath, append: external_exports.boolean().optional() }).strict(),
  external_exports.object({ api: external_exports.literal("ai"), op: external_exports.literal("send"), sessionId: external_exports.string().regex(/^[0-9a-f]{32}$/), text: external_exports.string().max(8e3), mime: external_exports.enum(["image/jpeg", "image/png"]) }).strict(),
  external_exports.object({ api: external_exports.literal("capability"), op: external_exports.literal("send"), sessionId: external_exports.string().regex(/^[0-9a-f]{32}$/), message: boundedCapabilityMessage }).strict()
]);
var identifier2 = external_exports.string().regex(/^[a-z0-9][a-z0-9._-]{1,95}$/);
var surfaceId = external_exports.string().regex(/^[A-Za-z0-9_-]{32,96}$/);
var requestId2 = external_exports.string().regex(/^[A-Za-z0-9_-]{8,96}$/);
var opaquePayload = external_exports.unknown();
var PluginRemoteSurfaceRequestV1Schema = external_exports.discriminatedUnion("op", [
  external_exports.object({ protocolVersion: external_exports.literal(PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION), op: external_exports.literal("list") }).strict(),
  external_exports.object({ protocolVersion: external_exports.literal(PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION), op: external_exports.literal("open"), pluginId: identifier2, viewId: identifier2 }).strict(),
  external_exports.object({ protocolVersion: external_exports.literal(PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION), op: external_exports.literal("close"), surfaceId }).strict(),
  external_exports.object({ protocolVersion: external_exports.literal(PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION), op: external_exports.literal("poll"), surfaceId, after: external_exports.number().int().nonnegative() }).strict(),
  external_exports.object({ protocolVersion: external_exports.literal(PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION), op: external_exports.literal("upload"), surfaceId, uploadId: requestId2, purpose: external_exports.enum(["storage-write", "ai-image", "capability-send"]), target: PluginRemoteSurfaceUploadTargetV1Schema, chunkIndex: external_exports.number().int().nonnegative().max(256), bytes: PluginRemoteSurfaceByteArrayV1Schema, complete: external_exports.boolean() }).strict(),
  external_exports.object({ protocolVersion: external_exports.literal(PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION), op: external_exports.literal("call"), surfaceId, requestId: requestId2, api: external_exports.enum(PLUGIN_REMOTE_SURFACE_API_FAMILIES), payload: opaquePayload }).strict()
]).refine((value) => value.op !== "upload" || value.purpose === "storage-write" && value.target.api === "storage" || value.purpose === "ai-image" && value.target.api === "ai" || value.purpose === "capability-send" && value.target.api === "capability");
var PluginRemoteSurfaceDescriptorV1Schema = external_exports.object({
  surfaceId,
  pluginId: identifier2,
  viewId: identifier2,
  title: external_exports.string().min(1).max(48),
  artifactSha256: external_exports.string().regex(/^[0-9a-f]{64}$/),
  expiresAt: external_exports.number().int().positive(),
  src: external_exports.string().min(1).max(2048).startsWith(`${PLUGIN_REMOTE_SURFACE_PATH}/assets/`),
  handshakeNonce: external_exports.string().regex(/^[A-Za-z0-9_-]{32,96}$/)
}).strict();
var PluginRemoteSurfaceViewV1Schema = external_exports.object({ pluginId: identifier2, viewId: identifier2, title: external_exports.string().min(1).max(48) }).strict();
var success = external_exports.discriminatedUnion("op", [
  external_exports.object({ protocolVersion: external_exports.literal(PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION), ok: external_exports.literal(true), op: external_exports.literal("list"), surfaces: external_exports.array(PluginRemoteSurfaceViewV1Schema).max(96) }).strict(),
  external_exports.object({ protocolVersion: external_exports.literal(PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION), ok: external_exports.literal(true), op: external_exports.literal("open"), surface: PluginRemoteSurfaceDescriptorV1Schema }).strict(),
  external_exports.object({ protocolVersion: external_exports.literal(PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION), ok: external_exports.literal(true), op: external_exports.literal("close"), surfaceId }).strict(),
  external_exports.object({ protocolVersion: external_exports.literal(PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION), ok: external_exports.literal(true), op: external_exports.literal("poll"), surfaceId, cursor: external_exports.number().int().nonnegative(), events: external_exports.array(external_exports.object({ id: external_exports.number().int().positive(), type: external_exports.enum(["capability", "ai", "store"]), payload: external_exports.unknown() }).strict()).max(64) }).strict(),
  external_exports.object({ protocolVersion: external_exports.literal(PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION), ok: external_exports.literal(true), op: external_exports.literal("upload"), uploadId: requestId2, receivedBytes: external_exports.number().int().nonnegative(), complete: external_exports.boolean() }).strict(),
  external_exports.object({ protocolVersion: external_exports.literal(PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION), ok: external_exports.literal(true), op: external_exports.literal("call"), requestId: requestId2, result: PluginCoreEnvelopeSchema }).strict()
]);
var PluginRemoteSurfaceEnvelopeV1Schema = external_exports.union([
  success,
  external_exports.object({ protocolVersion: external_exports.literal(PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION), ok: external_exports.literal(false), error: external_exports.enum(PLUGIN_REMOTE_SURFACE_ERROR_CODES) }).strict()
]);
var PluginRemoteSurfaceFrameReadyV1Schema = external_exports.object({
  protocolVersion: external_exports.literal(PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION),
  kind: external_exports.literal("ready"),
  nonce: external_exports.string().regex(/^[A-Za-z0-9_-]{32,96}$/)
}).strict();
var PluginRemoteSurfaceFrameInitV1Schema = external_exports.object({
  protocolVersion: external_exports.literal(PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION),
  kind: external_exports.literal("init"),
  pluginId: identifier2,
  viewId: identifier2,
  artifactSha256: external_exports.string().regex(/^[0-9a-f]{64}$/),
  expiresAt: external_exports.number().int().positive(),
  nonce: external_exports.string().regex(/^[A-Za-z0-9_-]{32,96}$/)
}).strict();
var PluginRemoteSurfaceFrameCallV1Schema = external_exports.object({
  protocolVersion: external_exports.literal(PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION),
  kind: external_exports.literal("call"),
  requestId: requestId2,
  api: external_exports.enum(PLUGIN_REMOTE_SURFACE_API_FAMILIES),
  payload: opaquePayload
}).strict();
var PluginRemoteSurfaceFrameResultV1Schema = external_exports.object({
  protocolVersion: external_exports.literal(PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION),
  kind: external_exports.literal("result"),
  requestId: requestId2,
  result: PluginCoreEnvelopeSchema
}).strict();
var PluginRemoteSurfaceFrameEventV1Schema = external_exports.object({
  protocolVersion: external_exports.literal(PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION),
  kind: external_exports.literal("event"),
  id: external_exports.number().int().positive(),
  type: external_exports.enum(["capability", "ai", "store"]),
  payload: external_exports.unknown()
}).strict();
var PluginRemoteSurfaceEventV1Schema = external_exports.object({
  type: external_exports.enum(["capability", "ai", "store"]),
  payload: external_exports.unknown()
}).strict();

// packages/platform/plugin-artifact/src/errors.ts
var ArtifactError = class extends Error {
  code;
  detail;
  constructor(code, detail) {
    super(detail === void 0 ? code : `${code}: ${detail}`);
    this.name = "ArtifactError";
    this.code = code;
    this.detail = detail;
  }
};
function isArtifactError(value) {
  return value instanceof Error && value.name === "ArtifactError" && typeof value.code === "string";
}

// packages/platform/plugin-artifact/src/fsRetry.ts
import { promises as fs } from "node:fs";
var TRANSIENT_CODES = /* @__PURE__ */ new Set(["EPERM", "EBUSY", "EACCES"]);
var RENAME_RETRY_BUDGET_MS = 2e3;
var FIRST_DELAY_MS = 10;
var MAX_DELAY_MS = 250;
var REMOVE_RETRIES = 6;
var REMOVE_RETRY_DELAY_MS = 50;
function errnoOf(error) {
  const code = error !== null && typeof error === "object" ? error.code : void 0;
  return typeof code === "string" ? code : null;
}
function isTransientFsCode(code) {
  return process.platform === "win32" && code !== null && TRANSIENT_CODES.has(code);
}
async function renameWithRetry(from, to, label) {
  const started = Date.now();
  let delay = FIRST_DELAY_MS;
  for (; ; ) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = errnoOf(error);
      if (!isTransientFsCode(code)) throw new ArtifactError("fs_rename_failed", `${label}: ${code ?? "unknown"}`);
      if (Date.now() - started + delay > RENAME_RETRY_BUDGET_MS) throw new ArtifactError("fs_rename_busy", `${label}: ${code}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    }
  }
}
function removeTree(target) {
  return fs.rm(target, { recursive: true, force: true, maxRetries: REMOVE_RETRIES, retryDelay: REMOVE_RETRY_DELAY_MS });
}

// packages/platform/plugin-artifact/src/zip/entryNames.ts
var MAX_ENTRY_PATH_LENGTH = 200;
var MAX_SEGMENT_LENGTH = 100;
var RESERVED_DEVICE_NAMES = /* @__PURE__ */ new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "CONIN$",
  "CONOUT$",
  ...Array.from({ length: 10 }, (_, index) => `COM${index}`),
  ...Array.from({ length: 10 }, (_, index) => `LPT${index}`),
  "COM¹",
  "COM²",
  "COM³",
  "LPT¹",
  "LPT²",
  "LPT³"
]);
var NATIVE_LIBRARY_EXTENSIONS = /* @__PURE__ */ new Set([".node", ".dll", ".dylib", ".so"]);
var SCRIPT_OR_EXECUTABLE_EXTENSIONS = /* @__PURE__ */ new Set([
  ".exe",
  ".sh",
  ".bat",
  ".cmd",
  ".ps1",
  ".vbs",
  ".msi",
  ".jar",
  ".lnk",
  ".scr",
  ".com",
  ".pif",
  ".reg",
  ".hta",
  ".wsf"
]);
var invalid = (name, reason2) => {
  throw new ArtifactError("entry_name_invalid", `${reason2}: ${JSON.stringify(name.slice(0, 80))}`);
};
function auditEntryName(rawName) {
  const isDirectory = rawName.endsWith("/");
  const name = isDirectory ? rawName.slice(0, -1) : rawName;
  if (name.length === 0) return invalid(rawName, "empty name");
  if (/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(name)) return invalid(rawName, "control or format character");
  if (name.length > MAX_ENTRY_PATH_LENGTH) return invalid(rawName, "path too long");
  if (name.includes("\\")) return invalid(rawName, "backslash");
  if (name.startsWith("/")) return invalid(rawName, "absolute path");
  if (/^[A-Za-z]:/.test(name)) return invalid(rawName, "drive letter");
  if (name.includes(":")) return invalid(rawName, "colon (alternate data stream)");
  if (/[<>"|?*]/.test(name)) return invalid(rawName, "reserved character");
  for (const segment of name.split("/")) {
    if (segment.length === 0) return invalid(rawName, "empty segment");
    if (segment === "." || segment === "..") return invalid(rawName, "dot segment");
    if (segment.length > MAX_SEGMENT_LENGTH) return invalid(rawName, "segment too long");
    if (segment.endsWith(".") || segment.endsWith(" ")) return invalid(rawName, "trailing dot or space");
    const stem = segment.split(".")[0].trimEnd().toUpperCase();
    if (RESERVED_DEVICE_NAMES.has(stem)) return invalid(rawName, "reserved device name");
  }
  return name;
}
var baseNameOf = (name) => name.slice(name.lastIndexOf("/") + 1).toLowerCase();
function hasNativeLibraryExtension(name) {
  const base = baseNameOf(name);
  if (/\.so(?:\.[0-9]+)+$/.test(base)) return true;
  const dot = base.lastIndexOf(".");
  return dot >= 0 && NATIVE_LIBRARY_EXTENSIONS.has(base.slice(dot));
}
function hasScriptOrExecutableExtension(name) {
  const base = baseNameOf(name);
  const dot = base.lastIndexOf(".");
  return dot >= 0 && SCRIPT_OR_EXECUTABLE_EXTENSIONS.has(base.slice(dot));
}
var ACTIVE_CONTENT_EXTENSIONS = /* @__PURE__ */ new Set([".js", ".mjs", ".cjs", ".html", ".htm", ".xhtml", ".xht", ".svg", ".wasm"]);
function hasActiveContentExtension(name) {
  const base = baseNameOf(name);
  const dot = base.lastIndexOf(".");
  return dot >= 0 && ACTIVE_CONTENT_EXTENSIONS.has(base.slice(dot));
}
function hasNativeOrScriptExtension(name) {
  return hasNativeLibraryExtension(name) || hasScriptOrExecutableExtension(name);
}
function hasNativeMagic(head) {
  if (head.length >= 2 && head[0] === 77 && head[1] === 90) return true;
  if (head.length < 4) return false;
  const word = (head[0] << 24 | head[1] << 16 | head[2] << 8 | head[3]) >>> 0;
  return word === 2135247942 || word === 4277009102 || word === 4277009103 || word === 3472551422 || word === 3489328638 || word === 3405691582 || word === 3199925962;
}
var foldKey = (path12) => path12.normalize("NFKC").toUpperCase().toLowerCase();
function createNameRegistry() {
  const files = /* @__PURE__ */ new Set();
  const directories = /* @__PURE__ */ new Set();
  const explicitDirectories = /* @__PURE__ */ new Set();
  const collide = (name) => {
    throw new ArtifactError("entry_name_collision", JSON.stringify(name.slice(0, 80)));
  };
  return {
    add(name, isDirectory) {
      const key2 = foldKey(name);
      const segments = key2.split("/");
      let prefix = "";
      for (let index = 0; index < segments.length - 1; index += 1) {
        prefix = index === 0 ? segments[0] : `${prefix}/${segments[index]}`;
        if (files.has(prefix)) collide(name);
        directories.add(prefix);
      }
      if (isDirectory) {
        if (files.has(key2) || explicitDirectories.has(key2)) collide(name);
        explicitDirectories.add(key2);
        directories.add(key2);
        return;
      }
      if (files.has(key2) || directories.has(key2)) collide(name);
      files.add(key2);
    }
  };
}

// packages/platform/plugin-artifact/src/integrity.ts
var MANIFEST_FILE = "manifest.json";
var INTEGRITY_FILE = "integrity.json";
var SIGNATURE_FILE = "signature.json";
var DELEGATION_FILE = "delegation.json";
var MAX_MANIFEST_BYTES = 256 * 1024;
var MAX_INTEGRITY_BYTES = 1024 * 1024;
var MAX_SIGNATURE_BYTES = 4 * 1024;
var MAX_DELEGATION_BYTES = 8 * 1024;
var IntegrityFileSchema = external_exports.object({
  algorithm: external_exports.literal("sha256"),
  files: external_exports.array(external_exports.object({
    path: external_exports.string().min(1).max(200),
    size: external_exports.number().int().nonnegative(),
    sha256: external_exports.string().regex(/^[0-9a-f]{64}$/),
    kind: external_exports.enum(["code", "asset", "native", "payload"]),
    platform: external_exports.string().regex(/^[a-z0-9]+-[a-z0-9]+$/).nullable()
  }).strict()).max(5e3)
}).strict();
function parseIntegrity(bytes4) {
  let parsed;
  try {
    parsed = IntegrityFileSchema.parse(JSON.parse(bytes4.toString("utf8")));
  } catch {
    throw new ArtifactError("integrity_invalid", "integrity.json is not valid");
  }
  const seen = /* @__PURE__ */ new Set();
  let previous = "";
  for (const entry of parsed.files) {
    auditEntryName(entry.path);
    if (entry.path.endsWith("/")) throw new ArtifactError("integrity_invalid", `directory listed: ${entry.path}`);
    if (entry.path === SIGNATURE_FILE || entry.path === INTEGRITY_FILE || entry.path === DELEGATION_FILE) throw new ArtifactError("integrity_invalid", `${entry.path} must not be listed`);
    if (seen.has(entry.path)) throw new ArtifactError("integrity_invalid", `duplicate path: ${entry.path}`);
    if (previous !== "" && entry.path < previous) throw new ArtifactError("integrity_invalid", "files are not sorted by path");
    seen.add(entry.path);
    previous = entry.path;
  }
  if (!seen.has(MANIFEST_FILE)) throw new ArtifactError("integrity_invalid", "manifest.json is not listed");
  return parsed;
}
function assertCoverage(integrity, entries, options2 = {}) {
  const files = new Map(entries.filter((entry) => !entry.isDirectory).map((entry) => [entry.name, entry]));
  for (const required of [MANIFEST_FILE, INTEGRITY_FILE]) {
    if (!files.has(required)) throw new ArtifactError(required === MANIFEST_FILE ? "manifest_missing" : "integrity_missing");
  }
  const listed = new Map(integrity.files.map((entry) => [entry.path, entry]));
  for (const name of files.keys()) {
    if (name === INTEGRITY_FILE || name === SIGNATURE_FILE || name === DELEGATION_FILE && options2.delegationFile === "allow") continue;
    if (!listed.has(name)) throw new ArtifactError("integrity_unlisted_file", name);
  }
  for (const entry of integrity.files) {
    const archived = files.get(entry.path);
    if (archived === void 0) throw new ArtifactError("integrity_missing_file", entry.path);
    if (archived.uncompressedSize !== entry.size) throw new ArtifactError("integrity_mismatch", `${entry.path} size`);
  }
}
function assertNoNativeContent(integrity, kind = "plugin") {
  for (const entry of integrity.files) {
    if (entry.kind === "native" || hasNativeOrScriptExtension(entry.path)) throw new ArtifactError("native_content_forbidden", entry.path);
    if (kind === "asset-pack" && hasActiveContentExtension(entry.path)) throw new ArtifactError("native_content_forbidden", entry.path);
    if (kind === "plugin" && entry.kind === "payload") throw new ArtifactError("native_content_forbidden", entry.path);
    if (kind === "asset-pack" && entry.path !== MANIFEST_FILE && entry.kind !== "payload") throw new ArtifactError("integrity_invalid", `${entry.path} must be payload`);
  }
}
function auditNativeContent(integrity, manifest) {
  if (manifest.kind !== "plugin" || manifest.trustTier !== "full-trust") {
    assertNoNativeContent(integrity, manifest.kind);
    return { files: /* @__PURE__ */ new Map(), hasAddon: false };
  }
  const declared = new Map((manifest.native?.files ?? []).map((file) => [file.path, file.platform]));
  const listed = new Map(integrity.files.map((entry) => [entry.path, entry]));
  for (const entry of integrity.files) {
    if (hasScriptOrExecutableExtension(entry.path) || entry.kind === "payload") throw new ArtifactError("native_content_forbidden", entry.path);
    const library = hasNativeLibraryExtension(entry.path);
    const whitelisted = declared.has(entry.path);
    if (entry.kind !== "native" && !library && !whitelisted) continue;
    if (!whitelisted) throw new ArtifactError("native_not_whitelisted", entry.path);
    if (entry.kind !== "native" || !library) throw new ArtifactError("native_not_whitelisted", `${entry.path} must be a native library listed with kind native`);
    if (entry.platform === null || entry.platform !== declared.get(entry.path)) throw new ArtifactError("native_platform_mismatch", entry.path);
  }
  for (const path12 of declared.keys()) if (!listed.has(path12)) throw new ArtifactError("integrity_missing_file", path12);
  const hasAddon = [...declared.keys()].some((path12) => path12.toLowerCase().endsWith(".node"));
  if (hasAddon !== (manifest.native?.allowAddons === true)) throw new ArtifactError("native_addons_mismatch", hasAddon ? "a .node file needs native.allowAddons" : "native.allowAddons without a .node file");
  const backend = manifest.entry.backend;
  const backendEntry = backend === void 0 ? void 0 : listed.get(backend);
  if (backendEntry === void 0 || backendEntry.kind !== "code" || backendEntry.platform !== null) throw new ArtifactError("backend_entry_invalid", backend ?? "missing");
  return { files: declared, hasAddon };
}

// packages/platform/plugin-artifact/src/trust/signature.ts
import { createHash, createPublicKey as createPublicKey2, verify as verify2 } from "node:crypto";

// packages/platform/plugin-artifact/src/trust/delegation.ts
import { createPublicKey, verify } from "node:crypto";
var RELEASE_KEY_PREFIX = "teamuq-release-";
var MAX_DELEGATION_LIFETIME_MS = 400 * 24 * 60 * 60 * 1e3;
var DELEGATION_CLOCK_SKEW_MS = 24 * 60 * 60 * 1e3;
var DELEGATION_DOMAIN_PREFIX = Buffer.from("TeamUQ-Release-Delegation-v1\0", "utf8");
var SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
var RAW_KEY_BYTES = 32;
var SIGNATURE_BYTES = 64;
var MAX_ENTRIES = 64;
var MAX_STRING = 200;
var base64 = (max) => external_exports.string().min(1).max(max).regex(/^[A-Za-z0-9+/]+={0,2}$/);
var timestamp = external_exports.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
var identifier3 = external_exports.string().min(3).max(96).regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/);
var text = external_exports.string().min(1).max(MAX_STRING);
var list = (item) => external_exports.array(item).max(MAX_ENTRIES).default([]);
var OuterSchema = external_exports.object({
  format: external_exports.literal(1),
  issuerKeyId: external_exports.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/),
  cert: base64(8192),
  signature: base64(200)
}).strict();
var CertificateSchema = external_exports.object({
  schema: external_exports.literal(1),
  serial: external_exports.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  issuer: external_exports.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/),
  release: external_exports.object({
    keyId: external_exports.string().regex(/^teamuq-release-[a-z0-9][a-z0-9-]{0,46}$/),
    algorithm: external_exports.literal("ed25519"),
    publicKey: base64(64)
  }).strict(),
  notBefore: timestamp,
  notAfter: timestamp,
  scope: external_exports.object({
    plugins: list(external_exports.object({
      id: identifier3,
      publisher: text,
      trustTier: external_exports.enum(["sandboxed", "full-trust"]).default("sandboxed"),
      native: external_exports.enum(["none", "libraries", "addons"]).default("none"),
      permissions: list(text),
      networkAllow: list(text),
      provides: list(text),
      assetPackRefs: list(identifier3),
      assetPackPrefixes: list(text)
    }).strict()),
    assetPacks: list(identifier3)
  }).strict()
}).strict();
function delegationSigningInput(certBytes) {
  return Buffer.concat([DELEGATION_DOMAIN_PREFIX, certBytes]);
}
function isReleaseKeyId(keyId2) {
  return keyId2.startsWith(RELEASE_KEY_PREFIX);
}
function invalid2(detail) {
  throw new ArtifactError("delegation_invalid", detail);
}
function decodeBase64(value, label) {
  const bytes4 = Buffer.from(value, "base64");
  if (bytes4.toString("base64") !== value) return invalid2(`${label} is not canonical base64`);
  return bytes4;
}
function parseCanonicalJson(bytes4, label, allowTrailingNewline) {
  let source = bytes4.toString("utf8");
  if (allowTrailingNewline && source.endsWith("\n")) source = source.slice(0, -1);
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    return invalid2(`${label} is not JSON`);
  }
  if (JSON.stringify(value) !== source) return invalid2(`${label} is not in canonical compact form`);
  return value;
}
function parseTimestamp(value, label) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) + "Z" !== value) return invalid2(`${label} is not a valid UTC time`);
  return ms;
}
function assertNoDuplicates(values, label) {
  if (new Set(values).size !== values.length) invalid2(`${label} has a duplicate entry`);
}
function parseCertificate(certBytes) {
  const value = parseCanonicalJson(certBytes, "certificate", false);
  const parsed = CertificateSchema.safeParse(value);
  if (!parsed.success) return invalid2("certificate does not match the schema");
  const { scope } = parsed.data;
  assertNoDuplicates(scope.plugins.map((plugin) => plugin.id), "scope.plugins");
  assertNoDuplicates(scope.assetPacks, "scope.assetPacks");
  for (const plugin of scope.plugins) {
    for (const [label, entries] of [["permissions", plugin.permissions], ["networkAllow", plugin.networkAllow], ["provides", plugin.provides], ["assetPackRefs", plugin.assetPackRefs], ["assetPackPrefixes", plugin.assetPackPrefixes]]) assertNoDuplicates(entries, `${plugin.id}.${label}`);
  }
  return parsed.data;
}
function freezeScope(scope) {
  return Object.freeze({
    plugins: Object.freeze(scope.plugins.map((plugin) => Object.freeze({
      id: plugin.id,
      publisher: plugin.publisher,
      trustTier: plugin.trustTier,
      native: plugin.native,
      permissions: Object.freeze([...plugin.permissions]),
      networkAllow: Object.freeze([...plugin.networkAllow]),
      provides: Object.freeze([...plugin.provides]),
      assetPackRefs: Object.freeze([...plugin.assetPackRefs]),
      assetPackPrefixes: Object.freeze([...plugin.assetPackPrefixes])
    }))),
    assetPacks: Object.freeze([...scope.assetPacks])
  });
}
function rawToKey(raw) {
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki" });
}
function verifyDelegation(releaseKeyId, anchors, options2) {
  const { delegationBytes, now } = options2;
  if (typeof now !== "number" || !Number.isFinite(now)) return invalid2("now is not a finite time");
  const expiry = options2.expiry === void 0 ? "enforce" : options2.expiry;
  if (expiry !== "enforce" && expiry !== "ignore") return invalid2("expiry is neither enforce nor ignore");
  if (delegationBytes === null) throw new ArtifactError("delegation_missing", releaseKeyId);
  if (delegationBytes.length > MAX_DELEGATION_BYTES) return invalid2("delegation.json is too large");
  const outerParsed = OuterSchema.safeParse(parseCanonicalJson(delegationBytes, "delegation.json", true));
  if (!outerParsed.success) return invalid2("delegation.json does not match the schema");
  const outer = outerParsed.data;
  const certBytes = decodeBase64(outer.cert, "cert");
  const rootSignature = decodeBase64(outer.signature, "signature");
  const cert = parseCertificate(certBytes);
  const issuer = anchors.rootKeys.find((candidate) => candidate.keyId === outer.issuerKeyId);
  if (issuer === void 0) return invalid2(`issuer ${outer.issuerKeyId} is not a built-in root key`);
  if (anchors.revokedKeyIds.includes(issuer.keyId)) throw new ArtifactError("signer_revoked", issuer.keyId);
  if ((issuer.role ?? "package") !== "package") throw new ArtifactError("signer_role_mismatch", issuer.keyId);
  const issuerRaw = Buffer.from(issuer.publicKey, "base64");
  if (rootSignature.length !== SIGNATURE_BYTES || issuerRaw.length !== RAW_KEY_BYTES) return invalid2("unexpected issuer key or signature length");
  if (!verify(null, delegationSigningInput(certBytes), rawToKey(issuerRaw), rootSignature)) return invalid2("root signature does not verify");
  if (cert.issuer !== outer.issuerKeyId) return invalid2("cert.issuer differs from issuerKeyId");
  if (cert.release.keyId !== releaseKeyId) return invalid2("certificate is for another key id");
  if (anchors.rootKeys.some((candidate) => candidate.keyId === cert.release.keyId)) return invalid2("the release key id is a built-in anchor");
  const releaseRaw = decodeBase64(cert.release.publicKey, "release.publicKey");
  if (releaseRaw.length !== RAW_KEY_BYTES) return invalid2("release public key is not 32 bytes");
  try {
    rawToKey(releaseRaw);
  } catch {
    return invalid2("release public key is not a valid ed25519 key");
  }
  const notBefore = parseTimestamp(cert.notBefore, "notBefore");
  const notAfter = parseTimestamp(cert.notAfter, "notAfter");
  if (notAfter <= notBefore) return invalid2("notAfter is not after notBefore");
  if (notAfter - notBefore > MAX_DELEGATION_LIFETIME_MS) return invalid2("certificate lifetime exceeds 400 days");
  if (notBefore > now + DELEGATION_CLOCK_SKEW_MS) throw new ArtifactError("delegation_not_yet_valid", cert.notBefore);
  if (expiry === "enforce" && now > notAfter) throw new ArtifactError("delegation_expired", cert.notAfter);
  return {
    publicKey: releaseRaw,
    grant: Object.freeze({ issuer: cert.issuer, serial: cert.serial, notBefore: cert.notBefore, notAfter: cert.notAfter, scope: freezeScope(cert.scope) })
  };
}

// packages/platform/plugin-artifact/src/trust/signature.ts
var TEAMUQ_TRUST_ANCHORS = Object.freeze({
  rootKeys: Object.freeze([
    Object.freeze({ keyId: "teamuq-root-2026a", publicKey: "uw/H7oqXWeNFGbN60pr8SRWr2T1Eo8/suCokKWH3kd0=" }),
    Object.freeze({ keyId: "teamuq-root-2026b", publicKey: "WNhfR7OaRj1WuNcy2bNC2k8NLHGmjUNdxJiBR+6wk9E=" })
  ]),
  revokedKeyIds: Object.freeze([]),
  revokedArtifactSha256: Object.freeze([])
});
var DEV_KEY_PREFIX = "dev-";
var SPKI_ED25519_PREFIX2 = Buffer.from("302a300506032b6570032100", "hex");
var RAW_KEY_BYTES2 = 32;
var SIGNATURE_BYTES2 = 64;
var INTEGRITY_FIRST_BYTE = 123;
var SignatureFileSchema = external_exports.object({
  algorithm: external_exports.literal("ed25519"),
  keyId: external_exports.string().regex(/^(?:dev-[0-9a-f]{16}|[a-z0-9][a-z0-9-]{2,62})$/),
  signature: external_exports.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(200)
}).strict();
function rawKeyToObject(raw) {
  return createPublicKey2({ key: Buffer.concat([SPKI_ED25519_PREFIX2, raw]), format: "der", type: "spki" });
}
function devKeyIdOf(raw) {
  return `${DEV_KEY_PREFIX}${createHash("sha256").update(raw).digest("hex").slice(0, 16)}`;
}
var PublicKeyFileSchema = external_exports.object({
  keyId: external_exports.string().optional(),
  publicKey: external_exports.string().min(1)
}).strict();
function parsePublicKeyFile(input) {
  let json;
  try {
    json = JSON.parse(input);
  } catch {
    throw new ArtifactError("dev_key_invalid");
  }
  const file = PublicKeyFileSchema.safeParse(json);
  if (!file.success || file.data.publicKey.trim().startsWith("{")) throw new ArtifactError("dev_key_invalid");
  const raw = parsePublicKeyInput(file.data.publicKey);
  if (file.data.keyId !== void 0 && file.data.keyId !== devKeyIdOf(raw)) throw new ArtifactError("dev_key_invalid");
  return raw;
}
function parsePublicKeyInput(text2) {
  const fail = () => {
    throw new ArtifactError("dev_key_invalid");
  };
  const input = text2.trim();
  if (input.length === 0 || input.length > 4096) return fail();
  if (input.startsWith("{")) return parsePublicKeyFile(input);
  let raw;
  try {
    if (input.startsWith("-----BEGIN")) {
      const key2 = createPublicKey2(input);
      if (key2.asymmetricKeyType !== "ed25519") return fail();
      const der = key2.export({ type: "spki", format: "der" });
      raw = Buffer.from(der.subarray(der.length - RAW_KEY_BYTES2));
    } else if (/^[0-9a-fA-F]{64}$/.test(input)) {
      raw = Buffer.from(input, "hex");
    } else {
      const decoded = Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64");
      if (decoded.length === RAW_KEY_BYTES2) raw = decoded;
      else if (decoded.length === SPKI_ED25519_PREFIX2.length + RAW_KEY_BYTES2 && decoded.subarray(0, SPKI_ED25519_PREFIX2.length).equals(SPKI_ED25519_PREFIX2)) raw = decoded.subarray(SPKI_ED25519_PREFIX2.length);
      else return fail();
    }
    rawKeyToObject(raw);
  } catch {
    return fail();
  }
  return raw;
}
function parseSignatureFile(signatureBytes) {
  try {
    return SignatureFileSchema.parse(JSON.parse(signatureBytes.toString("utf8")));
  } catch {
    throw new ArtifactError("signature_invalid", "signature.json is not valid");
  }
}
async function classifyKey(parsed, anchors, lookupDevKey, delegation, integrityBytes) {
  if (anchors.revokedKeyIds.includes(parsed.keyId)) throw new ArtifactError("signer_revoked", parsed.keyId);
  if (delegation !== void 0 && integrityBytes[0] !== INTEGRITY_FIRST_BYTE) throw new ArtifactError("integrity_invalid", "integrity.json is not valid");
  if (parsed.keyId.startsWith(DEV_KEY_PREFIX)) {
    if (delegation !== void 0 && delegation.delegationBytes !== null) throw new ArtifactError("delegation_invalid", "a development-key package must not carry delegation.json");
    const found = await lookupDevKey(parsed.keyId);
    if (found.status !== "trusted") return { status: found.status };
    return { status: "known", publicKey: found.publicKey, signer: Object.freeze({ kind: "dev", keyId: parsed.keyId, label: found.label }) };
  }
  if (isReleaseKeyId(parsed.keyId)) {
    if (delegation === void 0) throw new ArtifactError("signer_unknown", parsed.keyId);
    const verified = verifyDelegation(parsed.keyId, anchors, delegation);
    return { status: "known", publicKey: verified.publicKey.toString("base64"), signer: Object.freeze({ kind: "teamuq", keyId: parsed.keyId, delegation: verified.grant }) };
  }
  const root = anchors.rootKeys.find((candidate) => candidate.keyId === parsed.keyId);
  if (root === void 0) return { status: "unknown" };
  if ((root.role ?? "package") !== "package") throw new ArtifactError("signer_role_mismatch", parsed.keyId);
  if (delegation !== void 0 && delegation.delegationBytes !== null) throw new ArtifactError("delegation_invalid", "a root-signed package must not carry delegation.json");
  return { status: "known", publicKey: root.publicKey, signer: Object.freeze({ kind: "teamuq", keyId: parsed.keyId }) };
}
function assertSignatureMatches(parsed, publicKey, integrityBytes) {
  const signature = Buffer.from(parsed.signature, "base64");
  const raw = Buffer.from(publicKey, "base64");
  if (signature.length !== SIGNATURE_BYTES2 || raw.length !== RAW_KEY_BYTES2) throw new ArtifactError("signature_invalid", "unexpected key or signature length");
  if (!verify2(null, integrityBytes, rawKeyToObject(raw), signature)) throw new ArtifactError("signature_invalid", parsed.keyId);
}
async function resolveArtifactSigner(integrityBytes, signatureBytes, anchors, lookupDevKey, delegation) {
  if (signatureBytes === null) return { signer: Object.freeze({ kind: "unsigned" }), claimedKeyId: null };
  const parsed = parseSignatureFile(signatureBytes);
  const classified = await classifyKey(parsed, anchors, lookupDevKey, delegation, integrityBytes);
  if (classified.status !== "known") return { signer: Object.freeze({ kind: "unsigned" }), claimedKeyId: parsed.keyId };
  assertSignatureMatches(parsed, classified.publicKey, integrityBytes);
  return { signer: classified.signer, claimedKeyId: parsed.keyId };
}

// packages/platform/plugin-artifact/src/trust/recordedSigner.ts
var SignerRecordSchema = external_exports.discriminatedUnion("kind", [
  external_exports.object({ kind: external_exports.literal("teamuq"), keyId: external_exports.string().min(3).max(64) }).strict(),
  external_exports.object({ kind: external_exports.literal("dev"), keyId: external_exports.string().min(3).max(64), label: external_exports.string().min(1).max(48) }).strict(),
  external_exports.object({ kind: external_exports.literal("unsigned") }).strict()
]);
var ProviderSignerRecordSchema = external_exports.union([
  external_exports.object({ kind: external_exports.enum(["teamuq", "dev"]), keyId: external_exports.string().min(3).max(64) }).strict(),
  external_exports.object({ kind: external_exports.literal("unsigned") }).strict()
]);

// packages/platform/plugin-artifact/src/install/installPersistence.ts
var InstallRecordSchema = external_exports.object({
  id: external_exports.string().min(3).max(96),
  version: external_exports.string().min(5).max(32),
  name: external_exports.string().min(1).max(96),
  publisher: external_exports.string().min(2).max(48),
  signer: SignerRecordSchema,
  manifestSha256: external_exports.string().regex(/^[0-9a-f]{64}$/),
  integritySha256: external_exports.string().regex(/^[0-9a-f]{64}$/),
  grants: external_exports.array(external_exports.string().min(3).max(64)).max(64),
  revoked: external_exports.array(external_exports.string().min(3).max(64)).max(64).default([]),
  enabled: external_exports.boolean(),
  installedAt: external_exports.string().min(1).max(40),
  dataUninstall: external_exports.enum(["keep", "delete", "ask"]),
  assetPacks: external_exports.array(external_exports.object({ id: external_exports.string().min(3).max(96), range: external_exports.string().max(32), required: external_exports.boolean() }).strict()).max(16).default([]),
  assetPackPrefixes: external_exports.array(external_exports.string().min(3).max(90)).max(4).default([]),
  trustTier: external_exports.enum(["sandboxed", "full-trust"]).default("sandboxed"),
  backend: external_exports.object({ resources: external_exports.object({ memoryMB: external_exports.number().int().positive(), cpuThreads: external_exports.number().int().positive(), maxSessions: external_exports.number().int().positive(), idleUnloadSec: external_exports.number().int().nonnegative(), bootTimeoutSec: external_exports.number().int().positive() }).strict(), allowAddons: external_exports.boolean(), nativeFiles: external_exports.array(external_exports.string().max(200)).max(64) }).strict().nullable().default(null)
}).strict();
var InstallFileSchema = external_exports.object({ version: external_exports.literal(1), plugins: external_exports.array(InstallRecordSchema).max(256) }).strict();
var LegacyRollbackEntrySchema = external_exports.object({ id: external_exports.string().min(3).max(96), pending: external_exports.string().min(5).max(32).nullable(), retained: external_exports.array(InstallRecordSchema).max(2) }).strict();
var RollbackFileSchema = external_exports.object({ version: external_exports.literal(1), updates: external_exports.array(LegacyRollbackEntrySchema).max(256) }).strict();
var RollbackEntrySchema = LegacyRollbackEntrySchema.extend({ pendingRecord: InstallRecordSchema.optional() });
var InstallSnapshotSchema = external_exports.object({ plugins: external_exports.array(InstallRecordSchema).max(256), updates: external_exports.array(RollbackEntrySchema).max(256) }).strict();

// packages/platform/plugin-artifact/src/trust/delegationScope.ts
var TIER_RANK = { sandboxed: 0, "full-trust": 1 };
var NATIVE_RANK = { none: 0, libraries: 1, addons: 2 };
function nativeLevelOf(manifest) {
  const native = manifest.native;
  if (native === void 0) return "none";
  if (native.allowAddons || native.files.some((file) => file.path.toLowerCase().endsWith(".node"))) return "addons";
  return native.files.length > 0 ? "libraries" : "none";
}
function publisherOfId(id) {
  const dot = id.indexOf(".");
  return dot <= 0 || dot === id.length - 1 ? null : id.slice(0, dot);
}
function delegationNow(now) {
  const ms = now().getTime();
  if (!Number.isFinite(ms)) throw new ArtifactError("install_failed", "the clock returned an invalid time");
  return ms;
}
function assertDelegationScope(signer, manifest) {
  if (signer.kind !== "teamuq" || signer.delegation === void 0) return;
  const { scope } = signer.delegation;
  const exceeds = (field, value) => {
    throw new ArtifactError("delegation_scope_exceeded", `${manifest.id}: ${field}${value === void 0 ? "" : ` ${value}`}`.replace(/[^ -~]/g, "?").slice(0, 200));
  };
  if (manifest.kind === "asset-pack") {
    if (!scope.assetPacks.includes(manifest.id)) return exceeds("assetPacks");
    const namespace = publisherOfId(manifest.id);
    if (namespace === null || manifest.publisher !== namespace) return exceeds("publisher", manifest.publisher);
    return;
  }
  const entry = scope.plugins.find((candidate) => candidate.id === manifest.id);
  if (entry === void 0) return exceeds("id");
  if (manifest.publisher !== entry.publisher) exceeds("publisher", manifest.publisher);
  if (TIER_RANK[manifest.trustTier] > TIER_RANK[entry.trustTier]) exceeds("trustTier", manifest.trustTier);
  const level = nativeLevelOf(manifest);
  if (NATIVE_RANK[level] > NATIVE_RANK[entry.native]) exceeds("native", level);
  for (const permission2 of manifest.permissions) if (!entry.permissions.includes(permission2)) exceeds("permissions", permission2);
  for (const origin of manifest.network.allow) if (!entry.networkAllow.includes(origin)) exceeds("networkAllow", origin);
  for (const provided of manifest.provides) if (!entry.provides.includes(provided.capability)) exceeds("provides", provided.capability);
  for (const reference of manifest.assetPacks) if (!entry.assetPackRefs.includes(reference.id)) exceeds("assetPackRefs", reference.id);
  for (const prefix of manifest.assetPackPrefixes) if (!entry.assetPackPrefixes.includes(prefix)) exceeds("assetPackPrefixes", prefix);
}

// packages/platform/plugin-artifact/src/stateFile.ts
import { randomBytes } from "node:crypto";
import { promises as fs2 } from "node:fs";
import path from "node:path";
var LOCK_RETRY_MS = 25;
var LOCK_ATTEMPTS = 200;
var LOCK_STALE_MS = 3e4;
var LOCK_RELEASE_RETRIES = 10;
var LOCK_RELEASE_RETRY_MS = 20;
async function readStateFile(file, parse2, empty) {
  let text2;
  try {
    text2 = await fs2.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return empty();
    throw new ArtifactError("store_corrupt", `${path.basename(file)} unreadable`);
  }
  try {
    return parse2(JSON.parse(text2));
  } catch {
    throw new ArtifactError("store_corrupt", `${path.basename(file)} is not valid`);
  }
}
async function acquireLock(lockPath) {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      const handle = await fs2.open(lockPath, "wx");
      await handle.close();
      return () => fs2.rm(lockPath, { force: true, maxRetries: LOCK_RELEASE_RETRIES, retryDelay: LOCK_RELEASE_RETRY_MS }).catch(() => void 0);
    } catch (error) {
      if (errnoOf(error) !== "EEXIST" && !isTransientFsCode(errnoOf(error))) throw error;
      const stat = await fs2.stat(lockPath).catch(() => null);
      if (stat !== null && Date.now() - stat.mtimeMs > LOCK_STALE_MS) await fs2.rm(lockPath, { force: true });
      else await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  throw new ArtifactError("store_busy", path.basename(lockPath));
}
async function updateStateFile(file, parse2, empty, mutate) {
  await fs2.mkdir(path.dirname(file), { recursive: true });
  const release = await acquireLock(`${file}.lock`);
  try {
    const next = mutate(await readStateFile(file, parse2, empty));
    const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const handle = await fs2.open(temporary, "w", 420);
    try {
      await handle.writeFile(`${JSON.stringify(next, null, 2)}
`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await renameWithRetry(temporary, file, path.basename(file));
    } catch (error) {
      await fs2.rm(temporary, { force: true }).catch(() => void 0);
      throw error;
    }
    return next;
  } finally {
    await release();
  }
}

// packages/platform/plugin-artifact/src/assetPacks/assetPackStore.ts
var PackRecordSchema = external_exports.object({
  id: external_exports.string().min(3).max(96),
  version: external_exports.string().min(5).max(32),
  name: external_exports.string().min(1).max(96),
  publisher: external_exports.string().min(2).max(48),
  signer: SignerRecordSchema,
  manifestSha256: external_exports.string().regex(/^[0-9a-f]{64}$/),
  integritySha256: external_exports.string().regex(/^[0-9a-f]{64}$/),
  installedAt: external_exports.string().min(1).max(40),
  totalBytes: external_exports.number().int().nonnegative(),
  fileCount: external_exports.number().int().nonnegative()
}).strict();
var PackFileSchema = external_exports.object({ version: external_exports.literal(1), packs: external_exports.array(PackRecordSchema).max(256) }).strict();
function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

// packages/platform/plugin-artifact/src/trust/devTrustPolicy.ts
var RESERVED_PREFIX = "teamuq.";
var issued = /* @__PURE__ */ new WeakSet();
function issue(scope, pluginIds) {
  if (pluginIds.length === 0 || pluginIds.some((id) => !id.startsWith(RESERVED_PREFIX))) return null;
  const ids = new Set(pluginIds);
  const policy = {
    scope,
    permitsId: (pluginId8) => ids.has(pluginId8),
    trustsInstalledSigner: async (pluginId8, signer, lookup) => scope === "isolated-dev-profile" && signer.kind === "dev" && ids.has(pluginId8) && (await lookup(signer.keyId)).status === "trusted"
  };
  issued.add(policy);
  return Object.freeze(policy);
}
function createAuthoringDevTrustPolicy(pluginId8) {
  return issue("authoring", [pluginId8]);
}
function permitsPreplantedDevId(policy, pluginId8) {
  return policy !== void 0 && issued.has(policy) && policy.permitsId(pluginId8);
}

// packages/platform/plugin-artifact/src/install/updatePolicy.ts
function assertUpdateAllowed(existing, next, devTrust) {
  const order = compareVersions(next.version, existing.version);
  if (order === 0) throw new ArtifactError("already_installed", `${existing.id}@${next.version}`);
  if (order < 0) throw new ArtifactError("downgrade_rejected", `${existing.id}@${next.version}`);
  if (existing.signer.kind === "teamuq" && next.signer.kind === "dev" && !permitsPreplantedDevId(devTrust, existing.id)) throw new ArtifactError("signer_not_allowed", existing.id);
  if (existing.signer.kind === "teamuq" && next.signer.kind === "unsigned") throw new ArtifactError("signer_not_allowed", existing.id);
  if (existing.signer.kind === "dev" && (next.signer.kind !== "dev" || next.signer.keyId !== existing.signer.keyId)) throw new ArtifactError("signer_changed", existing.id);
}

// packages/platform/plugin-artifact/src/install/installStore.ts
var InstallRecordSchema2 = external_exports.object({
  id: external_exports.string().min(3).max(96),
  version: external_exports.string().min(5).max(32),
  name: external_exports.string().min(1).max(96),
  publisher: external_exports.string().min(2).max(48),
  signer: SignerRecordSchema,
  manifestSha256: external_exports.string().regex(/^[0-9a-f]{64}$/),
  integritySha256: external_exports.string().regex(/^[0-9a-f]{64}$/),
  grants: external_exports.array(external_exports.string().min(3).max(64)).max(64),
  revoked: external_exports.array(external_exports.string().min(3).max(64)).max(64).default([]),
  enabled: external_exports.boolean(),
  installedAt: external_exports.string().min(1).max(40),
  dataUninstall: external_exports.enum(["keep", "delete", "ask"]),
  assetPacks: external_exports.array(external_exports.object({ id: external_exports.string().min(3).max(96), range: external_exports.string().max(32), required: external_exports.boolean() }).strict()).max(16).default([]),
  assetPackPrefixes: external_exports.array(external_exports.string().min(3).max(90)).max(4).default([]),
  trustTier: external_exports.enum(["sandboxed", "full-trust"]).default("sandboxed"),
  backend: external_exports.object({
    resources: external_exports.object({ memoryMB: external_exports.number().int().positive(), cpuThreads: external_exports.number().int().positive(), maxSessions: external_exports.number().int().positive(), idleUnloadSec: external_exports.number().int().nonnegative(), bootTimeoutSec: external_exports.number().int().positive() }).strict(),
    allowAddons: external_exports.boolean(),
    nativeFiles: external_exports.array(external_exports.string().max(200)).max(64)
  }).strict().nullable().default(null)
}).strict();
var RECHECK_SMALL_FILE_BYTES = 8 * 1024 * 1024;

// packages/platform/plugin-artifact/src/install/installedPresentation.ts
var EMPTY_INSTALLED_PRESENTATION = Object.freeze({ description: null, provides: Object.freeze([]), networkOrigins: Object.freeze([]), iconDataUrl: null });

// packages/platform/plugin-artifact/src/install/reviewArtifact.ts
import { createHash as createHash3, randomBytes as randomBytes2 } from "node:crypto";
import { constants as fsConstants, promises as fs4 } from "node:fs";
import path2 from "node:path";

// packages/platform/plugin-artifact/src/zip/zipReader.ts
var import_yauzl = __toESM(require_yauzl());
import { createHash as createHash2 } from "node:crypto";
import { promises as fs3 } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
var PLUGIN_ARTIFACT_LIMITS = Object.freeze({
  maxArchiveBytes: 50 * 1024 * 1024,
  maxTotalUncompressedBytes: 200 * 1024 * 1024,
  maxEntries: 5e3,
  maxRatio: 100,
  ratioFloorBytes: 4096
});
var ASSET_PACK_LIMITS = Object.freeze({
  maxArchiveBytes: 1024 * 1024 * 1024,
  maxTotalUncompressedBytes: 2 * 1024 * 1024 * 1024,
  maxEntries: 100,
  maxRatio: 100,
  ratioFloorBytes: 4096
});
var EOCD_SIGNATURE = 101010256;
var ZIP64_LOCATOR_SIGNATURE = 117853008;
var EOCD_LENGTH = 22;
var MAX_COMMENT_LENGTH = 65535;
var ZIP64_EXTRA_ID = 1;
var UNICODE_PATH_EXTRA_ID = 28789;
var ENCRYPTED_FLAGS = 1 | 64;
var TYPE_MASK = 61440;
var TYPE_REGULAR = 32768;
var TYPE_DIRECTORY = 16384;
var FORBIDDEN_UNIX_TYPES = /* @__PURE__ */ new Set([40960, 24576, 8192, 4096, 49152]);
var DOS_REPARSE_POINT = 1024;
var DOS_DIRECTORY = 16;
var LOCAL_HEADER_MIN_LENGTH = 30;
async function assertNotZip64(filePath, size) {
  const handle = await fs3.open(filePath, "r");
  try {
    const length = Math.min(size, EOCD_LENGTH + MAX_COMMENT_LENGTH + 20);
    const tail = Buffer.alloc(length);
    await handle.read(tail, 0, length, size - length);
    for (let index = tail.length - EOCD_LENGTH; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) !== EOCD_SIGNATURE) continue;
      if (index + EOCD_LENGTH + tail.readUInt16LE(index + 20) !== tail.length) continue;
      if (index >= 20 && tail.readUInt32LE(index - 20) === ZIP64_LOCATOR_SIGNATURE) throw new ArtifactError("zip64_rejected", "zip64 end of central directory locator");
      if (tail.readUInt16LE(index + 10) === 65535 || tail.readUInt32LE(index + 12) === 4294967295 || tail.readUInt32LE(index + 16) === 4294967295) throw new ArtifactError("zip64_rejected", "zip64 marker values in end of central directory");
      return;
    }
    throw new ArtifactError("zip_unreadable", "end of central directory record not found");
  } finally {
    await handle.close();
  }
}
function mapYauzlError(error) {
  if (error instanceof ArtifactError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/invalid characters in fileName|absolute path|invalid relative path/.test(message)) return new ArtifactError("entry_name_invalid", message.slice(0, 120));
  if (/too many bytes|not enough bytes|size mismatch|compressed size/.test(message)) return new ArtifactError("zip_entry_size_mismatch", message.slice(0, 120));
  if (/encrypted|strong encryption/.test(message)) return new ArtifactError("zip_entry_encrypted", message.slice(0, 120));
  if (/unsupported compression method/.test(message)) return new ArtifactError("zip_entry_method_unsupported", message.slice(0, 120));
  return new ArtifactError("zip_unreadable", message.slice(0, 120));
}
function entryKind(entry, nameIsDirectory) {
  const attributes = entry.externalFileAttributes;
  const unixType = attributes >>> 16 & TYPE_MASK;
  if (FORBIDDEN_UNIX_TYPES.has(unixType)) throw new ArtifactError("zip_entry_type_forbidden", `unix file type 0o${unixType.toString(8)}`);
  const host = entry.versionMadeBy >>> 8;
  if (host === 3 || host === 19) {
    if (unixType !== 0 && unixType !== TYPE_REGULAR && unixType !== TYPE_DIRECTORY) throw new ArtifactError("zip_entry_type_forbidden", `unix file type 0o${unixType.toString(8)}`);
    if (unixType === TYPE_DIRECTORY && !nameIsDirectory) throw new ArtifactError("zip_entry_type_forbidden", "directory mode on a file name");
    if (unixType === TYPE_REGULAR && nameIsDirectory) throw new ArtifactError("zip_entry_type_forbidden", "regular file mode on a directory name");
  } else {
    if ((attributes & DOS_REPARSE_POINT) !== 0) throw new ArtifactError("zip_entry_type_forbidden", "reparse point attribute");
    if ((attributes & DOS_DIRECTORY) !== 0 && !nameIsDirectory) throw new ArtifactError("zip_entry_type_forbidden", "directory attribute on a file name");
  }
}
function auditEntry(entry, limits) {
  const isDirectory = entry.fileName.endsWith("/");
  const name = auditEntryName(entry.fileName);
  if ((entry.generalPurposeBitFlag & ENCRYPTED_FLAGS) !== 0 || entry.isEncrypted()) throw new ArtifactError("zip_entry_encrypted", name);
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) throw new ArtifactError("zip_entry_method_unsupported", `${name} method ${entry.compressionMethod}`);
  for (const field of entry.extraFields) {
    if (field.id === UNICODE_PATH_EXTRA_ID) throw new ArtifactError("zip_entry_unicode_path_extra", name);
    if (field.id === ZIP64_EXTRA_ID) throw new ArtifactError("zip64_rejected", name);
  }
  entryKind(entry, isDirectory);
  if (isDirectory && entry.uncompressedSize !== 0) throw new ArtifactError("zip_entry_size_mismatch", `directory ${name} carries data`);
  if (entry.uncompressedSize > limits.maxTotalUncompressedBytes) throw new ArtifactError("zip_size_exceeded", name);
  if (entry.uncompressedSize >= limits.ratioFloorBytes && entry.compressedSize * limits.maxRatio < entry.uncompressedSize) throw new ArtifactError("zip_ratio_exceeded", name);
  return { name, isDirectory };
}
function assertNoOverlap(spans, archiveBytes) {
  const sorted = [...spans].sort((left, right) => left.offset - right.offset);
  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index];
    const end = current.offset + LOCAL_HEADER_MIN_LENGTH + current.compressedSize;
    const limit = index + 1 < sorted.length ? sorted[index + 1].offset : archiveBytes;
    if (end > limit) throw new ArtifactError("zip_entries_overlap", current.name);
  }
}
async function openArchive(filePath, limits = PLUGIN_ARTIFACT_LIMITS) {
  const stat = await fs3.stat(filePath).catch(() => null);
  if (stat === null || !stat.isFile()) throw new ArtifactError("file_unreadable");
  if (stat.size > limits.maxArchiveBytes) throw new ArtifactError("zip_size_exceeded", "archive");
  await assertNotZip64(filePath, stat.size);
  let zip;
  try {
    zip = await (0, import_yauzl.openPromise)(filePath, { lazyEntries: true, strictFileNames: true, decodeStrings: true, validateEntrySizes: true, autoClose: false });
  } catch (error) {
    throw mapYauzlError(error);
  }
  try {
    if (zip.entryCount > limits.maxEntries) throw new ArtifactError("zip_entry_count_exceeded", String(zip.entryCount));
    const registry = createNameRegistry();
    const entries = [];
    const yauzlEntries = /* @__PURE__ */ new Map();
    const spans = [];
    let declaredTotal = 0;
    for await (const entry of zip.eachEntry()) {
      const { name, isDirectory } = auditEntry(entry, limits);
      registry.add(name, isDirectory);
      declaredTotal += entry.uncompressedSize;
      if (declaredTotal > limits.maxTotalUncompressedBytes) throw new ArtifactError("zip_size_exceeded", "declared total");
      if (entry.relativeOffsetOfLocalHeader >= stat.size) throw new ArtifactError("zip_unreadable", `${name} offset beyond archive`);
      spans.push({ offset: entry.relativeOffsetOfLocalHeader, compressedSize: entry.compressedSize, name });
      entries.push({ name, isDirectory, compressedSize: entry.compressedSize, uncompressedSize: entry.uncompressedSize });
      if (!isDirectory) yauzlEntries.set(name, entry);
    }
    if (declaredTotal >= limits.ratioFloorBytes && declaredTotal > stat.size * limits.maxRatio) throw new ArtifactError("zip_ratio_exceeded", "archive");
    assertNoOverlap(spans, stat.size);
    const open = async (name) => {
      const entry = yauzlEntries.get(name);
      if (entry === void 0) throw new ArtifactError("integrity_missing_file", name);
      try {
        return { entry, stream: await zip.openReadStreamPromise(entry) };
      } catch (error) {
        throw mapYauzlError(error);
      }
    };
    return {
      entries,
      close: () => zip.close(),
      readSmall: async (name, maxBytes) => {
        const { entry, stream } = await open(name);
        if (entry.uncompressedSize > maxBytes) {
          stream.destroy();
          throw new ArtifactError("zip_size_exceeded", name);
        }
        const chunks = [];
        let size = 0;
        try {
          for await (const chunk of stream) {
            const buffer = chunk;
            size += buffer.length;
            if (size > maxBytes) throw new ArtifactError("zip_size_exceeded", name);
            chunks.push(buffer);
          }
        } catch (error) {
          throw mapYauzlError(error);
        }
        return Buffer.concat(chunks);
      },
      readHead: async (name, count2) => {
        const { stream } = await open(name);
        const chunks = [];
        let size = 0;
        try {
          for await (const chunk of stream) {
            chunks.push(chunk);
            size += chunk.length;
            if (size >= count2) break;
          }
        } catch (error) {
          throw mapYauzlError(error);
        } finally {
          stream.destroy();
        }
        return Buffer.concat(chunks).subarray(0, count2);
      },
      extractTo: async (name, destination, budget) => {
        const handle = await fs3.open(destination, "wx", 420);
        const { entry, stream } = await open(name).catch(async (error) => {
          await handle.close();
          await fs3.rm(destination, { force: true });
          throw error;
        });
        const hash = createHash2("sha256");
        let size = 0;
        let head = Buffer.alloc(0);
        const meter = new Transform({
          transform(chunk, _encoding, callback) {
            size += chunk.length;
            budget.remaining -= chunk.length;
            if (size > entry.uncompressedSize) return callback(new ArtifactError("zip_entry_size_mismatch", name));
            if (budget.remaining < 0) return callback(new ArtifactError("zip_extract_budget_exceeded", name));
            hash.update(chunk);
            if (head.length < 8) head = Buffer.concat([head, chunk.subarray(0, 8 - head.length)]);
            callback(null, chunk);
          }
        });
        try {
          await pipeline(stream, meter, handle.createWriteStream());
        } catch (error) {
          await fs3.rm(destination, { force: true }).catch(() => void 0);
          throw mapYauzlError(error);
        }
        if (size !== entry.uncompressedSize) {
          await fs3.rm(destination, { force: true }).catch(() => void 0);
          throw new ArtifactError("zip_entry_size_mismatch", name);
        }
        return { sha256: hash.digest("hex"), size, head };
      }
    };
  } catch (error) {
    zip.close();
    throw mapYauzlError(error);
  }
}

// packages/platform/plugin-artifact/src/install/reviewArtifact.ts
var PLUGIN_FILE_EXTENSION = ".tuqplugin";
var ADOPTABLE_FOLDER = ["store", "downloads"];
var sha256 = (bytes4) => createHash3("sha256").update(bytes4).digest("hex");
function parseManifest(bytes4) {
  try {
    return PluginManifestV2Schema.parse(JSON.parse(bytes4.toString("utf8")));
  } catch (error) {
    const issue2 = error.issues?.[0];
    throw new ArtifactError("manifest_invalid", issue2 === void 0 ? "manifest.json is not valid JSON" : `${issue2.path.join(".")}: ${issue2.message}`);
  }
}
function assertSignerMayInstall(manifest, signer, devTrust) {
  if (manifest.id === CORE_CALLER_ID) throw new ArtifactError("id_reserved", manifest.id);
  const reservedId = manifest.id.startsWith("teamuq.");
  if (signer.kind === "dev") {
    if ((reservedId || manifest.publisher === "teamuq") && !permitsPreplantedDevId(devTrust, manifest.id)) throw new ArtifactError("id_reserved", manifest.id);
  } else if (signer.kind === "unsigned") {
    if (reservedId || manifest.publisher === "teamuq") throw new ArtifactError("id_reserved", manifest.id);
  } else if (!reservedId && manifest.publisher === "teamuq") {
    throw new ArtifactError("id_reserved", manifest.id);
  }
}
async function assertDelegatedIdNotReserved(signer, manifest, isReservedId) {
  if (signer.kind !== "teamuq" || signer.delegation === void 0 || manifest.kind !== "plugin") return;
  if (isReservedId === void 0) throw new ArtifactError("install_failed", "no reserved id check was given");
  let reserved;
  try {
    reserved = await isReservedId(manifest.id);
  } catch {
    reserved = true;
  }
  if (reserved) throw new ArtifactError("id_reserved", manifest.id);
}
async function assertUnsignedIdNotOfficial(signer, manifest, isOfficialId) {
  if (signer.kind !== "unsigned" || isOfficialId === void 0) return;
  let official;
  try {
    official = await isOfficialId(manifest.id);
  } catch {
    official = true;
  }
  if (official) throw new ArtifactError("id_reserved", manifest.id);
}
function assertSupported(manifest, context) {
  const issues = evaluateManifestSupport(manifest, context);
  if (issues.length === 0) return;
  const primary = issues.find((issue2) => issue2.code === "unsupported_in_this_core") ?? issues[0];
  throw new ArtifactError(primary.code, issues.map((issue2) => `${issue2.field}: ${issue2.message}`).join("; ").slice(0, 300));
}
function referencedPaths(manifest) {
  return [
    ...manifest.entry.ui === void 0 ? [] : [manifest.entry.ui],
    ...manifest.entry.backend === void 0 ? [] : [manifest.entry.backend],
    ...manifest.icon === void 0 ? [] : [manifest.icon],
    ...manifest.contributes.views.flatMap((view) => [view.entry, ...view.icon === void 0 ? [] : [view.icon]])
  ];
}
async function assertIconIsPng(payloadDir, icon, listed) {
  if (listed === void 0 || listed.platform !== null || listed.size > PLUGIN_ICON_MAX_BYTES) throw new ArtifactError("icon_invalid", icon);
  const bytes4 = await fs4.readFile(path2.join(payloadDir, ...icon.split("/"))).catch(() => null);
  if (bytes4 === null || !isPngIcon(bytes4)) throw new ArtifactError("icon_invalid", icon);
}
function peekKind(bytes4) {
  try {
    return JSON.parse(bytes4.toString("utf8")).kind === "asset-pack" ? "asset-pack" : "plugin";
  } catch {
    return "plugin";
  }
}
async function readDelegation(archive) {
  if (!archive.entries.some((entry) => !entry.isDirectory && entry.name === DELEGATION_FILE)) return null;
  return archive.readSmall(DELEGATION_FILE, MAX_DELEGATION_BYTES).catch((error) => {
    throw isArtifactError(error) && error.code === "zip_size_exceeded" ? new ArtifactError("delegation_invalid", "delegation.json is too large") : error;
  });
}
function enforceLimits(entries, archiveBytes, limits) {
  if (archiveBytes > limits.maxArchiveBytes) throw new ArtifactError("zip_size_exceeded", "archive");
  if (entries.length > limits.maxEntries) throw new ArtifactError("zip_entry_count_exceeded", String(entries.length));
  const declared = entries.reduce((total, entry) => total + entry.uncompressedSize, 0);
  if (declared > limits.maxTotalUncompressedBytes) throw new ArtifactError("zip_size_exceeded", "declared total");
}
async function defaultFreeBytes(directory) {
  const stats = await fs4.statfs(directory);
  return Number(stats.bavail) * Number(stats.bsize);
}
async function reviewArtifact(sourcePath, options2) {
  const pluginLimits = options2.limits ?? PLUGIN_ARTIFACT_LIMITS;
  const packLimits = options2.assetPackLimits ?? ASSET_PACK_LIMITS;
  const limits = {
    maxArchiveBytes: Math.max(pluginLimits.maxArchiveBytes, packLimits.maxArchiveBytes),
    maxTotalUncompressedBytes: Math.max(pluginLimits.maxTotalUncompressedBytes, packLimits.maxTotalUncompressedBytes),
    maxEntries: Math.max(pluginLimits.maxEntries, packLimits.maxEntries),
    maxRatio: Math.max(pluginLimits.maxRatio, packLimits.maxRatio),
    ratioFloorBytes: Math.min(pluginLimits.ratioFloorBytes, packLimits.ratioFloorBytes)
  };
  if (path2.extname(sourcePath).toLowerCase() !== PLUGIN_FILE_EXTENSION) throw new ArtifactError("extension_not_allowed", path2.extname(sourcePath));
  const source = await fs4.stat(sourcePath).catch(() => null);
  if (source === null || !source.isFile()) throw new ArtifactError("file_unreadable");
  if (source.size > limits.maxArchiveBytes) throw new ArtifactError("zip_size_exceeded", "archive");
  const txId = randomBytes2(12).toString("hex");
  const stagingDir = path2.join(options2.pluginsRoot, "staging", txId);
  const payloadDir = path2.join(stagingDir, "payload");
  const copyPath = path2.join(stagingDir, `package${PLUGIN_FILE_EXTENSION}`);
  const discard = () => removeTree(stagingDir);
  let archive = null;
  try {
    await fs4.mkdir(payloadDir, { recursive: true });
    if (options2.adoptSource === true) {
      const downloads = path2.resolve(options2.pluginsRoot, ...ADOPTABLE_FOLDER);
      if (path2.dirname(path2.resolve(sourcePath)) !== downloads) throw new ArtifactError("file_unreadable", "adopted source is outside the downloads folder");
      await renameWithRetry(sourcePath, copyPath, "adopted download");
    } else await fs4.copyFile(sourcePath, copyPath, fsConstants.COPYFILE_EXCL);
    archive = await openArchive(copyPath, limits);
    const peeked = peekKind(await archive.readSmall(MANIFEST_FILE, MAX_MANIFEST_BYTES).catch(() => Buffer.alloc(0)));
    const active = peeked === "asset-pack" ? packLimits : pluginLimits;
    enforceLimits(archive.entries, source.size, active);
    const declaredTotal = archive.entries.reduce((total, entry) => total + entry.uncompressedSize, 0);
    if (peeked === "asset-pack") {
      const free = await (options2.freeBytes ?? defaultFreeBytes)(options2.pluginsRoot);
      const needed = options2.adoptSource === true ? declaredTotal : declaredTotal * 2;
      if (free < needed) throw new ArtifactError("disk_space_insufficient", `${needed} bytes needed`);
    }
    const signatureBytes = archive.entries.some((entry) => !entry.isDirectory && entry.name === SIGNATURE_FILE) ? await archive.readSmall(SIGNATURE_FILE, MAX_SIGNATURE_BYTES) : null;
    const integrityBytes = await archive.readSmall(INTEGRITY_FILE, MAX_INTEGRITY_BYTES).catch((error) => {
      throw isArtifactError(error) && error.code === "integrity_missing_file" ? new ArtifactError("integrity_missing") : error;
    });
    const accepting = options2.delegation === "accept";
    const delegationBytes = accepting ? await readDelegation(archive) : null;
    const { signer, claimedKeyId } = await resolveArtifactSigner(integrityBytes, signatureBytes, options2.anchors, options2.devKeys.lookup, accepting ? { delegationBytes, now: delegationNow(options2.now ?? (() => /* @__PURE__ */ new Date())), expiry: "enforce" } : void 0);
    if (signer.kind === "unsigned" && delegationBytes !== null) throw new ArtifactError("delegation_invalid", "an unsigned package must not carry delegation.json");
    if (options2.refuseUnverifiedKey === true && signer.kind === "unsigned" && claimedKeyId !== null) throw new ArtifactError("signer_unknown", claimedKeyId);
    const integrityHash = sha256(integrityBytes);
    if ((options2.anchors.revokedArtifactSha256 ?? []).includes(integrityHash) || (options2.revokedArtifacts ?? []).includes(integrityHash)) throw new ArtifactError("artifact_revoked", integrityHash);
    const integrity = parseIntegrity(integrityBytes);
    assertCoverage(integrity, archive.entries, { delegationFile: accepting ? "allow" : "refuse" });
    const manifestBytes = await archive.readSmall(MANIFEST_FILE, MAX_MANIFEST_BYTES);
    const listedManifest = integrity.files.find((entry) => entry.path === MANIFEST_FILE);
    if (listedManifest === void 0 || listedManifest.sha256 !== sha256(manifestBytes)) throw new ArtifactError("integrity_mismatch", MANIFEST_FILE);
    const manifest = parseManifest(manifestBytes);
    assertSignerMayInstall(manifest, signer, options2.devTrust);
    await assertUnsignedIdNotOfficial(signer, manifest, options2.isOfficialId);
    assertDelegationScope(signer, manifest);
    await assertDelegatedIdNotReserved(signer, manifest, options2.isReservedId);
    if (manifest.kind !== peeked) throw new ArtifactError("manifest_invalid", "kind changed between reads");
    const existing = await options2.findInstalled(manifest.id, manifest.kind);
    if (manifest.kind === "plugin" && options2.updateFrom !== void 0) {
      if (options2.updateFrom.id !== manifest.id) throw new ArtifactError("manifest_invalid", "update target id differs from the package");
      if (existing === null) throw new ArtifactError("not_installed", manifest.id);
      if (existing.version !== options2.updateFrom.version) throw new ArtifactError("install_failed", "installed version differs from the update base");
      assertUpdateAllowed(existing, { version: manifest.version, signer }, options2.devTrust);
    } else if (existing !== null && manifest.kind === "plugin") throw new ArtifactError(existing.signer.kind === "teamuq" && signer.kind === "dev" ? "signer_not_allowed" : "already_installed", manifest.id);
    if (existing !== null && manifest.kind === "asset-pack") {
      const order = compareVersions(manifest.version, existing.version);
      if (order === 0) throw new ArtifactError("already_installed", `${manifest.id}@${manifest.version}`);
      if (order < 0) throw new ArtifactError("downgrade_rejected", `${manifest.id}@${manifest.version}`);
      if (existing.signer.kind === "teamuq" && signer.kind === "dev") throw new ArtifactError("signer_not_allowed", manifest.id);
      if (existing.signer.kind !== "unsigned" && signer.kind === "unsigned") throw new ArtifactError("signer_not_allowed", manifest.id);
    }
    assertSupported(manifest, options2.support);
    const whitelist = auditNativeContent(integrity, manifest);
    const listed = new Set(integrity.files.map((entry) => entry.path));
    for (const reference of referencedPaths(manifest)) if (!listed.has(reference)) throw new ArtifactError("integrity_missing_file", reference);
    const budget = { remaining: active.maxTotalUncompressedBytes };
    for (const entry of integrity.files) {
      const whitelisted = whitelist.files.has(entry.path);
      if (entry.platform !== null && entry.platform !== options2.support.platform.id) {
        if (hasNativeMagic(await archive.readHead(entry.path, 8)) !== whitelisted) throw new ArtifactError("native_content_forbidden", entry.path);
        continue;
      }
      const destination = path2.resolve(payloadDir, ...entry.path.split("/"));
      if (!destination.startsWith(`${payloadDir}${path2.sep}`)) throw new ArtifactError("entry_name_invalid", entry.path);
      await fs4.mkdir(path2.dirname(destination), { recursive: true });
      const extracted = await archive.extractTo(entry.path, destination, budget);
      if (extracted.sha256 !== entry.sha256 || extracted.size !== entry.size) throw new ArtifactError("integrity_mismatch", entry.path);
      if (hasNativeMagic(extracted.head) !== whitelisted) throw new ArtifactError("native_content_forbidden", entry.path);
    }
    if (manifest.icon !== void 0) await assertIconIsPng(payloadDir, manifest.icon, integrity.files.find((entry) => entry.path === manifest.icon));
    await fs4.writeFile(path2.join(payloadDir, INTEGRITY_FILE), integrityBytes, { flag: "wx", mode: 420 });
    if (signer.kind !== "unsigned" && signatureBytes !== null) await fs4.writeFile(path2.join(payloadDir, SIGNATURE_FILE), signatureBytes, { flag: "wx", mode: 420 });
    if (delegationBytes !== null) await fs4.writeFile(path2.join(payloadDir, DELEGATION_FILE), delegationBytes, { flag: "wx", mode: 420 });
    archive.close();
    archive = null;
    await fs4.rm(copyPath, { force: true });
    return { txId, stagingDir, payloadDir, manifest, manifestSha256: listedManifest.sha256, integritySha256: integrityHash, signer, claimedKeyId, totalBytes: declaredTotal, fileCount: integrity.files.length, discard };
  } catch (error) {
    archive?.close();
    await discard().catch(() => void 0);
    throw isArtifactError(error) ? error : new ArtifactError("install_failed", error instanceof Error ? error.message.slice(0, 120) : "unknown");
  }
}

// packages/platform/plugin-artifact/src/trust/devKeyStore.ts
import { createHash as createHash4 } from "node:crypto";
import os from "node:os";
import path3 from "node:path";
var DevKeyRecordSchema = external_exports.object({
  keyId: external_exports.string().regex(/^dev-[0-9a-f]{16}$/),
  publicKey: external_exports.string().min(1).max(64),
  label: external_exports.string().min(1).max(48),
  importedAt: external_exports.string().min(1).max(40),
  machine: external_exports.string().regex(/^[0-9a-f]{64}$/)
}).strict();
var DevKeyFileSchema = external_exports.object({
  version: external_exports.literal(1),
  keys: external_exports.array(DevKeyRecordSchema).max(32)
}).strict();
function fingerprintOf(raw) {
  return createHash4("sha256").update(raw).digest("hex");
}
function defaultMachineId() {
  const user = (() => {
    try {
      return os.userInfo().username;
    } catch {
      return "";
    }
  })();
  return createHash4("sha256").update(["teamuq-dev-key-v1", os.hostname(), user, os.platform(), os.arch(), os.homedir()].join("\0")).digest("hex");
}
function createDevKeyStore(options2) {
  const file = path3.join(options2.pluginsRoot, "trust", "dev-keys.json");
  const machineId = options2.machineId ?? defaultMachineId;
  const now = options2.now ?? (() => /* @__PURE__ */ new Date());
  const parse2 = (raw) => DevKeyFileSchema.parse(raw);
  const empty = () => ({ version: 1, keys: [] });
  const withKeys = (keys) => ({ version: 1, keys });
  const view = (record) => ({
    keyId: record.keyId,
    fingerprint: fingerprintOf(Buffer.from(record.publicKey, "base64")),
    label: record.label,
    importedAt: record.importedAt,
    trustedHere: record.machine === machineId()
  });
  return {
    inspect: (text2) => {
      if (/PRIVATE KEY|privatePkcs8/i.test(text2)) throw new ArtifactError("dev_key_private");
      const raw = parsePublicKeyInput(text2);
      return { keyId: devKeyIdOf(raw), fingerprint: fingerprintOf(raw), publicKey: raw.toString("base64") };
    },
    list: async () => (await readStateFile(file, parse2, empty)).keys.map(view),
    add: async (input) => {
      const label = input.label.trim();
      if (label.length === 0 || label.length > 48) throw new ArtifactError("dev_key_invalid", "label");
      const raw = parsePublicKeyInput(input.publicKey);
      const keyId2 = devKeyIdOf(raw);
      const record = { keyId: keyId2, publicKey: raw.toString("base64"), label, importedAt: now().toISOString(), machine: machineId() };
      await updateStateFile(file, parse2, empty, (current) => {
        const existing = current.keys.find((candidate) => candidate.keyId === keyId2);
        if (existing !== void 0 && existing.machine === record.machine) throw new ArtifactError("dev_key_duplicate", keyId2);
        return withKeys([...current.keys.filter((candidate) => candidate.keyId !== keyId2), record]);
      });
      return view(record);
    },
    remove: async (keyId2) => {
      await updateStateFile(file, parse2, empty, (current) => {
        if (!current.keys.some((candidate) => candidate.keyId === keyId2)) throw new ArtifactError("dev_key_unknown", keyId2);
        return withKeys(current.keys.filter((candidate) => candidate.keyId !== keyId2));
      });
    },
    lookup: async (keyId2) => {
      const found = (await readStateFile(file, parse2, empty)).keys.find((candidate) => candidate.keyId === keyId2);
      if (found === void 0) return { status: "unknown" };
      if (found.machine !== machineId()) return { status: "foreign" };
      return { status: "trusted", publicKey: found.publicKey, label: found.label };
    }
  };
}

// packages/platform/plugin-artifact/src/data/pluginCoreState.ts
var SettingsFileSchema = external_exports.object({ version: external_exports.literal(1), values: external_exports.record(external_exports.string(), external_exports.unknown()) }).strict();
var SecretsFileSchema = external_exports.object({ version: external_exports.literal(1), entries: external_exports.record(external_exports.string(), external_exports.string().max(PLUGIN_CORE_LIMITS.secretBytes * 4)) }).strict();
var SecretEnvelopeSchema = external_exports.object({ v: external_exports.literal(1), pluginId: external_exports.string(), name: external_exports.string(), value: external_exports.string() }).strict();

// packages/platform/plugin-artifact/src/capabilities/capabilityState.ts
var ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
var CAPABILITY = /^[a-z0-9]+(?:[.-][a-z0-9]+)*@[1-9][0-9]*$/;
var ConsentSchema = external_exports.object({
  consumerId: external_exports.string().regex(ID).max(96),
  capability: external_exports.string().regex(CAPABILITY).max(96),
  providerId: external_exports.string().regex(ID).max(96),
  providerVersion: external_exports.string().min(5).max(32),
  providerSigner: ProviderSignerRecordSchema,
  providerIntegritySha256: external_exports.string().regex(/^[0-9a-f]{64}$/),
  grantedAt: external_exports.string().min(1).max(40)
}).strict();
var StateFileSchema = external_exports.object({
  version: external_exports.literal(1),
  consents: external_exports.array(ConsentSchema).max(512),
  preferences: external_exports.record(external_exports.string().regex(CAPABILITY).max(96), external_exports.string().regex(ID).max(96))
}).strict();

// packages/platform/plugin-artifact/src/bundled/bundledLedger.ts
var ID2 = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
var SHA256 = /^[0-9a-f]{64}$/;
var Id = external_exports.string().regex(ID2).max(96);
var Sha256 = external_exports.string().regex(SHA256);
var Time = external_exports.string().min(1).max(40);
var Version = external_exports.string().min(5).max(32);
var Code = external_exports.string().min(1).max(64);
var OfferedSchema = external_exports.object({ version: Version, artifactSha256: Sha256 }).strict();
var ConsentSchema2 = external_exports.object({
  version: Version,
  integritySha256: Sha256,
  riskNotices: external_exports.array(Code).max(32),
  grants: external_exports.array(external_exports.string().min(1).max(96)).max(64),
  at: Time
}).strict();
var PendingUpdateSchema = external_exports.object({ version: Version, artifactSha256: Sha256, loosened: external_exports.array(Code).max(32), at: Time }).strict();
var LastFailureSchema = external_exports.object({ code: Code, artifactSha256: Sha256, coreVersion: external_exports.string().min(1).max(32) }).strict();
var BUNDLED_STATUSES = ["awaiting_consent", "consented", "declined", "removed"];
var StatusSchema = external_exports.enum(BUNDLED_STATUSES);
var EntrySchema = external_exports.object({
  id: Id,
  name: external_exports.string().min(1).max(128),
  status: StatusSchema,
  offered: OfferedSchema,
  installedArtifactSha256: Sha256.nullable(),
  plantedAt: Time,
  decidedAt: Time.nullable(),
  consent: ConsentSchema2.nullable(),
  pendingUpdate: PendingUpdateSchema.nullable(),
  lastFailure: LastFailureSchema.nullable()
}).strict().superRefine((entry, context) => {
  const problem = (message) => context.addIssue({ code: "custom", message });
  if (entry.status === "consented" !== (entry.consent !== null)) problem("consent iff consented");
  if (entry.status === "removed" !== (entry.installedArtifactSha256 === null)) problem("installedArtifactSha256 null iff removed");
  if (entry.status === "awaiting_consent" !== (entry.decidedAt === null)) problem("decidedAt null iff awaiting_consent");
  if (entry.pendingUpdate !== null && entry.status !== "consented") problem("pendingUpdate only when consented");
});
var LedgerFileSchema = external_exports.object({
  version: external_exports.literal(1),
  entries: external_exports.array(EntrySchema).max(64),
  failures: external_exports.record(Id, LastFailureSchema)
}).strict().superRefine((file, context) => {
  if (new Set(file.entries.map((entry) => entry.id)).size !== file.entries.length) context.addIssue({ code: "custom", message: "duplicate id" });
  if (Object.keys(file.failures).length > 64) context.addIssue({ code: "custom", message: "too many failures" });
});

// packages/platform/plugin-artifact/src/authoring/packArtifact.ts
import { createHash as createHash6, randomBytes as randomBytes3 } from "node:crypto";
import { promises as fs7 } from "node:fs";
import path6 from "node:path";

// packages/platform/plugin-artifact/src/authoring/signing.ts
import { createPrivateKey, createPublicKey as createPublicKey3, sign, verify as verify3 } from "node:crypto";
var KEY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,62}$/;
var SPKI_ED25519_PREFIX_BYTES = 12;
function loadPrivateKey(key2) {
  let loaded;
  if ("pem" in key2) {
    try {
      loaded = createPrivateKey({ key: key2.pem, format: "pem", ...key2.passphrase === void 0 ? {} : { passphrase: key2.passphrase } });
    } catch {
      throw new ArtifactError("signature_invalid", "private key is unreadable (wrong passphrase or not a PEM private key)");
    }
  } else {
    loaded = key2;
  }
  if (loaded.type !== "private" || loaded.asymmetricKeyType !== "ed25519") throw new ArtifactError("signature_invalid", "signing key must be an ed25519 private key");
  return loaded;
}
function signIntegrity(integrityBytes, signer) {
  const privateKey = loadPrivateKey(signer.key);
  const publicKey = createPublicKey3(privateKey);
  if (signer.keyId.startsWith(DEV_KEY_PREFIX)) {
    const der = publicKey.export({ type: "spki", format: "der" });
    if (devKeyIdOf(Buffer.from(der.subarray(SPKI_ED25519_PREFIX_BYTES))) !== signer.keyId) throw new ArtifactError("signature_invalid", "a dev- keyId must be the one derived from the public key");
  } else if (!KEY_ID_PATTERN.test(signer.keyId)) {
    throw new ArtifactError("signature_invalid", "keyId does not match the signature.json rule");
  }
  const signature = sign(null, integrityBytes, privateKey);
  if (!verify3(null, integrityBytes, publicKey, signature)) throw new ArtifactError("signature_invalid", "signature does not verify against the key it was made with");
  return Buffer.from(JSON.stringify({ algorithm: "ed25519", keyId: signer.keyId, signature: signature.toString("base64") }));
}

// packages/platform/plugin-artifact/src/authoring/stageFiles.ts
import { createHash as createHash5 } from "node:crypto";
import { promises as fs5 } from "node:fs";
import path4 from "node:path";

// packages/platform/plugin-artifact/src/authoring/zipWriter.ts
import { crc32, deflateRawSync } from "node:zlib";
var LOCAL_HEADER_SIGNATURE = 67324752;
var CENTRAL_HEADER_SIGNATURE = 33639248;
var END_SIGNATURE = 101010256;
var VERSION_NEEDED = 20;
var VERSION_MADE_BY = 3 << 8 | 30;
var UTF8_NAME_FLAG = 2048;
var DOS_TIME_MIDNIGHT = 0;
var DOS_DATE_1980_01_01 = 33;
var METHOD_STORED = 0;
var METHOD_DEFLATE = 8;
var UNIX_REGULAR_FILE_0644 = 33188 << 16 >>> 0;
var DEFLATE_LEVEL = 9;
var ZIP32_LIMIT = 4294967295;
var ZIP32_MAX_ENTRIES = 65534;
var compareEntryNames = (left, right) => left < right ? -1 : left > right ? 1 : 0;
var u16 = (value) => {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
};
var u32 = (value) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
};
function writeZip(entries) {
  if (entries.length > ZIP32_MAX_ENTRIES) throw new ArtifactError("zip_entry_count_exceeded", String(entries.length));
  const registry = createNameRegistry();
  for (const entry of entries) {
    if (entry.name.endsWith("/")) throw new ArtifactError("entry_name_invalid", "directory entries are not written");
    registry.add(auditEntryName(entry.name), false);
  }
  const ordered = [...entries].sort((left, right) => compareEntryNames(left.name, right.name));
  const chunks = [];
  const central = [];
  let offset = 0;
  const push = (buffer) => {
    chunks.push(buffer);
    offset += buffer.length;
  };
  for (const entry of ordered) {
    const name = Buffer.from(entry.name, "utf8");
    const deflated = deflateRawSync(entry.data, { level: DEFLATE_LEVEL });
    const stored = deflated.length >= entry.data.length;
    const method2 = stored ? METHOD_STORED : METHOD_DEFLATE;
    const payload = stored ? entry.data : deflated;
    if (payload.length >= ZIP32_LIMIT || entry.data.length >= ZIP32_LIMIT || offset >= ZIP32_LIMIT) throw new ArtifactError("zip_size_exceeded", entry.name);
    const crc = crc32(entry.data);
    central.push(Buffer.concat([
      u32(CENTRAL_HEADER_SIGNATURE),
      u16(VERSION_MADE_BY),
      u16(VERSION_NEEDED),
      u16(UTF8_NAME_FLAG),
      u16(method2),
      u16(DOS_TIME_MIDNIGHT),
      u16(DOS_DATE_1980_01_01),
      u32(crc),
      u32(payload.length),
      u32(entry.data.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(UNIX_REGULAR_FILE_0644),
      u32(offset),
      name
    ]));
    push(Buffer.concat([
      u32(LOCAL_HEADER_SIGNATURE),
      u16(VERSION_NEEDED),
      u16(UTF8_NAME_FLAG),
      u16(method2),
      u16(DOS_TIME_MIDNIGHT),
      u16(DOS_DATE_1980_01_01),
      u32(crc),
      u32(payload.length),
      u32(entry.data.length),
      u16(name.length),
      u16(0),
      name
    ]));
    push(payload);
  }
  const centralBytes = Buffer.concat(central);
  const centralOffset = offset;
  if (centralOffset + centralBytes.length >= ZIP32_LIMIT) throw new ArtifactError("zip_size_exceeded", "archive");
  push(centralBytes);
  push(Buffer.concat([u32(END_SIGNATURE), u16(0), u16(0), u16(ordered.length), u16(ordered.length), u32(centralBytes.length), u32(centralOffset), u16(0)]));
  return Buffer.concat(chunks);
}

// packages/platform/plugin-artifact/src/authoring/stageFiles.ts
var CODE_EXTENSIONS = /* @__PURE__ */ new Set([".mjs", ".js", ".cjs"]);
var PLATFORM_PATTERN = /^[a-z0-9]+-[a-z0-9]+$/;
var MAX_FILES = 5e3;
async function walk(root, relative, found) {
  const directory = relative === "" ? root : path4.join(root, ...relative.split("/"));
  const children = (await fs5.readdir(directory, { withFileTypes: true })).sort((left, right) => compareEntryNames(left.name, right.name));
  for (const child of children) {
    const childPath = relative === "" ? child.name : `${relative}/${child.name}`;
    if (child.isDirectory()) await walk(root, childPath, found);
    else if (child.isFile()) found.push(childPath);
    else throw new ArtifactError("zip_entry_type_forbidden", `${childPath} is not a regular file`);
    if (found.length > MAX_FILES) throw new ArtifactError("zip_entry_count_exceeded", `more than ${MAX_FILES} files`);
  }
}
function peekManifestKind(bytes4) {
  try {
    const parsed = JSON.parse(bytes4.toString("utf8"));
    return typeof parsed === "object" && parsed !== null && parsed.kind === "asset-pack" ? "asset-pack" : "plugin";
  } catch {
    throw new ArtifactError("manifest_invalid", "manifest.json is not valid JSON");
  }
}
function indexOverrides(overrides) {
  const indexed = /* @__PURE__ */ new Map();
  for (const override of overrides) {
    if (indexed.has(override.path)) throw new ArtifactError("integrity_invalid", `duplicate override: ${override.path}`);
    if (override.path === MANIFEST_FILE) throw new ArtifactError("integrity_invalid", "manifest.json kind is fixed");
    if (override.platform !== void 0 && !PLATFORM_PATTERN.test(override.platform)) throw new ArtifactError("integrity_invalid", `platform id: ${override.platform}`);
    if (override.kind === "native" && override.platform === void 0) throw new ArtifactError("integrity_invalid", `native file needs a platform: ${override.path}`);
    indexed.set(override.path, override);
  }
  return indexed;
}
async function collectStage(stageDir, overrides) {
  const stat = await fs5.stat(stageDir).catch(() => null);
  if (stat === null || !stat.isDirectory()) throw new ArtifactError("file_unreadable", "stage directory");
  const relatives = [];
  await walk(stageDir, "", relatives);
  const registry = createNameRegistry();
  for (const name of relatives) registry.add(auditEntryName(name), false);
  if (!relatives.includes(MANIFEST_FILE)) throw new ArtifactError("manifest_missing");
  for (const generated of [INTEGRITY_FILE, SIGNATURE_FILE, DELEGATION_FILE]) if (relatives.includes(generated)) throw new ArtifactError("integrity_invalid", `${generated} is generated and must not be in the stage directory`);
  const indexed = indexOverrides(overrides);
  for (const override of indexed.values()) if (!relatives.includes(override.path)) throw new ArtifactError("integrity_missing_file", `override for a file that is not staged: ${override.path}`);
  const files = [];
  let packKind = "plugin";
  for (const relative of [...relatives].sort(compareEntryNames)) {
    const data = await fs5.readFile(path4.join(stageDir, ...relative.split("/")));
    if (relative === MANIFEST_FILE) packKind = peekManifestKind(data);
    files.push({ path: relative, data, entry: { path: relative, size: data.length, sha256: createHash5("sha256").update(data).digest("hex"), kind: "code", platform: null } });
  }
  return files.map((file) => {
    if (file.path === MANIFEST_FILE) return file;
    const override = indexed.get(file.path);
    const kind = override?.kind ?? (packKind === "asset-pack" ? "payload" : CODE_EXTENSIONS.has(path4.posix.extname(file.path).toLowerCase()) ? "code" : "asset");
    return { ...file, entry: { ...file.entry, kind, platform: override?.platform ?? null } };
  });
}

// packages/platform/plugin-artifact/src/authoring/verifyArtifactFile.ts
import { promises as fs6 } from "node:fs";
import os2 from "node:os";
import path5 from "node:path";
var WORK_PREFIX = "teamuq-authoring-";
async function withWorkDir(workDir, run) {
  const directory = await fs6.mkdtemp(path5.join(workDir ?? os2.tmpdir(), WORK_PREFIX));
  try {
    return await run(directory);
  } finally {
    await fs6.rm(directory, { recursive: true, force: true });
  }
}
async function verifyArtifactFile(filePath, options2) {
  return withWorkDir(options2.workDir, async (directory) => {
    const pluginsRoot = path5.join(directory, "plugins");
    await fs6.mkdir(pluginsRoot, { recursive: true });
    const staged = await reviewArtifact(filePath, {
      pluginsRoot,
      anchors: options2.anchors,
      devKeys: options2.devKeys ?? createDevKeyStore({ pluginsRoot }),
      support: options2.support,
      ...options2.devTrust === void 0 ? {} : { devTrust: options2.devTrust },
      findInstalled: async () => null,
      refuseUnverifiedKey: true,
      ...options2.limits === void 0 ? {} : { limits: options2.limits },
      ...options2.delegation === void 0 ? {} : { delegation: options2.delegation },
      ...options2.now === void 0 ? {} : { now: options2.now },
      ...options2.isReservedId === void 0 ? {} : { isReservedId: options2.isReservedId },
      ...options2.isOfficialId === void 0 ? {} : { isOfficialId: options2.isOfficialId }
    });
    return {
      manifest: staged.manifest,
      signer: staged.signer,
      manifestSha256: staged.manifestSha256,
      integritySha256: staged.integritySha256,
      totalBytes: staged.totalBytes,
      fileCount: staged.fileCount
    };
  });
}

// packages/platform/plugin-artifact/src/authoring/packArtifact.ts
async function packArtifact(options2) {
  if (path6.extname(options2.outFile).toLowerCase() !== PLUGIN_FILE_EXTENSION) throw new ArtifactError("extension_not_allowed", path6.extname(options2.outFile));
  if (options2.delegation !== void 0 && (options2.delegation.length === 0 || options2.delegation.length > MAX_DELEGATION_BYTES)) throw new ArtifactError("delegation_invalid", "delegation.json is empty or too large");
  if (options2.signer === null && options2.delegation !== void 0) throw new ArtifactError("delegation_invalid", "an unsigned package must not carry delegation.json");
  const staged = await collectStage(options2.stageDir, options2.files ?? []);
  const integrityBytes = Buffer.from(JSON.stringify({ algorithm: "sha256", files: staged.map((file) => file.entry) }, null, 2));
  const signature = options2.signer === null ? [] : [{ name: SIGNATURE_FILE, data: signIntegrity(integrityBytes, options2.signer) }];
  const container = writeZip([
    ...staged.map((file) => ({ name: file.path, data: file.data })),
    { name: INTEGRITY_FILE, data: integrityBytes },
    ...signature,
    ...options2.delegation === void 0 ? [] : [{ name: DELEGATION_FILE, data: options2.delegation }]
  ]);
  const verified = await withWorkDir(options2.review.workDir, async (directory) => {
    const candidate = path6.join(directory, `candidate${PLUGIN_FILE_EXTENSION}`);
    await fs7.writeFile(candidate, container);
    return verifyArtifactFile(candidate, { ...options2.review, workDir: directory, ...options2.delegation === void 0 ? {} : { delegation: "accept" } });
  });
  const destination = path6.resolve(options2.outFile);
  await fs7.mkdir(path6.dirname(destination), { recursive: true });
  const partial = `${destination}.${randomBytes3(6).toString("hex")}.partial`;
  try {
    await fs7.writeFile(partial, container, { flag: "wx" });
    await fs7.rename(partial, destination);
  } catch (error) {
    await fs7.rm(partial, { force: true }).catch(() => void 0);
    throw new ArtifactError("install_failed", error instanceof Error ? error.message.slice(0, 120) : "write failed");
  }
  return { file: destination, size: container.length, sha256: createHash6("sha256").update(container).digest("hex"), verified };
}

// packages/platform/plugin-artifact/src/trust/detachedSignature.ts
var DOMAIN_PREFIX = Object.freeze({
  "store-index": Buffer.from("TeamUQ-Store-Index-v1\0", "utf8"),
  "store-withdrawn": Buffer.from("TeamUQ-Store-Withdrawn-v1\0", "utf8")
});
var MAX_DETACHED_SIGNATURE_BYTES = 4 * 1024;
var DetachedSignatureFileSchema = external_exports.object({
  algorithm: external_exports.literal("ed25519"),
  keyId: external_exports.string().regex(/^(?:dev-[0-9a-f]{16}|[a-z0-9][a-z0-9-]{2,62})$/),
  signature: external_exports.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(200)
}).strict();

// .teamuq/scripts/plugin-tools/keyTools.mjs
import { createHash as createHash7, createPrivateKey as createPrivateKey2, createPublicKey as createPublicKey4, generateKeyPairSync, randomBytes as randomBytes4, sign as sign2, verify as verify4 } from "node:crypto";
import fs8 from "node:fs";
import path7 from "node:path";
var KEY_ID_PATTERN2 = /^[a-z0-9][a-z0-9-]{2,62}$/;
var PASSPHRASE_ENV_FOR_TESTS = "TEAMUQ_KEY_PASSPHRASE_FOR_TESTS";
var MIN_PASSPHRASE_LENGTH = 16;
var ENCRYPTED_PEM_HEADER = ["-----BEGIN", "ENCRYPTED", "PRIVATE KEY-----"].join(" ");
var SPKI_ED25519_PREFIX3 = Buffer.from("302a300506032b6570032100", "hex");
var RAW_KEY_BYTES3 = 32;
var MAX_KEY_FILE_BYTES = 16 * 1024;
function assertReleaseKeyId(keyId2) {
  if (typeof keyId2 !== "string" || !KEY_ID_PATTERN2.test(keyId2)) throw new Error(`keyId must match ${KEY_ID_PATTERN2}`);
  if (keyId2.startsWith("dev-")) throw new Error('keyId must not start with "dev-": that prefix is reserved for local development keys');
}
var RELEASE_KEY_PREFIX2 = "teamuq-release-";
var RELEASE_KEY_ID_PATTERN = /^teamuq-release-[a-z0-9][a-z0-9-]{0,46}$/;
function assertDelegatedKeyId(keyId2) {
  if (typeof keyId2 !== "string" || !RELEASE_KEY_ID_PATTERN.test(keyId2)) throw new Error(`a release keyId must match ${RELEASE_KEY_ID_PATTERN}`);
}
function assertNoPassphraseEnv(command) {
  const injected = process.env[PASSPHRASE_ENV_FOR_TESTS];
  if (injected !== void 0 && injected !== "") throw new Error(`${command} never takes a passphrase from the environment: unset ${PASSPHRASE_ENV_FOR_TESTS} and type the passphrase at the prompt`);
}
function devKeyIdOf2(raw) {
  if (!Buffer.isBuffer(raw) || raw.length !== RAW_KEY_BYTES3) throw new Error("public key must be 32 raw bytes");
  return `dev-${createHash7("sha256").update(raw).digest("hex").slice(0, 16)}`;
}
function assertDevKeyId(keyId2, raw) {
  const expected = devKeyIdOf2(raw);
  if (keyId2 !== expected) throw new Error(`development keyId mismatch: expected ${expected}`);
  return expected;
}
function generateEncryptedDevKeyPair(passphrase) {
  const pair = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase },
    publicKeyEncoding: { type: "spki", format: "der" }
  });
  const raw = Buffer.from(pair.publicKey.subarray(pair.publicKey.length - RAW_KEY_BYTES3));
  return { privatePem: pair.privateKey, raw, keyId: devKeyIdOf2(raw) };
}
function findGitWorkTree(target) {
  let current = path7.resolve(target);
  while (!fs8.existsSync(current)) {
    const parent = path7.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  current = fs8.realpathSync(current);
  for (; ; ) {
    if (fs8.existsSync(path7.join(current, ".git"))) return current;
    const parent = path7.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
function assertOutsideGitWorkTree(target, label) {
  const workTree = findGitWorkTree(target);
  if (workTree !== null) throw new Error(`${label} ${path7.resolve(target)} is inside the git work tree ${workTree}; keep signing keys outside any repository`);
}
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    let value = "";
    process.stderr.write(question);
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const finish = (settle, result) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      process.stderr.write("\n");
      settle(result);
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n" || character === "") return finish(resolve, value);
        if (character === "") return finish(reject, new Error("cancelled"));
        if (character === "" || character === "\b") value = value.slice(0, -1);
        else value += character;
      }
    };
    input.on("data", onData);
  });
}
function canPrompt() {
  return process.stdin.isTTY === true && process.stderr.isTTY === true;
}
async function readPassphrase(question) {
  const injected = process.env[PASSPHRASE_ENV_FOR_TESTS];
  if (injected !== void 0 && injected !== "") return injected;
  if (!canPrompt()) throw new Error("an interactive terminal is required to type the passphrase (it is never accepted on the command line)");
  return promptHidden(question);
}
async function readNewPassphrase() {
  const first = await readPassphrase(`New passphrase (at least ${MIN_PASSPHRASE_LENGTH} characters): `);
  if (first.length < MIN_PASSPHRASE_LENGTH) throw new Error(`passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  if (process.env[PASSPHRASE_ENV_FOR_TESTS] === void 0 || process.env[PASSPHRASE_ENV_FOR_TESTS] === "") {
    const again = await readPassphrase("Repeat passphrase: ");
    if (again !== first) throw new Error("passphrases do not match");
  }
  return first;
}
async function readInteractivePassphrase(question) {
  assertNoPassphraseEnv("this command");
  if (!canPrompt()) throw new Error("an interactive terminal is required to type the passphrase (it is never accepted on the command line or from the environment)");
  return promptHidden(question);
}
async function readNewInteractivePassphrase() {
  const first = await readInteractivePassphrase(`New passphrase (at least ${MIN_PASSPHRASE_LENGTH} characters): `);
  if (first.length < MIN_PASSPHRASE_LENGTH) throw new Error(`passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  const again = await readInteractivePassphrase("Repeat passphrase: ");
  if (again !== first) throw new Error("passphrases do not match");
  return first;
}
function writeEncryptedKeyFiles({ keyId: keyId2, directory, passphrase }) {
  if (typeof passphrase !== "string" || passphrase.length < MIN_PASSPHRASE_LENGTH) throw new Error(`passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  const keyFile = path7.join(directory, `${keyId2}.key.pem`);
  const publicFile = path7.join(directory, `${keyId2}.pub.json`);
  if (fs8.existsSync(keyFile) || fs8.existsSync(publicFile)) throw new Error(`${keyId2} already exists in ${directory}; refusing to overwrite a key`);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const description = describePublicKey(publicKey);
  const pem = privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase });
  fs8.mkdirSync(directory, { recursive: true, mode: 448 });
  const written = [];
  try {
    fs8.writeFileSync(keyFile, pem, { flag: "wx", mode: 384 });
    written.push(keyFile);
    fs8.writeFileSync(publicFile, `${JSON.stringify({ keyId: keyId2, publicKey: description.publicKey }, null, 2)}
`, { flag: "wx" });
    written.push(publicFile);
    const reloaded = loadEncryptedPrivateKey(fs8.readFileSync(keyFile, "utf8"), passphrase);
    const stored = JSON.parse(fs8.readFileSync(publicFile, "utf8"));
    selfCheck(reloaded, Buffer.from(stored.publicKey, "base64"));
    let wrongPassphraseRejected = false;
    try {
      createPrivateKey2({ key: pem, format: "pem", passphrase: `${passphrase}x` });
    } catch {
      wrongPassphraseRejected = true;
    }
    if (!wrongPassphraseRejected) throw new Error("the stored private key opened with a wrong passphrase; the file was not encrypted");
  } catch (error) {
    for (const file of written) fs8.rmSync(file, { force: true });
    throw error;
  }
  return { keyId: keyId2, keyFile, publicFile, ...description };
}
function rawToPublicKey(raw) {
  if (!Buffer.isBuffer(raw) || raw.length !== RAW_KEY_BYTES3) throw new Error("public key must be 32 raw bytes");
  return createPublicKey4({ key: Buffer.concat([SPKI_ED25519_PREFIX3, raw]), format: "der", type: "spki" });
}
function describePublicKey(publicKey) {
  const der = publicKey.export({ type: "spki", format: "der" });
  const raw = Buffer.from(der.subarray(der.length - RAW_KEY_BYTES3));
  return {
    raw,
    publicKey: raw.toString("base64"),
    spki: Buffer.from(der).toString("base64"),
    fingerprint: `sha256:${createHash7("sha256").update(raw).digest("hex")}`
  };
}
function readKeyFile(file) {
  const stat = fs8.statSync(file);
  if (!stat.isFile() || stat.size > MAX_KEY_FILE_BYTES) throw new Error(`${file} is not a key file`);
  return fs8.readFileSync(file, "utf8");
}
function loadEncryptedPrivateKey(pem, passphrase) {
  if (!pem.includes(ENCRYPTED_PEM_HEADER)) throw new Error("the key file is not an encrypted PKCS8 PEM; unencrypted signing keys are refused");
  let key2;
  try {
    key2 = createPrivateKey2({ key: pem, format: "pem", passphrase });
  } catch {
    throw new Error("the private key could not be decrypted (wrong passphrase or damaged file)");
  }
  if (key2.type !== "private" || key2.asymmetricKeyType !== "ed25519") throw new Error("the key must be an Ed25519 private key");
  return key2;
}
function selfCheck(privateKey, raw) {
  const message = randomBytes4(32);
  const signature = sign2(null, message, privateKey);
  if (signature.length !== 64) throw new Error("unexpected signature length");
  if (!verify4(null, message, rawToPublicKey(raw), signature)) throw new Error("the signature made by the private key does not verify with the public key");
  if (verify4(null, randomBytes4(32), rawToPublicKey(raw), signature)) throw new Error("signature verified against a different message");
}

// .teamuq/scripts/plugin-tools/releaseUnlock.mjs
import { randomBytes as randomBytes5 } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs9 from "node:fs";
import path8 from "node:path";
var UNLOCK_FILE_SUFFIX = ".unlock.dpapi";
var UNLOCK_SCHEME = "windows-dpapi-current-user";
var UNLOCK_ENTROPY_PREFIX = "TeamUQ-Release-Unlock-v1\0";
var MAX_UNLOCK_FILE_BYTES = 4 * 1024;
var POWERSHELL_TIMEOUT_MS = 3e4;
var BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;
var SYNCED_FOLDER_HINTS = Object.freeze(["onedrive", "dropbox", "google drive", "googledrive", "共用雲端硬碟", "icloud", "box sync"]);
var UnlockRefused = class extends Error {
};
function unlockFileName(keyId2) {
  return `${keyId2}${UNLOCK_FILE_SUFFIX}`;
}
function assertUnlockAllowedFor(keyId2) {
  if (typeof keyId2 !== "string" || !RELEASE_KEY_ID_PATTERN.test(keyId2)) {
    throw new UnlockRefused(`a non-interactive unlock source is only for release keys (${RELEASE_KEY_ID_PATTERN}); ${typeof keyId2 === "string" ? keyId2 : "this key"} is refused: root keys are typed at the prompt, always`);
  }
}
function assertNotSyncedFolder(target, label) {
  const lowered = path8.resolve(target).toLowerCase();
  const hint = SYNCED_FOLDER_HINTS.find((name) => lowered.includes(name));
  if (hint !== void 0) throw new UnlockRefused(`${label} ${path8.resolve(target)} looks like a synced or cloud folder ("${hint}"); keep release key material on the local disk only`);
}
function assertWindows() {
  if (process.platform !== "win32") throw new UnlockRefused("Windows DPAPI unlock exists only on Windows (the release signing machine); there is no other non-interactive unlock source");
}
var PROTECT_SCRIPT = [
  "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'",
  "Add-Type -AssemblyName System.Security",
  "$in=[Console]::In.ReadToEnd()|ConvertFrom-Json",
  "$p=[System.Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String($in.data),[Convert]::FromBase64String($in.entropy),[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Convert]::ToBase64String($p))"
].join(";");
var UNPROTECT_SCRIPT = [
  "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'",
  "Add-Type -AssemblyName System.Security",
  "$in=[Console]::In.ReadToEnd()|ConvertFrom-Json",
  "$b=[System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($in.data),[Convert]::FromBase64String($in.entropy),[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Convert]::ToBase64String($b))"
].join(";");
function powershellPath() {
  const root = process.env.SystemRoot ?? "C:\\Windows";
  return path8.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
function runPowerShell(script, payload) {
  const child = spawnSync(powershellPath(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: POWERSHELL_TIMEOUT_MS,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  if (child.error !== void 0 || child.status !== 0) throw new UnlockRefused("Windows DPAPI (PowerShell) could not complete; check that PowerShell is available and not in a restricted language mode, and that this blob was made by this Windows user on this computer");
  return child.stdout.trim();
}
function entropyFor(keyId2) {
  return Buffer.from(`${UNLOCK_ENTROPY_PREFIX}${keyId2}`, "utf8").toString("base64");
}
function dpapiProtect(keyId2, secret) {
  assertUnlockAllowedFor(keyId2);
  assertWindows();
  const blob = runPowerShell(PROTECT_SCRIPT, { entropy: entropyFor(keyId2), data: Buffer.from(secret, "utf8").toString("base64") });
  if (!BASE64.test(blob)) throw new UnlockRefused("DPAPI returned something that is not a protected blob");
  return blob;
}
function unlockEnvelope(keyId2, blob) {
  return `${JSON.stringify({ format: 1, scheme: UNLOCK_SCHEME, keyId: keyId2, protected: blob }, null, 2)}
`;
}
function readUnlockEnvelope(file, keyId2) {
  const stat = fs9.statSync(file);
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_UNLOCK_FILE_BYTES) throw new UnlockRefused(`${file} is not an unlock file`);
  let parsed;
  try {
    parsed = JSON.parse(fs9.readFileSync(file, "utf8"));
  } catch {
    throw new UnlockRefused(`${file} is not an unlock file (not JSON)`);
  }
  const keys = parsed !== null && typeof parsed === "object" ? Object.keys(parsed).sort().join(",") : "";
  if (keys !== "format,keyId,protected,scheme" || parsed.format !== 1 || parsed.scheme !== UNLOCK_SCHEME || typeof parsed.keyId !== "string" || typeof parsed.protected !== "string" || !BASE64.test(parsed.protected)) throw new UnlockRefused(`${file} is not an unlock file for this tool`);
  if (parsed.keyId !== keyId2) throw new UnlockRefused(`${file} belongs to ${parsed.keyId}, not to ${keyId2}`);
  return parsed.protected;
}
function readDpapiPassphrase(file, keyId2) {
  assertUnlockAllowedFor(keyId2);
  assertWindows();
  const blob = readUnlockEnvelope(file, keyId2);
  const raw = runPowerShell(UNPROTECT_SCRIPT, { entropy: entropyFor(keyId2), data: blob });
  if (!BASE64.test(raw)) throw new UnlockRefused("DPAPI returned something that is not a passphrase");
  return Buffer.from(raw, "base64").toString("utf8");
}
function initReleaseKey({ keyId: keyId2, directory }) {
  assertDelegatedKeyId(keyId2);
  assertWindows();
  const target = path8.resolve(directory);
  assertOutsideGitWorkTree(target, "release key directory");
  assertNotSyncedFolder(target, "release key directory");
  const unlockFile = path8.join(target, unlockFileName(keyId2));
  if (fs9.existsSync(unlockFile)) throw new UnlockRefused(`${unlockFile} already exists; refusing to overwrite`);
  const passphrase = randomBytes5(33).toString("base64url");
  const blob = dpapiProtect(keyId2, passphrase);
  const written = writeEncryptedKeyFiles({ keyId: keyId2, directory: target, passphrase });
  try {
    fs9.writeFileSync(unlockFile, unlockEnvelope(keyId2, blob), { flag: "wx" });
    if (readDpapiPassphrase(unlockFile, keyId2) !== passphrase) throw new Error("the DPAPI blob did not return the passphrase it was given");
    const key2 = loadEncryptedPrivateKey(readKeyFile(written.keyFile), readDpapiPassphrase(unlockFile, keyId2));
    selfCheck(key2, written.raw);
  } catch (error) {
    for (const file of [written.keyFile, written.publicFile, unlockFile]) fs9.rmSync(file, { force: true });
    throw error;
  }
  return { keyId: keyId2, keyFile: written.keyFile, publicFile: written.publicFile, unlockFile, publicKey: written.publicKey, fingerprint: written.fingerprint };
}
var OFFICIAL_KEY_ID = /^teamuq-/u;
async function obtainSigningPassphrase({ keyId: keyId2, question, unlockFile, injected }) {
  if (unlockFile !== void 0) return { passphrase: readDpapiPassphrase(unlockFile, keyId2), source: "dpapi" };
  if (injected !== void 0) return { passphrase: await injected(question), source: "injected" };
  const fromEnv = process.env[PASSPHRASE_ENV_FOR_TESTS];
  if (fromEnv !== void 0 && fromEnv !== "" && OFFICIAL_KEY_ID.test(keyId2)) {
    const hint = RELEASE_KEY_ID_PATTERN.test(keyId2) ? "a release key is unlocked from its DPAPI file (--unlock-dpapi) or at the prompt" : "a root key (any teamuq-* key) is unlocked only by typing the passphrase at the prompt";
    throw new UnlockRefused(`${keyId2} never takes its passphrase from the environment (${PASSPHRASE_ENV_FOR_TESTS} is set): ${hint}`);
  }
  const passphrase = await readPassphrase(question);
  return { passphrase, source: fromEnv !== void 0 && fromEnv !== "" ? "env" : "interactive" };
}

// .teamuq/scripts/plugin-tools/delegationTools.mjs
import { createHash as createHash8, createPublicKey as createPublicKey5, sign as sign3, verify as verify5 } from "node:crypto";
import fs10 from "node:fs";
import path9 from "node:path";
import { isDeepStrictEqual } from "node:util";
var DELEGATION_DOMAIN_PREFIX2 = Buffer.from("TeamUQ-Release-Delegation-v1\0", "utf8");
var MAX_DELEGATION_BYTES2 = 8 * 1024;
var MAX_LIFETIME_DAYS = 400;
var DEFAULT_LIFETIME_DAYS = 180;
var MAX_ENTRIES2 = 64;
var MAX_STRING2 = 200;
var DAY_MS = 24 * 60 * 60 * 1e3;
var CLOCK_SKEW_MS = DAY_MS;
var MAX_SMALL_FILE_BYTES = 64 * 1024;
var MAX_NOT_BEFORE_AHEAD_DAYS = 30;
var PUBLISHER_MIN = 2;
var PUBLISHER_MAX = 48;
var MAX_SERIAL_DIGITS = 16;
var BUILT_IN_RESERVED_IDS = Object.freeze(["core", "teamuq.core", "teamuq.memory"]);
var isDevkitReservedId = (id) => BUILT_IN_RESERVED_IDS.includes(id);
var IDENTIFIER = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
var PERMISSION = /^[a-z0-9]+(?:-[a-z0-9]+)*(?::[a-z0-9]+(?:-[a-z0-9]+)*)+$/;
var CAPABILITY2 = /^[a-z0-9]+(?:[.-][a-z0-9]+)*@[1-9][0-9]*$/;
var ASSET_PREFIX = /^[a-z0-9]+(?:[.-][a-z0-9]+)*-$/;
var TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
var TIERS = Object.freeze(["sandboxed", "full-trust"]);
var NATIVE_LEVELS = Object.freeze(["none", "libraries", "addons"]);
var PLUGIN_KEYS = Object.freeze(["id", "publisher", "trustTier", "native", "permissions", "networkAllow", "provides", "assetPackRefs", "assetPackPrefixes"]);
var DELEGATION_USAGE = [
  "  release-keygen --key-id teamuq-release-<name> --out-dir <directory outside git work trees>  (makes an encrypted release signing key; the passphrase is typed at the prompt)",
  "  delegate --root-key <file> --release-pub <file.pub.json> --scope <scope.json> --bundled-index <bundled-plugins.json> (--previous <delegation.json> | --first) --out <delegation.json> [--days n] [--serial n] [--not-before YYYY-MM-DDTHH:MM:SSZ] [--root-key-id id] [--anchors core|self] [--root-pub-file file.pub.json]  (ROOT key signs a delegation certificate; every check runs before the passphrase prompt; --bundled-index is resources/bundled-plugins/bundled-plugins.json of the TeamUQ checkout and has no default, so the pre-installed id check cannot silently turn off)",
  "  delegation-inspect <delegation.json> [--anchors core|self] [--root-pub-file file.pub.json] [--at YYYY-MM-DDTHH:MM:SSZ]  (verifies the signature and prints the scope and validity in plain words)"
].join("\n");
var UsageProblem = class extends Error {
};
var SCREEN_CONTROL_RANGES = Object.freeze([[0, 31], [127, 159], [173, 173], [1564, 1564], [6158, 6158], [8203, 8207], [8232, 8238], [8288, 8303], [65279, 65279], [65529, 65531]]);
var isScreenControl = (code) => SCREEN_CONTROL_RANGES.some(([low, high]) => code >= low && code <= high);
function neutralize(text2, keep = "") {
  return Array.from(String(text2), (character) => {
    const code = character.codePointAt(0);
    return keep.includes(character) || !isScreenControl(code) ? character : `\\u${code.toString(16).padStart(4, "0")}`;
  }).join("");
}
function asciiOnly(text2) {
  return Array.from(String(text2), (character) => {
    const code = character.codePointAt(0);
    if (code >= 32 && code <= 126) return character;
    return code > 65535 ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, "0")}`;
  }).join("");
}
function screen(text2) {
  return neutralize(text2, "\n");
}
function parseFlags(argv, allowed, booleanFlags = []) {
  const positional = [];
  const flags = /* @__PURE__ */ new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    if (/pass/iu.test(token)) throw new UsageProblem("the passphrase is never accepted on the command line");
    if (!allowed.includes(token)) throw new UsageProblem(`unknown option ${token}`);
    if (flags.has(token)) throw new UsageProblem(`${token} was given twice`);
    if (booleanFlags.includes(token)) {
      flags.set(token, "true");
      continue;
    }
    const value = argv[index + 1];
    if (value === void 0 || value.startsWith("--")) throw new UsageProblem(`${token} needs a value`);
    flags.set(token, value);
    index += 1;
  }
  return { positional, flags };
}
function sinks(deps) {
  return {
    out: deps.stdout ?? ((text2) => process.stdout.write(text2)),
    err: deps.stderr ?? ((text2) => process.stderr.write(text2))
  };
}
async function guarded(label, deps, body) {
  const { err } = sinks(deps);
  try {
    return await body();
  } catch (error) {
    if (error instanceof UsageProblem) {
      err(screen(`usage: ${label}: ${error.message}
${DELEGATION_USAGE}
`));
      return 2;
    }
    err(screen(`${label}: ${error instanceof Error ? error.message : String(error)}
`));
    return 1;
  }
}
function formatUtc(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/u, "Z");
}
function parseUtc(value, label) {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) throw new UsageProblem(`${label} must look like 2026-10-15T00:00:00Z (UTC, whole seconds)`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || formatUtc(ms) !== value) throw new UsageProblem(`${label} is not a real UTC time`);
  return ms;
}
function wholeSecond(ms) {
  return Math.floor(ms / 1e3) * 1e3;
}
function problemsOf(list2) {
  return `the scope is not acceptable:
${list2.map((line2) => `  - ${neutralize(line2)}`).join("\n")}`;
}
function checkText(value, where, problems, { pattern, patternName, min = 1, max = MAX_STRING2 } = {}) {
  if (typeof value !== "string") {
    problems.push(`${where} must be a string`);
    return false;
  }
  if (/[*?]/u.test(value)) {
    problems.push(`${where} contains a wildcard (${JSON.stringify(value)}); a certificate lists exact names only`);
    return false;
  }
  if (value.length < min || value.length > max) {
    problems.push(`${where} must be ${min} to ${max} characters (${JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}...` : value)} has ${value.length})`);
    return false;
  }
  if (pattern !== void 0 && !pattern.test(value)) {
    problems.push(`${where} is not a valid ${patternName} (${JSON.stringify(value)})`);
    return false;
  }
  return true;
}
function checkList(value, where, problems, options2) {
  if (value === void 0) return [];
  if (!Array.isArray(value)) {
    problems.push(`${where} must be an array`);
    return [];
  }
  if (value.length > MAX_ENTRIES2) {
    problems.push(`${where} has ${value.length} entries; the limit is ${MAX_ENTRIES2}`);
    return [];
  }
  const kept = [];
  for (const [index, item] of value.entries()) {
    if (checkText(item, `${where}[${index}]`, problems, options2)) kept.push(item);
  }
  if (new Set(kept).size !== kept.length) problems.push(`${where} lists the same entry twice`);
  return kept;
}
function isAssetPackPrefixOf2(pluginId8, prefix) {
  const dot = pluginId8.indexOf(".");
  if (dot <= 0 || dot === pluginId8.length - 1 || !IDENTIFIER.test(pluginId8)) return false;
  return prefix.length <= 90 && ASSET_PREFIX.test(prefix) && prefix.startsWith(`${pluginId8.slice(0, dot)}.asset.${pluginId8.slice(dot + 1)}-`);
}
function normalizeScope(raw, { reservedIds = BUILT_IN_RESERVED_IDS, parseOrigin } = {}) {
  const problems = [];
  const reserved = new Set(reservedIds);
  const origin = { test: (value) => typeof parseOrigin === "function" && parseOrigin(value) === value };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(problemsOf(['the scope must be a JSON object with "plugins" and "assetPacks"']));
  for (const key2 of Object.keys(raw)) {
    if (key2 !== "plugins" && key2 !== "assetPacks") problems.push(`unknown field "${key2}" in the scope`);
  }
  const plugins = [];
  if (raw.plugins !== void 0 && !Array.isArray(raw.plugins)) problems.push("plugins must be an array");
  const rawPlugins = Array.isArray(raw.plugins) ? raw.plugins : [];
  if (rawPlugins.length > MAX_ENTRIES2) problems.push(`plugins has ${rawPlugins.length} entries; the limit is ${MAX_ENTRIES2}`);
  const seenIds = /* @__PURE__ */ new Set();
  for (const [index, entry] of (rawPlugins.length > MAX_ENTRIES2 ? [] : rawPlugins).entries()) {
    const where = `plugins[${index}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`${where} must be an object`);
      continue;
    }
    for (const key2 of Object.keys(entry)) {
      if (!PLUGIN_KEYS.includes(key2)) problems.push(`${where} has an unknown field "${key2}"`);
    }
    const idOk = checkText(entry.id, `${where}.id`, problems, { pattern: IDENTIFIER, patternName: "plugin id", min: 3, max: 96 });
    if (idOk) {
      if (reserved.has(entry.id)) problems.push(`${where}.id ${entry.id} is reserved (Core id or pre-installed plugin); a release key can never sign it`);
      if (seenIds.has(entry.id)) problems.push(`${where}.id ${entry.id} is listed twice`);
      seenIds.add(entry.id);
    }
    const publisherOk = checkText(entry.publisher, `${where}.publisher`, problems, { pattern: IDENTIFIER, patternName: "publisher id", min: PUBLISHER_MIN, max: PUBLISHER_MAX });
    if (idOk && publisherOk && entry.publisher === "teamuq" && !entry.id.startsWith("teamuq.")) problems.push(`${where}: publisher "teamuq" is only allowed for ids that start with "teamuq." (Core would refuse the plugin)`);
    const trustTier = entry.trustTier ?? "sandboxed";
    if (!TIERS.includes(trustTier)) problems.push(`${where}.trustTier must be one of ${TIERS.join(", ")}`);
    const native = entry.native ?? "none";
    if (!NATIVE_LEVELS.includes(native)) problems.push(`${where}.native must be one of ${NATIVE_LEVELS.join(", ")}`);
    const permissions = checkList(entry.permissions, `${where}.permissions`, problems, { pattern: PERMISSION, patternName: "permission name" });
    if (entry.networkAllow !== void 0 && Array.isArray(entry.networkAllow) && entry.networkAllow.length > 0 && typeof parseOrigin !== "function") throw new Error("internal error: no network origin parser was given to this tool, so networkAllow cannot be checked; nothing was signed");
    const networkAllow = checkList(entry.networkAllow, `${where}.networkAllow`, problems, { pattern: origin, patternName: "public https or wss origin in the exact form Core accepts in a manifest (no IP address, no local name, no port 443, no path)" });
    const provides = checkList(entry.provides, `${where}.provides`, problems, { pattern: CAPABILITY2, patternName: "capability id such as teamuq.text-input@1" });
    const assetPackRefs = checkList(entry.assetPackRefs, `${where}.assetPackRefs`, problems, { pattern: IDENTIFIER, patternName: "asset pack id", min: 3, max: 96 });
    const assetPackPrefixes = checkList(entry.assetPackPrefixes, `${where}.assetPackPrefixes`, problems, { pattern: ASSET_PREFIX, patternName: "asset pack prefix such as teamuq.asset.name-", max: 90 });
    for (const prefix of assetPackPrefixes) {
      if (idOk && !isAssetPackPrefixOf2(entry.id, prefix)) problems.push(`${where}.assetPackPrefixes: ${prefix} is not inside the namespace of ${entry.id} (${entry.id.slice(0, entry.id.indexOf("."))}.asset.${entry.id.slice(entry.id.indexOf(".") + 1)}-...)`);
    }
    for (const ref of assetPackRefs) {
      if (reserved.has(ref)) problems.push(`${where}.assetPackRefs ${ref} is reserved`);
    }
    plugins.push({ id: entry.id, publisher: entry.publisher, trustTier, native, permissions, networkAllow, provides, assetPackRefs, assetPackPrefixes });
  }
  const assetPacks = checkList(raw.assetPacks, "assetPacks", problems, { pattern: IDENTIFIER, patternName: "asset pack id", min: 3, max: 96 });
  for (const id of assetPacks) {
    if (reserved.has(id)) problems.push(`assetPacks ${id} is reserved`);
  }
  if (problems.length > 0) throw new Error(problemsOf(problems));
  return { plugins, assetPacks };
}
var rank = (levels, value) => levels.indexOf(value);
function narrowingProblems(previous, next) {
  const problems = [];
  const nextById = new Map(next.plugins.map((plugin) => [plugin.id, plugin]));
  for (const old of previous.plugins) {
    const now = nextById.get(old.id);
    if (now === void 0) {
      problems.push(`plugin ${old.id} is in the previous certificate but not in the new scope`);
      continue;
    }
    if (rank(TIERS, now.trustTier) < rank(TIERS, old.trustTier)) problems.push(`${old.id}: trust level drops from ${old.trustTier} to ${now.trustTier}`);
    if (rank(NATIVE_LEVELS, now.native) < rank(NATIVE_LEVELS, old.native)) problems.push(`${old.id}: native level drops from ${old.native} to ${now.native}`);
    if (now.publisher !== old.publisher) problems.push(`${old.id}: publisher changes from ${old.publisher} to ${now.publisher}`);
    for (const field of ["permissions", "networkAllow", "provides", "assetPackRefs", "assetPackPrefixes"]) {
      const lost = old[field].filter((item) => !now[field].includes(item));
      if (lost.length > 0) problems.push(`${old.id}.${field} loses: ${lost.join(", ")}`);
    }
  }
  const lostPacks = previous.assetPacks.filter((id) => !next.assetPacks.includes(id));
  if (lostPacks.length > 0) problems.push(`assetPacks loses: ${lostPacks.join(", ")}`);
  return problems;
}
var TIER_TEXT = {
  sandboxed: "sandboxed (runs only inside its own window)",
  "full-trust": "full trust (also runs its own background program on the user's computer)"
};
var NATIVE_TEXT = {
  none: "none (no native libraries and no add-ons)",
  libraries: "native libraries allowed",
  addons: "native libraries and add-ons allowed (code that runs directly on the user's computer)"
};
function listOrNone(items, none) {
  return items.length === 0 ? none : items.map(asciiOnly).join(", ");
}
function describeScope(scope) {
  const lines = [];
  if (scope.plugins.length === 0) lines.push("No plugin may be signed.");
  for (const [index, plugin] of scope.plugins.entries()) {
    lines.push(`${index + 1}. Plugin ${asciiOnly(plugin.id)} (publisher ${asciiOnly(plugin.publisher)})`);
    lines.push(`   - runs as: ${TIER_TEXT[plugin.trustTier] ?? asciiOnly(plugin.trustTier)}`);
    lines.push(`   - native files: ${NATIVE_TEXT[plugin.native] ?? asciiOnly(plugin.native)}`);
    lines.push(`   - may ask for these permissions: ${listOrNone(plugin.permissions, "none")}`);
    lines.push(`   - may connect to: ${listOrNone(plugin.networkAllow, "nowhere (no network address)")}`);
    lines.push(`   - may offer these services to other plugins: ${listOrNone(plugin.provides, "none")}`);
    lines.push(`   - may use these asset packs: ${listOrNone(plugin.assetPackRefs, "none")}`);
    lines.push(`   - owns store packs whose id starts with: ${listOrNone(plugin.assetPackPrefixes, "nothing")}`);
  }
  lines.push(`Asset packs this key may sign itself (exact ids only): ${listOrNone(scope.assetPacks, "none")}`);
  return lines;
}
function validityState({ notBefore, notAfter }, nowMs) {
  if (nowMs > Date.parse(notAfter)) return "expired";
  if (Date.parse(notBefore) - CLOCK_SKEW_MS > nowMs) return "not-yet-valid";
  return "valid";
}
function describeValidity({ notBefore, notAfter }, nowMs) {
  const from = Date.parse(notBefore);
  const to = Date.parse(notAfter);
  const total = Math.round((to - from) / DAY_MS);
  const shown = (iso) => `${asciiOnly(iso.slice(0, 10))} ${asciiOnly(iso.slice(11, 16))} UTC`;
  const state = validityState({ notBefore, notAfter }, nowMs);
  const lines = [`Valid from ${shown(notBefore)} until ${shown(notAfter)} (${total} days in total).`];
  if (state === "expired") lines.push(`Status: EXPIRED ${Math.max(1, Math.floor((nowMs - to) / DAY_MS))} day(s) ago. TeamUQ refuses new installs and updates signed under this certificate; plugins that are already installed keep working.`);
  else if (state === "not-yet-valid") lines.push(`Status: NOT VALID YET (starts in ${Math.ceil((from - nowMs) / DAY_MS)} day(s)).`);
  else {
    const left = Math.floor((to - nowMs) / DAY_MS);
    lines.push(`Status: valid now, ${left} day(s) left.`);
    if (left < 30) lines.push("Warning: less than 30 days left. Issue the next certificate at least 30 days before this one ends, so the two overlap.");
  }
  return lines;
}
function describeChange(previous, next) {
  const lines = [];
  const previousById = new Map(previous.plugins.map((plugin) => [plugin.id, plugin]));
  for (const plugin of next.plugins) {
    const old = previousById.get(plugin.id);
    const id = asciiOnly(plugin.id);
    if (old === void 0) {
      lines.push(`+ NEW plugin ${id}`);
      continue;
    }
    if (rank(TIERS, plugin.trustTier) > rank(TIERS, old.trustTier)) lines.push(`+ ${id}: trust level raised from ${asciiOnly(old.trustTier)} to ${asciiOnly(plugin.trustTier)}`);
    if (rank(NATIVE_LEVELS, plugin.native) > rank(NATIVE_LEVELS, old.native)) lines.push(`+ ${id}: native level raised from ${asciiOnly(old.native)} to ${asciiOnly(plugin.native)}`);
    for (const field of ["permissions", "networkAllow", "provides", "assetPackRefs", "assetPackPrefixes"]) {
      const added = plugin[field].filter((item) => !old[field].includes(item));
      if (added.length > 0) lines.push(`+ ${id}.${field}: adds ${added.map(asciiOnly).join(", ")}`);
    }
  }
  const addedPacks = next.assetPacks.filter((id) => !previous.assetPacks.includes(id));
  if (addedPacks.length > 0) lines.push(`+ assetPacks: adds ${addedPacks.map(asciiOnly).join(", ")}`);
  if (lines.length === 0) lines.push("(no change to the scope: this certificate only renews the validity)");
  return lines;
}
function certificateBytes({ serial, issuer, release, notBefore, notAfter, scope }) {
  return Buffer.from(JSON.stringify({
    schema: 1,
    serial,
    issuer,
    release: { keyId: release.keyId, algorithm: "ed25519", publicKey: release.publicKey },
    notBefore,
    notAfter,
    scope: { plugins: scope.plugins.map((plugin) => ({ id: plugin.id, publisher: plugin.publisher, trustTier: plugin.trustTier, native: plugin.native, permissions: plugin.permissions, networkAllow: plugin.networkAllow, provides: plugin.provides, assetPackRefs: plugin.assetPackRefs, assetPackPrefixes: plugin.assetPackPrefixes })), assetPacks: scope.assetPacks }
  }), "utf8");
}
function delegationSigningInput2(certBytes) {
  return Buffer.concat([DELEGATION_DOMAIN_PREFIX2, certBytes]);
}
function delegationFileBytes({ issuerKeyId, certBytes, signature }) {
  return Buffer.from(JSON.stringify({ format: 1, issuerKeyId, cert: certBytes.toString("base64"), signature: signature.toString("base64") }), "utf8");
}
function readSmallFile(file, label, limit = MAX_SMALL_FILE_BYTES) {
  let stat;
  try {
    stat = fs10.statSync(file);
  } catch {
    throw new Error(`${label} ${file} cannot be read`);
  }
  if (!stat.isFile() || stat.size > limit) throw new Error(`${label} ${file} is not a regular file of at most ${limit} bytes`);
  return fs10.readFileSync(file);
}
function readJsonFile(file, label, limit) {
  try {
    return JSON.parse(readSmallFile(file, label, limit).toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} ${file} is not valid JSON`);
    throw error;
  }
}
function canonicalRaw(base642, label) {
  const raw = Buffer.from(String(base642), "base64");
  if (raw.toString("base64") !== base642 || raw.length !== 32) throw new Error(`${label} must be the canonical base64 of 32 raw bytes`);
  try {
    rawToPublicKey(raw);
  } catch {
    throw new Error(`${label} is not a valid Ed25519 public key`);
  }
  return raw;
}
function readPublicKeyFile(file, label) {
  const stored = readJsonFile(file, label, 4096);
  if (stored === null || typeof stored !== "object" || Array.isArray(stored) || typeof stored.keyId !== "string" || typeof stored.publicKey !== "string" || Object.keys(stored).some((key2) => key2 !== "keyId" && key2 !== "publicKey")) throw new Error(`${label} ${file} must contain exactly { keyId, publicKey }`);
  canonicalRaw(stored.publicKey, `${label} publicKey`);
  return { keyId: stored.keyId, publicKey: stored.publicKey };
}
function keyIdFromFile(keyFile, explicit) {
  const base = path9.basename(keyFile);
  const keyId2 = explicit ?? (base.endsWith(".key.pem") ? base.slice(0, -".key.pem".length) : void 0);
  if (keyId2 === void 0) throw new UsageProblem("--root-key-id is required when the key file is not named <keyId>.key.pem");
  return keyId2;
}
function loadBundledIds(flags) {
  const file = path9.resolve(flags.get("--bundled-index"));
  const index = readJsonFile(file, "bundled plugin index");
  if (index === null || typeof index !== "object" || !Array.isArray(index.plugins) || index.plugins.some((entry) => typeof entry?.id !== "string")) throw new Error(`bundled plugin index ${file} does not look like bundled-plugins.json`);
  if (index.plugins.length === 0) throw new Error(`bundled plugin index ${file} lists no plugin; the real one lists at least teamuq.memory, so this is the wrong file or a cut-off copy`);
  return { file, ids: index.plugins.map((entry) => entry.id) };
}
function anchorsFor(flags, deps) {
  const mode = flags.get("--anchors") ?? "core";
  if (mode !== "core" && mode !== "self") throw new UsageProblem("--anchors must be core or self");
  const pubFile = flags.get("--root-pub-file");
  if (mode === "core") {
    if (pubFile !== void 0) throw new UsageProblem("--root-pub-file is only for --anchors self");
    if (deps.coreAnchors === void 0) throw new Error("no built-in TEAMUQ_TRUST_ANCHORS were given to this tool");
    return { mode, anchors: deps.coreAnchors };
  }
  if (pubFile === void 0) throw new UsageProblem("--anchors self needs --root-pub-file <file.pub.json> (the public file of the root key you test with)");
  const stored = readPublicKeyFile(pubFile, "root public key file");
  if (!KEY_ID_PATTERN2.test(stored.keyId) || stored.keyId.startsWith("dev-") || stored.keyId.startsWith(RELEASE_KEY_PREFIX2)) throw new Error(`${stored.keyId} cannot be a root key id (not dev- and not ${RELEASE_KEY_PREFIX2}*)`);
  if (deps.coreAnchors === void 0) throw new Error("no built-in TEAMUQ_TRUST_ANCHORS were given to this tool, so the name of --root-pub-file cannot be checked against them");
  const impersonated = deps.coreAnchors.rootKeys.find((candidate) => candidate.keyId === stored.keyId && candidate.publicKey !== stored.publicKey);
  if (impersonated !== void 0) throw new Error(`refused: ${stored.keyId} in --root-pub-file is the id of a built-in key but holds a different public key; a test root key must not borrow the name of a TeamUQ key`);
  return { mode, anchors: { rootKeys: [{ keyId: stored.keyId, publicKey: stored.publicKey, role: "package" }], revokedKeyIds: [] } };
}
function resolveRootAnchor(rootKeyId, anchors) {
  if (!KEY_ID_PATTERN2.test(rootKeyId)) throw new Error(`root keyId ${rootKeyId} does not match ${KEY_ID_PATTERN2}`);
  if (rootKeyId.startsWith("dev-")) throw new Error(`refused: ${rootKeyId} is a development key; only a TeamUQ root key can sign a delegation certificate`);
  if (rootKeyId.startsWith(RELEASE_KEY_PREFIX2)) throw new Error(`refused: ${rootKeyId} is a release key; a release key can never sign a delegation certificate (only a root key does)`);
  const anchor = anchors.rootKeys.find((candidate) => candidate.keyId === rootKeyId);
  if (anchor === void 0) throw new Error(`refused: ${rootKeyId} is not one of the ${anchors.rootKeys.length} root keys built into this tool, so Core would not accept a certificate it signs (use --anchors self only for tests)`);
  if ((anchor.role ?? "package") !== "package") throw new Error(`refused: ${rootKeyId} is registered for the store catalog (role ${anchor.role}), not for packages; it cannot issue delegations`);
  if (anchors.revokedKeyIds.includes(rootKeyId)) throw new Error(`refused: ${rootKeyId} is revoked`);
  return anchor;
}
function untrustedCertificate(bytes4) {
  try {
    const outer = JSON.parse(bytes4.toString("utf8"));
    const cert = JSON.parse(Buffer.from(outer.cert, "base64").toString("utf8"));
    if (typeof cert?.release?.keyId !== "string" || typeof cert.notBefore !== "string") throw new Error("shape");
    return cert;
  } catch {
    throw new Error("this file is not a delegation certificate (delegation.json)");
  }
}
function reasonOf(error) {
  const message = error instanceof Error ? error.message : String(error);
  return typeof error?.code === "string" && !message.startsWith(error.code) ? `${error.code}: ${message}` : message;
}
function requireVerifier(deps) {
  if (typeof deps.verifyDelegation !== "function") throw new Error("internal error: no Core delegation verifier was given to this tool");
  return deps.verifyDelegation;
}
function verifyWithCore(bytes4, anchors, deps, nowMs) {
  const cert = untrustedCertificate(bytes4);
  const notBefore = Date.parse(cert.notBefore);
  const verified = requireVerifier(deps)(cert.release.keyId, anchors, { delegationBytes: bytes4, now: Number.isFinite(notBefore) ? Math.max(nowMs, notBefore) : nowMs, expiry: "ignore" });
  return { releaseKeyId: cert.release.keyId, publicKey: verified.publicKey, grant: verified.grant };
}
async function runReleaseKeygen(argv, deps = {}) {
  return guarded("release-keygen", deps, async () => {
    const { out } = sinks(deps);
    const { positional, flags } = parseFlags(argv, ["--key-id", "--out-dir"]);
    if (positional.length !== 0) throw new UsageProblem("release-keygen takes no positional argument");
    const keyId2 = flags.get("--key-id");
    const outDir = flags.get("--out-dir");
    if (keyId2 === void 0 || outDir === void 0) throw new UsageProblem("--key-id and --out-dir are both required (where a release key lives is decided by the release process, so there is no default directory)");
    assertNoPassphraseEnv("release-keygen");
    try {
      assertDelegatedKeyId(keyId2);
    } catch (error) {
      throw new UsageProblem(error.message);
    }
    const directory = path9.resolve(outDir);
    assertOutsideGitWorkTree(directory, "output directory");
    if (fs10.existsSync(path9.join(directory, `${keyId2}.key.pem`)) || fs10.existsSync(path9.join(directory, `${keyId2}.pub.json`))) throw new Error(`${keyId2} already exists in ${directory}; refusing to overwrite a key`);
    const passphrase = await (deps.readNewPassphrase ?? readNewInteractivePassphrase)();
    const result = writeEncryptedKeyFiles({ keyId: keyId2, directory, passphrase });
    out([
      `keyId        : ${result.keyId}`,
      `private key  : ${result.keyFile} (encrypted PKCS8 PEM; never commit, upload or share it)`,
      `public file  : ${result.publicFile}`,
      `publicKey    : ${result.publicKey}`,
      `fingerprint  : ${result.fingerprint}`,
      "self-check   : ok (signed and verified once with the stored files; a wrong passphrase is rejected)",
      "",
      `This key signs nothing yet. Do NOT paste it into TEAMUQ_TRUST_ANCHORS: a release key is trusted only through a certificate that a root key issues with "delegate --release-pub ${result.publicFile}".`,
      ""
    ].join("\n"));
    return 0;
  });
}
var DELEGATE_REQUIRED = ["--root-key", "--release-pub", "--scope", "--bundled-index", "--out"];
var DELEGATE_FLAGS = ["--root-key", "--root-key-id", "--release-pub", "--scope", "--previous", "--first", "--out", "--days", "--serial", "--not-before", "--anchors", "--root-pub-file", "--bundled-index"];
function planDelegation(argv, deps) {
  const { positional, flags } = parseFlags(argv, DELEGATE_FLAGS, ["--first"]);
  if (positional.length !== 0) throw new UsageProblem("delegate takes no positional argument");
  assertNoPassphraseEnv("delegate");
  for (const required of DELEGATE_REQUIRED) {
    if (!flags.has(required)) throw new UsageProblem(`${required} is required`);
  }
  if (flags.has("--first") === flags.has("--previous")) throw new UsageProblem("give exactly one of --previous <the newest delegation.json of this release key> or --first (no certificate exists for this key id yet)");
  const now = wholeSecond((deps.now ?? Date.now)());
  const { mode, anchors } = anchorsFor(flags, deps);
  const keyFile = path9.resolve(flags.get("--root-key"));
  assertOutsideGitWorkTree(keyFile, "root key file");
  const rootKeyId = keyIdFromFile(keyFile, flags.get("--root-key-id"));
  const rootAnchor = resolveRootAnchor(rootKeyId, anchors);
  const keyStat = fs10.existsSync(keyFile) ? fs10.statSync(keyFile) : null;
  if (keyStat === null || !keyStat.isFile()) throw new Error(`root key file ${keyFile} does not exist`);
  const releaseStored = readPublicKeyFile(flags.get("--release-pub"), "release public key file");
  try {
    assertDelegatedKeyId(releaseStored.keyId);
  } catch (error) {
    throw new Error(`release public key file: ${error.message}`);
  }
  if (anchors.rootKeys.some((candidate) => candidate.keyId === releaseStored.keyId)) throw new Error(`refused: ${releaseStored.keyId} is the id of a built-in key`);
  const sameKey = anchors.rootKeys.find((candidate) => candidate.publicKey === releaseStored.publicKey);
  if (sameKey !== void 0) throw new Error(`refused: the public key in the release public key file is the public key of the built-in key ${sameKey.keyId}; a release key must be a key pair of its own (release-keygen)`);
  if (anchors.revokedKeyIds.includes(releaseStored.keyId)) throw new Error(`refused: ${releaseStored.keyId} is on the revoked key list; TeamUQ refuses everything it signs, so it gets no new certificate (make a new key with release-keygen)`);
  const release = { keyId: releaseStored.keyId, publicKey: releaseStored.publicKey };
  const bundled = loadBundledIds(flags);
  const scope = normalizeScope(readJsonFile(flags.get("--scope"), "scope file"), { reservedIds: [...BUILT_IN_RESERVED_IDS, ...bundled.ids], parseOrigin: deps.parseDeclaredNetworkOrigin });
  const daysText = flags.get("--days");
  const days = daysText === void 0 ? DEFAULT_LIFETIME_DAYS : Number(daysText);
  if (daysText !== void 0 && !/^[0-9]+$/u.test(daysText)) throw new UsageProblem("--days must be a whole number of days");
  if (days < 1) throw new UsageProblem("--days must be at least 1");
  if (days > MAX_LIFETIME_DAYS) throw new Error(`refused: ${days} days is longer than the ${MAX_LIFETIME_DAYS} day limit Core enforces; default is ${DEFAULT_LIFETIME_DAYS} days`);
  const notBeforeMs = flags.has("--not-before") ? parseUtc(flags.get("--not-before"), "--not-before") : now;
  if (notBeforeMs > now + MAX_NOT_BEFORE_AHEAD_DAYS * DAY_MS) throw new Error(`refused: --not-before ${flags.get("--not-before")} is more than ${MAX_NOT_BEFORE_AHEAD_DAYS} days away; a certificate may start at most ${MAX_NOT_BEFORE_AHEAD_DAYS} days after it is issued (issue it later instead)`);
  const notAfterMs = notBeforeMs + days * DAY_MS;
  if (notAfterMs <= now) throw new Error("refused: the certificate would already be expired when it is issued");
  const serialText = flags.get("--serial");
  if (serialText !== void 0 && (!new RegExp(`^[1-9][0-9]{0,${MAX_SERIAL_DIGITS - 1}}$`, "u").test(serialText) || !Number.isSafeInteger(Number(serialText)))) throw new UsageProblem(`--serial must be a positive whole number of at most ${Number.MAX_SAFE_INTEGER}`);
  const requestedSerial = serialText === void 0 ? void 0 : Number(serialText);
  let serial = 1;
  let previous = null;
  if (flags.has("--first") && requestedSerial !== void 0 && requestedSerial !== 1) throw new Error(`refused: --first makes certificate number 1; --serial ${requestedSerial} would start a series in the middle. A later certificate needs --previous <the newest delegation.json of this key>`);
  if (flags.has("--previous")) {
    const previousFile = flags.get("--previous");
    const bytes4 = readSmallFile(previousFile, "previous certificate", MAX_DELEGATION_BYTES2);
    let checked;
    try {
      checked = verifyWithCore(bytes4, anchors, deps, now);
    } catch (error) {
      throw new Error(`the previous certificate ${previousFile} does not verify: ${reasonOf(error)}`);
    }
    if (checked.releaseKeyId !== release.keyId) throw new Error(`the previous certificate is for ${checked.releaseKeyId}, not ${release.keyId}; a different key id starts its own series (use --first)`);
    if (checked.publicKey.toString("base64") !== release.publicKey) throw new Error(`the previous certificate holds a different public key for ${release.keyId}; a key id must never be reused for another key`);
    const narrowed = narrowingProblems(JSON.parse(JSON.stringify(checked.grant.scope)), scope);
    if (narrowed.length > 0) throw new Error(`refused: the new scope is narrower than the previous certificate (same key id may only widen; to narrow, use a new key id and revoke the old one):
${narrowed.map((line2) => `  - ${line2}`).join("\n")}`);
    serial = checked.grant.serial + 1;
    if (!Number.isSafeInteger(serial)) throw new Error(`refused: the previous certificate already has the largest number Core accepts (${checked.grant.serial}); start a new key id`);
    if (requestedSerial !== void 0 && requestedSerial !== serial) throw new Error(`refused: --serial ${requestedSerial} is not the previous certificate's number ${checked.grant.serial} plus 1 (${serial}); numbers are never skipped or reused, so that a missing or duplicate number shows a certificate that was lost or forged`);
    previous = { serial: checked.grant.serial, scope: JSON.parse(JSON.stringify(checked.grant.scope)), notAfter: checked.grant.notAfter };
  }
  const notBefore = formatUtc(notBeforeMs);
  const notAfter = formatUtc(notAfterMs);
  const certBytes = certificateBytes({ serial, issuer: rootKeyId, release, notBefore, notAfter, scope });
  const sizeEstimate = delegationFileBytes({ issuerKeyId: rootKeyId, certBytes, signature: Buffer.alloc(64) }).length;
  if (sizeEstimate > MAX_DELEGATION_BYTES2) throw new Error(`refused: the certificate file would be ${sizeEstimate} bytes; Core accepts at most ${MAX_DELEGATION_BYTES2}. Shorten the scope.`);
  const outFile = path9.resolve(flags.get("--out"));
  if (fs10.existsSync(outFile)) throw new Error(`${outFile} already exists; refusing to overwrite a certificate`);
  if (!fs10.existsSync(path9.dirname(outFile))) throw new Error(`the folder ${path9.dirname(outFile)} does not exist`);
  return { mode, anchors, bundled: { file: bundled.file, count: bundled.ids.length }, keyFile, rootKeyId, rootAnchor, release, scope, previous, serial, notBefore, notAfter, notBeforeMs, notAfterMs, days, certBytes, outFile, now };
}
function reviewText(plan) {
  const lines = [
    "",
    "=== Please check this before you type the ROOT passphrase ===",
    `Root key that signs  : ${plan.rootKeyId}${plan.mode === "self" ? "  (TEST MODE: --anchors self, Core will not accept this)" : ""}`,
    `Release key it trusts: ${plan.release.keyId}`,
    `Certificate number   : ${plan.serial}${plan.previous === null ? " (first certificate for this key id)" : ` (follows number ${plan.previous.serial})`}`,
    ...describeValidity({ notBefore: plan.notBefore, notAfter: plan.notAfter }, plan.now),
    `Pre-installed ids   : checked against ${plan.bundled.count} id(s) in ${plan.bundled.file}`,
    "",
    "This release key will be allowed to sign:",
    ...describeScope(plan.scope).map((line2) => `  ${line2}`),
    "",
    plan.previous === null ? "There is no earlier certificate to compare with, so everything above is new." : `Changes compared with certificate number ${plan.previous.serial}:`,
    ...plan.previous === null ? [] : describeChange(plan.previous.scope, plan.scope).map((line2) => `  ${line2}`),
    ""
  ];
  return screen(`${lines.join("\n")}
`);
}
async function runDelegate(argv, deps = {}) {
  return guarded("delegate", deps, async () => {
    const { out, err } = sinks(deps);
    const plan = planDelegation(argv, deps);
    err(reviewText(plan));
    const passphrase = await (deps.readPassphrase ?? readInteractivePassphrase)(`Passphrase for ROOT key ${plan.rootKeyId}: `);
    const key2 = loadEncryptedPrivateKey(readKeyFile(plan.keyFile), passphrase);
    const description = describePublicKey(createPublicKey5(key2));
    if (description.publicKey !== plan.rootAnchor.publicKey) throw new Error(`refused: the key in ${plan.keyFile} is not the public key that ${plan.rootKeyId} has in the trust anchors (wrong file, or a key that only carries that name)`);
    selfCheck(key2, description.raw);
    const signature = sign3(null, delegationSigningInput2(plan.certBytes), key2);
    const bytes4 = delegationFileBytes({ issuerKeyId: plan.rootKeyId, certBytes: plan.certBytes, signature });
    if (!verify5(null, delegationSigningInput2(plan.certBytes), rawToPublicKey(description.raw), signature)) throw new Error("internal error: the new signature does not verify");
    const checked = requireVerifier(deps)(plan.release.keyId, plan.anchors, { delegationBytes: bytes4, now: Math.max(plan.now, plan.notBeforeMs), expiry: "enforce" });
    if (checked.publicKey.toString("base64") !== plan.release.publicKey || !isDeepStrictEqual(JSON.parse(JSON.stringify(checked.grant.scope)), plan.scope)) throw new Error("internal error: the certificate Core reads back differs from the one that was requested; nothing was written");
    fs10.writeFileSync(plan.outFile, bytes4, { flag: "wx" });
    out(`${JSON.stringify({ file: plan.outFile, issuer: plan.rootKeyId, releaseKeyId: plan.release.keyId, serial: plan.serial, notBefore: plan.notBefore, notAfter: plan.notAfter, bytes: bytes4.length, sha256: createHash8("sha256").update(bytes4).digest("hex"), verifiedBy: "Core delegation verifier (trust/delegation.ts)", anchors: plan.mode }, null, 2)}
`);
    return 0;
  });
}
async function runDelegationInspect(argv, deps = {}) {
  return guarded("delegation-inspect", deps, async () => {
    const { out } = sinks(deps);
    const { positional, flags } = parseFlags(argv, ["--anchors", "--root-pub-file", "--at"]);
    if (positional.length !== 1) throw new UsageProblem("delegation-inspect needs exactly one delegation.json file");
    const { mode, anchors } = anchorsFor(flags, deps);
    const nowMs = flags.has("--at") ? parseUtc(flags.get("--at"), "--at") : wholeSecond((deps.now ?? Date.now)());
    const file = path9.resolve(positional[0]);
    const bytes4 = readSmallFile(file, "certificate file", MAX_DELEGATION_BYTES2);
    let checked;
    try {
      checked = verifyWithCore(bytes4, anchors, deps, nowMs);
    } catch (error) {
      out(screen([
        `Certificate file : ${file}`,
        `Signature check  : FAILED (${reasonOf(error)})`,
        "Do not trust this file. Nothing in it is shown because none of it is proven.",
        ""
      ].join("\n")));
      return 1;
    }
    const { grant } = checked;
    const revoked = anchors.revokedKeyIds.includes(checked.releaseKeyId);
    const validity = describeValidity(grant, nowMs);
    const shownValidity = revoked ? [validity[0], "Status: REVOKED. This release key id is on the revoked key list: TeamUQ refuses everything it signs, whatever the dates above say. Do not use this certificate."] : validity;
    const usable = !revoked && validityState(grant, nowMs) === "valid";
    const raw = checked.publicKey;
    out(screen([
      `Certificate file : ${file}`,
      `Signature check  : OK - signed by TeamUQ root key ${grant.issuer}${mode === "self" ? " (TEST MODE: --anchors self; real TeamUQ would not accept it)" : ""}`,
      `Release key      : ${checked.releaseKeyId} (fingerprint sha256:${createHash8("sha256").update(raw).digest("hex")})`,
      `Certificate no.  : ${grant.serial}`,
      ...shownValidity,
      "",
      "This release key may sign:",
      ...describeScope(JSON.parse(JSON.stringify(grant.scope))).map((line2) => `  ${line2}`),
      "",
      "Not covered: any plugin id or asset pack id that is not listed above, pre-installed plugins, store packs and the store catalog, and new certificates. This certificate is a permission list only; it contains no secret.",
      ""
    ].join("\n")));
    return usable ? 0 : 1;
  });
}

// .teamuq/scripts/plugin-tools/pluginStarter.mjs
import { promises as fs11 } from "node:fs";
import path10 from "node:path";

// .teamuq/scripts/plugin-tools/starter-template/ui/index.html.tpl
var index_html_default = '<!doctype html>\n<!--\n  這是外掛畫面的骨架，你看到的文字都可以直接改成自己的。\n  注意：TeamUQ 不允許在 HTML 裡直接寫 <script>…</script> 程式，\n  所有 JavaScript 都要放在獨立檔案（這裡是 app.js），再用下面的 <script src="app.js"> 引用。\n-->\n<html lang="zh-Hant">\n<head>\n<meta charset="utf-8">\n<title>__PLUGIN_NAME__</title>\n<link rel="stylesheet" href="style.css">\n</head>\n<body>\n<main>\n  <h1>__PLUGIN_NAME__</h1>\n  <p class="hint">這是你的第一個 TeamUQ 外掛。在下面寫點東西、按「儲存」，關掉外掛再打開，內容還會在。</p>\n\n  <label for="note">我的筆記</label>\n  <textarea id="note" rows="6" placeholder="在這裡輸入…"></textarea>\n\n  <div class="row">\n    <button id="save" type="button">儲存</button>\n    <output id="status" aria-live="polite"></output>\n  </div>\n</main>\n<script src="app.js" defer></script>\n</body>\n</html>\n';

// .teamuq/scripts/plugin-tools/starter-template/ui/app.js.tpl
var app_js_default = "// 這個檔案是外掛畫面的程式。你可以直接改它，改完重新打包（見 README.md）就會生效。\n//\n// TeamUQ 給外掛畫面的唯一入口是 window.tuqPlugin。\n// 這個範本只用到其中的 storage（外掛自己的資料資料夾，其他外掛看不到），\n// 它需要 manifest.json 的 permissions 裡有 \"storage:plugin-data\"。\n// 如果你刪掉這個權限，下面的讀寫會失敗。\n\nconst NOTE_FILE = 'note.txt'\n\nconst noteBox = document.querySelector('#note')\nconst saveButton = document.querySelector('#save')\nconst statusText = document.querySelector('#status')\n\nfunction say(message) {\n  statusText.textContent = message\n}\n\nasync function loadNote() {\n  try {\n    noteBox.value = await window.tuqPlugin.storage.readText(NOTE_FILE)\n  } catch {\n    // 第一次打開還沒有這個檔案，保持空白就好\n    noteBox.value = ''\n  }\n}\n\nasync function saveNote() {\n  say('儲存中…')\n  try {\n    await window.tuqPlugin.storage.write(NOTE_FILE, noteBox.value)\n    say('已儲存')\n  } catch (error) {\n    say(`儲存失敗：${error instanceof Error ? error.message : String(error)}`)\n  }\n}\n\nif (window.tuqPlugin === undefined) {\n  // 直接用瀏覽器打開這個檔案時沒有 window.tuqPlugin；請在 TeamUQ 裡安裝後再試\n  say('請在 TeamUQ 裡安裝這個外掛後使用。')\n  saveButton.disabled = true\n} else {\n  saveButton.addEventListener('click', saveNote)\n  loadNote()\n}\n";

// .teamuq/scripts/plugin-tools/starter-template/ui/style.css.tpl
var style_css_default = '/* 外觀設定：想改顏色、字體大小就改這裡。 */\n:root {\n  color-scheme: light dark;\n  --accent: #2f6fed;\n}\n\nbody {\n  margin: 0;\n  padding: 24px;\n  font: 15px/1.6 system-ui, "Noto Sans TC", "Microsoft JhengHei", sans-serif;\n}\n\nmain {\n  max-width: 560px;\n  margin: 0 auto;\n}\n\nh1 {\n  margin: 0 0 8px;\n  font-size: 22px;\n}\n\n.hint {\n  margin: 0 0 20px;\n  opacity: 0.75;\n}\n\nlabel {\n  display: block;\n  margin-bottom: 6px;\n  font-weight: 600;\n}\n\ntextarea {\n  box-sizing: border-box;\n  width: 100%;\n  padding: 10px;\n  font: inherit;\n  resize: vertical;\n}\n\n.row {\n  display: flex;\n  align-items: center;\n  gap: 12px;\n  margin-top: 12px;\n}\n\nbutton {\n  padding: 8px 20px;\n  border: 0;\n  border-radius: 6px;\n  background: var(--accent);\n  color: #fff;\n  font: inherit;\n  cursor: pointer;\n}\n\nbutton:disabled {\n  opacity: 0.5;\n  cursor: default;\n}\n';

// .teamuq/scripts/plugin-tools/starter-template/README.md.tpl
var README_md_default = "# __PLUGIN_NAME__\n\n這是用 `tuq-plugin-tool init` 產生的 TeamUQ 外掛範本。它是「沙盒級」外掛：只在自己的畫面裡執行，不能碰你電腦上的其他檔案，也不能連網。\n\n## 檔案說明\n\n| 檔案 | 作用 | 想改的話 |\n|---|---|---|\n| `manifest.json` | 外掛的身分證：名稱、版本、需要哪些權限 | 見下方「manifest.json 哪裡可以改」 |\n| `ui/index.html` | 畫面的文字與按鈕 | 直接改裡面的中文 |\n| `ui/app.js` | 按鈕按下去要做什麼 | 改裡面的程式；檔案內有中文說明 |\n| `ui/style.css` | 顏色、字體、間距 | 直接改 |\n| `README.md` | 就是這份說明 | 可以刪掉或改成你自己的介紹 |\n\n## manifest.json 哪裡可以改\n\n| 欄位 | 說明 |\n|---|---|\n| `name` | 外掛在 TeamUQ 裡顯示的名字，可以改成任何文字 |\n| `description` | 一句話介紹 |\n| `version` | 版本號。改過外掛內容、要更新已安裝的外掛時，請把它加大（例如 `0.1.0` 改成 `0.1.1`） |\n| `publisher` 與 `id` | 你的名字（小寫英文、數字、`-`）與外掛的唯一識別。`id` 必須是「`publisher` 加上一個點再加名稱」。**不能用 `teamuq.` 開頭**，這個名稱保留給 TeamUQ 官方 |\n| `permissions` | 外掛需要的權限。這個範本只要 `ui:view`（顯示畫面）與 `storage:plugin-data`（讀寫自己的資料）。只列你真的用到的，用不到就刪掉 |\n| `contributes.views[0].title` | 外掛頁籤上顯示的標題 |\n\n其他欄位（`schemaVersion`、`kind`、`pluginApi`、`minCoreVersion`、`trustTier`、`entry`）請先不要動。\n\n## 打包與安裝\n\n1. 在你放 `tuq-plugin-tool.mjs` 的資料夾執行（把路徑換成這個資料夾的位置）：\n\n   ```powershell\n   node .\\tuq-plugin-tool.mjs validate <這個資料夾>\n   node .\\tuq-plugin-tool.mjs pack <這個資料夾> --unsigned\n   ```\n\n   `validate` 會檢查有沒有寫錯；`pack --unsigned` 會在這個資料夾的旁邊產生 `<id>-<version>.tuqplugin`，不需要金鑰或密碼。\n2. 在 TeamUQ 的「我的 AI › 外掛」最下面的「更多與進階」按「從檔案安裝…」，選這個 `.tuqplugin` 檔，就會直接安裝並啟用。\n3. 改了內容之後，把 `version` 加大、重新打包、再選一次同一個檔名的新檔案，就會更新。\n\n未簽章的外掛，TeamUQ 會標示「未簽章」，代表沒有人能保證它是誰做的；自己用或給同事試用沒有問題。\n";

// .teamuq/scripts/plugin-tools/pluginStarter.mjs
var STARTER_DEFAULT_NAME = "我的第一個外掛";
var STARTER_DEFAULT_PUBLISHER = "myname";
var STARTER_FALLBACK_SLUG = "my-plugin";
var STARTER_VERSION = "0.1.0";
var STARTER_PERMISSIONS = Object.freeze(["ui:view", "storage:plugin-data"]);
var STARTER_BUTTON_LABEL = "從檔案安裝…";
var INIT_USAGE = "  init <newFolder> [--name <display name>] [--publisher <your name>] [--id <publisher.name>]  (creates a small working sandboxed plugin to start from; the folder must not exist or must be empty)";
var MAX_SLUG_LENGTH = 40;
var MAX_VIEW_TITLE_CHARACTERS = 48;
function slugOf(text2) {
  const slug = String(text2).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, MAX_SLUG_LENGTH).replace(/-+$/u, "");
  return slug === "" ? STARTER_FALLBACK_SLUG : slug;
}
function escapeHtml(text2) {
  return text2.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}
function fill(template, name, escape) {
  return template.replaceAll("__PLUGIN_NAME__", () => escape(name));
}
function starterManifest({ id, publisher, name, coreVersionRange }) {
  const description = `${name}（範本外掛，請改成你自己的說明）`;
  return {
    schemaVersion: 2,
    kind: "plugin",
    id,
    name,
    version: STARTER_VERSION,
    publisher,
    description,
    pluginApi: "^2.0.0",
    minCoreVersion: coreVersionRange,
    trustTier: "sandboxed",
    entry: { ui: "ui/index.html" },
    permissions: [...STARTER_PERMISSIONS],
    contributes: { views: [{ id: "main", title: [...name].slice(0, MAX_VIEW_TITLE_CHARACTERS).join(""), entry: "ui/index.html", presentations: ["tab"], defaultPresentation: "tab" }] }
  };
}
function starterFiles(manifest) {
  return /* @__PURE__ */ new Map([
    ["manifest.json", `${JSON.stringify(manifest, null, 2)}
`],
    ["README.md", fill(README_md_default, manifest.name, (text2) => text2)],
    ["ui/index.html", fill(index_html_default, manifest.name, escapeHtml)],
    ["ui/app.js", app_js_default],
    ["ui/style.css", style_css_default]
  ]);
}
function starterIdentity(directory, flags, UsageError2) {
  const explicitId = flags.get("--id");
  const explicitPublisher = flags.get("--publisher");
  if (explicitId === void 0) {
    const publisher = explicitPublisher ?? STARTER_DEFAULT_PUBLISHER;
    return { id: `${publisher}.${slugOf(path10.basename(directory))}`, publisher };
  }
  const dot = explicitId.indexOf(".");
  if (dot <= 0) throw new UsageError2("--id must look like <publisher>.<name>, for example alice.my-notes");
  return { id: explicitId, publisher: explicitPublisher ?? explicitId.slice(0, dot) };
}
function reservedIdMessage(id, publisher) {
  if (!id.startsWith("teamuq.") && publisher !== "teamuq" && !isDevkitReservedId(id)) return null;
  return `the id ${id} and the publisher teamuq are reserved for official TeamUQ plugins (id_reserved); use your own publisher name. This tool checks only the names it can know offline: when you install, Core also refuses any id that ships with TeamUQ itself (the pre-installed plugins and the items of the bundled kits), so pick an id of your own`;
}
async function assertEmptyOrMissing(directory, UsageError2) {
  const stat = await fs11.stat(directory).catch(() => null);
  if (stat === null) return;
  if (!stat.isDirectory()) throw new UsageError2(`${directory} exists and is not a folder`);
  if ((await fs11.readdir(directory)).length > 0) throw new UsageError2(`${directory} is not empty; init never overwrites, so pick a new folder`);
}
async function writeStarterFiles(directory, files, validate) {
  const written = [];
  const createdDirectories = [];
  try {
    for (const [relative, text2] of files) {
      const target = path10.join(directory, ...relative.split("/"));
      const created = await fs11.mkdir(path10.dirname(target), { recursive: true });
      if (created !== void 0) createdDirectories.push(created);
      await fs11.writeFile(target, text2, { encoding: "utf8", flag: "wx" });
      written.push(target);
    }
    const { problems } = await validate(directory);
    if (problems.length > 0) throw new Error(`the starter did not pass validate: ${problems.join("; ")}`);
  } catch (error) {
    for (const file of written) await fs11.rm(file, { force: true }).catch(() => void 0);
    for (const created of createdDirectories.reverse()) await fs11.rmdir(created).catch(() => void 0);
    throw error;
  }
}
async function runInit(argv, { parse: parse2, UsageError: UsageError2, show: show2, schema, validate }) {
  const { positional, flags } = parse2(argv, ["--name", "--id", "--publisher"]);
  if (positional.length !== 1) throw new UsageError2("init needs exactly one new folder: init <newFolder> [--name <display name>] [--publisher <your name>] [--id <publisher.name>]");
  const directory = path10.resolve(positional[0]);
  const { id, publisher } = starterIdentity(directory, flags, UsageError2);
  const refusal = reservedIdMessage(id, publisher);
  if (refusal !== null) throw new UsageError2(refusal);
  const manifest = starterManifest({ id, publisher, name: flags.get("--name") ?? STARTER_DEFAULT_NAME, coreVersionRange: ">=1.6.0" });
  const checked = schema.safeParse(manifest);
  if (!checked.success) throw new UsageError2(`these names cannot be used in a manifest: ${checked.error.issues.map((issue2) => `${issue2.path.join(".") || "(root)"}: ${issue2.message}`).join("; ")}`);
  await assertEmptyOrMissing(directory, UsageError2);
  const files = starterFiles(manifest);
  await writeStarterFiles(directory, files, validate);
  show2({ folder: directory, id, publisher, name: manifest.name, version: manifest.version, trustTier: manifest.trustTier, permissions: manifest.permissions, files: [...files.keys()] });
  console.error([
    `created ${directory}`,
    "next:",
    "  1. edit the files (README.md inside the folder says what each one does; the text is in Traditional Chinese)",
    `  2. node tuq-plugin-tool.mjs validate ${positional[0]}`,
    `  3. node tuq-plugin-tool.mjs pack ${positional[0]} --unsigned`,
    `  4. in TeamUQ open 我的 AI > 外掛, expand 更多與進階, press ${STARTER_BUTTON_LABEL}, then pick the .tuqplugin file that pack wrote next to the folder`
  ].join("\n"));
  return 0;
}

// .teamuq/scripts/plugin-tools/tuq-plugin-tool.entry.ts
var CORE_VERSION = "1.7.1";
var MAX_MANIFEST_BYTES2 = 256 * 1024;
var MAX_OVERRIDE_BYTES = 256 * 1024;
var KEY_FILE_SUFFIX = ".key.pem";
var PLUGIN_EXTENSION = ".tuqplugin";
var FILE_KINDS = ["code", "asset", "native", "payload"];
var USAGE = [
  `tuq-plugin-tool (built from TeamUQ Core ${CORE_VERSION})
${INIT_USAGE}`,
  "  validate <stageDir> [--core-version v] [--platform id] [--os-version v]",
  "  pack <stageDir> --unsigned [--out file] [--overrides file.json] [--core-version v] [--platform id] [--os-version v]  (no key and no passphrase: the package carries no signature.json, Core installs it and labels it unsigned)",
  "  pack <stageDir> --key <file> [--key-id id] [--out file] [--anchors core|self] [--overrides file.json] [--delegation delegation.json [--root-pub-file file.pub.json] [--unlock-dpapi <keyId>.unlock.dpapi]] [--core-version v] [--platform id] [--os-version v]",
  "  pack-batch --jobs <jobs.json> --key <file> [--key-id id] [--anchors core|self] [--delegation delegation.json [--root-pub-file file.pub.json] [--unlock-dpapi <keyId>.unlock.dpapi]] [--core-version v] [--platform id] [--os-version v]  (signs every job with ONE passphrase prompt; jobs.json is a JSON array of { stage, out, overrides?, delegation? }; relative paths in it are relative to the folder of jobs.json, not to the current directory)",
  "  verify <file.tuqplugin> [--anchors core|self] [--pub-file file.pub.json | --key-id id --public-key base64 | --root-pub-file file.pub.json] [--preplanted-id teamuq.<name>] [--core-version v] [--platform id] [--os-version v]",
  "delegation: with --delegation the package is signed by a teamuq-release-* key and carries that certificate; the certificate and the stage manifest are checked (expiry, window, scope) before the passphrase is asked. With --anchors self the certificate is judged against the test root key in --root-pub-file.",
  "unlock-dpapi: a release key (teamuq-release-*) can be unlocked without a prompt from its Windows DPAPI file (made by release-key-init); no other key can. A teamuq-* key (root or release) never takes its passphrase from the environment; the test variable works only for keys that are not teamuq-*.",
  "  release-key-init --key-id teamuq-release-<name> --out-dir <directory outside git work trees and cloud folders>  (Windows only: random passphrase kept in a DPAPI file next to the key; nothing is typed or printed)",
  "  dev-keygen --out-dir <directory outside git work trees>",
  "  dev-pack <stageDir> --key <encrypted-dev-key.pem> --out <file.tuqplugin> --bump-patch [--preplanted-id teamuq.<name>]",
  "preplanted-id lets a development key sign a TeamUQ pre-planted plugin id for the isolated Core dev profile; a packaged or non-isolated Core rejects the result with id_reserved.",
  "  types --out <plugin-repo/types>",
  "  selftest-key --key <file> [--key-id id]",
  DELEGATION_USAGE,
  "anchors core (default) trusts only the TEAMUQ_TRUST_ANCHORS embedded in this tool; anchors self trusts only your own key and is for development.",
  "The key passphrase is typed at an interactive prompt and is never accepted as an argument."
].join("\n");
var UsageError = class extends Error {
};
function parse(argv, allowed, booleanFlags = []) {
  const positional = [];
  const flags = /* @__PURE__ */ new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    if (/pass/iu.test(token)) throw new UsageError("the passphrase is never accepted on the command line");
    if (!allowed.includes(token)) throw new UsageError(`unknown option ${token}`);
    if (booleanFlags.includes(token)) {
      if (flags.has(token)) throw new UsageError(`${token} was given twice`);
      flags.set(token, "true");
      continue;
    }
    const value = argv[index + 1];
    if (value === void 0 || value.startsWith("--")) throw new UsageError(`${token} needs a value`);
    if (flags.has(token)) throw new UsageError(`${token} was given twice`);
    flags.set(token, value);
    index += 1;
  }
  return { positional, flags };
}
function supportContext(flags) {
  const id = flags.get("--platform") ?? `${process.platform}-${process.arch}`;
  const osVersion = flags.get("--os-version") ?? (process.platform === "win32" ? os3.release().split(".")[2] : void 0);
  return { coreVersion: flags.get("--core-version") ?? CORE_VERSION, platform: osVersion === void 0 ? { id } : { id, osVersion } };
}
function show(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}
`);
}
async function isRegularFile(file) {
  try {
    return (await fs12.lstat(file)).isFile();
  } catch {
    return false;
  }
}
async function validateStage(stageDir, support) {
  const problems = [];
  const stat = await fs12.stat(stageDir).catch(() => null);
  if (stat === null || !stat.isDirectory()) return { problems: [`${stageDir} is not a directory`] };
  const manifestFile = path11.join(stageDir, "manifest.json");
  if (!await isRegularFile(manifestFile)) return { problems: ["manifest.json is missing from the stage directory"] };
  const bytes4 = await fs12.readFile(manifestFile);
  if (bytes4.length > MAX_MANIFEST_BYTES2) return { problems: [`manifest.json is larger than ${MAX_MANIFEST_BYTES2} bytes`] };
  let json;
  try {
    json = JSON.parse(bytes4.toString("utf8"));
  } catch {
    return { problems: ["manifest.json is not valid JSON"] };
  }
  const parsed = PluginManifestV2Schema.safeParse(json);
  if (!parsed.success) return { problems: parsed.error.issues.map((issue2) => `manifest ${issue2.path.join(".") || "(root)"}: ${issue2.message}`) };
  const manifest = parsed.data;
  for (const issue2 of evaluateManifestSupport(manifest, support)) problems.push(`support ${issue2.code} ${issue2.field}: ${issue2.message}`);
  const referenced = [
    ...manifest.entry.ui === void 0 ? [] : [manifest.entry.ui],
    ...manifest.entry.backend === void 0 ? [] : [manifest.entry.backend],
    ...manifest.contributes.views.flatMap((view) => [view.entry, ...view.icon === void 0 ? [] : [view.icon]]),
    ...manifest.native?.files.map((file) => file.path) ?? []
  ];
  for (const relative of new Set(referenced)) {
    if (!await isRegularFile(path11.join(stageDir, ...relative.split("/")))) problems.push(`manifest references ${relative}, which is not a regular file in the stage directory`);
  }
  return { manifest, problems };
}
async function nearestRealPath(target) {
  let current = path11.resolve(target);
  const tail = [];
  for (; ; ) {
    try {
      return path11.join(await fs12.realpath(current), ...tail);
    } catch {
      const parent = path11.dirname(current);
      if (parent === current) return path11.resolve(target);
      tail.unshift(path11.basename(current));
      current = parent;
    }
  }
}
async function assertOutsideStage(stageDir, outFile) {
  const stage = await nearestRealPath(stageDir);
  const out = await nearestRealPath(outFile);
  const relative = path11.relative(stage, out);
  if (relative === "" || !relative.startsWith("..") && !path11.isAbsolute(relative)) throw new UsageError(`the output ${outFile} is inside the stage directory ${stageDir}; the next pack would ship the old .tuqplugin as a file of the plugin`);
}
async function readOverrides(file) {
  if (file === void 0) return void 0;
  const stat = await fs12.stat(file);
  if (!stat.isFile() || stat.size > MAX_OVERRIDE_BYTES) throw new UsageError(`${file} is not an overrides file`);
  const parsed = JSON.parse(await fs12.readFile(file, "utf8"));
  if (!Array.isArray(parsed)) throw new UsageError("overrides must be a JSON array of { path, kind, platform? }");
  return parsed.map((item) => {
    const entry = item;
    if (typeof entry?.path !== "string" || !FILE_KINDS.includes(entry.kind)) throw new UsageError(`bad override ${JSON.stringify(item)}: path must be a string and kind one of ${FILE_KINDS.join(", ")}`);
    if (entry.platform !== void 0 && typeof entry.platform !== "string") throw new UsageError("override platform must be a string");
    return { path: entry.path, kind: entry.kind, ...entry.platform === void 0 ? {} : { platform: entry.platform } };
  });
}
function keyIdFrom(flags, keyFile) {
  const explicit = flags.get("--key-id");
  const base = path11.basename(keyFile);
  const keyId2 = explicit ?? (base.endsWith(KEY_FILE_SUFFIX) ? base.slice(0, -KEY_FILE_SUFFIX.length) : void 0);
  if (keyId2 === void 0) throw new UsageError("--key-id is required when the key file is not named <keyId>.key.pem");
  try {
    assertReleaseKeyId(keyId2);
  } catch (error) {
    throw new UsageError(error.message);
  }
  return keyId2;
}
function preplantedPolicy(flags) {
  const id = flags.get("--preplanted-id");
  if (id === void 0) return void 0;
  const policy = createAuthoringDevTrustPolicy(id);
  if (policy === null) throw new UsageError("--preplanted-id must be a TeamUQ plugin id starting with teamuq.");
  return policy;
}
function selfAnchors(keyId2, publicKey) {
  return { rootKeys: [{ keyId: keyId2, publicKey }], revokedKeyIds: [] };
}
async function readDelegationFile(file) {
  const stat = await fs12.stat(file).catch(() => null);
  if (stat === null || !stat.isFile() || stat.size === 0 || stat.size > MAX_DELEGATION_BYTES2) throw new UsageError(`${file} is not a delegation.json (a regular file of 1 to ${MAX_DELEGATION_BYTES2} bytes)`);
  return fs12.readFile(file);
}
function certificateAnchors(flags) {
  try {
    return anchorsFor(flags, { coreAnchors: TEAMUQ_TRUST_ANCHORS }).anchors;
  } catch (error) {
    if (error instanceof UsageProblem) throw new UsageError(error.message);
    throw error;
  }
}
function assertKeyMatchesMode(keyId2, delegated) {
  if (delegated) {
    try {
      assertDelegatedKeyId(keyId2);
    } catch (error) {
      throw new UsageError(`--delegation needs a release key: ${error.message}`);
    }
  } else if (keyId2.startsWith(RELEASE_KEY_PREFIX2)) throw new UsageError(`${keyId2} is a release key and signs only together with its certificate: add --delegation <delegation.json>`);
}
function assertNotRootKeyUnlockedSilently(source, publicKey) {
  if ((source === "env" || source === "dpapi") && TEAMUQ_TRUST_ANCHORS.rootKeys.some((root) => root.publicKey === publicKey)) throw new UnlockRefused("refused: this private key is one of the TeamUQ root keys embedded in this tool, and a root key is unlocked only by typing its passphrase at the prompt; nothing was signed");
}
function unlockFileFlag(flags, keyId2, keyFile, delegated) {
  const given = flags.get("--unlock-dpapi");
  if (given === void 0) return void 0;
  if (!delegated) throw new UsageError("--unlock-dpapi is only for a release key signing with --delegation");
  assertUnlockAllowedFor(keyId2);
  const file = path11.resolve(given);
  assertNotSyncedFolder(file, "unlock file");
  assertNotSyncedFolder(keyFile, "key file");
  return file;
}
async function checkDelegation(file, keyId2, anchors, manifest, stageDir) {
  if (await pathExists(path11.join(stageDir, "delegation.json"))) throw new UsageError(`delegation.json is generated and must not be in the stage directory ${stageDir}`);
  const bytes4 = await readDelegationFile(file);
  if (anchors.revokedKeyIds.includes(keyId2)) throw new ArtifactError("signer_revoked", `${keyId2} is in the revokedKeyIds of the trust anchors this tool uses; it must not sign again`);
  const verified = verifyDelegation(keyId2, anchors, { delegationBytes: bytes4, now: delegationNow(() => /* @__PURE__ */ new Date()), expiry: "enforce" });
  assertDelegationScope({ kind: "teamuq", keyId: keyId2, delegation: verified.grant }, manifest);
  return { bytes: bytes4, publicKey: verified.publicKey.toString("base64") };
}
function assertKeyIsCertified(keyFile, keyId2, actual, certified) {
  if (actual !== certified) throw new Error(`refused: the private key in ${keyFile} is not the ${keyId2} key that the certificate names (the public keys differ); nothing was written`);
}
async function withSelfDevKey(publicKey, run) {
  const root = await fs12.mkdtemp(path11.join(os3.tmpdir(), "tuq-plugin-self-trust-"));
  const store = createDevKeyStore({ pluginsRoot: root });
  try {
    await store.add({ publicKey, label: "Local self verification" });
    return await run(store);
  } finally {
    await fs12.rm(root, { recursive: true, force: true });
  }
}
async function commandDevKeygen(argv) {
  const { positional, flags } = parse(argv, ["--out-dir"]);
  const output = flags.get("--out-dir");
  if (positional.length !== 0 || output === void 0) throw new UsageError("dev-keygen needs --out-dir <directory>");
  const directory = path11.resolve(output);
  assertOutsideGitWorkTree(directory, "development key directory");
  await fs12.mkdir(directory, { recursive: true });
  const passphrase = await readNewPassphrase();
  const pair = generateEncryptedDevKeyPair(passphrase);
  const publicKey = describePublicKey(createPublicKey6({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pair.raw]), format: "der", type: "spki" })).publicKey;
  const keyFile = path11.join(directory, `${pair.keyId}.key.pem`);
  const publicFile = path11.join(directory, `${pair.keyId}.pub.json`);
  let privateCreated = false;
  try {
    const privateHandle = await fs12.open(keyFile, "wx", 384);
    privateCreated = true;
    await privateHandle.writeFile(pair.privatePem, "utf8");
    await privateHandle.close();
    const publicHandle = await fs12.open(publicFile, "wx", 384);
    await publicHandle.writeFile(`${JSON.stringify({ keyId: pair.keyId, publicKey }, null, 2)}
`, "utf8");
    await publicHandle.close();
  } catch (error) {
    if (privateCreated) await fs12.rm(keyFile, { force: true }).catch(() => void 0);
    throw error;
  }
  selfCheck(loadEncryptedPrivateKey(pair.privatePem, passphrase), pair.raw);
  const fingerprint = createHash9("sha256").update(pair.raw).digest("hex");
  const identity = deriveKeyIdentity(fingerprint);
  const identityFile = path11.join(directory, `${pair.keyId}.identity.txt`);
  const identityText = [
    "開發者識別（請放進你的外掛說明檔，讓使用者安裝時核對）",
    `短代碼：${identity.shortCode}`,
    "圖案：",
    renderKeyIdentityText(identity),
    `金鑰識別碼：${pair.keyId}`,
    `完整指紋（SHA-256）：${fingerprint}`,
    ""
  ].join("\n");
  await fs12.writeFile(identityFile, identityText, { encoding: "utf8", flag: "wx", mode: 420 });
  show({ keyId: pair.keyId, privateKey: keyFile, publicKey: publicFile, identityFile, shortCode: identity.shortCode, fingerprint, passphrase: "interactive only" });
  return 0;
}
function bumpedPatch(version2) {
  const match = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/u.exec(version2);
  if (match === null) throw new UsageError(`cannot bump non-semver version ${version2}`);
  const patch = Number(match[3]) + 1;
  if (patch > 999999) throw new UsageError(`patch version is at its maximum: ${version2}`);
  return `${match[1]}.${match[2]}.${patch}`;
}
async function commandDevPack(argv) {
  const { positional, flags } = parse(argv, ["--key", "--out", "--core-version", "--platform", "--os-version", "--bump-patch", "--preplanted-id"], ["--bump-patch"]);
  if (positional.length !== 1 || flags.get("--bump-patch") !== "true") throw new UsageError("dev-pack needs <stageDir> --key <encrypted-dev-key.pem> --out <file.tuqplugin> --bump-patch");
  const keyFile = flags.get("--key");
  const outArg = flags.get("--out");
  if (keyFile === void 0 || outArg === void 0) throw new UsageError("dev-pack needs --key and --out");
  const stageDir = path11.resolve(positional[0]);
  const outFile = path11.resolve(outArg);
  assertOutsideGitWorkTree(keyFile, "development signing key");
  await assertOutsideStage(stageDir, outFile);
  const support = supportContext(flags);
  const devTrust = preplantedPolicy(flags);
  const staged = await validateStage(stageDir, support);
  if (staged.manifest === void 0 || staged.problems.length > 0) {
    for (const problem of staged.problems) console.error(`invalid: ${problem}`);
    return 1;
  }
  const key2 = loadEncryptedPrivateKey(readKeyFile(keyFile), await readPassphrase("Passphrase for local development key: "));
  const description = describePublicKey(createPublicKey6(key2));
  const keyId2 = assertDevKeyId(`dev-${createHash9("sha256").update(description.raw).digest("hex").slice(0, 16)}`, description.raw);
  selfCheck(key2, description.raw);
  const identity = path11.basename(keyFile);
  if (identity !== `${keyId2}.key.pem`) throw new UsageError(`development key id mismatch: file name must be ${keyId2}.key.pem`);
  let version2 = bumpedPatch(staged.manifest.version);
  if (await isRegularFile(outFile)) {
    await withSelfDevKey(description.publicKey, async (devKeys) => {
      const previous = await verifyArtifactFile(outFile, { anchors: { rootKeys: [], revokedKeyIds: [] }, devKeys, support, ...devTrust === void 0 ? {} : { devTrust } });
      if (previous.manifest.id !== staged.manifest?.id) throw new UsageError("existing output artifact belongs to a different plugin id");
      version2 = bumpedPatch(previous.manifest.version);
    });
  }
  const scratch = await fs12.mkdtemp(path11.join(os3.tmpdir(), "tuq-plugin-dev-pack-"));
  const copiedStage = path11.join(scratch, "stage");
  try {
    await fs12.cp(stageDir, copiedStage, { recursive: true, errorOnExist: true, force: false });
    const manifestFile = path11.join(copiedStage, "manifest.json");
    const manifest = JSON.parse(await fs12.readFile(manifestFile, "utf8"));
    manifest.version = version2;
    await fs12.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}
`, "utf8");
    const packed = await withSelfDevKey(description.publicKey, (devKeys) => packArtifact({
      stageDir: copiedStage,
      outFile,
      signer: { keyId: keyId2, key: key2 },
      review: { anchors: { rootKeys: [], revokedKeyIds: [] }, devKeys, support, ...devTrust === void 0 ? {} : { devTrust } }
    }));
    show({ file: packed.file, id: packed.verified.manifest.id, version: packed.verified.manifest.version, signer: packed.verified.signer, anchors: "self", sha256: packed.sha256, integritySha256: packed.verified.integritySha256, stageChanged: false });
  } finally {
    await fs12.rm(scratch, { recursive: true, force: true });
  }
  return 0;
}
var SDK_TYPES = "declare module '@teamuq/plugin-sdk' {\nexport type JsonValue = null | boolean | number | string | JsonValue[] | {\n    [key: string]: JsonValue;\n};\nexport interface PluginBackendApiV1 {\n    call(method: string, params: JsonValue): Promise<JsonValue>;\n}\nexport type PluginAgentAvatarResultV1 = Readonly<{\n    protocolVersion: 1;\n    image: Readonly<{\n        mimeType: 'image/png' | 'image/jpeg' | 'image/webp';\n        bytes: Uint8Array;\n    }> | null;\n}>;\nexport interface PluginAgentAvatarApiV1 {\n    read(agentId: string): Promise<PluginAgentAvatarResultV1['image']>;\n}\nexport interface PluginStoreStatusViewV1 {\n    readonly state: 'disabled' | 'fresh' | 'stale' | 'offline' | 'untrusted';\n    readonly ageSec: number | null;\n    readonly acquirable: boolean;\n}\nexport interface PluginStorePreviewViewV1 {\n    readonly role: 'cover' | 'video' | 'voice';\n    readonly mime: string;\n    readonly sizeBytes: number;\n    readonly width: number | null;\n    readonly height: number | null;\n    readonly durationMs: number | null;\n    readonly url: string;\n}\nexport interface PluginStoreEntryViewV1 {\n    readonly entryId: string;\n    readonly packId: string;\n    readonly version: string;\n    readonly name: string;\n    readonly summary: string;\n    readonly tags: readonly string[];\n    readonly creator: string;\n    readonly downloadBytes: number;\n    readonly installedBytes: number;\n    readonly consentLabel: string | null;\n}\nexport interface PluginStoreEntryDetailViewV1 extends PluginStoreEntryViewV1 {\n    readonly description: string;\n    readonly previews: readonly PluginStorePreviewViewV1[];\n}\nexport interface PluginStoreListViewV1 {\n    readonly entries: readonly PluginStoreEntryViewV1[];\n    readonly nextCursor: string | null;\n}\nexport interface PluginStoreListQueryV1 {\n    readonly text?: string;\n    readonly tags?: readonly string[];\n    readonly cursor?: string | null;\n    readonly limit?: number;\n}\nexport interface PluginStoreNoticeV1 {\n    readonly title: string;\n    readonly body: string;\n}\nexport interface PluginStoreInstalledViewV1 {\n    readonly entryId: string;\n    readonly packId: string;\n    readonly version: string;\n    readonly state: 'ready' | 'hidden' | 'disabled' | 'removed';\n    readonly withdrawnReason: string | null;\n    readonly notice: PluginStoreNoticeV1 | null;\n    readonly previousVersion: string | null;\n}\nexport interface PluginStorePendingViewV1 {\n    readonly entryId: string;\n    readonly version: string;\n    readonly bytesReceived: number;\n    readonly bytesTotal: number | null;\n    readonly stale: boolean;\n    readonly active: boolean;\n}\nexport interface PluginStoreUpdateViewV1 {\n    readonly entryId: string;\n    readonly packId: string;\n    readonly installedVersion: string;\n    readonly version: string;\n}\nexport interface PluginStorePreflightViewV1 {\n    readonly downloadBytes: number;\n    readonly installedBytes: number;\n    readonly neededBytes: number;\n    readonly reserveBytes: number;\n    readonly freeBytes: number;\n    readonly enough: boolean;\n}\nexport interface PluginStoreErrorTextViewV1 {\n    readonly title: string;\n    readonly body: string;\n    readonly steps: readonly string[];\n    readonly named: boolean;\n}\nexport type PluginStoreAcquireOutcomeV1 = Readonly<{\n    status: 'installed' | 'updated';\n    packId: string;\n    version: string;\n    name: string;\n}> | Readonly<{\n    status: 'cancelled';\n}>;\nexport interface PluginStoreProgressViewV1 {\n    readonly entryId: string;\n    readonly stage: 'downloading' | 'verifying' | 'installing';\n    readonly bytesReceived: number;\n    readonly bytesTotal: number | null;\n    readonly retry: Readonly<{\n        attempt: number;\n        max: number;\n    }> | null;\n}\nexport interface PluginStoreChangeViewV1 {\n    readonly entryId: string;\n    readonly state: 'installed' | 'updated' | 'hidden' | 'disabled' | 'removed';\n    readonly withdrawnReason: string | null;\n    readonly notice: PluginStoreNoticeV1 | null;\n}\nexport type PluginStoreRollbackOutcomeV1 = Readonly<{\n    status: 'rolled_back';\n    packId: string;\n    version: string;\n    name: string;\n}> | Readonly<{\n    status: 'cancelled';\n}> | Readonly<{\n    status: 'no_previous';\n}>;\nexport interface PluginStoreApiV1 {\n    status(options?: Readonly<{\n        refresh?: boolean;\n    }>): Promise<PluginStoreStatusViewV1>;\n    list(query?: PluginStoreListQueryV1): Promise<PluginStoreListViewV1>;\n    get(entryId: string): Promise<PluginStoreEntryDetailViewV1 | null>;\n    installed(): Promise<readonly PluginStoreInstalledViewV1[]>;\n    pending(): Promise<readonly PluginStorePendingViewV1[]>;\n    updates(): Promise<readonly PluginStoreUpdateViewV1[]>;\n    preflight(entryId: string): Promise<PluginStorePreflightViewV1>;\n    acquire(entryId: string): Promise<PluginStoreAcquireOutcomeV1>;\n    cancel(entryId: string): Promise<void>;\n    discard(entryId: string): Promise<void>;\n    rollback(entryId: string): Promise<PluginStoreRollbackOutcomeV1>;\n    errorText(code: string): Promise<PluginStoreErrorTextViewV1 | null>;\n    onProgress(listener: (progress: PluginStoreProgressViewV1) => void): () => void;\n    onChange(listener: (change: PluginStoreChangeViewV1) => void): () => void;\n}\n}\ninterface Window { tuqPlugin: { backend: import('@teamuq/plugin-sdk').PluginBackendApiV1; store: import('@teamuq/plugin-sdk').PluginStoreApiV1; agentAvatar: import('@teamuq/plugin-sdk').PluginAgentAvatarApiV1 } }\ndeclare module '@teamuq/plugin-sdk/external' {\nexport interface PluginHostApiV1 {\n    readonly workRecords: Readonly<{\n        openSettledSnapshot(): Promise<{\n            snapshotId: string;\n            generation: string;\n            highWatermark: string | null;\n        }>;\n        readSettledPage(request: {\n            snapshotId: string;\n            cursor: string | null;\n            limit: number;\n        }): Promise<{\n            snapshot: {\n                snapshotId: string;\n                generation: string;\n                highWatermark: string | null;\n            };\n            records: Array<{\n                id: string;\n                agentId: string;\n                projectId: string | null;\n                sessionId: string | null;\n                providerId: string | null;\n                punchId: string;\n                punchType: 'main' | 'subagent';\n                startedAtMs: number;\n                endedAtMs: number;\n                model: string | null;\n                name: string | null;\n                description: string | null;\n            }>;\n            nextCursor: string | null;\n        }>;\n        subscribeSettledChanges(listener: (event: {\n            protocolVersion: 1;\n            kind: 'ext-capability-event';\n            capabilityId: 'teamuq.work-records@1';\n            event: 'settled-changed';\n            generation: string;\n            highWatermark: string | null;\n        }) => void): () => void;\n    }>;\n    readonly agentDirectory: Readonly<{\n        openSnapshot(): Promise<{\n            snapshotId: string;\n            generation: string;\n            highWatermark: string | null;\n        }>;\n        readPage(request: {\n            snapshotId: string;\n            cursor: string | null;\n            limit: number;\n        }): Promise<{\n            snapshot: {\n                snapshotId: string;\n                generation: string;\n                highWatermark: string | null;\n            };\n            entries: Array<{\n                id: string;\n                name: string;\n                teamKey: string;\n                teamName: string | null;\n                title: string;\n                enabled: boolean;\n            }>;\n            nextCursor: string | null;\n        }>;\n    }>;\n    readonly projectDirectory: Readonly<{\n        openSnapshot(): Promise<{\n            snapshotId: string;\n            generation: string;\n            highWatermark: string | null;\n        }>;\n        readPage(request: {\n            snapshotId: string;\n            cursor: string | null;\n            limit: number;\n        }): Promise<{\n            snapshot: {\n                snapshotId: string;\n                generation: string;\n                highWatermark: string | null;\n            };\n            entries: Array<{\n                id: string;\n                name: string;\n                archived: boolean;\n            }>;\n            nextCursor: string | null;\n        }>;\n    }>;\n    readonly pluginState: Readonly<{\n        readPage(namespace: string, cursor: string | null, limit: number): Promise<{\n            records: Array<{\n                key: string;\n                value: unknown;\n                sourceKind?: string | null;\n                sourceId?: string | null;\n                revision: number;\n            }>;\n            nextCursor: string | null;\n        }>;\n        writeBatch(namespace: string, records: readonly {\n            key: string;\n            value: unknown;\n            sourceKind?: string | null;\n            sourceId?: string | null;\n            expectedRevision?: number | null;\n        }[]): Promise<void>;\n        deleteBatch(namespace: string, keys: readonly string[]): Promise<void>;\n    }>;\n}\nexport type PluginBackendContextV1 = Readonly<{\n    readonly pluginId: string;\n    readonly dataDir: string;\n    readonly assetPacks: Readonly<Record<string, string>>;\n    readonly allowAddons: boolean;\n    readonly host: PluginHostApiV1;\n    readonly settings: Readonly<{\n        all(): Readonly<Record<string, boolean | number | string>>;\n        get(key: string): boolean | number | string | undefined;\n        onChange(listener: (values: Readonly<Record<string, boolean | number | string>>) => void): () => void;\n    }>;\n}>;\n}\n";
async function commandTypes(argv) {
  const { positional, flags } = parse(argv, ["--out"]);
  const output = flags.get("--out");
  if (positional.length !== 0 || output === void 0) throw new UsageError("types needs --out <plugin-repo/types>");
  const directory = path11.resolve(output);
  const declaration = SDK_TYPES.replace(/\r\n/gu, "\n");
  const sha2562 = createHash9("sha256").update(declaration).digest("hex");
  await fs12.mkdir(directory, { recursive: true });
  await fs12.writeFile(path11.join(directory, "tuq-plugin-sdk.d.ts"), declaration, "utf8");
  const metadata = { contractVersion: "1", coreVersion: CORE_VERSION, file: "tuq-plugin-sdk.d.ts", sha256: sha2562 };
  await fs12.writeFile(path11.join(directory, "tuq-plugin-sdk.version.json"), `${JSON.stringify(metadata, null, 2)}
`, "utf8");
  show(metadata);
  return 0;
}
function anchorMode(flags) {
  const mode = flags.get("--anchors") ?? "core";
  if (mode !== "core" && mode !== "self") throw new UsageError("--anchors must be core or self");
  return mode;
}
async function commandValidate(argv) {
  const { positional, flags } = parse(argv, ["--core-version", "--platform", "--os-version"]);
  if (positional.length !== 1) throw new UsageError("validate needs exactly one stage directory");
  const support = supportContext(flags);
  const result = await validateStage(path11.resolve(positional[0]), support);
  if (result.manifest === void 0 || result.problems.length > 0) {
    for (const problem of result.problems) console.error(`invalid: ${problem}`);
    return 1;
  }
  show({ ok: true, id: result.manifest.id, version: result.manifest.version, kind: result.manifest.kind, trustTier: result.manifest.trustTier, coreVersion: support.coreVersion, platform: support.platform.id });
  return 0;
}
async function commandPack(argv, deps) {
  const { positional, flags } = parse(argv, ["--key", "--key-id", "--out", "--anchors", "--overrides", "--delegation", "--root-pub-file", "--unlock-dpapi", "--core-version", "--platform", "--os-version", "--unsigned"], ["--unsigned"]);
  if (positional.length !== 1) throw new UsageError("pack needs exactly one stage directory");
  const unsigned = flags.get("--unsigned") === "true";
  const keyFile = flags.get("--key");
  if (unsigned && ["--key", "--key-id", "--anchors", "--delegation", "--root-pub-file", "--unlock-dpapi"].some((flag) => flags.has(flag))) throw new UsageError("--unsigned takes no key and no certificate: leave out --key, --key-id, --anchors, --delegation, --root-pub-file and --unlock-dpapi");
  if (!unsigned && keyFile === void 0) throw new UsageError("--key is required (or pass --unsigned to pack without a key)");
  const stageDir = path11.resolve(positional[0]);
  const support = supportContext(flags);
  const staged = await validateStage(stageDir, support);
  if (staged.manifest === void 0 || staged.problems.length > 0) {
    for (const problem of staged.problems) console.error(`invalid: ${problem}`);
    return 1;
  }
  if (unsigned) return packUnsigned(stageDir, staged.manifest, flags, support);
  if (keyFile === void 0) throw new UsageError("--key is required");
  const mode = anchorMode(flags);
  const keyId2 = keyIdFrom(flags, keyFile);
  const delegationFile = flags.get("--delegation");
  if (delegationFile === void 0 && flags.has("--root-pub-file")) throw new UsageError("--root-pub-file is only for --delegation");
  assertKeyMatchesMode(keyId2, delegationFile !== void 0);
  const unlockFile = unlockFileFlag(flags, keyId2, keyFile, delegationFile !== void 0);
  if (delegationFile === void 0 && mode === "core" && !TEAMUQ_TRUST_ANCHORS.rootKeys.some((root) => root.keyId === keyId2)) {
    console.error(`refused: keyId ${keyId2} is not one of the ${TEAMUQ_TRUST_ANCHORS.rootKeys.length} TEAMUQ_TRUST_ANCHORS embedded in this tool; the Core would reject the package. Use --anchors self while developing.`);
    return 1;
  }
  assertOutsideGitWorkTree(keyFile, "key file");
  const outFile = path11.resolve(flags.get("--out") ?? path11.join(path11.dirname(stageDir), `${staged.manifest.id}-${staged.manifest.version}${PLUGIN_EXTENSION}`));
  await assertOutsideStage(stageDir, outFile);
  const overrides = await readOverrides(flags.get("--overrides"));
  const delegatedAnchors = delegationFile === void 0 ? void 0 : certificateAnchors(flags);
  const certificate = delegationFile === void 0 || delegatedAnchors === void 0 ? void 0 : await checkDelegation(delegationFile, keyId2, delegatedAnchors, staged.manifest, stageDir);
  const pem = readKeyFile(keyFile);
  const unlocked = await obtainSigningPassphrase({ keyId: keyId2, question: `Passphrase for ${keyId2}: `, unlockFile, injected: deps.readPassphrase });
  const key2 = loadEncryptedPrivateKey(pem, unlocked.passphrase);
  const description = describePublicKey(createPublicKey6(key2));
  assertNotRootKeyUnlockedSilently(unlocked.source, description.publicKey);
  if (certificate !== void 0) assertKeyIsCertified(keyFile, keyId2, description.publicKey, certificate.publicKey);
  const anchors = delegatedAnchors ?? (mode === "self" ? selfAnchors(keyId2, description.publicKey) : TEAMUQ_TRUST_ANCHORS);
  const packed = await packArtifact({ stageDir, outFile, signer: { keyId: keyId2, key: key2 }, ...overrides === void 0 ? {} : { files: overrides }, ...certificate === void 0 ? {} : { delegation: certificate.bytes }, review: { anchors, support, isReservedId: isDevkitReservedId } });
  if (mode === "self") console.error(certificate === void 0 ? "warning: verified against your own key only (--anchors self); the Core accepts this package only if the keyId is in its TEAMUQ_TRUST_ANCHORS." : "warning: verified against the test root key of --root-pub-file (--anchors self); the Core accepts this package only if the certificate was signed by one of its TEAMUQ_TRUST_ANCHORS.");
  show({ file: packed.file, size: packed.size, sha256: packed.sha256, id: packed.verified.manifest.id, version: packed.verified.manifest.version, signer: packed.verified.signer, anchors: mode, fileCount: packed.verified.fileCount, totalBytes: packed.verified.totalBytes, integritySha256: packed.verified.integritySha256 });
  return 0;
}
async function packUnsigned(stageDir, manifest, flags, support) {
  const outFile = path11.resolve(flags.get("--out") ?? path11.join(path11.dirname(stageDir), `${manifest.id}-${manifest.version}${PLUGIN_EXTENSION}`));
  await assertOutsideStage(stageDir, outFile);
  const overrides = await readOverrides(flags.get("--overrides"));
  const packed = await packArtifact({ stageDir, outFile, signer: null, ...overrides === void 0 ? {} : { files: overrides }, review: { anchors: TEAMUQ_TRUST_ANCHORS, support, isOfficialId: isDevkitReservedId } });
  console.error("note: this package is unsigned; Core installs it and labels it unsigned, so nobody can tell who made it or whether it was changed after it left you. Pass --key to sign it.");
  show({ file: packed.file, size: packed.size, sha256: packed.sha256, id: packed.verified.manifest.id, version: packed.verified.manifest.version, signer: packed.verified.signer, anchors: "none", fileCount: packed.verified.fileCount, totalBytes: packed.verified.totalBytes, integritySha256: packed.verified.integritySha256 });
  return 0;
}
var MAX_BATCH_JOBS = 64;
async function readBatchJobs(file) {
  const stat = await fs12.stat(file);
  if (!stat.isFile() || stat.size > MAX_OVERRIDE_BYTES) throw new UsageError(`${file} is not a jobs file`);
  const parsed = JSON.parse(await fs12.readFile(file, "utf8"));
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_BATCH_JOBS) throw new UsageError(`jobs must be a JSON array of 1 to ${MAX_BATCH_JOBS} items { stage, out, overrides?, delegation? }`);
  const base = path11.dirname(path11.resolve(file));
  return parsed.map((item) => {
    const entry = item;
    if (typeof entry?.stage !== "string" || typeof entry.out !== "string" || entry.overrides !== void 0 && typeof entry.overrides !== "string" || entry.delegation !== void 0 && typeof entry.delegation !== "string") throw new UsageError(`bad job ${JSON.stringify(item)}: stage and out must be strings, overrides and delegation optional strings`);
    return { stageDir: path11.resolve(base, entry.stage), outFile: path11.resolve(base, entry.out), overridesFile: entry.overrides === void 0 ? void 0 : path11.resolve(base, entry.overrides), delegationFile: entry.delegation === void 0 ? void 0 : path11.resolve(base, entry.delegation) };
  });
}
async function pathExists(file) {
  return fs12.lstat(file).then(() => true, () => false);
}
async function outputIdentity(outFile) {
  return path11.join(await nearestRealPath(path11.dirname(outFile)), path11.basename(outFile)).toLowerCase();
}
async function assertOverridesMatchStage(stageDir, overrides, overridesFile) {
  if (overrides === void 0) return;
  const seen = /* @__PURE__ */ new Set();
  for (const override of overrides) {
    if (override.path === "manifest.json") throw new UsageError(`${overridesFile}: the kind of manifest.json is fixed and cannot be overridden`);
    if (seen.has(override.path)) throw new UsageError(`${overridesFile}: duplicate override for ${override.path}`);
    seen.add(override.path);
    const segments = override.path.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..") || !await isRegularFile(path11.join(stageDir, ...segments))) throw new UsageError(`${overridesFile}: override ${override.path} is not a regular file of the stage directory ${stageDir}`);
  }
}
function removeFiles(files) {
  const stuck = [];
  for (const file of files.splice(0)) {
    try {
      rmSync(file, { force: true });
    } catch {
      stuck.push(file);
    }
  }
  return stuck;
}
function removeScratches(state) {
  const doomed = [];
  for (const scratch of state.scratches.splice(0)) {
    doomed.push(scratch);
    const directory = path11.dirname(scratch);
    try {
      for (const name of readdirSync(directory)) if (name.startsWith(`${path11.basename(scratch)}.`) && name.endsWith(".partial")) doomed.push(path11.join(directory, name));
    } catch {
    }
  }
  return removeFiles(doomed);
}
async function publishWithoutOverwrite(scratch, destination, created) {
  const taken = () => new Error(`the output ${destination} appeared while pack-batch was running; pack-batch never overwrites, so it left that file untouched`);
  try {
    await fs12.link(scratch, destination);
  } catch (error) {
    if (error.code === "EEXIST") throw taken();
    const handle = await fs12.open(destination, "wx").catch((openError) => {
      throw openError.code === "EEXIST" ? taken() : openError;
    });
    created();
    try {
      await handle.writeFile(await fs12.readFile(scratch));
    } finally {
      await handle.close();
    }
    return;
  }
  created();
}
async function commandPackBatch(argv, deps) {
  const { positional, flags } = parse(argv, ["--key", "--key-id", "--jobs", "--anchors", "--delegation", "--root-pub-file", "--unlock-dpapi", "--core-version", "--platform", "--os-version"]);
  if (positional.length !== 0) throw new UsageError("pack-batch takes no positional argument; the stages are listed in the --jobs file");
  const keyFile = flags.get("--key");
  const jobsFile = flags.get("--jobs");
  if (keyFile === void 0 || jobsFile === void 0) throw new UsageError("pack-batch needs --key and --jobs");
  const jobs = await readBatchJobs(path11.resolve(jobsFile));
  const support = supportContext(flags);
  const outputs = /* @__PURE__ */ new Set();
  const overrideList = [];
  const manifests = [];
  for (const job of jobs) {
    const result = await validateStage(job.stageDir, support);
    if (result.manifest === void 0 || result.problems.length > 0) {
      for (const problem of result.problems) console.error(`invalid (${job.stageDir}): ${problem}`);
      return 1;
    }
    if (path11.extname(job.outFile).toLowerCase() !== PLUGIN_EXTENSION) throw new UsageError(`the output ${job.outFile} must end with ${PLUGIN_EXTENSION}`);
    const identity = await outputIdentity(job.outFile);
    if (outputs.has(identity)) throw new UsageError(`two jobs write the same output ${job.outFile}`);
    outputs.add(identity);
    if (await pathExists(job.outFile)) throw new UsageError(`the output ${job.outFile} already exists; pack-batch never overwrites (remove it first)`);
    const overrides = await readOverrides(job.overridesFile);
    await assertOverridesMatchStage(job.stageDir, overrides, job.overridesFile);
    overrideList.push(overrides);
    manifests.push(result.manifest);
  }
  for (const job of jobs) for (const other of jobs) await assertOutsideStage(other.stageDir, job.outFile);
  const mode = anchorMode(flags);
  const keyId2 = keyIdFrom(flags, keyFile);
  const certificateFiles = jobs.map((job) => job.delegationFile ?? (flags.has("--delegation") ? path11.resolve(flags.get("--delegation")) : void 0));
  const delegated = certificateFiles.some((file) => file !== void 0);
  if (!delegated && flags.has("--root-pub-file")) throw new UsageError("--root-pub-file is only for --delegation");
  assertKeyMatchesMode(keyId2, delegated);
  const unlockFile = unlockFileFlag(flags, keyId2, keyFile, delegated);
  if (delegated) {
    const missing = jobs.filter((_job, position) => certificateFiles[position] === void 0);
    if (missing.length > 0) throw new UsageError(`${keyId2} signs only with a certificate, but no certificate is given for: ${missing.map((job) => job.stageDir).join(", ")} (set "delegation" on the job or pass --delegation)`);
  } else if (mode === "core" && !TEAMUQ_TRUST_ANCHORS.rootKeys.some((root) => root.keyId === keyId2)) {
    console.error(`refused: keyId ${keyId2} is not one of the ${TEAMUQ_TRUST_ANCHORS.rootKeys.length} TEAMUQ_TRUST_ANCHORS embedded in this tool; the Core would reject the package. Use --anchors self while developing.`);
    return 1;
  }
  assertOutsideGitWorkTree(keyFile, "key file");
  const delegatedAnchors = delegated ? certificateAnchors(flags) : void 0;
  const certificates = [];
  if (delegatedAnchors !== void 0) {
    for (const [position, job] of jobs.entries()) {
      try {
        certificates.push(await checkDelegation(certificateFiles[position], keyId2, delegatedAnchors, manifests[position], job.stageDir));
      } catch (error) {
        if (!isArtifactError(error)) throw error;
        console.error(`rejected (${job.stageDir}): ${error.code}: ${error.message}`);
        return 1;
      }
    }
  }
  const unlocked = await obtainSigningPassphrase({ keyId: keyId2, question: `Passphrase for ${keyId2} (asked once for all ${jobs.length} packages): `, unlockFile, injected: deps.readPassphrase });
  const key2 = loadEncryptedPrivateKey(readKeyFile(keyFile), unlocked.passphrase);
  const description = describePublicKey(createPublicKey6(key2));
  assertNotRootKeyUnlockedSilently(unlocked.source, description.publicKey);
  for (const certificate of certificates) assertKeyIsCertified(keyFile, keyId2, description.publicKey, certificate.publicKey);
  const anchors = delegatedAnchors ?? (mode === "self" ? selfAnchors(keyId2, description.publicKey) : TEAMUQ_TRUST_ANCHORS);
  const state = { written: [], scratches: [] };
  const rollBack = () => [...removeFiles(state.written), ...removeScratches(state)];
  const reportStuck = (stuck) => {
    if (stuck.length > 0) console.error(`rollback: could not remove ${stuck.length} file(s) this run created; delete them by hand:
${stuck.map((file) => `  ${file}`).join("\n")}`);
  };
  const handlers = ["SIGINT", "SIGTERM"].map((signal) => {
    const handler = () => {
      const count2 = state.written.length;
      console.error(`interrupted (${signal}): removing the ${count2} package(s) this run had written`);
      reportStuck(rollBack());
      process.exit(signal === "SIGINT" ? 130 : 143);
    };
    process.once(signal, handler);
    return { signal, handler };
  });
  const results = [];
  try {
    for (const [position, job] of jobs.entries()) {
      await fs12.mkdir(path11.dirname(job.outFile), { recursive: true });
      if (await pathExists(job.outFile)) throw new Error(`the output ${job.outFile} appeared after the checks; pack-batch never overwrites, so it left that file untouched`);
      const scratch = path11.join(path11.dirname(job.outFile), `.pack-batch-${randomBytes6(6).toString("hex")}-${path11.basename(job.outFile)}`);
      state.scratches.push(scratch);
      const overrides = overrideList[position];
      const certificate = certificates[position];
      const packed = await packArtifact({ stageDir: job.stageDir, outFile: scratch, signer: { keyId: keyId2, key: key2 }, ...overrides === void 0 ? {} : { files: overrides }, ...certificate === void 0 ? {} : { delegation: certificate.bytes }, review: { anchors, support, isReservedId: isDevkitReservedId } });
      await publishWithoutOverwrite(scratch, job.outFile, () => state.written.push(job.outFile));
      await fs12.rm(scratch, { force: true }).catch(() => void 0);
      console.error(`[${position + 1}/${jobs.length}] signed ${packed.verified.manifest.id}@${packed.verified.manifest.version}`);
      results.push({ file: job.outFile, size: packed.size, sha256: packed.sha256, id: packed.verified.manifest.id, version: packed.verified.manifest.version, signer: packed.verified.signer, anchors: mode, fileCount: packed.verified.fileCount, totalBytes: packed.verified.totalBytes, integritySha256: packed.verified.integritySha256 });
    }
  } catch (error) {
    reportStuck(rollBack());
    throw error;
  } finally {
    for (const { signal, handler } of handlers) process.removeListener(signal, handler);
  }
  reportStuck(removeScratches(state));
  if (mode === "self") console.error(delegated ? "warning: verified against the test root key of --root-pub-file (--anchors self); the Core accepts these packages only if the certificates were signed by one of its TEAMUQ_TRUST_ANCHORS." : "warning: verified against your own key only (--anchors self); the Core accepts these packages only if the keyId is in its TEAMUQ_TRUST_ANCHORS.");
  show({ results });
  return 0;
}
function publicKeyAnchors(flags) {
  const pubFile = flags.get("--pub-file");
  let keyId2 = flags.get("--key-id");
  let publicKey = flags.get("--public-key");
  if (pubFile !== void 0) {
    const stored = JSON.parse(readFileSync(pubFile, "utf8"));
    if (typeof stored.keyId !== "string" || typeof stored.publicKey !== "string") throw new UsageError(`${pubFile} must contain { keyId, publicKey }`);
    if (keyId2 !== void 0 && keyId2 !== stored.keyId) throw new UsageError("--key-id does not match the public key file");
    if (publicKey !== void 0 && publicKey !== stored.publicKey) throw new UsageError("--public-key does not match the public key file");
    keyId2 ??= stored.keyId;
    publicKey ??= stored.publicKey;
  }
  if (keyId2 === void 0 || publicKey === void 0) throw new UsageError("--anchors self needs --pub-file, or --key-id together with --public-key");
  const raw = Buffer.from(publicKey, "base64");
  if (raw.length !== 32) throw new UsageError("--public-key must be 32 raw bytes in base64");
  if (keyId2.startsWith("dev-")) {
    try {
      assertDevKeyId(keyId2, raw);
    } catch (error) {
      throw new UsageError(error.message);
    }
  }
  return selfAnchors(keyId2, publicKey);
}
async function commandVerify(argv) {
  const { positional, flags } = parse(argv, ["--anchors", "--pub-file", "--key-id", "--public-key", "--root-pub-file", "--preplanted-id", "--core-version", "--platform", "--os-version"]);
  if (positional.length !== 1) throw new UsageError("verify needs exactly one .tuqplugin file");
  const devTrust = preplantedPolicy(flags);
  const mode = anchorMode(flags);
  const rootAnchors = flags.has("--root-pub-file");
  if (rootAnchors && (flags.has("--pub-file") || flags.has("--key-id") || flags.has("--public-key"))) throw new UsageError("--root-pub-file cannot be combined with --pub-file, --key-id or --public-key");
  const anchors = rootAnchors ? certificateAnchors(flags) : mode === "self" ? publicKeyAnchors(flags) : TEAMUQ_TRUST_ANCHORS;
  const file = path11.resolve(positional[0]);
  const support = supportContext(flags);
  const publicKey = mode === "self" && !rootAnchors ? anchors.rootKeys[0]?.publicKey : void 0;
  const verified = mode === "self" && !rootAnchors && anchors.rootKeys[0]?.keyId.startsWith("dev-") && publicKey !== void 0 ? await withSelfDevKey(publicKey, (devKeys) => verifyArtifactFile(file, { anchors, devKeys, support, delegation: "accept", isReservedId: isDevkitReservedId, isOfficialId: isDevkitReservedId, ...devTrust === void 0 ? {} : { devTrust } })) : await verifyArtifactFile(file, { anchors, support, delegation: "accept", isReservedId: isDevkitReservedId, isOfficialId: isDevkitReservedId, ...devTrust === void 0 ? {} : { devTrust } });
  if (mode === "self") console.error(rootAnchors ? "warning: verified against the test root key of --root-pub-file (--anchors self); the Core accepts this package only if the certificate was signed by one of its TEAMUQ_TRUST_ANCHORS." : "warning: verified against your own key only (--anchors self); the Core accepts this package only if the keyId is in its TEAMUQ_TRUST_ANCHORS.");
  const { manifest } = verified;
  const pinned = manifest.kind === "plugin" ? { trustTier: manifest.trustTier, permissions: manifest.permissions, allowAddons: manifest.native?.allowAddons === true } : {};
  show({ file, id: manifest.id, version: manifest.version, kind: manifest.kind, ...pinned, signer: verified.signer, anchors: mode, fileCount: verified.fileCount, totalBytes: verified.totalBytes, integritySha256: verified.integritySha256 });
  return 0;
}
async function commandSelftestKey(argv, deps) {
  const { positional, flags } = parse(argv, ["--key", "--key-id"]);
  const keyFile = flags.get("--key");
  if (positional.length !== 0 || keyFile === void 0) throw new UsageError("selftest-key needs --key <file>");
  assertOutsideGitWorkTree(keyFile, "key file");
  const keyId2 = keyIdFrom(flags, keyFile);
  const unlocked = await obtainSigningPassphrase({ keyId: keyId2, question: `Passphrase for ${keyId2}: `, unlockFile: void 0, injected: deps.readPassphrase });
  const key2 = loadEncryptedPrivateKey(readKeyFile(keyFile), unlocked.passphrase);
  const description = describePublicKey(createPublicKey6(key2));
  assertNotRootKeyUnlockedSilently(unlocked.source, description.publicKey);
  selfCheck(key2, description.raw);
  const anchor = TEAMUQ_TRUST_ANCHORS.rootKeys.find((root) => root.keyId === keyId2);
  const embedded = anchor === void 0 ? "not-embedded" : anchor.publicKey === description.publicKey ? "embedded" : "keyId-embedded-with-a-different-public-key";
  show({ ok: embedded !== "keyId-embedded-with-a-different-public-key", keyId: keyId2, publicKey: description.publicKey, spki: description.spki, fingerprint: description.fingerprint, shortCode: deriveKeyIdentity(description.fingerprint).shortCode, embeddedAnchors: embedded });
  return embedded === "keyId-embedded-with-a-different-public-key" ? 1 : 0;
}
async function commandReleaseKeyInit(argv) {
  const { positional, flags } = parse(argv, ["--key-id", "--out-dir"]);
  const keyId2 = flags.get("--key-id");
  const outDir = flags.get("--out-dir");
  if (positional.length !== 0 || keyId2 === void 0 || outDir === void 0) throw new UsageError("release-key-init needs --key-id teamuq-release-<name> and --out-dir <directory>");
  try {
    assertDelegatedKeyId(keyId2);
  } catch (error) {
    throw new UsageError(error.message);
  }
  if (TEAMUQ_TRUST_ANCHORS.rootKeys.some((root) => root.keyId === keyId2)) throw new UsageError(`${keyId2} is the id of an embedded trust anchor`);
  const created = initReleaseKey({ keyId: keyId2, directory: outDir });
  show({ keyId: created.keyId, privateKey: created.keyFile, publicKey: created.publicFile, unlockFile: created.unlockFile, publicKeyBase64: created.publicKey, fingerprint: created.fingerprint, passphrase: "random, kept only in the DPAPI unlock file (Windows current user)" });
  console.error([
    "Release key created. It is NOT trusted yet: the TeamUQ root key must sign a delegation certificate for it (delegate, typed root passphrase, once).",
    "Do NOT paste this public key into TEAMUQ_TRUST_ANCHORS: a release key is trusted only through its certificate.",
    "Anything that runs as this Windows user can unlock this key and sign inside the certificate scope; that is the accepted limit of automatic signing.",
    "This key needs no backup: if it is lost, make a new release key and have the root key sign a new certificate."
  ].join("\n"));
  return 0;
}
function delegationDeps() {
  return { coreAnchors: TEAMUQ_TRUST_ANCHORS, verifyDelegation, parseDeclaredNetworkOrigin };
}
async function main(argv, deps = {}) {
  const [command, ...rest] = argv;
  try {
    if (command === "--version") {
      process.stdout.write(`tuq-plugin-tool core ${CORE_VERSION}
`);
      return 0;
    }
    if (command === "validate") return await commandValidate(rest);
    if (command === "init") return await runInit(rest, { parse, UsageError, show, schema: PluginManifestV2Schema, validate: (d) => validateStage(d, supportContext(/* @__PURE__ */ new Map())) });
    if (command === "pack") return await commandPack(rest, deps);
    if (command === "pack-batch") return await commandPackBatch(rest, deps);
    if (command === "dev-keygen") return await commandDevKeygen(rest);
    if (command === "dev-pack") return await commandDevPack(rest);
    if (command === "types") return await commandTypes(rest);
    if (command === "verify") return await commandVerify(rest);
    if (command === "selftest-key") return await commandSelftestKey(rest, deps);
    if (command === "release-key-init") return await commandReleaseKeyInit(rest);
    if (command === "release-keygen") return await runReleaseKeygen(rest, delegationDeps());
    if (command === "delegate") return await runDelegate(rest, delegationDeps());
    if (command === "delegation-inspect") return await runDelegationInspect(rest, delegationDeps());
    if (command === void 0 || command === "--help" || command === "-h") {
      console.error(USAGE);
      return command === void 0 ? 2 : 0;
    }
    throw new UsageError(`unknown command ${command}`);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`usage: ${error.message}
${USAGE}`);
      return 2;
    }
    if (error instanceof UnlockRefused) {
      console.error(`refused: ${error.message}`);
      return 1;
    }
    if (isArtifactError(error)) console.error(`rejected: ${error.code}: ${error.message}`);
    else console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
function isEntryPoint() {
  const script = process.argv[1];
  if (script === void 0) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isEntryPoint()) process.exitCode = await main(process.argv.slice(2));
export {
  main
};
