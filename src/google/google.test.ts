import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { MAX_ATTACHMENT_BYTES, UPLOAD_TTL_MS, saveUpload } from "../uploads.ts";

import { ArgError, addressList, googleUrls } from "./api.ts";
import { eventTime } from "./calendar.ts";
import { attachmentsFrom, buildRawMessage, encodeHeader, htmlToText, messageContent } from "./gmail.ts";

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

// Just enough MIME parsing to check what buildRawMessage nests where.
type Entity = { headers: Record<string, string>; body: string; parts: Entity[] };
function parseEntity(text: string): Entity {
  const split = text.indexOf("\r\n\r\n");
  const headers: Record<string, string> = {};
  for (const line of text.slice(0, split).replace(/\r\n /g, " ").split("\r\n")) {
    const colon = line.indexOf(":");
    headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  const body = text.slice(split + 4);
  const boundary = /boundary="([^"]+)"/.exec(headers["content-type"] ?? "")?.[1];
  const parts = boundary
    ? body
        .split(`--${boundary}--`)[0]!
        .split(`--${boundary}\r\n`)
        .slice(1)
        .map((part) => parseEntity(part.replace(/\r\n$/, "")))
    : [];
  return { headers, body, parts };
}
const decodedBody = (entity: Entity) => Buffer.from(entity.body.replace(/\r\n/g, ""), "base64");
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

describe("Gmail messages with HTML and attachments", () => {
  it("nests attachments, inline images and the two bodies the way Gmail does", () => {
    const raw = buildRawMessage({
      to: ["ana@example.com"],
      subject: "Portal",
      body: "See the screenshot.",
      htmlBody: '<p>See:</p><img src="cid:shot1">',
      attachments: [
        { filename: "portal.png", mimeType: "image/png", data: PNG, inline: true, contentId: "shot1" },
        { filename: "Résumé.pdf", mimeType: "application/pdf", data: Buffer.from("%PDF"), inline: false },
      ],
    });
    const top = parseEntity(Buffer.from(raw, "base64url").toString("utf8"));
    assert.match(top.headers["content-type"]!, /^multipart\/mixed; boundary="=_connectors_[0-9a-f]{24}"$/);
    assert.equal(top.headers.subject, "Portal");
    const [related, pdf] = top.parts;
    assert.match(related!.headers["content-type"]!, /^multipart\/related/);
    const [alternative, image] = related!.parts;
    assert.match(alternative!.headers["content-type"]!, /^multipart\/alternative/);
    const [plain, htmlPart] = alternative!.parts;
    assert.equal(plain!.headers["content-type"], 'text/plain; charset="UTF-8"');
    assert.equal(decodedBody(plain!).toString(), "See the screenshot.");
    assert.equal(htmlPart!.headers["content-type"], 'text/html; charset="UTF-8"');
    assert.equal(decodedBody(htmlPart!).toString(), '<p>See:</p><img src="cid:shot1">');
    assert.equal(image!.headers["content-type"], 'image/png; name="portal.png"');
    assert.equal(image!.headers["content-disposition"], 'inline; filename="portal.png"');
    assert.equal(image!.headers["content-id"], "<shot1>");
    assert.deepEqual(decodedBody(image!), PNG);
    assert.equal(pdf!.headers["content-disposition"], `attachment; filename="=?UTF-8?B?${Buffer.from("Résumé.pdf").toString("base64")}?="`);
    assert.equal(decodedBody(pdf!).toString(), "%PDF");
  });

  it("makes HTML alone a multipart/alternative, and leaves related and mixed out", () => {
    const top = parseEntity(
      Buffer.from(buildRawMessage({ to: ["a@b.c"], subject: "Hi", body: "Hi", htmlBody: "<b>Hi</b>" }), "base64url").toString("utf8"),
    );
    assert.match(top.headers["content-type"]!, /^multipart\/alternative/);
    assert.equal(top.parts.length, 2);
  });

  it("checks attachments and their cid: links before anything goes to Gmail", () => {
    const data = PNG.toString("base64");
    const bad = (args: Record<string, unknown>, message: RegExp) => assert.throws(() => attachmentsFrom(args), message);
    bad({ attachments: [{ filename: "a.png", data, inline: true }], htmlBody: "<img src='cid:a'>" }, /needs a contentId/);
    bad({ attachments: [{ filename: "a.png", data, inline: true, contentId: "a" }] }, /needs an htmlBody with <img src="cid:a">/);
    bad({ attachments: [{ filename: "a.png", data, inline: true, contentId: "a" }], htmlBody: "<img src='cid:b'>" }, /has no <img src="cid:a">/);
    bad({ htmlBody: '<img src="cid:x">' }, /uses cid:x, but there are no attachments/);
    bad({ attachments: [{ filename: "a.png", data, uploadId: "up_x" }] }, /exactly one of data or uploadId/);
    bad({ attachments: [{ filename: "a.png" }] }, /exactly one of data or uploadId/);
    bad({ attachments: [{ filename: 'a".png', data }] }, /can't contain quotes/);
    bad({ attachments: [{ filename: "a.png", data, path: "/etc/passwd" }] }, /unknown field: path/);
    bad({ attachments: [{ filename: "a.png", data: "not base64!" }] }, /must be base64/);
    bad({ attachments: [{ filename: "a.png", data, mimeType: "image/png\r\nBcc: x@y.z" }] }, /plain type\/subtype/);
    bad({ attachments: [{ filename: "a.png", data, contentId: "a>b" }] }, /contentId can only have/);
    const big = Buffer.alloc(MAX_ATTACHMENT_BYTES / 2 + 1).toString("base64");
    bad({ attachments: [{ filename: "a.bin", data: big }, { filename: "b.bin", data: big }] }, /over 3 MB, the limit/);
    bad({ attachments: [{ filename: "a.png", uploadId: "up_aaaaaaaaaaaaaaaaaaaaaa" }] }, /isn't an upload that's still here/);

    const [file] = attachmentsFrom({
      attachments: [{ filename: "Shot.PNG", data: `data:image/png;base64,${data}`, inline: true, contentId: "Shot1" }],
      htmlBody: '<img src="CID:shot1" alt="">',
    })!;
    assert.equal(file!.mimeType, "image/png");
    assert.deepEqual(file!.data, PNG);
  });

  it("loads an upload by id, with its name and type, until it expires", () => {
    const dir = mkdtempSync(join(tmpdir(), "connectors-uploads-"));
    try {
      const meta = saveUpload(dir, PNG, { filename: "portal.png", contentType: "image/png", agent: "codex" }, 1_000);
      const args = { attachments: [{ uploadId: meta.id, inline: true, contentId: "p" }], htmlBody: '<img src="cid:p">' };
      const [file] = attachmentsFrom(args, { uploadsDir: dir, now: 2_000 })!;
      assert.equal(file!.filename, "portal.png");
      assert.equal(file!.mimeType, "image/png");
      assert.deepEqual(file!.data, PNG);
      assert.throws(() => attachmentsFrom(args, { uploadsDir: dir, now: 1_000 + UPLOAD_TTL_MS }), /isn't an upload that's still here/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
