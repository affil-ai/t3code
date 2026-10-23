/**
 * Redaction for output of commands that received secrets. Each value is
 * scrubbed as written and in the encodings a command commonly prints:
 * base64 (standard and URL-safe, including inside a longer encoded string
 * such as an HTTP Basic credential), percent and form encoding, JSON string
 * escaping, and hex. This guards against accidents; a command written to
 * leak a value in some other form still can.
 *
 * @module redactSecrets
 */

export const REDACTED = "[REDACTED]";

/** Encoded forms shorter than this are too likely to match unrelated output. */
const MIN_ENCODED_LENGTH = 4;

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

/** Every form of `value` to scrub, longest first so a full match wins over a part. */
export const secretVariants = (value: string): ReadonlyArray<string> => {
  const bytes = Buffer.from(value, "utf8");
  const percent = encodeURIComponent(value);
  const base64 = [bytes.toString("base64"), ...embeddedBase64(bytes)];
  const encoded = [
    percent,
    percent.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()),
    percent.replace(/%20/g, "+"),
    JSON.stringify(value).slice(1, -1),
    bytes.toString("hex"),
    bytes.toString("hex").toUpperCase(),
    ...base64,
    ...base64.map((form) => form.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")),
  ].filter((form) => form.length >= MIN_ENCODED_LENGTH);
  return [...new Set([value, ...encoded])]
    .filter((form) => form.length > 0)
    .toSorted((a, b) => b.length - a.length);
};

export interface SecretRedactor {
  /** `text` with every variant replaced, and how many were. */
  readonly redact: (text: string) => { readonly text: string; readonly count: number };
  /** The longest variant; a cut can leave a prefix of a variant at most one shorter. */
  readonly longestVariant: number;
}

export const makeSecretRedactor = (values: ReadonlyArray<string>): SecretRedactor => {
  const variants = [...new Set(values.flatMap(secretVariants))].toSorted(
    (a, b) => b.length - a.length,
  );
  if (variants.length === 0) return { redact: (text) => ({ text, count: 0 }), longestVariant: 0 };
  const pattern = new RegExp(variants.map(escapeRegExp).join("|"), "g");
  return {
    redact: (text) => {
      let count = 0;
      const redacted = text.replace(pattern, () => {
        count += 1;
        return REDACTED;
      });
      return { text: redacted, count };
    },
    longestVariant: variants[0]!.length,
  };
};
