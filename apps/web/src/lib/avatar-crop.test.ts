import { describe, expect, it } from "vitest";
import { centerCropSquare } from "./avatar-crop.ts";

describe("centerCropSquare", () => {
  it("crops a wide picture from its middle, never stretching it", () => {
    expect(centerCropSquare(600, 300)).toEqual({ sx: 150, sy: 0, side: 300 });
  });
  it("crops a tall picture from its middle", () => {
    expect(centerCropSquare(300, 900)).toEqual({ sx: 0, sy: 300, side: 300 });
  });
  it("leaves a square picture alone", () => {
    expect(centerCropSquare(512, 512)).toEqual({ sx: 0, sy: 0, side: 512 });
  });
  it("copes with odd sizes and degenerate input", () => {
    expect(centerCropSquare(101, 50)).toEqual({ sx: 25, sy: 0, side: 50 });
    expect(centerCropSquare(0, 0).side).toBe(1);
  });
});
