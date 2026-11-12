// Gmail tools for the built-in Google server, exposed as gmail__<tool>.
// Reads, labels, drafts and sending. A draft or send can have an HTML
// version and attachments, inline images included (see buildRawMessage). Sending matches the policy's
// "*__*send*" rule, so the owner approves every send and sees the full message
// on the approval page. There's deliberately no "send draft" tool: its
// approval page would show only a draft id, not what goes out.

import { randomBytes } from "node:crypto";

import { MAX_ATTACHMENT_BYTES, contentTypeOk, filenameProblem, isUploadId, readUpload } from "../uploads.ts";
import {
  ArgError,
  type ToolContext,
  type ToolDef,
  addressList,
  cut,
  enc,
  google,
  optInt,
  optString,
  reqString,
  withQuery,
} from "./api.ts";

const MAX_BODY_CHARS = 20_000;
const MAX_THREAD_CHARS = 60_000;

type Header = { name: string; value: string };
type Part = {
  mimeType?: string;
  filename?: string;
  headers?: Header[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: Part[];
};
type Message = {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: Part;
};
type Thread = { id: string; snippet?: string; messages?: Message[] };

function header(message: Message, name: string): string | undefined {
  const lower = name.toLowerCase();
  return message.payload?.headers?.find((item) => item.name.toLowerCase() === lower)?.value;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Readable text from an HTML-only email. Not a renderer, just enough to read. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
      if (name.startsWith("#x") || name.startsWith("#X")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
      if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decode(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

/** The message's text (plain if it has any, else its HTML as text) and its attachments. */
export function messageContent(payload: Part | undefined): {
  body: string;
  attachments: { filename: string; mimeType?: string; size?: number }[];
} {
  const plain: string[] = [];
  const html: string[] = [];
  const attachments: { filename: string; mimeType?: string; size?: number }[] = [];
  const walk = (part: Part | undefined) => {
    if (!part) return;
    if (part.filename) {
      attachments.push({ filename: part.filename, mimeType: part.mimeType, size: part.body?.size });
    } else if (part.body?.data && part.mimeType === "text/plain") {
      plain.push(decode(part.body.data));
    } else if (part.body?.data && part.mimeType === "text/html") {
      html.push(decode(part.body.data));
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  const body = plain.length ? plain.join("\n\n") : htmlToText(html.join("\n\n"));
  return { body, attachments };
}

function summarize(message: Message, withBody: boolean, maxChars = MAX_BODY_CHARS) {
  const base = {
    messageId: message.id,
    threadId: message.threadId,
    date: header(message, "Date"),
    from: header(message, "From"),
    to: header(message, "To"),
    cc: header(message, "Cc"),
    subject: header(message, "Subject"),
    labels: message.labelIds ?? [],
  };
  if (!withBody) return { ...base, snippet: message.snippet };
  const { body, attachments } = messageContent(message.payload);
  return { ...base, body: cut(body, maxChars), ...(attachments.length ? { attachments } : {}) };
}

// RFC 2047: a header value that isn't plain ASCII goes as UTF-8 base64
// words, each kept under the 75-character limit.
export function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const words: string[] = [];
  let chunk = "";
  for (const char of value) {
    if (Buffer.byteLength(chunk + char) > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word).toString("base64")}?=`).join("\r\n ");
}

export type Attachment = {
  filename: string;
  mimeType: string;
  data: Buffer;
  // Shown in the body where the HTML has <img src="cid:contentId">.
  inline: boolean;
  contentId?: string;
};

export type OutgoingMessage = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  htmlBody?: string;
  attachments?: Attachment[];
  inReplyTo?: string;
  references?: string;
};

const base64Lines = (data: Buffer): string => (data.toString("base64").match(/.{1,76}/g) ?? [""]).join("\r\n");
const textPart = (subtype: "plain" | "html", text: string): string =>
  `Content-Type: text/${subtype}; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
  base64Lines(Buffer.from(text.replace(/\r?\n/g, "\r\n")));

// A file name in a quoted header parameter: as is when it's plain ASCII,
// else one RFC 2047 word, which is what Gmail itself sends and reads.
const quotedName = (name: string): string =>
  /^[\x20-\x7e]*$/.test(name) ? name : `=?UTF-8?B?${Buffer.from(name).toString("base64")}?=`;

function attachmentPart(file: Attachment): string {
  const name = quotedName(file.filename);
  return [
    `Content-Type: ${file.mimeType}; name="${name}"`,
    `Content-Disposition: ${file.inline ? "inline" : "attachment"}; filename="${name}"`,
    ...(file.contentId ? [`Content-ID: <${file.contentId}>`, `X-Attachment-Id: ${file.contentId}`] : []),
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(file.data),
  ].join("\r\n");
}

/** A multipart entity: its Content-Type header and body. Boundaries are random, so no content can close one. */
function multipart(subtype: "mixed" | "related" | "alternative", parts: string[]): string {
  const boundary = `=_connectors_${randomBytes(12).toString("hex")}`;
  return (
    `Content-Type: multipart/${subtype}; boundary="${boundary}"\r\n\r\n` +
    parts.map((part) => `--${boundary}\r\n${part}\r\n`).join("") +
    `--${boundary}--`
  );
}

/**
 * An RFC 5322 message, base64url as Gmail's raw field wants it. Plain text
 * alone stays a single text/plain part. With more it nests the way Gmail's
 * own compose does: mixed (attachments) around related (inline images)
 * around alternative (the plain text and the HTML).
 */
export function buildRawMessage(message: OutgoingMessage): string {
  const headers: [string, string | undefined][] = [
    ["To", message.to.join(", ")],
    ["Cc", message.cc?.join(", ")],
    ["Bcc", message.bcc?.join(", ")],
    ["Subject", encodeHeader(message.subject)],
    ["In-Reply-To", message.inReplyTo],
    ["References", message.references],
  ];
  const lines: string[] = [];
  for (const [name, value] of headers) {
    if (value === undefined || value === "") continue;
    // A line break in a header would let an argument add its own headers.
    if (/[\r\n]/.test(value.replace(/\r\n /g, ""))) throw new ArgError(`${name} can't contain line breaks.`);
    lines.push(`${name}: ${value}`);
  }
  lines.push("MIME-Version: 1.0");
  const files = message.attachments ?? [];
  let entity =
    message.htmlBody === undefined
      ? textPart("plain", message.body)
      : multipart("alternative", [textPart("plain", message.body), textPart("html", message.htmlBody)]);
  const inline = files.filter((file) => file.inline);
  const attached = files.filter((file) => !file.inline);
  if (inline.length) entity = multipart("related", [entity, ...inline.map(attachmentPart)]);
  if (attached.length) entity = multipart("mixed", [entity, ...attached.map(attachmentPart)]);
  return Buffer.from(`${lines.join("\r\n")}\r\n${entity}`).toString("base64url");
}

const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  ics: "text/calendar",
  zip: "application/zip",
  json: "application/json",
};

const CONTENT_ID = /^[A-Za-z0-9._@-]{1,100}$/;

/** cid: references in the HTML, as Gmail's renderer matches them (case-insensitively). */
function cidReferences(html: string): Set<string> {
  const found = new Set<string>();
  for (const match of html.matchAll(/["'(]\s*cid:([^"')\s>]+)/gi)) found.add(match[1]!.toLowerCase());
  return found;
}

/**
 * The attachments argument, checked and loaded. Each has base64 `data`, or
 * an `uploadId` from POST /uploads. Inline ones must be used by the HTML,
 * and every cid: in the HTML must be one of them, so a typo fails here
 * instead of arriving as a broken image.
 */
export function attachmentsFrom(
  args: Record<string, unknown>,
  options: { uploadsDir?: string; now?: number } = {},
): Attachment[] | undefined {
  const value = args.attachments;
  const html = typeof args.htmlBody === "string" ? args.htmlBody : undefined;
  if (value === undefined || value === null) {
    const refs = html ? [...cidReferences(html)] : [];
    if (refs.length) throw new ArgError(`htmlBody uses cid:${refs[0]}, but there are no attachments.`);
    return undefined;
  }
  if (!Array.isArray(value)) throw new ArgError("attachments must be a list.");
  if (value.length > 20) throw new ArgError("At most 20 attachments.");
  const files: Attachment[] = [];
  let total = 0;
  for (const [index, item] of value.entries()) {
    const where = `attachments[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new ArgError(`${where} must be an object.`);
    const entry = item as Record<string, unknown>;
    const allowed = new Set(["filename", "mimeType", "data", "uploadId", "inline", "contentId"]);
    const unknown = Object.keys(entry).find((key) => !allowed.has(key));
    if (unknown) throw new ArgError(`${where} has an unknown field: ${unknown}.`);
    const str = (key: string) => {
      const field = entry[key];
      if (field === undefined || field === null || field === "") return undefined;
      if (typeof field !== "string") throw new ArgError(`${where}.${key} must be a string.`);
      return field;
    };
    const data = str("data");
    const uploadId = str("uploadId");
    if ((data === undefined) === (uploadId === undefined)) throw new ArgError(`${where} needs exactly one of data or uploadId.`);
    let bytes: Buffer;
    let uploadedName: string | undefined;
    let uploadedType: string | undefined;
    if (uploadId !== undefined) {
      const upload =
        options.uploadsDir && isUploadId(uploadId) ? readUpload(options.uploadsDir, uploadId, options.now ?? Date.now()) : undefined;
      if (!upload) throw new ArgError(`${where}.uploadId ${JSON.stringify(uploadId.slice(0, 40))} isn't an upload that's still here. Uploads last a day.`);
      bytes = upload.bytes;
      uploadedName = upload.meta.filename;
      uploadedType = upload.meta.contentType === "application/octet-stream" ? undefined : upload.meta.contentType;
    } else {
      const clean = data!.replace(/\s+/g, "").replace(/^data:[^,]*;base64,/, "");
      if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(clean)) throw new ArgError(`${where}.data must be base64.`);
      bytes = Buffer.from(clean, clean.includes("-") || clean.includes("_") ? "base64url" : "base64");
      if (bytes.length === 0) throw new ArgError(`${where}.data is empty.`);
    }
    const filename = str("filename") ?? uploadedName;
    if (!filename) throw new ArgError(`${where}.filename is required.`);
    const problem = filenameProblem(filename);
    if (problem) throw new ArgError(`${where}.filename ${problem}.`);
    const extension = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase();
    const mimeType = (str("mimeType") ?? uploadedType ?? MIME_TYPES[extension ?? ""] ?? "application/octet-stream").toLowerCase();
    if (!contentTypeOk(mimeType)) throw new ArgError(`${where}.mimeType must be a plain type/subtype, like image/png.`);
    const inline = entry.inline ?? false;
    if (typeof inline !== "boolean") throw new ArgError(`${where}.inline must be true or false.`);
    const contentId = str("contentId");
    if (contentId !== undefined && !CONTENT_ID.test(contentId)) {
      throw new ArgError(`${where}.contentId can only have letters, digits and . _ @ - (up to 100).`);
    }
    if (inline && !contentId) throw new ArgError(`${where} is inline, so it needs a contentId to use as <img src="cid:...">.`);
    total += bytes.length;
    if (total > MAX_ATTACHMENT_BYTES) {
      throw new ArgError(
        `The attachments come to over ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB, the limit for one email. ` +
          "Crop the screenshots, or save them as JPEG.",
      );
    }
    files.push({ filename, mimeType, data: bytes, inline, ...(contentId ? { contentId } : {}) });
  }
  const ids = files.map((file) => file.contentId?.toLowerCase()).filter((id): id is string => !!id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) throw new ArgError(`Two attachments have the contentId ${duplicate}.`);
  const refs = html ? cidReferences(html) : new Set<string>();
  for (const file of files) {
    if (file.inline && !refs.has(file.contentId!.toLowerCase())) {
      throw new ArgError(
        html === undefined
          ? `${file.filename} is inline, which needs an htmlBody with <img src="cid:${file.contentId}">.`
          : `${file.filename} is inline, but htmlBody has no <img src="cid:${file.contentId}">.`,
      );
    }
  }
  for (const ref of refs) {
    if (!ids.includes(ref)) throw new ArgError(`htmlBody uses cid:${ref}, but no attachment has that contentId.`);
  }
  return files.length ? files : undefined;
}

const addressSchema = {
  type: "array",
  items: { type: "string" },
  description: "Email addresses, like \"Ann <ann@example.com>\" or ann@example.com.",
};

// The upload address comes from the gateway, which knows its own public URL.
const UPLOAD_URL = process.env.CONNECTORS_UPLOAD_URL || "this MCP server's address with /uploads in place of /mcp";
const UPLOAD_HELP =
  `POST the raw bytes to ${UPLOAD_URL}?filename=<name> with a Content-Type header and your usual Connectors ` +
  "Authorization: Bearer token, and use the uploadId it answers with. On a Mac wired by Connectors' install-clients, " +
  "the token is in the Keychain: curl -sS --data-binary @shot.png -H 'Content-Type: image/png' " +
  "-H \"Authorization: Bearer $(security find-generic-password -s connectors -a <your agent id> -w)\" " +
  `'${process.env.CONNECTORS_UPLOAD_URL || "<uploads URL>"}?filename=shot.png'. connectors__status says your agent id. Uploads last a day.`;

const composeProperties = {
  to: { ...addressSchema, description: "Recipients. Email addresses, like \"Ann <ann@example.com>\" or ann@example.com." },
  cc: { ...addressSchema, description: "Cc recipients." },
  bcc: { ...addressSchema, description: "Bcc recipients." },
  subject: { type: "string", description: "Subject. When replying, leave it out to use \"Re: \" and the original subject." },
  body: {
    type: "string",
    description: "Plain-text body. With htmlBody, it's the version for mail apps that don't show HTML, so keep the same words.",
  },
  htmlBody: {
    type: "string",
    description:
      "Optional HTML version of the body, for formatting and inline images. Use <img src=\"cid:<contentId>\"> to show an inline attachment. Gmail drops <style> blocks in some apps, so style elements inline.",
  },
  attachments: {
    type: "array",
    maxItems: 20,
    description: `Optional files, ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB at most altogether. Give each one either data (base64, fine for something tiny) or uploadId. For a real file such as a screenshot, upload it first so you don't have to type it out: ${UPLOAD_HELP}`,
    items: {
      type: "object",
      properties: {
        filename: { type: "string", description: "File name, like \"portal.png\". Optional with uploadId if the upload had one." },
        mimeType: { type: "string", description: "Like image/png. Optional: taken from the upload or the file name." },
        data: { type: "string", description: "The file as base64." },
        uploadId: { type: "string", description: "An id from POST /uploads (up_...)." },
        inline: { type: "boolean", description: "Show it in the HTML body instead of as an attachment. Needs contentId and htmlBody." },
        contentId: { type: "string", description: "For inline images: the name used in <img src=\"cid:...\">, like \"shot1\"." },
      },
      additionalProperties: false,
    },
  },
  replyToMessageId: {
    type: "string",
    description: "To reply, the Gmail id of the message being answered. Puts the message in the same thread.",
  },
};

type Threading = { threadId?: string; inReplyTo?: string; references?: string; subject?: string };

/**
 * Recipients, subject, body, attachments and reply headers from compose
 * arguments. `keep` is an existing draft's threading and subject, which
 * update_draft keeps unless the call replies to something else.
 */
async function composed(
  args: Record<string, unknown>,
  ctx: ToolContext,
  keep: Threading = {},
): Promise<{ raw: string; threadId?: string }> {
  const to = addressList(args, "to");
  if (!to) throw new ArgError("to needs at least one email address.");
  const body = reqString(args, "body");
  const htmlBody = optString(args, "htmlBody");
  const attachments = attachmentsFrom(args, { uploadsDir: ctx.uploadsDir });
  let subject = optString(args, "subject") ?? keep.subject;
  const replyTo = optString(args, "replyToMessageId");
  let { threadId, inReplyTo, references } = keep;
  if (replyTo) {
    const original = await google<Message>(
      ctx,
      "GET",
      withQuery(`${ctx.urls.gmail}/users/me/messages/${enc(replyTo)}`, {
        format: "metadata",
        metadataHeaders: ["Message-ID", "References", "Subject"],
      }),
    );
    threadId = original.threadId;
    inReplyTo = header(original, "Message-ID");
    references = [header(original, "References"), inReplyTo].filter(Boolean).join(" ") || undefined;
    if (optString(args, "subject") === undefined) {
      const originalSubject = header(original, "Subject") ?? "";
      subject = /^re:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`;
    }
  }
  if (subject === undefined) throw new ArgError("subject is required unless you're replying.");
  const raw = buildRawMessage({
    to,
    cc: addressList(args, "cc"),
    bcc: addressList(args, "bcc"),
    subject,
    body,
    htmlBody,
    attachments,
    inReplyTo,
    references,
  });
  return { raw, ...(threadId ? { threadId } : {}) };
}

type Draft = { id: string; message?: Message };

function draftResult(draft: Draft, saved: string) {
  return { draftId: draft.id, messageId: draft.message?.id, threadId: draft.message?.threadId, saved };
}

export const gmailTools: ToolDef[] = [
  {
    name: "search_threads",
    title: "Search Gmail",
    description:
      "Searches the user's Gmail with Gmail search syntax (for example \"from:ann is:unread newer_than:7d\") and lists matching threads, newest first, with subject, sender, date and snippet.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Gmail search, as typed in Gmail's search box. Leave out for the latest threads." },
        maxResults: { type: "integer", minimum: 1, maximum: 25, description: "How many threads (default 10)." },
        pageToken: { type: "string", description: "nextPageToken from an earlier search, for the next page." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args, ctx) {
      const list = await google<{ threads?: Thread[]; nextPageToken?: string; resultSizeEstimate?: number }>(
        ctx,
        "GET",
        withQuery(`${ctx.urls.gmail}/users/me/threads`, {
          q: optString(args, "query"),
          maxResults: optInt(args, "maxResults", 1, 25) ?? 10,
          pageToken: optString(args, "pageToken"),
        }),
      );
      const threads = await Promise.all(
        (list.threads ?? []).map((thread) =>
          google<Thread>(
            ctx,
            "GET",
            withQuery(`${ctx.urls.gmail}/users/me/threads/${enc(thread.id)}`, {
              format: "metadata",
              metadataHeaders: ["From", "Subject", "Date"],
            }),
          ),
        ),
      );
      return {
        threads: threads.map((thread, index) => {
          const messages = thread.messages ?? [];
          const first = messages[0];
          const last = messages.at(-1);
          const labels = [...new Set(messages.flatMap((message) => message.labelIds ?? []))];
          return {
            threadId: thread.id,
            subject: first ? header(first, "Subject") : undefined,
            from: last ? header(last, "From") : undefined,
            date: last ? header(last, "Date") : undefined,
            messages: messages.length,
            unread: labels.includes("UNREAD"),
            labels,
            snippet: list.threads?.[index]?.snippet ?? last?.snippet,
          };
        }),
        ...(list.nextPageToken ? { nextPageToken: list.nextPageToken } : {}),
      };
    },
  },
  {
    name: "get_thread",
    title: "Read a Gmail thread",
    description: "Gets every message in a Gmail thread with headers and plain-text bodies. Long bodies are cut.",
    inputSchema: {
      type: "object",
      properties: { threadId: { type: "string", description: "The thread id, from search_threads." } },
      required: ["threadId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args, ctx) {
      const thread = await google<Thread>(
        ctx,
        "GET",
        withQuery(`${ctx.urls.gmail}/users/me/threads/${enc(reqString(args, "threadId"))}`, { format: "full" }),
      );
      const messages = thread.messages ?? [];
      // Share the room between messages so a long thread still fits.
      const each = Math.max(2_000, Math.floor(MAX_THREAD_CHARS / Math.max(1, messages.length)));
      return { threadId: thread.id, messages: messages.map((message) => summarize(message, true, Math.min(each, MAX_BODY_CHARS))) };
    },
  },
  {
    name: "get_message",
    title: "Read a Gmail message",
    description: "Gets one Gmail message with its headers, plain-text body and a list of attachments.",
    inputSchema: {
      type: "object",
      properties: { messageId: { type: "string", description: "The message id." } },
      required: ["messageId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args, ctx) {
      const message = await google<Message>(
        ctx,
        "GET",
        withQuery(`${ctx.urls.gmail}/users/me/messages/${enc(reqString(args, "messageId"))}`, { format: "full" }),
      );
      return summarize(message, true);
    },
  },
  {
    name: "list_labels",
    title: "List Gmail labels",
    description: "Lists the user's Gmail labels with their ids, for use in searches (label:name).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(_args, ctx) {
      const result = await google<{ labels?: { id: string; name: string; type?: string }[] }>(
        ctx,
        "GET",
        `${ctx.urls.gmail}/users/me/labels`,
      );
      return { labels: (result.labels ?? []).map(({ id, name, type }) => ({ id, name, type })) };
    },
  },
  {
    name: "create_draft",
    title: "Create a Gmail draft",
    description:
      "Saves an email as a draft in the user's Gmail without sending it. The user can review and send it from Gmail. Plain text, or with htmlBody and attachments for formatting, screenshots and files (inline images too). To reply, pass replyToMessageId.",
    inputSchema: {
      type: "object",
      properties: composeProperties,
      required: ["to", "body"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async run(args, ctx) {
      const { raw, threadId } = await composed(args, ctx);
      const draft = await google<Draft>(ctx, "POST", `${ctx.urls.gmail}/users/me/drafts`, {
        message: { raw, ...(threadId ? { threadId } : {}) },
      });
      return draftResult(draft, "Saved as a draft. Nothing was sent.");
    },
  },
  {
    name: "update_draft",
    title: "Change a Gmail draft",
    description:
      "Replaces a draft's contents (recipients, subject, body, HTML and attachments) with these, without sending it. Give the whole email again, attachments included: anything left out is gone. The subject and the thread it replies to stay as they were unless you pass subject or replyToMessageId. Edit a draft through this rather than in Gmail's web page, where an agent's changes can lose the HTML.",
    inputSchema: {
      type: "object",
      properties: {
        draftId: { type: "string", description: "The draft's id, from create_draft." },
        ...composeProperties,
        subject: { type: "string", description: "Subject. Leave it out to keep the draft's." },
      },
      required: ["draftId", "to", "body"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async run(args, ctx) {
      const draftId = reqString(args, "draftId");
      const url = `${ctx.urls.gmail}/users/me/drafts/${enc(draftId)}`;
      const existing = await google<Draft>(ctx, "GET", withQuery(url, { format: "metadata" }));
      const message = existing.message ?? { id: "" };
      const { raw, threadId } = await composed(args, ctx, {
        threadId: message.threadId,
        inReplyTo: header(message, "In-Reply-To"),
        references: header(message, "References"),
        subject: header(message, "Subject"),
      });
      const draft = await google<Draft>(ctx, "PUT", url, { id: draftId, message: { raw, ...(threadId ? { threadId } : {}) } });
      return draftResult(draft, "Draft updated. Nothing was sent.");
    },
  },
  {
    name: "send_message",
    title: "Send an email",
    description:
      "Sends an email from the user's Gmail: plain text, or with htmlBody and attachments (inline images too). Every send waits for the user's approval first. To reply in a thread, pass replyToMessageId.",
    inputSchema: {
      type: "object",
      properties: composeProperties,
      required: ["to", "body"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async run(args, ctx) {
      const { raw, threadId } = await composed(args, ctx);
      const sent = await google<{ id: string; threadId?: string }>(ctx, "POST", `${ctx.urls.gmail}/users/me/messages/send`, {
        raw,
        ...(threadId ? { threadId } : {}),
      });
      return { messageId: sent.id, threadId: sent.threadId, sent: true };
    },
  },
];
