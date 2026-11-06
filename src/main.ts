import { device } from "@shared/device";
import { loadValues, str, num, bool } from "@shared/settings";
import manifest from "./appmeta/manifest.json";
import { measure, type DisplayDrawParams } from "@busy-app/busy-lib";

/** The name the app draws under; the device clears elements by this id. */
const APP = manifest.id;

type Element = NonNullable<DisplayDrawParams["elements"]>[number];

const SCREEN_W = 72;
const SCREEN_H = 16;
/** Width of the accent bar on the left edge. */
const ACCENT_W = 2;
/** Where the text columns start. */
const TEXT_X = ACCENT_W + 2;
const TEXT_W = SCREEN_W - TEXT_X;
/** Scrolling for titles wider than the screen, in pixels per minute (10 px/s), and the pauses around a pass. */
const SCROLL_RATE = 600;
const SCROLL_START_MS = 1500;
const SCROLL_REPEAT_MS = 3000;
/** The title font: condensed fits a few more characters before a title has to scroll. */
const TITLE_FONT = "condensed";
/** Frames in a transition, and the pause between them. */
const TRANSITION_STEPS = 6;
const TRANSITION_MS = 70;
/** Poll interval while nothing is playing. */
const IDLE_POLL_SECONDS = 60;
/** Progress bar refresh while a single stream is on screen. */
const PROGRESS_TICK_MS = 2000;

/** Accent per media type: a warm amber for films, blue for TV, green for music, grey for the rest. */
const ACCENT: Record<string, string> = {
  movie: "#E5A00D",
  episode: "#3B8BEB",
  track: "#3DD68C",
  clip: "#B07CE8",
  photo: "#B07CE8",
};
const DIM = "#FFFFFF70";
const PAUSED = "#FFFFFF50";
/** Transcode decision colours for the accent bar's lower cap. */
const DECISION: Record<string, string> = {
  "direct play": "#3DD68C",
  copy: "#E5A00D",
  transcode: "#E0443E",
};

interface Settings {
  url: string;
  apiKey: string;
  pollSeconds: number;
  dwellSeconds: number;
  transition: "slide" | "fade" | "curtain" | "cut";
  showIdle: boolean;
}

/** The few fields kept from a Tautulli session. */
interface Stream {
  key: string;
  title: string;
  subtitle: string;
  user: string;
  mediaType: string;
  decision: string;
  playing: boolean;
  /** Playback position in ms when fetched, and when that was. */
  offsetMs: number;
  durationMs: number;
  fetchedAt: number;
}

interface State {
  settings: Settings;
  streams: Stream[];
  /** Index of the stream on screen. */
  current: number;
  /** When the current stream was first shown, for the dwell timer. */
  shownAt: number;
  /** Auto-advance paused by the OK button. */
  held: boolean;
  /** A transition is running; polls and ticks wait. */
  animating: boolean;
  /** Last error from Tautulli, shown instead of streams. */
  error: string | null;
  stopped: boolean;
  drawing: boolean;
  redrawWanted: boolean;
}

/* ---------- Tautulli ---------- */

function text(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

function integer(v: unknown): number {
  const n = typeof v === "number" ? v : parseInt(text(v), 10);
  return isFinite(n) ? n : 0;
}

/** Maps one Tautulli session to the fields the screen needs. */
function toStream(s: Record<string, unknown>, fetchedAt: number): Stream {
  const mediaType = text(s.media_type);
  const grandparent = text(s.grandparent_title);
  const parent = text(s.parent_title);
  const title = text(s.title);
  const year = text(s.year);
  const user = text(s.friendly_name) || text(s.user);
  // Line one is what is playing; line two is who is watching it, then the episode, year or artist.
  let line1 = title;
  let detail = "";
  if (mediaType === "episode") {
    line1 = grandparent || title;
    const season = integer(s.parent_media_index);
    const episode = integer(s.media_index);
    detail = season || episode ? `S${season}E${episode}` : "";
  } else if (mediaType === "movie") {
    detail = year;
  } else if (mediaType === "track") {
    detail = grandparent || parent;
  }
  const line2 = detail ? `${user}  ${detail}` : user;
  const decision = text(s.transcode_decision).toLowerCase();
  return {
    key: text(s.session_key) || text(s.session_id) || title,
    title: line1,
    subtitle: line2,
    user,
    mediaType,
    decision,
    playing: text(s.state) === "playing",
    offsetMs: integer(s.view_offset),
    durationMs: integer(s.duration),
    fetchedAt,
  };
}

async function fetchStreams(settings: Settings): Promise<Stream[]> {
  const res = await fetch(`${settings.url}/api/v2?cmd=get_activity`, {
    headers: { Accept: "application/json", "X-Api-Key": settings.apiKey },
  });
  if (!res.ok) throw new Error(`Tautulli HTTP ${res.status}`);
  const body = (await res.json()) as { response?: { result?: string; message?: string; data?: { sessions?: unknown[] } } };
  const r = body.response;
  if (!r || r.result !== "success") throw new Error(r?.message || "Tautulli error");
  const now = Date.now();
  const sessions = Array.isArray(r.data?.sessions) ? r.data!.sessions! : [];
  return sessions.map((s) => toStream(s as Record<string, unknown>, now));
}

/* ---------- frame ---------- */

function progressOf(s: Stream): number {
  if (s.durationMs <= 0) return 0;
  const elapsed = s.playing ? Date.now() - s.fetchedAt : 0;
  return Math.max(0, Math.min(1, (s.offsetMs + elapsed) / s.durationMs));
}

function textWidth(t: string, font: "normal" | "condensed" | "small" | "tiny"): number {
  try {
    return measure({ type: "text", id: "m", text: t, font }).width;
  } catch {
    return t.length * 5;
  }
}

/** Only printable ASCII reaches the device fonts. */
function ascii(t: string): string {
  let out = "";
  for (const ch of t) {
    const c = ch.charCodeAt(0);
    out += c >= 32 && c < 127 ? ch : c === 0x2019 ? "'" : c === 0x2013 || c === 0x2014 ? "-" : "";
  }
  return out;
}

/**
 * The elements of one stream, offset by `dx` pixels (for sliding) with the given text alpha (for fading).
 * Ids carry a slot suffix so two streams can be on screen during a transition.
 */
function barElement(s: Stream, slot: string, dx: number, alpha: string): Element {
  const accent = ACCENT[s.mediaType] ?? "#9A9A9A";
  return {
    id: `bar${slot}`,
    type: "rectangle",
    x: TEXT_X + dx,
    y: SCREEN_H - 1,
    align: "top_left",
    width: Math.max(1, Math.round(TEXT_W * progressOf(s))),
    height: 1,
    fill: "solid",
    fill_colors: [s.playing ? accent + alpha : PAUSED],
    border_width: 0,
    z_index: 1,
  };
}

function streamElements(s: Stream, slot: string, dx: number, alpha: string): Element[] {
  const accent = ACCENT[s.mediaType] ?? "#9A9A9A";
  const title = ascii(s.title);
  const scrolls = textWidth(title, TITLE_FONT) > TEXT_W;
  const subtitle = ascii(s.subtitle) + (s.playing ? "" : " ||");
  const subScrolls = textWidth(subtitle, "small") > TEXT_W;
  const elements: Element[] = [
    {
      id: `accent${slot}`,
      type: "rectangle",
      x: dx,
      y: 0,
      align: "top_left",
      width: ACCENT_W,
      height: SCREEN_H - 4,
      fill: "solid",
      fill_colors: [accent + alpha],
      border_width: 0,
    },
    {
      id: `decision${slot}`,
      type: "rectangle",
      x: dx,
      y: SCREEN_H - 3,
      align: "top_left",
      width: ACCENT_W,
      height: 2,
      fill: "solid",
      fill_colors: [(DECISION[s.decision] ?? "#9A9A9A") + alpha],
      border_width: 0,
    },
    {
      id: `title${slot}`,
      type: "text",
      x: TEXT_X + dx,
      y: 0,
      align: "top_left",
      text: title,
      font: TITLE_FONT,
      color: "#FFFFFF" + alpha,
      width: TEXT_W,
      ...(scrolls ? { scroll_rate: SCROLL_RATE, scroll_start_delay: SCROLL_START_MS, scroll_repeat_delay: SCROLL_REPEAT_MS } : {}),
    },
    {
      id: `sub${slot}`,
      type: "text",
      x: TEXT_X + dx,
      y: 7,
      align: "top_left",
      text: subtitle,
      font: "small",
      color: accent + (alpha === "FF" ? "D0" : alpha),
      width: TEXT_W,
      ...(subScrolls ? { scroll_rate: SCROLL_RATE, scroll_start_delay: SCROLL_START_MS + 1000, scroll_repeat_delay: SCROLL_REPEAT_MS } : {}),
    },
    {
      id: `track${slot}`,
      type: "rectangle",
      x: TEXT_X + dx,
      y: SCREEN_H - 1,
      align: "top_left",
      width: TEXT_W,
      height: 1,
      fill: "solid",
      fill_colors: ["#FFFFFF28"],
      border_width: 0,
    },
    barElement(s, slot, dx, alpha),
  ];
  return elements;
}

/** How long a stream must stay on screen for both lines to scroll through once; 0 when nothing scrolls. */
function scrollTimeMs(s: Stream): number {
  const overflow = Math.max(
    textWidth(ascii(s.title), TITLE_FONT) - TEXT_W,
    textWidth(ascii(s.subtitle) + (s.playing ? "" : " ||"), "small") - TEXT_W,
  );
  if (overflow <= 0) return 0;
  return SCROLL_START_MS + 1000 + (overflow / (SCROLL_RATE / 60)) * 1000 + 1500;
}

/** What a full redraw depends on; while it is unchanged only the progress bar is resent, so scrolling titles keep their place. */
function signature(s: Stream): string {
  return `${s.key}|${s.title}|${s.subtitle}|${s.playing}|${s.decision}`;
}

const STREAM_IDS = ["accent", "decision", "title", "sub", "track", "bar"];

function idsFor(slot: string): string[] {
  return STREAM_IDS.map((id) => id + slot);
}

function messageElements(line: string, colour: string): Element[] {
  return [
    { id: "msg", type: "text", x: SCREEN_W / 2, y: SCREEN_H / 2, align: "center", text: line, font: "small", color: colour },
  ];
}

/* ---------- app ---------- */

function report(err: unknown): void {
  console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function main(): void {
  const state: State = {
    settings: { url: "http://tautulli.lan:8181", apiKey: "", pollSeconds: 15, dwellSeconds: 8, transition: "slide", showIdle: true },
    streams: [],
    current: 0,
    shownAt: Date.now(),
    held: false,
    animating: false,
    error: null,
    stopped: false,
    drawing: false,
    redrawWanted: false,
  };

  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  /** What is on screen now, to clear it when the layout changes. */
  let shown: "stream" | "message" | "blank" = "blank";
  let shownSig = "";
  let slotA = "a";

  async function drawElements(elements: Element[]): Promise<void> {
    await device.DisplayDraw({ application_name: APP, priority: 50, elements });
  }

  async function clearIds(ids: string[]): Promise<void> {
    await device.DisplayClear({ application_name: APP, element_ids: ids });
  }

  /** Redraws the current stream in place (progress, pause state), coalescing concurrent requests. */
  async function draw(): Promise<void> {
    if (state.stopped || state.animating) return;
    if (state.drawing) {
      state.redrawWanted = true;
      return;
    }
    state.drawing = true;
    try {
      if (state.error) {
        if (shown === "stream") await clearIds(idsFor(slotA));
        shown = "message";
        await drawElements(messageElements(state.error, "#E0443EFF"));
      } else if (state.streams.length === 0) {
        if (shown === "stream") await clearIds(idsFor(slotA));
        if (state.settings.showIdle) {
          shown = "message";
          await drawElements(messageElements("Nothing playing", DIM));
        } else if (shown !== "blank") {
          await clearIds(["msg"]);
          shown = "blank";
        }
      } else {
        if (shown === "message") await clearIds(["msg"]);
        const s = state.streams[Math.min(state.current, state.streams.length - 1)]!;
        const sig = signature(s);
        if (shown === "stream" && shownSig === sig) {
          await drawElements([barElement(s, slotA, 0, "FF")]);
        } else {
          shown = "stream";
          shownSig = sig;
          await drawElements(streamElements(s, slotA, 0, "FF"));
        }
      }
    } finally {
      state.drawing = false;
      if (state.redrawWanted && !state.stopped) {
        state.redrawWanted = false;
        void draw().catch(report);
      }
    }
  }

  /** Animates from the current stream to `next` with the configured transition, then makes it current. */
  async function transitionTo(next: number): Promise<void> {
    if (state.stopped || state.animating || state.streams.length === 0) return;
    const from = state.streams[Math.min(state.current, state.streams.length - 1)]!;
    const to = state.streams[next]!;
    state.animating = true;
    const slotB = slotA === "a" ? "b" : "a";
    try {
      if (shown !== "stream") {
        if (shown === "message") await clearIds(["msg"]);
        await drawElements(streamElements(to, slotB, 0, "FF"));
      } else if (state.settings.transition === "slide") {
        for (let i = 1; i <= TRANSITION_STEPS; i++) {
          const dx = Math.round((SCREEN_W * i) / TRANSITION_STEPS);
          await drawElements(streamElements(from, slotA, -dx, "FF").concat(streamElements(to, slotB, SCREEN_W - dx, "FF")));
          await sleep(TRANSITION_MS);
        }
        await clearIds(idsFor(slotA));
      } else if (state.settings.transition === "fade") {
        const ramp = ["C0", "80", "40", "10"];
        for (const a of ramp) {
          await drawElements(streamElements(from, slotA, 0, a));
          await sleep(TRANSITION_MS);
        }
        await clearIds(idsFor(slotA));
        for (const a of ramp.slice().reverse().concat("FF")) {
          await drawElements(streamElements(to, slotB, 0, a));
          await sleep(TRANSITION_MS);
        }
      } else if (state.settings.transition === "curtain") {
        const curtain = (width: number, x: number): Element => ({
          id: "curtain",
          type: "rectangle",
          x,
          y: 0,
          align: "top_left",
          width: Math.max(1, width),
          height: SCREEN_H,
          fill: "solid",
          fill_colors: ["#000000FF"],
          border_width: 0,
          z_index: 20,
        });
        for (let i = 1; i <= TRANSITION_STEPS; i++) {
          await drawElements([curtain(Math.round((SCREEN_W * i) / TRANSITION_STEPS), 0)]);
          await sleep(TRANSITION_MS);
        }
        await clearIds(idsFor(slotA));
        await drawElements(streamElements(to, slotB, 0, "FF").concat(curtain(SCREEN_W, 0)));
        for (let i = TRANSITION_STEPS - 1; i >= 0; i--) {
          const w = Math.round((SCREEN_W * i) / TRANSITION_STEPS);
          await drawElements([curtain(w, SCREEN_W - w)]);
          await sleep(TRANSITION_MS);
        }
        await clearIds(["curtain"]);
      } else {
        await clearIds(idsFor(slotA));
        await drawElements(streamElements(to, slotB, 0, "FF"));
      }
      slotA = slotB;
      shown = "stream";
      shownSig = signature(to);
      state.current = next;
      state.shownAt = Date.now();
    } finally {
      state.animating = false;
    }
  }

  /** Fetches activity and merges it into the state without losing the stream on screen. */
  async function poll(): Promise<void> {
    if (state.stopped) return;
    try {
      if (!state.settings.apiKey) throw new Error("Set the API key");
      const fresh = await fetchStreams(state.settings);
      const currentKey = state.streams[state.current]?.key;
      state.streams = fresh;
      state.error = null;
      const keep = fresh.findIndex((s) => s.key === currentKey);
      state.current = keep >= 0 ? keep : 0;
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
      state.streams = [];
    }
    await draw();
    schedulePoll();
  }

  function schedulePoll(): void {
    if (state.stopped) return;
    if (pollTimer !== null) clearTimeout(pollTimer);
    const seconds = state.streams.length === 0 && !state.error ? Math.max(state.settings.pollSeconds, IDLE_POLL_SECONDS) : state.settings.pollSeconds;
    pollTimer = setTimeout(() => void poll().catch(report), seconds * 1000);
  }

  /** Advances the progress bar and, on the dwell timer, moves to the next stream. */
  function tick(): void {
    if (state.stopped || state.animating || state.streams.length === 0) return;
    const many = state.streams.length > 1;
    const current = state.streams[Math.min(state.current, state.streams.length - 1)]!;
    const dwell = Math.max(state.settings.dwellSeconds * 1000, scrollTimeMs(current));
    if (many && !state.held && Date.now() - state.shownAt >= dwell) {
      void transitionTo((state.current + 1) % state.streams.length).catch(report);
    } else {
      void draw().catch(report);
    }
  }

  function stop(unbind: () => void): void {
    state.stopped = true;
    if (pollTimer !== null) clearTimeout(pollTimer);
    if (tickTimer !== null) clearInterval(tickTimer);
    pollTimer = null;
    tickTimer = null;
    setTimeout(unbind, 0);
  }

  const unbind = listen("input", (event) => {
    if (state.stopped) return;
    if (event.key === "back" && event.action === "short") {
      stop(unbind);
      return;
    }
    if (event.key === "encoder" && state.streams.length > 1) {
      const n = state.streams.length;
      void transitionTo((state.current + event.delta + n) % n).catch(report);
      return;
    }
    if (event.key === "ok" && event.action === "short") {
      state.held = !state.held;
      state.shownAt = Date.now();
      return;
    }
    if (event.key === "start" && event.action === "short") {
      void poll().catch(report);
    }
  });

  void loadValues(APP)
    .then((values) => {
      const s = state.settings;
      s.url = str(values, "tautulli_url", s.url).replace(/\/+$/, "");
      s.apiKey = str(values, "api_key", s.apiKey);
      s.pollSeconds = Math.max(5, num(values, "poll_seconds", s.pollSeconds));
      s.dwellSeconds = Math.max(3, num(values, "dwell_seconds", s.dwellSeconds));
      const t = str(values, "transition", s.transition);
      s.transition = t === "fade" || t === "curtain" || t === "cut" ? t : "slide";
      s.showIdle = bool(values, "show_idle", s.showIdle);
    })
    .catch(report)
    .then(() => {
      tickTimer = setInterval(tick, PROGRESS_TICK_MS);
      void poll().catch(report);
    });
}

main();
