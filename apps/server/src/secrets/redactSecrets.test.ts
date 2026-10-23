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

  describe("forms other tools write", () => {
    const tricky = "Pa$$!'()*<&>é w/😀";
    const trickyBytes = Buffer.from(tricky);
    const strict = makeSecretRedactor([tricky]);
    const unreserved = (keep: RegExp, lower = false) =>
      Array.from(trickyBytes, (byte) => {
        const char = String.fromCharCode(byte);
        if (byte < 0x80 && keep.test(char)) return char;
        const hex = byte.toString(16).padStart(2, "0");
        return `%${lower ? hex : hex.toUpperCase()}`;
      }).join("");
    const goJson = JSON.stringify(tricky)
      .slice(1, -1)
      .replace(/[^\p{ASCII}]|[<>&]/gu, (char) =>
        Array.from(
          { length: char.length },
          (_, index) => `\\u${char.charCodeAt(index).toString(16).padStart(4, "0")}`,
        ).join(""),
      );
    const wrappedBase64 = (
      Buffer.from(tricky.repeat(4))
        .toString("base64")
        .match(/.{1,64}/g) ?? []
    ).join("\n");

    it.each([
      ["curl --data-urlencode / quote_plus", unreserved(/[A-Za-z0-9\-._~]/)],
      ["Python quote", unreserved(/[A-Za-z0-9\-._~/]/)],
      ["lowercase escapes", unreserved(/[A-Za-z0-9\-._~]/, true)],
      ["Go HTML-safe JSON", goJson],
      [
        "Python ASCII JSON",
        goJson.replace(/\\u00(3c|3e|26)/g, (_, hex) =>
          String.fromCharCode(Number.parseInt(hex, 16)),
        ),
      ],
      ["JSON with escaped slashes", JSON.stringify(tricky).slice(1, -1).replace(/\//g, "\\/")],
    ])("scrubs %s", (_, form) => {
      const result = strict.redact(`x=${form};`);
      expect(result.text).toBe(`x=${REDACTED};`);
    });

    it("scrubs base64 that an encoder wrapped across lines", () => {
      const long = makeSecretRedactor([tricky.repeat(4)]);
      const result = long.redact(`-----BEGIN-----\n${wrappedBase64}\n-----END-----`);
      expect(result.text).toBe(`-----BEGIN-----\n${REDACTED}\n-----END-----`);
    });
  });

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
