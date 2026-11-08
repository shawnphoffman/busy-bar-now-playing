import { device } from "@shared/device";
import { loadValues, str, num, bool } from "@shared/settings";
import { readSnapshot, saveSnapshot, ageOf } from "@shared/cache";
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
/** Longest Tautulli request; TLS on the bar alone can take several seconds. */
const FETCH_TIMEOUT_MS = 20000;
/** After failures the next try waits twice as long each time, up to this. */
const MAX_BACKOFF_SECONDS = 300;
/** Past this age, kept streams give way to the error: they have probably ended. */
const ERROR_AFTER_MS = 10 * 60000;

/** The launch snapshot: what was on screen last time, painted at once while a fresh fetch runs. */
const CACHE_KEY = "np";
/** Rewrite an unchanged snapshot this often, so its age stays honest. */
const CACHE_HEARTBEAT_MS = 10 * 60000;
/** Cached streams older than these are not shown at launch: a playing one has likely moved on, a paused one stopped. */
const CACHE_PLAYING_MAX_MS = 20 * 60000;
const CACHE_PAUSED_MAX_MS = 10 * 60000;
/** Accent alpha while the data on screen is not live: a quiet cue in place of a spinner. */
const STALE_ALPHA = "50";

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
  /** Last error from Tautulli; shown instead of streams only once they are too old to trust. */
  error: string | null;
  /** A setup problem (no API key) that no retry will fix: shown at once. */
  setupError: boolean;
  /** When Tautulli last answered, from this run or the launch snapshot; 0 before any data. */
  lastOk: number;
  /** Consecutive failed polls, for the backoff. */
  failures: number;
  /** A poll is in flight; another request waits for it. */
  polling: boolean;
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

/** fetch with a time limit where the runtime supports aborting; otherwise a plain fetch. */
async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  if (typeof AbortController !== "function") return fetch(url, init);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchStreams(settings: Settings): Promise<Stream[]> {
  const res = await fetchWithTimeout(
    `${settings.url}/api/v2?cmd=get_activity`,
    { headers: { Accept: "application/json", "X-Api-Key": settings.apiKey } },
    FETCH_TIMEOUT_MS,
  );
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

/** The accent alpha: the transition's, or dimmer while the data on screen is not live. */
function accentAlpha(alpha: string, stale: boolean): string {
  return stale && parseInt(alpha, 16) > parseInt(STALE_ALPHA, 16) ? STALE_ALPHA : alpha;
}

/** The accent bar and its transcode cap: the only elements that change when the data goes stale or live again. */
function capElements(s: Stream, slot: string, dx: number, alpha: string, stale: boolean): Element[] {
  const a = accentAlpha(alpha, stale);
  return [
    {
      id: `accent${slot}`,
      type: "rectangle",
      x: dx,
      y: 0,
      align: "top_left",
      width: ACCENT_W,
      height: SCREEN_H - 4,
      fill: "solid",
      fill_colors: [(ACCENT[s.mediaType] ?? "#9A9A9A") + a],
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
      fill_colors: [(DECISION[s.decision] ?? "#9A9A9A") + a],
      border_width: 0,
    },
  ];
}

function streamElements(s: Stream, slot: string, dx: number, alpha: string, stale: boolean): Element[] {
  const accent = ACCENT[s.mediaType] ?? "#9A9A9A";
  const title = ascii(s.title);
  const scrolls = textWidth(title, TITLE_FONT) > TEXT_W;
  const subtitle = ascii(s.subtitle) + (s.playing ? "" : " ||");
  const subScrolls = textWidth(subtitle, "small") > TEXT_W;
  const elements: Element[] = [
    ...capElements(s, slot, dx, alpha, stale),
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

/**
 * The very first launch, before any data: the stream layout's empty frame (a dim accent bar and progress track),
 * drawn at once so the app owns the screen while Tautulli answers.
 */
function skeletonElements(): Element[] {
  const rect = (id: string, x: number, y: number, width: number, height: number, colour: string): Element => ({
    id,
    type: "rectangle",
    x,
    y,
    align: "top_left",
    width,
    height,
    fill: "solid",
    fill_colors: [colour],
    border_width: 0,
  });
  return [rect("skel_accent", 0, 0, ACCENT_W, SCREEN_H - 1, "#FFFFFF30"), rect("skel_track", TEXT_X, SCREEN_H - 1, TEXT_W, 1, "#FFFFFF28")];
}

/**
 * `e` marked to expire at once. The firmware shows its "Loading..." screen whenever the app has nothing on screen,
 * even for a moment, so the app never clears one layout before drawing the next. Instead the draw that adds the new
 * elements also re-sends the old ones with a past `display_until` (a string, as the firmware reads it), and the
 * firmware removes them in that same update. The element must keep its type: an update that changes an element's
 * type is rejected outright.
 */
function expired(e: Element): Element {
  return { ...e, display_until: "1" };
}

/** A transparent pixel that keeps the screen the app's while it deliberately shows nothing (idle message off). */
const BLANK: Element = { id: "blank", type: "rectangle", x: 0, y: 0, align: "top_left", width: 1, height: 1, fill: "solid", fill_colors: ["#00000000"], border_width: 0 };

/* ---------- launch snapshot ---------- */

interface Cached {
  streams: Stream[];
  showIdle: boolean;
}

/** The streams from a snapshot still worth painting: young enough, and (when playing) not yet past their end. */
function usableStreams(streams: Stream[], savedAt: number): Stream[] {
  const age = ageOf(savedAt);
  return streams.filter((s) => {
    if (typeof s.key !== "string" || typeof s.title !== "string") return false;
    if (!s.playing) return age < CACHE_PAUSED_MAX_MS;
    return age < CACHE_PLAYING_MAX_MS && (s.durationMs <= 0 || progressOf(s) < 1);
  });
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
    setupError: false,
    lastOk: 0,
    failures: 0,
    polling: false,
    stopped: false,
    drawing: false,
    redrawWanted: false,
  };

  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  /** What is on screen now, to clear it when the layout changes. */
  let shown: "stream" | "message" | "skeleton" | "blank" = "blank";
  let shownSig = "";
  let shownStale = false;
  let slotA = "a";

  /** The last full layout sent, so a different layout can expire exactly these elements. */
  let shownElements: Element[] = [];

  /**
   * Puts up `elements` as layout `next` in one draw that also expires the old layout, so the screen is never empty
   * in between. The caller sets `shown`.
   */
  async function swapTo(next: typeof shown, elements: Element[]): Promise<void> {
    const now = elements.length > 0 ? elements : [BLANK];
    const ids = new Set(now.map((e) => e.id));
    const old = shown !== next ? shownElements.filter((e) => !ids.has(e.id)) : [];
    await drawElements(now.concat(old.map(expired)));
    shownElements = now;
  }

  /**
   * The data on screen is not live: refreshing has failed and the last good answer is older than a couple of polls.
   * A refresh that is merely still running (at launch, say) is not stale: it lands quietly.
   */
  function isStale(): boolean {
    return state.failures > 0 && state.lastOk > 0 && ageOf(state.lastOk) > Math.max(state.settings.pollSeconds * 2, 30) * 1000 + 5000;
  }

  /** The error replaces the streams only for setup problems, or once the last good data is too old to trust. */
  function errorToShow(): string | null {
    if (!state.error) return null;
    if (state.setupError || state.lastOk === 0 || ageOf(state.lastOk) > ERROR_AFTER_MS) return state.error;
    return null;
  }

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
      const error = errorToShow();
      if (error) {
        await swapTo("message", messageElements(error, "#E0443EFF"));
        shown = "message";
      } else if (state.lastOk === 0) {
        // Nothing known yet (first launch, no snapshot): hold the screen with the empty frame.
        if (shown !== "skeleton") {
          await swapTo("skeleton", skeletonElements());
          shown = "skeleton";
        }
      } else if (state.streams.length === 0) {
        if (state.settings.showIdle) {
          await swapTo("message", messageElements("Nothing playing", DIM));
          shown = "message";
        } else if (shown !== "blank") {
          await swapTo("blank", []);
          shown = "blank";
        }
      } else {
        const s = state.streams[Math.min(state.current, state.streams.length - 1)]!;
        const sig = signature(s);
        const stale = isStale();
        if (shown === "stream" && shownSig === sig) {
          // Same stream: move the progress bar, and touch the accent only when the data goes stale or live again.
          const update = [barElement(s, slotA, 0, "FF")];
          if (stale !== shownStale) update.push(...capElements(s, slotA, 0, "FF", stale));
          await drawElements(update);
        } else {
          await swapTo("stream", streamElements(s, slotA, 0, "FF", stale));
          shown = "stream";
          shownSig = sig;
        }
        shownStale = stale;
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
    const stale = isStale();
    try {
      if (shown !== "stream") {
        await swapTo("stream", streamElements(to, slotB, 0, "FF", stale));
      } else if (state.settings.transition === "slide") {
        for (let i = 1; i <= TRANSITION_STEPS; i++) {
          const dx = Math.round((SCREEN_W * i) / TRANSITION_STEPS);
          await drawElements(streamElements(from, slotA, -dx, "FF", stale).concat(streamElements(to, slotB, SCREEN_W - dx, "FF", stale)));
          await sleep(TRANSITION_MS);
        }
        await clearIds(idsFor(slotA));
      } else if (state.settings.transition === "fade") {
        const ramp = ["C0", "80", "40", "10"];
        for (const a of ramp) {
          await drawElements(streamElements(from, slotA, 0, a, stale));
          await sleep(TRANSITION_MS);
        }
        // The faint first step of the next stream goes up in the same draw that expires the old one.
        await drawElements(streamElements(to, slotB, 0, "10", stale).concat(streamElements(from, slotA, 0, "10", stale).map(expired)));
        for (const a of ["40", "80", "C0", "FF"]) {
          await sleep(TRANSITION_MS);
          await drawElements(streamElements(to, slotB, 0, a, stale));
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
        await drawElements(streamElements(to, slotB, 0, "FF", stale).concat(curtain(SCREEN_W, 0)));
        for (let i = TRANSITION_STEPS - 1; i >= 0; i--) {
          const w = Math.round((SCREEN_W * i) / TRANSITION_STEPS);
          await drawElements([curtain(w, SCREEN_W - w)]);
          await sleep(TRANSITION_MS);
        }
        await clearIds(["curtain"]);
      } else {
        await drawElements(streamElements(to, slotB, 0, "FF", stale).concat(streamElements(from, slotA, 0, "FF", stale).map(expired)));
      }
      slotA = slotB;
      shownElements = streamElements(to, slotA, 0, "FF", stale);
      shown = "stream";
      shownSig = signature(to);
      shownStale = stale;
      state.current = next;
      state.shownAt = Date.now();
    } finally {
      state.animating = false;
    }
  }

  /**
   * Fetches activity and merges it into the state without losing the stream on screen. A failure keeps the last
   * good streams (dimmed once stale) rather than blanking the screen, and backs off before the next try.
   */
  async function poll(): Promise<void> {
    if (state.stopped || state.polling) return;
    state.polling = true;
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
    try {
      if (!state.settings.apiKey) {
        state.setupError = true;
        throw new Error("Set the API key");
      }
      const fresh = await fetchStreams(state.settings);
      const currentKey = state.streams[state.current]?.key;
      state.streams = fresh;
      state.error = null;
      state.lastOk = Date.now();
      state.failures = 0;
      const keep = fresh.findIndex((s) => s.key === currentKey);
      state.current = keep >= 0 ? keep : 0;
      const content = fresh.map(signature).join("\n") + `|${state.settings.showIdle}`;
      saveSnapshot<Cached>(CACHE_KEY, { streams: fresh, showIdle: state.settings.showIdle }, content, CACHE_HEARTBEAT_MS);
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
      state.failures++;
      report(err);
    } finally {
      state.polling = false;
    }
    await draw();
    schedulePoll();
  }

  function schedulePoll(delayMs?: number): void {
    if (state.stopped) return;
    if (pollTimer !== null) clearTimeout(pollTimer);
    const s = state.settings;
    let seconds = state.streams.length === 0 ? Math.max(s.pollSeconds, IDLE_POLL_SECONDS) : s.pollSeconds;
    if (state.failures > 0) seconds = Math.min(MAX_BACKOFF_SECONDS, s.pollSeconds * Math.pow(2, state.failures));
    pollTimer = setTimeout(() => void poll().catch(report), delayMs ?? seconds * 1000);
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

  // Paint the last known state at once, so the firmware's loading screen gives way immediately; a fresh fetch follows.
  const snap = readSnapshot<Cached>(CACHE_KEY);
  if (snap && Array.isArray(snap.data.streams) && ageOf(snap.savedAt) < CACHE_PLAYING_MAX_MS) {
    const usable = usableStreams(snap.data.streams, snap.savedAt);
    // If every cached stream aged out, nothing about the present is known: show the empty frame, not "Nothing playing".
    if (usable.length > 0 || snap.data.streams.length === 0) {
      state.streams = usable;
      state.lastOk = snap.savedAt;
    }
    state.settings.showIdle = snap.data.showIdle !== false;
  }
  void draw().catch(report);

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
      // A snapshot younger than one poll interval is as good as a fetch: wait out the rest of the interval.
      const wait = state.lastOk > 0 ? state.settings.pollSeconds * 1000 - ageOf(state.lastOk) : 0;
      if (wait > 0) schedulePoll(wait);
      else void poll().catch(report);
      // The idle message may have been drawn from the snapshot's setting; redraw in case it changed.
      void draw().catch(report);
    });
}

main();
