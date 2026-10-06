export const FRAME_MS = 160
export const CAT_WIDTH = 11

export const POSES = [
  ["  ⡠⣒⠄  ⡔⢄⠔⡄", " ⢸⠸⣀⡔⢉⠱⣃⡢⣂⡣", "  ⠉⠒⠣⠤⠵⠤⠬⠮⠆"],
  ["  ⡠⣒⠄  ⡔⢄⠔⡄", " ⢸⠸⣀⡔⠉⠑⣃⡢⣂⡣", "  ⠉⠒⠣⠤⠵⠤⠬⠮⠆"],
  ["  ⡠⣒⠄  ⡔⢄⠢⡄", " ⢸⠸⣀⡔⢉⠱⣃⡢⣂⡣", "  ⠉⠒⠣⠤⠵⠤⠬⠮⠆"],
  ["  ⡠⣒⠂  ⡔⢄⠔⡄", " ⢸⠸⣀⡔⢉⠱⣃⡢⣂⡣", "  ⠉⠒⠣⠤⠵⠤⠬⠮⠆"],
  ["  ⡠⣒⠄  ⡔⢄⠔⡄", " ⢸⠸⣀⡔⢉⠱⣃⡢⣂⡱", "  ⠉⠒⠣⠤⠵⠤⠬⠮⠆"],
] as const

/** Neutral pose between a blink, an ear twitch and a tail flick. Ends neutral. */
export const SEQUENCE = [0, 1, 0, 0, 2, 2, 0, 3, 3, 0, 4, 4, 0] as const

export function pose(frame: number): readonly string[] {
  const index = ((Math.trunc(frame) % SEQUENCE.length) + SEQUENCE.length) % SEQUENCE.length
  return POSES[SEQUENCE[index]!]!
}

export type Mode = "smart" | "always" | "working" | "static"
export const MODES: { mode: Mode; label: string; description: string }[] = [
  { mode: "smart", label: "Smart", description: "Occasional movement, livelier while OpenCode works" },
  { mode: "always", label: "Always", description: "Animate continuously" },
  { mode: "working", label: "Working", description: "Animate only while OpenCode works" },
  { mode: "static", label: "Static", description: "Stay in the neutral pose" },
]

export type Command = { type: "panel" } | { type: "status" } | { type: "visible"; visible: boolean } | { type: "mode"; mode: Mode } | { type: "invalid" }

export function parseCommand(input = ""): Command {
  const command = input.trim().toLowerCase()
  if (!command) return { type: "panel" }
  if (command === "status") return { type: "status" }
  if (command === "show" || command === "on") return { type: "visible", visible: true }
  if (command === "hide" || command === "off") return { type: "visible", visible: false }
  if (MODES.some((entry) => entry.mode === command)) return { type: "mode", mode: command as Mode }
  return { type: "invalid" }
}

interface Range {
  min: number
  max: number
}
export const IDLE_DELAY: Range = { min: 12_000, max: 30_000 }
export const WORKING_DELAY: Range = { min: 1_500, max: 4_000 }

export function randomDelay(range: Range, random: () => number = Math.random): number {
  const sample = Math.max(0, Math.min(0.999_999_999, random()))
  return Math.floor(range.min + sample * (range.max - range.min + 1))
}

export interface Timers {
  set(callback: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realTimers: Timers = { set: (callback, ms) => setTimeout(callback, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) }

/**
 * Drives the frame index; rendering is the caller's job.
 * - smart: one full sequence after a random pause, shorter pauses while working
 * - always: loop continuously
 * - working: loop while working, rest in the neutral pose otherwise
 * - static: neutral pose
 */
export class Animator {
  private frame = 0
  private timer: unknown
  private mode: Mode = "smart"
  private working = false
  private active = false

  constructor(
    private readonly onFrame: (frame: number) => void,
    private readonly timers: Timers = realTimers,
    private readonly random: () => number = Math.random,
  ) {}

  update(next: { mode: Mode; working: boolean; active: boolean }): void {
    if (next.mode === this.mode && next.working === this.working && next.active === this.active) return
    const startedWorking = next.working && !this.working
    this.mode = next.mode
    this.working = next.working
    this.active = next.active
    this.cancel()
    this.setFrame(0)
    // Starting to work makes the smart cat react straight away.
    this.schedule(this.mode === "smart" && startedWorking)
  }

  dispose(): void {
    this.active = false
    this.cancel()
  }

  private schedule(immediate = false): void {
    if (!this.active) return
    if (this.mode === "always" || (this.mode === "working" && this.working)) {
      this.timer = this.timers.set(() => {
        this.setFrame((this.frame + 1) % SEQUENCE.length)
        this.schedule()
      }, FRAME_MS)
    } else if (this.mode === "smart") {
      if (immediate || this.frame > 0) this.step()
      else this.timer = this.timers.set(() => this.step(), randomDelay(this.working ? WORKING_DELAY : IDLE_DELAY, this.random))
    }
  }

  private step(): void {
    this.timer = this.timers.set(() => {
      const next = this.frame + 1
      // The final frame is the neutral pose, so wrapping to 0 is seamless.
      this.setFrame(next >= SEQUENCE.length - 1 ? 0 : next)
      this.schedule()
    }, FRAME_MS)
  }

  private setFrame(frame: number): void {
    if (frame === this.frame) return
    this.frame = frame
    this.onFrame(frame)
  }

  private cancel(): void {
    if (this.timer !== undefined) this.timers.clear(this.timer)
    this.timer = undefined
  }
}
