// Google Calendar tools for the built-in Google server, exposed as
// gcal__<tool>. The policy asks the owner before a create or update that has
// attendees ("gcal__*event*" with ifArgs attendees). Changing an event that
// already has guests reaches them too, so update_event refuses such a
// change unless the call names the attendees, which brings it under that
// rule and shows the owner the guest list on the approval page.

import {
  ArgError,
  type ToolDef,
  addressList,
  cut,
  enc,
  google,
  optBool,
  optInt,
  optString,
  reqString,
  withQuery,
} from "./api.ts";

type EventTime = { date?: string; dateTime?: string; timeZone?: string };
type Attendee = { email?: string; responseStatus?: string; optional?: boolean; self?: boolean; resource?: boolean; organizer?: boolean };
type CalendarEvent = {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: EventTime;
  end?: EventTime;
  organizer?: { email?: string; self?: boolean };
  attendees?: Attendee[];
  htmlLink?: string;
  hangoutLink?: string;
  recurringEventId?: string;
  recurrence?: string[];
};

const MAX_DESCRIPTION_CHARS = 5_000;

function summarize(event: CalendarEvent, full: boolean) {
  return {
    eventId: event.id,
    summary: event.summary,
    start: event.start?.dateTime ?? event.start?.date,
    end: event.end?.dateTime ?? event.end?.date,
    ...(event.start?.date ? { allDay: true } : {}),
    ...(event.start?.timeZone ? { timeZone: event.start.timeZone } : {}),
    location: event.location,
    status: event.status,
    organizer: event.organizer?.email,
    ...(event.attendees?.length
      ? {
          attendees: event.attendees.map((attendee) => ({
            email: attendee.email,
            responseStatus: attendee.responseStatus,
            ...(attendee.optional ? { optional: true } : {}),
            ...(attendee.self ? { self: true } : {}),
          })),
        }
      : {}),
    ...(event.hangoutLink ? { meetLink: event.hangoutLink } : {}),
    ...(event.recurringEventId ? { recurringEventId: event.recurringEventId } : {}),
    ...(full
      ? {
          description: event.description ? cut(event.description, MAX_DESCRIPTION_CHARS) : undefined,
          recurrence: event.recurrence,
          htmlLink: event.htmlLink,
        }
      : {}),
  };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** "2026-11-02" is an all-day date; anything else is a date and time. */
export function eventTime(value: string, key: string, timeZone?: string): EventTime {
  if (DATE_ONLY.test(value)) return { date: value };
  if (Number.isNaN(Date.parse(value))) {
    throw new ArgError(`${key} must be an RFC 3339 date and time (2026-11-02T09:30:00+10:00) or a date (2026-11-02).`);
  }
  return { dateTime: value, ...(timeZone ? { timeZone } : {}) };
}

/** Guests other than the calendar's owner and rooms. */
function guests(event: CalendarEvent): string[] {
  return (event.attendees ?? [])
    .filter((attendee) => !attendee.self && !attendee.resource && attendee.email)
    .map((attendee) => attendee.email!);
}

const timeDescription =
  "RFC 3339 with an offset (2026-11-02T09:30:00+10:00), a local time plus timeZone (2026-11-02T09:30:00), or a date (2026-11-02) for all day.";

const eventProperties = {
  calendarId: { type: "string", description: "Calendar id from list_calendars (default \"primary\", the user's main calendar)." },
  summary: { type: "string", description: "Title." },
  start: { type: "string", description: `Start. ${timeDescription}` },
  end: { type: "string", description: `End. ${timeDescription} For all day, the day after the last day.` },
  timeZone: { type: "string", description: "IANA time zone for local times, like Europe/Lisbon." },
  description: { type: "string", description: "Notes." },
  location: { type: "string", description: "Where." },
  attendees: {
    type: "array",
    items: { type: "string" },
    description: "Guests' email addresses. Events with guests wait for the user's approval.",
  },
  notifyGuests: {
    type: "boolean",
    description: "Email the guests about it (default true when there are attendees).",
  },
};

function eventBody(args: Record<string, unknown>, requireTimes: boolean): Partial<CalendarEvent> {
  const timeZone = optString(args, "timeZone");
  const start = requireTimes ? reqString(args, "start") : optString(args, "start");
  const end = requireTimes ? reqString(args, "end") : optString(args, "end");
  const attendees = addressList(args, "attendees");
  const body: Partial<CalendarEvent> = {};
  const summary = optString(args, "summary");
  if (summary !== undefined) body.summary = summary;
  const description = optString(args, "description");
  if (description !== undefined) body.description = description;
  const location = optString(args, "location");
  if (location !== undefined) body.location = location;
  if (start) body.start = eventTime(start, "start", timeZone);
  if (end) body.end = eventTime(end, "end", timeZone);
  if (attendees) body.attendees = attendees.map((email) => ({ email }));
  return body;
}

function sendUpdates(args: Record<string, unknown>, hasAttendees: boolean): "all" | "none" {
  return (optBool(args, "notifyGuests") ?? hasAttendees) ? "all" : "none";
}

export const calendarTools: ToolDef[] = [
  {
    name: "list_calendars",
    title: "List calendars",
    description: "Lists the calendars in the user's Google Calendar with their ids and time zones.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(_args, ctx) {
      const result = await google<{
        items?: { id: string; summary?: string; primary?: boolean; accessRole?: string; timeZone?: string }[];
      }>(ctx, "GET", `${ctx.urls.calendar}/users/me/calendarList`);
      return {
        calendars: (result.items ?? []).map(({ id, summary, primary, accessRole, timeZone }) => ({
          id,
          summary,
          ...(primary ? { primary: true } : {}),
          accessRole,
          timeZone,
        })),
      };
    },
  },
  {
    name: "list_events",
    title: "List calendar events",
    description:
      "Lists events in one of the user's calendars in time order, with recurring events expanded. Without timeMin or timeMax it lists upcoming events.",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: eventProperties.calendarId,
        timeMin: { type: "string", description: "Earliest end time, RFC 3339 with an offset (2026-11-02T00:00:00+00:00)." },
        timeMax: { type: "string", description: "Latest start time, RFC 3339 with an offset." },
        query: { type: "string", description: "Free text to match in titles, descriptions, locations and guests." },
        maxResults: { type: "integer", minimum: 1, maximum: 100, description: "How many events (default 25)." },
        pageToken: { type: "string", description: "nextPageToken from an earlier call, for the next page." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args, ctx) {
      const calendarId = optString(args, "calendarId") ?? "primary";
      let timeMin = optString(args, "timeMin");
      const timeMax = optString(args, "timeMax");
      if (!timeMin && !timeMax) timeMin = new Date().toISOString();
      const result = await google<{ items?: CalendarEvent[]; nextPageToken?: string; timeZone?: string }>(
        ctx,
        "GET",
        withQuery(`${ctx.urls.calendar}/calendars/${enc(calendarId)}/events`, {
          singleEvents: true,
          orderBy: "startTime",
          timeMin,
          timeMax,
          q: optString(args, "query"),
          maxResults: optInt(args, "maxResults", 1, 100) ?? 25,
          pageToken: optString(args, "pageToken"),
        }),
      );
      return {
        calendarTimeZone: result.timeZone,
        events: (result.items ?? []).map((event) => summarize(event, false)),
        ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}),
      };
    },
  },
  {
    name: "get_event",
    title: "Get a calendar event",
    description: "Gets one event with its description, guests and links.",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: eventProperties.calendarId,
        eventId: { type: "string", description: "The event id." },
      },
      required: ["eventId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args, ctx) {
      const calendarId = optString(args, "calendarId") ?? "primary";
      const event = await google<CalendarEvent>(
        ctx,
        "GET",
        `${ctx.urls.calendar}/calendars/${enc(calendarId)}/events/${enc(reqString(args, "eventId"))}`,
      );
      return summarize(event, true);
    },
  },
  {
    name: "create_event",
    title: "Create a calendar event",
    description:
      "Creates an event in one of the user's calendars. With attendees it waits for the user's approval, and guests get an invite unless notifyGuests is false.",
    inputSchema: {
      type: "object",
      properties: eventProperties,
      required: ["summary", "start", "end"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async run(args, ctx) {
      const calendarId = optString(args, "calendarId") ?? "primary";
      reqString(args, "summary");
      const body = eventBody(args, true);
      const event = await google<CalendarEvent>(
        ctx,
        "POST",
        withQuery(`${ctx.urls.calendar}/calendars/${enc(calendarId)}/events`, {
          sendUpdates: sendUpdates(args, Boolean(body.attendees?.length)),
        }),
        body,
      );
      return summarize(event, true);
    },
  },
  {
    name: "update_event",
    title: "Change a calendar event",
    description:
      "Changes the fields you pass on an existing event and leaves the rest. If the event has guests, pass the full attendees list (the current one if it isn't changing): the change reaches them, so it waits for the user's approval. attendees replaces the whole guest list.",
    inputSchema: {
      type: "object",
      properties: { ...eventProperties, eventId: { type: "string", description: "The event id." } },
      required: ["eventId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async run(args, ctx) {
      const calendarId = optString(args, "calendarId") ?? "primary";
      const url = `${ctx.urls.calendar}/calendars/${enc(calendarId)}/events/${enc(reqString(args, "eventId"))}`;
      const body = eventBody(args, false);
      const current = await google<CalendarEvent>(ctx, "GET", url);
      const existing = guests(current);
      if (existing.length && !body.attendees?.length) {
        throw new ArgError(
          `This event has guests (${existing.join(", ")}), so changing it reaches them. ` +
            "Call again with the full attendees list (the same one if it isn't changing) so the user can approve the change. " +
            "To remove every guest, ask the user to do it in Google Calendar.",
        );
      }
      if (Object.keys(body).length === 0) throw new ArgError("Pass at least one field to change.");
      // Keep the owner's own entry (and rooms) when the guest list is replaced.
      if (body.attendees) {
        const kept = (current.attendees ?? []).filter((attendee) => attendee.self || attendee.resource);
        const named = new Set(body.attendees.map((attendee) => attendee.email?.toLowerCase()));
        body.attendees = [...kept.filter((attendee) => !named.has(attendee.email?.toLowerCase())), ...body.attendees];
      }
      const event = await google<CalendarEvent>(
        ctx,
        "PATCH",
        withQuery(url, { sendUpdates: sendUpdates(args, existing.length > 0 || Boolean(body.attendees?.length)) }),
        body,
      );
      return summarize(event, true);
    },
  },
];
