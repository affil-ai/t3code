/**
 * Redaction for output of commands that received secrets. Each value is
 * scrubbed as written and in the encodings a command commonly prints:
 * base64 (standard and URL-safe, line-wrapped, and inside a longer encoded
 * string such as an HTTP Basic credential), percent and form encoding as
 * JavaScript, curl, Python and Go write them, JSON string escaping including
 * the ASCII-only and HTML-safe styles, and hex. This guards against
 * accidents; a command written to leak a value in some other form still can.
 *
 * @module redactSecrets
 */

export const REDACTED = "[REDACTED]";

/** Encoded forms shorter than this are too likely to match unrelated output. */
const MIN_ENCODED_LENGTH = 4;
/** Line breaks base64 encoders insert, at most one between any two characters. */
const BASE64_WRAP = "(?:\\r?\\n)?";

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The base64 characters that depend only on `bytes` when they sit at each of
 * the three byte offsets inside a longer encoded string.
 */
const embeddedBase64 = (bytes: Buffer): ReadonlyArray<string> =>
  [0, 1, 2].map((offset) => {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString("base64");
    return encoded.slice(
      Math.ceil((offset * 8) / 6),
      Math.floor(((offset + bytes.length) * 8) / 6),
    );
  });

/** Percent-encodes every byte of `value` except the characters `keep` allows. */
const percentEncode = (bytes: Buffer, keep: RegExp) =>
  Array.from(bytes, (byte) => {
    const char = String.fromCharCode(byte);
    return byte < 0x80 && keep.test(char)
      ? char
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");

const percentVariants = (value: string, bytes: Buffer): ReadonlyArray<string> => {
  const encoded = [
    encodeURIComponent(value),
    // curl --data-urlencode, Python quote_plus, Go QueryEscape: unreserved only.
    percentEncode(bytes, /[A-Za-z0-9\-._~]/),
    // Python quote's default also keeps "/".
    percentEncode(bytes, /[A-Za-z0-9\-._~/]/),
    percentEncode(bytes, /[A-Za-z0-9]/),
  ];
  return encoded.flatMap((form) => {
    const lower = form.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());
    return [form, lower, form.replace(/%20/g, "+"), lower.replace(/%20/g, "+")];
  });
};

const unicodeEscape = (char: string, upper: boolean) =>
  Array.from({ length: char.length }, (_, index) => {
    const hex = char.charCodeAt(index).toString(16).padStart(4, "0");
    return `\\u${upper ? hex.toUpperCase() : hex}`;
  }).join("");

const jsonVariants = (value: string): ReadonlyArray<string> => {
  const plain = JSON.stringify(value).slice(1, -1);
  const escaped = [false, true].flatMap((upper) => [
    // Python's ensure_ascii: every non-ASCII character as \uXXXX.
    plain.replace(/[^\p{ASCII}]/gu, (char) => unicodeEscape(char, upper)),
    // Go's HTML-safe encoding also escapes <, > and &.
    plain.replace(/[^\p{ASCII}]|[<>&]/gu, (char) => unicodeEscape(char, upper)),
  ]);
  return [plain, ...escaped].flatMap((form) => [form, form.replace(/\//g, "\\/")]);
};

/** The forms of one value: literal text, and base64 that may be line-wrapped. */
const valueForms = (value: string) => {
  const bytes = Buffer.from(value, "utf8");
  const base64 = [bytes.toString("base64"), ...embeddedBase64(bytes)];
  const literal = [
    value,
    ...[
      ...percentVariants(value, bytes),
      ...jsonVariants(value),
      bytes.toString("hex"),
      bytes.toString("hex").toUpperCase(),
    ].filter((form) => form.length >= MIN_ENCODED_LENGTH),
  ];
  const wrapped = [
    ...base64,
    ...base64.map((form) => form.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")),
  ].filter((form) => form.length >= MIN_ENCODED_LENGTH);
  return { literal, wrapped };
};

export interface SecretRedactor {
  /** `text` with every form replaced, and how many were. */
  readonly redact: (text: string) => { readonly text: string; readonly count: number };
  /** The longest text one form can match; a cut can leave a shorter prefix of it. */
  readonly longestVariant: number;
}

export const makeSecretRedactor = (values: ReadonlyArray<string>): SecretRedactor => {
  const forms = values.filter((value) => value.length > 0).map(valueForms);
  const literal = [...new Set(forms.flatMap((form) => form.literal))];
  const wrapped = [...new Set(forms.flatMap((form) => form.wrapped))];
  // Longest first, so a whole value wins over a form that is part of it.
  const alternatives = [
    ...literal.map((form) => ({ length: form.length, source: escapeRegExp(form) })),
    ...wrapped.map((form) => ({
      // Each break is at most two characters.
      length: form.length * 3,
      source: Array.from(form, escapeRegExp).join(BASE64_WRAP),
    })),
  ].toSorted((a, b) => b.length - a.length);
  if (alternatives.length === 0) {
    return { redact: (text) => ({ text, count: 0 }), longestVariant: 0 };
  }
  const pattern = new RegExp(alternatives.map((alternative) => alternative.source).join("|"), "g");
  return {
    redact: (text) => {
      let count = 0;
      const redacted = text.replace(pattern, () => {
        count += 1;
        return REDACTED;
      });
      return { text: redacted, count };
    },
    longestVariant: alternatives[0]!.length,
  };
};
