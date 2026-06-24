// tests/security/probe69-sanitize-control-char-regex.test.js
// Regression for an auditability/robustness hazard in the input sanitizer.
//
// sanitizeString() strips control characters via a regex character class. That
// class was authored with LITERAL control bytes (0x00-0x1f, 0x7f-0x9f) embedded
// directly in the source. Functionally correct, but it made src/utils/sanitize.js
// a "binary" file: `grep` reports "binary file matches" instead of the line, so a
// security auditor scanning for .replace/sanitization logic would miss the XSS
// defense entirely — and the raw bytes are fragile under editors/encoding changes.
//
// Fix: express the same class with explicit escape sequences (\x00-\x1f\x7f-\x9f).
// These tests assert (a) the source contains no stray control bytes and uses the
// escaped form, and (b) the behavior is unchanged — control chars and HTML tags
// are still stripped.

const fs = require('fs');
const path = require('path');
const { sanitizeString, sanitizeObject } = require('../../src/utils/sanitize');

const SANITIZE_SRC_PATH = path.join(__dirname, '../../src/utils/sanitize.js');

describe('sanitize.js source is plain text (auditable, robust)', () => {
  const src = fs.readFileSync(SANITIZE_SRC_PATH, 'utf8');

  it('contains no stray control bytes (file is not "binary" to grep)', () => {
    const offenders = [...src].filter((c) => {
      const x = c.charCodeAt(0);
      // Allow tab (0x09), newline (0x0a), CR (0x0d); flag all other C0/C1 controls.
      if (x === 0x09 || x === 0x0a || x === 0x0d) return false;
      return x < 0x20 || (x >= 0x7f && x <= 0x9f);
    });
    expect(offenders.length).toBe(0);
  });

  it('uses the explicit escape-sequence form for the control-char class', () => {
    expect(src).toMatch(/\.replace\(\/\[\\x00-\\x1f\\x7f-\\x9f\]\/g/);
  });
});

describe('sanitizeString behavior is unchanged after the byte->escape conversion', () => {
  it('strips C0 control characters (0x00-0x1f)', () => {
    const input = 'a' + '\x00\x07\x1f' + 'bcd'; // NUL, BEL, US interleaved
    expect(sanitizeString(input)).toBe('abcd');
  });

  it('strips DEL and C1 control characters (0x7f-0x9f)', () => {
    const input = 'a' + '\x7f' + 'b' + '\x80' + 'c' + '\x9f' + 'd'; // DEL + C1 controls
    expect(sanitizeString(input)).toBe('abcd');
  });

  it('preserves ordinary printable text and unicode', () => {
    expect(sanitizeString('Hello, world 123')).toBe('Hello, world 123');
  });

  it('strips HTML tags', () => {
    expect(sanitizeString('<script>alert(1)</script>hi')).toBe('alert(1)hi');
  });

  it('closes the <<tag> bypass (residual angle brackets removed)', () => {
    expect(sanitizeString('<<b>ok')).toBe('ok');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeString('  spaced  ')).toBe('spaced');
  });

  it('returns empty string for non-string input', () => {
    expect(sanitizeString(null)).toBe('');
    expect(sanitizeString(undefined)).toBe('');
    expect(sanitizeString(42)).toBe('');
  });

  it('sanitizeObject applies sanitizeString to listed string keys only', () => {
    const out = sanitizeObject({ name: 'a' + '\x01' + 'b<script>', count: 5, other: 'x' }, ['name']);
    expect(out.name).toBe('ab');
    expect(out.count).toBe(5);   // untouched (not a string)
    expect(out.other).toBe('x'); // untouched (not in keys)
  });
});
