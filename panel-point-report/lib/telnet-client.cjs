'use strict';

// Dependency-free, prompt-driven Telnet transport. No credentials or received
// content are logged. This is a text collector, not a full terminal emulator.
const net = require('node:net');

const IAC = 255;
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250;
const SE = 240;
const BINARY = 0;
const ECHO = 1;
const SGA = 3;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
}

function promptPattern(pattern) {
  if (typeof pattern === 'string') {
    if (pattern.length === 0) throw new TypeError('Prompt must not be empty.');
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
  if (!(pattern instanceof RegExp)) {
    throw new TypeError('Prompt must be a literal string or RegExp.');
  }
  const copy = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
  if (copy.test('')) throw new TypeError('Prompt must not match an empty string.');
  return copy;
}

class TelnetClient {
  constructor({ maxBufferedBytes = DEFAULT_MAX_BYTES, onFailure } = {}) {
    positiveInteger(maxBufferedBytes, 'maxBufferedBytes');
    if (onFailure !== undefined && typeof onFailure !== 'function') {
      throw new TypeError('onFailure must be a function when supplied.');
    }
    this.maxBufferedBytes = maxBufferedBytes;
    this.onFailure = onFailure;
    this.socket = null;
    this._state = 'idle';
    this._waiter = null;
    this._connectReject = null;
    this._connectTimer = null;
    this._lastError = null;
    this._resetBuffers();
  }

  _resetBuffers() {
    this._text = '';
    this._rawBytes = 0;
    this._iacState = 'data';
    this._iacCommand = null;
    this._ansiState = 'text';
    this._afterCR = false;
    this._localOptions = new Map();
    this._remoteOptions = new Map();
  }

  async connect(host, port = 23, timeoutMs = 5000) {
    if (this._state === 'connecting' || this._state === 'open') {
      throw new Error('Telnet client is already connected or connecting.');
    }
    if (typeof host !== 'string' || host.trim().length === 0) {
      throw new TypeError('Host must be a nonempty string.');
    }
    positiveInteger(port, 'port');
    if (port > 65535) throw new RangeError('Port must be at most 65535.');
    positiveInteger(timeoutMs, 'timeoutMs');
    this._resetBuffers();
    this._lastError = null;
    this._state = 'connecting';
    const socket = new net.Socket();
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on('data', chunk => { if (this.socket === socket) this._receive(chunk); });
    socket.on('error', error => { if (this.socket === socket) this._fail(error); });
    socket.on('end', () => {
      if (this.socket === socket) this._fail(new Error('Telnet peer closed the connection.'));
    });
    socket.on('close', () => {
      if (this.socket === socket && this._state !== 'closed') {
        this._fail(new Error('Telnet connection closed.'));
      }
    });
    return new Promise((resolve, reject) => {
      this._connectReject = reject;
      this._connectTimer = setTimeout(() => {
        if (this.socket === socket) this._fail(new Error('Telnet connection timeout.'));
      }, timeoutMs);
      socket.once('connect', () => {
        if (this.socket !== socket || this._state !== 'connecting') return;
        clearTimeout(this._connectTimer);
        this._connectTimer = null;
        this._connectReject = null;
        this._state = 'open';
        resolve();
      });
      try { socket.connect({ host, port }); }
      catch (error) { this._fail(error); }
    });
  }

  // Send exactly the caller's text, without automatically adding an Enter key.
  // Telnet's escaped 0xFF representation is applied to literal data bytes.
  send(text) {
    if (this._state !== 'open' || !this.socket || this.socket.destroyed) {
      throw this._lastError || new Error('Telnet connection is not open.');
    }
    if (typeof text !== 'string') throw new TypeError('Text must be a string.');
    if (text.length > 65536) throw new RangeError('A single send is limited to 65536 text bytes.');
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
      const byte = text.charCodeAt(i);
      if (byte > 255) throw new TypeError('Telnet text must contain Latin-1 characters only.');
      bytes.push(byte);
      if (byte === IAC) bytes.push(IAC);
    }
    const socket = this.socket;
    socket.write(Buffer.from(bytes), error => {
      if (error && this.socket === socket) this._fail(error);
    });
  }

  // Resolves only on the supplied prompt, never on a quiet-period heuristic.
  // The match is included; any following text remains for the next wait.
  async waitFor(pattern, { timeoutMs = 10000, maxBytes = DEFAULT_MAX_BYTES } = {}) {
    positiveInteger(timeoutMs, 'timeoutMs');
    positiveInteger(maxBytes, 'maxBytes');
    const regex = promptPattern(pattern);
    if (this._waiter) throw new Error('Only one prompt wait may be active.');
    if (this._state !== 'open') {
      throw this._lastError || new Error('Telnet connection is not open.');
    }
    return new Promise((resolve, reject) => {
      const waiter = { regex, resolve, reject, maxBytes, timer: null };
      this._waiter = waiter;
      waiter.timer = setTimeout(() => {
        this._fail(new Error('Telnet prompt timeout.'));
      }, timeoutMs);
      this._checkWaiter();
    });
  }

  // Explicitly consume any buffered text. Not a completion/prompt detector.
  drain() {
    if (this._waiter) throw new Error('Cannot drain during a prompt wait.');
    const text = this._text;
    this._text = '';
    this._rawBytes = 0;
    return text;
  }

  close() {
    this._fail(new Error('Telnet client closed.'));
  }

  _fail(error) {
    if (this._state === 'closed') return;
    this._lastError = error;
    this._state = 'closed';
    // Opt-in diagnostics: callers must redact authentication/secret content.
    // Never retain the snapshot or let a diagnostic callback prevent cleanup.
    if (this.onFailure) {
      try { this.onFailure({ message: error.message, partial: this._text }); }
      catch { /* Failure cleanup must always finish. */ }
    }
    clearTimeout(this._connectTimer);
    this._connectTimer = null;
    const connectReject = this._connectReject;
    this._connectReject = null;
    const waiter = this._waiter;
    this._waiter = null;
    if (waiter) clearTimeout(waiter.timer);
    if (this.socket) this.socket.destroy();
    // Do not retain passwords/echoes or partial response content after closure.
    this._resetBuffers();
    if (connectReject) connectReject(error);
    if (waiter) waiter.reject(error);
  }

  _checkWaiter() {
    const waiter = this._waiter;
    if (!waiter) return;
    if (this._rawBytes > Math.min(waiter.maxBytes, this.maxBufferedBytes)) {
      this._fail(new Error('Telnet response exceeded the byte limit.'));
      return;
    }
    const match = waiter.regex.exec(this._text);
    if (!match) return;
    if (match[0].length === 0) {
      this._fail(new Error('Prompt matched an empty string.'));
      return;
    }
    const end = match.index + match[0].length;
    const result = this._text.slice(0, end);
    this._text = this._text.slice(end);
    this._rawBytes = this._text.length;
    this._waiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve(result);
  }

  _receive(chunk) {
    if (this._state === 'closed') return;
    this._rawBytes += chunk.length;
    const limit = this._waiter
      ? Math.min(this._waiter.maxBytes, this.maxBufferedBytes)
      : this.maxBufferedBytes;
    if (this._rawBytes > limit) {
      this._fail(new Error('Telnet response exceeded the byte limit.'));
      return;
    }
    for (const byte of chunk) {
      switch (this._iacState) {
        case 'data':
          if (byte === IAC) this._iacState = 'iac';
          else this._character(byte);
          break;
        case 'iac':
          if (byte === IAC) { this._character(IAC); this._iacState = 'data'; }
          else if ([DO, DONT, WILL, WONT].includes(byte)) {
            this._iacCommand = byte;
            this._iacState = 'option';
          }
          else if (byte === SB) this._iacState = 'subnegotiation';
          else {
            if (byte === 247) this._backspace(); // Erase Character
            if (byte === 248) this._text = this._text.slice(0, this._text.lastIndexOf('\n') + 1);
            this._iacState = 'data';
          }
          break;
        case 'option':
          this._negotiate(this._iacCommand, byte);
          this._iacState = 'data';
          break;
        case 'subnegotiation':
          if (byte === IAC) this._iacState = 'subnegotiationIac';
          break;
        case 'subnegotiationIac':
          this._iacState = byte === SE ? 'data' : 'subnegotiation';
          break;
      }
    }
    this._checkWaiter();
  }

  _negotiate(command, option) {
    const remote = command === WILL || command === WONT;
    const states = remote ? this._remoteOptions : this._localOptions;
    const positive = command === WILL || command === DO;
    const allow = remote ? [BINARY, ECHO, SGA].includes(option) : [BINARY, SGA].includes(option);
    const accepted = positive && allow;
    const previous = states.get(option);
    states.set(option, accepted);
    // Reply once to a state transition. Repeated requests must not echo-loop.
    if ((positive && previous !== accepted) || (!positive && previous === true)) {
      const reply = remote ? (accepted ? DO : DONT) : (accepted ? WILL : WONT);
      const socket = this.socket;
      socket.write(Buffer.from([IAC, reply, option]), error => {
        if (error && this.socket === socket) this._fail(error);
      });
    }
  }

  _backspace() {
    if (this._text.length > 0 && !this._text.endsWith('\n')) {
      this._text = this._text.slice(0, -1);
    }
  }

  _character(byte) {
    const state = this._ansiState;
    if (state === 'escape') {
      if (byte === 91) this._ansiState = 'csi';
      else if ([93, 80, 94, 95].includes(byte)) this._ansiState = 'string';
      else if (byte >= 32 && byte <= 47) this._ansiState = 'intermediate';
      else this._ansiState = 'text';
      return;
    }
    if (state === 'intermediate') {
      if (byte >= 48 && byte <= 126) this._ansiState = 'text';
      return;
    }
    if (state === 'csi') {
      if (byte >= 64 && byte <= 126) this._ansiState = 'text';
      return;
    }
    if (state === 'string') {
      if (byte === 7) this._ansiState = 'text';
      else if (byte === 27) this._ansiState = 'stringEscape';
      return;
    }
    if (state === 'stringEscape') {
      this._ansiState = byte === 92 ? 'text' : 'string';
      return;
    }
    if (byte === 27) { this._ansiState = 'escape'; return; }
    if (this._afterCR) {
      this._afterCR = false;
      if (byte === 10 || byte === 0) return;
    }
    // Normalize CRLF, lone CR, and NVT CR-NUL to one LF for text reports.
    if (byte === 13) { this._text += '\n'; this._afterCR = true; }
    else if (byte === 8 || byte === 127) this._backspace();
    else if (byte === 10 || byte === 9 || byte >= 32) this._text += String.fromCharCode(byte);
  }
}

module.exports = { TelnetClient };
