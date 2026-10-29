import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ArgError, addressList, googleUrls } from "./api.ts";
import { eventTime } from "./calendar.ts";
import { buildRawMessage, encodeHeader, htmlToText, messageContent } from "./gmail.ts";

const decode = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");

describe("Gmail messages", () => {
  it("builds a plain-text message with only the headers given", () => {
    const text = decode(buildRawMessage({ to: ["a@b.c", "Ann <ann@example.com>"], subject: "Hi", body: "One\nTwo" }));
    const [head, body] = text.split("\r\n\r\n");
    assert.equal(
      head,
      'To: a@b.c, Ann <ann@example.com>\r\nSubject: Hi\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64',
    );
    assert.equal(Buffer.from(body!.replace(/\r\n/g, ""), "base64").toString("utf8"), "One\r\nTwo");
  });

  it("encodes non-ASCII subjects as RFC 2047 words under the length limit", () => {
    const subject = "Café ☕ ".repeat(12);
    const encoded = encodeHeader(subject);
    for (const word of encoded.split("\r\n ")) {
      assert.match(word, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
      assert.ok(word.length <= 75, word);
    }
    const back = encoded
      .split("\r\n ")
      .map((word) => Buffer.from(word.slice(10, -2), "base64").toString("utf8"))
      .join("");
    assert.equal(back, subject);
    assert.equal(encodeHeader("Plain"), "Plain");
  });

  it("can't be given extra headers through a subject or an address", () => {
    const text = decode(buildRawMessage({ to: ["a@b.c"], subject: "Hi\r\nBcc: evil@x.y", body: "" }));
    assert.ok(!/^Bcc:/m.test(text));
    assert.throws(() => addressList({ to: ["a@b.c\r\nBcc: evil@x.y"] }, "to"), ArgError);
    assert.throws(() => addressList({ to: "not an address" }, "to"), ArgError);
    assert.deepEqual(addressList({ to: "a@b.c, d@e.f" }, "to"), ["a@b.c", "d@e.f"]);
  });

  it("reads the plain part, or the HTML as text, and lists attachments", () => {
    const b64 = (text: string) => Buffer.from(text).toString("base64url");
    const both = messageContent({
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/html", body: { data: b64("<p>html</p>") } },
        { mimeType: "text/plain", body: { data: b64("plain") } },
        { mimeType: "image/png", filename: "a.png", body: { attachmentId: "x", size: 5 } },
      ],
    });
    assert.equal(both.body, "plain");
    assert.deepEqual(both.attachments, [{ filename: "a.png", mimeType: "image/png", size: 5 }]);
    assert.equal(
      htmlToText("<style>p{}</style><p>Hi&nbsp;there &amp; you</p><p>Line&#33;<br>Next &#x263A;</p>"),
      "Hi there & you\nLine!\nNext ☺",
    );
  });
});

describe("Calendar times", () => {
  it("treats a bare date as all day and anything else as a date and time", () => {
    assert.deepEqual(eventTime("2026-11-02", "start"), { date: "2026-11-02" });
    assert.deepEqual(eventTime("2026-11-02T09:30:00+00:00", "start"), { dateTime: "2026-11-02T09:30:00+00:00" });
    assert.deepEqual(eventTime("2026-11-02T09:30:00", "start", "Europe/Lisbon"), {
      dateTime: "2026-11-02T09:30:00",
      timeZone: "Europe/Lisbon",
    });
    assert.throws(() => eventTime("next tuesday", "start"), /start must be an RFC 3339/);
  });
});

describe("Google API roots", () => {
  it("uses Google's hosts unless a test points them elsewhere", () => {
    assert.deepEqual(googleUrls(), {
      gmail: "https://gmail.googleapis.com/gmail/v1",
      calendar: "https://www.googleapis.com/calendar/v3",
    });
    assert.deepEqual(googleUrls("http://127.0.0.1:9/"), {
      gmail: "http://127.0.0.1:9/gmail/v1",
      calendar: "http://127.0.0.1:9/calendar/v3",
    });
  });
});
