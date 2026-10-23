import { describe, expect, it } from "vite-plus/test";

import { makeSecretRedactor, REDACTED } from "./redactSecrets.ts";

const secret = "p@ss w/rd+?&=Zx9";

describe("makeSecretRedactor", () => {
  const { redact } = makeSecretRedactor([secret]);
  const bytes = Buffer.from(secret);

  it.each([
    ["raw", secret],
    ["base64", bytes.toString("base64")],
    ["base64 without padding", bytes.toString("base64").replace(/=+$/, "")],
    ["URL-safe base64", bytes.toString("base64url")],
    ["percent-encoded", encodeURIComponent(secret)],
    [
      "lowercase percent-encoded",
      encodeURIComponent(secret).replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()),
    ],
    ["form-encoded", new URLSearchParams({ v: secret }).toString().slice(2)],
    ["JSON-escaped", JSON.stringify(secret).slice(1, -1)],
    ["hex", bytes.toString("hex")],
    ["uppercase hex", bytes.toString("hex").toUpperCase()],
  ])("scrubs the %s form", (_, form) => {
    const result = redact(`before ${form} after`);
    expect(result.text).not.toContain(form);
    expect(result.text.startsWith("before ")).toBe(true);
    expect(result.text.endsWith(" after")).toBe(true);
    expect(result.count).toBeGreaterThan(0);
  });

  it.each([0, 1, 2, 3, 4, 5])(
    "scrubs a value inside a longer base64 string after a %i byte prefix",
    (prefixLength) => {
      // e.g. an HTTP Basic credential, base64("user:" + password).
      const encoded = Buffer.concat([Buffer.from("u".repeat(prefixLength) + ":"), bytes]).toString(
        "base64",
      );
      const { text } = redact(`Authorization: Basic ${encoded}`);
      const leftover = text.slice("Authorization: Basic ".length).split(REDACTED).join("");
      // At most the characters shared with the prefix or padding remain.
      expect(leftover.length).toBeLessThanOrEqual(Math.ceil(((prefixLength + 1) * 8) / 6) + 3);
      expect(text).toContain(REDACTED);
    },
  );

  it("counts every occurrence across lines and leaves other output alone", () => {
    const result = redact(`${secret}\nok\n${secret}${secret}`);
    expect(result).toEqual({ text: `${REDACTED}\nok\n${REDACTED}${REDACTED}`, count: 3 });
  });

  it("scrubs several values, preferring the longest match", () => {
    const both = makeSecretRedactor(["abc", "abcdef-long"]);
    expect(both.redact("x abcdef-long y abc").text).toBe(`x ${REDACTED} y ${REDACTED}`);
  });

  it("treats regular expression characters in a value literally", () => {
    const special = makeSecretRedactor(["a.b*c"]);
    expect(special.redact("a.b*c axbbbc").text).toBe(`${REDACTED} axbbbc`);
  });
});
