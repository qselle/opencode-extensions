import { describe, expect, test } from "bun:test"
import { Animator, CAT_WIDTH, FRAME_MS, IDLE_DELAY, POSES, SEQUENCE, WORKING_DELAY, parseCommand, pose, randomDelay, type Timers } from "./cat.ts"

class FakeTimers implements Timers {
  now = 0
  private queue: { at: number; callback: () => void; id: number }[] = []
  private id = 0
  set(callback: () => void, ms: number) {
    const timer = { at: this.now + ms, callback, id: ++this.id }
    this.queue.push(timer)
    return timer.id
  }
  clear(handle: unknown) {
    this.queue = this.queue.filter((timer) => timer.id !== handle)
  }
  get pending() {
    return this.queue.length
  }
  advance(ms: number) {
    const end = this.now + ms
    for (;;) {
      this.queue.sort((a, b) => a.at - b.at)
      const next = this.queue[0]
      if (!next || next.at > end) break
      this.queue.shift()
      this.now = next.at
      next.callback()
    }
    this.now = end
  }
}

function setup() {
  const timers = new FakeTimers()
  const frames: number[] = []
  const animator = new Animator((frame) => frames.push(frame), timers, () => 0)
  return { timers, frames, animator }
}

describe("frames", () => {
  test("every pose fits the sprite width and is three rows", () => {
    for (const lines of POSES) {
      expect(lines).toHaveLength(3)
      for (const line of lines) expect([...line].length).toBeLessThanOrEqual(CAT_WIDTH)
    }
  })

  test("the sequence starts and ends on the neutral pose", () => {
    expect(SEQUENCE[0]).toBe(0)
    expect(SEQUENCE.at(-1)).toBe(0)
    expect(pose(-1)).toBe(POSES[0])
  })
})

describe("Animator", () => {
  test("smart mode waits, plays one sequence, then rests on the neutral pose", () => {
    const { timers, frames, animator } = setup()
    animator.update({ mode: "smart", working: false, active: true })
    timers.advance(IDLE_DELAY.min - 1)
    expect(frames).toEqual([])
    timers.advance(1 + FRAME_MS * (SEQUENCE.length - 1))
    expect(frames).toEqual([...Array.from({ length: SEQUENCE.length - 2 }, (_, index) => index + 1), 0])
    expect(timers.pending).toBe(1)
  })

  test("smart mode reacts immediately when work starts and uses shorter pauses", () => {
    const { timers, frames, animator } = setup()
    animator.update({ mode: "smart", working: false, active: true })
    animator.update({ mode: "smart", working: true, active: true })
    timers.advance(FRAME_MS)
    expect(frames).toEqual([1])
    timers.advance(FRAME_MS * (SEQUENCE.length - 2))
    expect(frames.at(-1)).toBe(0)
    frames.length = 0
    timers.advance(WORKING_DELAY.min + FRAME_MS)
    expect(frames).toEqual([1])
  })

  test("working mode loops only while working", () => {
    const { timers, frames, animator } = setup()
    animator.update({ mode: "working", working: false, active: true })
    timers.advance(60_000)
    expect(frames).toEqual([])
    animator.update({ mode: "working", working: true, active: true })
    timers.advance(FRAME_MS * 3)
    expect(frames).toEqual([1, 2, 3])
    animator.update({ mode: "working", working: false, active: true })
    expect(frames.at(-1)).toBe(0)
    expect(timers.pending).toBe(0)
  })

  test("static, hidden and disposed cats schedule nothing", () => {
    const { timers, animator } = setup()
    animator.update({ mode: "static", working: true, active: true })
    expect(timers.pending).toBe(0)
    animator.update({ mode: "always", working: true, active: false })
    expect(timers.pending).toBe(0)
    animator.update({ mode: "always", working: true, active: true })
    expect(timers.pending).toBe(1)
    animator.dispose()
    expect(timers.pending).toBe(0)
  })
})

describe("parseCommand", () => {
  test("parses every form", () => {
    expect(parseCommand("")).toEqual({ type: "panel" })
    expect(parseCommand(" Status ")).toEqual({ type: "status" })
    expect(parseCommand("off")).toEqual({ type: "visible", visible: false })
    expect(parseCommand("always")).toEqual({ type: "mode", mode: "always" })
    expect(parseCommand("dance")).toEqual({ type: "invalid" })
  })

  test("random delays stay within range", () => {
    expect(randomDelay(IDLE_DELAY, () => 0)).toBe(IDLE_DELAY.min)
    expect(randomDelay(IDLE_DELAY, () => 1)).toBe(IDLE_DELAY.max)
  })
})
