// Gmail tools for the built-in Google server, exposed as gmail__<tool>.
// Reads, labels, drafts and sending. Sending matches the policy's
// "*__*send*" rule, so the owner approves every send and sees the full message
// on the approval page. There's deliberately no "send draft" tool: its
// approval page would show only a draft id, not what goes out.

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

export type OutgoingMessage = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
};

/** A plain-text RFC 5322 message, base64url as Gmail's raw field wants it. */
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
  lines.push("MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "");
  const body = Buffer.from(message.body.replace(/\r?\n/g, "\r\n")).toString("base64");
  lines.push(...(body.match(/.{1,76}/g) ?? [""]));
  return Buffer.from(lines.join("\r\n")).toString("base64url");
}

const addressSchema = {
  type: "array",
  items: { type: "string" },
  description: "Email addresses, like \"Ann <ann@example.com>\" or ann@example.com.",
};

const composeProperties = {
  to: { ...addressSchema, description: "Recipients. Email addresses, like \"Ann <ann@example.com>\" or ann@example.com." },
  cc: { ...addressSchema, description: "Cc recipients." },
  bcc: { ...addressSchema, description: "Bcc recipients." },
  subject: { type: "string", description: "Subject. When replying, leave it out to use \"Re: \" and the original subject." },
  body: { type: "string", description: "Plain-text body." },
  replyToMessageId: {
    type: "string",
    description: "To reply, the Gmail id of the message being answered. Puts the message in the same thread.",
  },
};

/** Recipients, subject, body and reply headers from compose arguments. */
async function composed(args: Record<string, unknown>, ctx: ToolContext): Promise<{ raw: string; threadId?: string }> {
  const to = addressList(args, "to");
  if (!to) throw new ArgError("to needs at least one email address.");
  const body = reqString(args, "body");
  let subject = optString(args, "subject");
  const replyTo = optString(args, "replyToMessageId");
  let threadId: string | undefined;
  let inReplyTo: string | undefined;
  let references: string | undefined;
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
    if (subject === undefined) {
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
    inReplyTo,
    references,
  });
  return { raw, ...(threadId ? { threadId } : {}) };
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
      "Saves a plain-text email as a draft in the user's Gmail without sending it. The user can review and send it from Gmail. To reply, pass replyToMessageId.",
    inputSchema: {
      type: "object",
      properties: composeProperties,
      required: ["to", "body"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async run(args, ctx) {
      const { raw, threadId } = await composed(args, ctx);
      const draft = await google<{ id: string; message?: { id: string; threadId?: string } }>(
        ctx,
        "POST",
        `${ctx.urls.gmail}/users/me/drafts`,
        { message: { raw, ...(threadId ? { threadId } : {}) } },
      );
      return {
        draftId: draft.id,
        messageId: draft.message?.id,
        threadId: draft.message?.threadId,
        saved: "Saved as a draft. Nothing was sent.",
      };
    },
  },
  {
    name: "send_message",
    title: "Send an email",
    description:
      "Sends a plain-text email from the user's Gmail. Every send waits for the user's approval first. To reply in a thread, pass replyToMessageId.",
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
