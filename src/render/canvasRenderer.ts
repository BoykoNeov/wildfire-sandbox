import type { WorldState } from '../core/world';
import type { IRenderer } from '../models/IRenderer';
import { cellRGB, type Rgb } from './palette';

/**
 * 2D top-down canvas renderer (Handoff §2.2). Reads world state, writes pixels;
 * never drives the sim. No perspective camera, no 3D — top-down serves the
 * incident-commander role. Colour decisions live in the shared palette.
 */
export class CanvasRenderer implements IRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly image: ImageData;

  constructor(canvas: HTMLCanvasElement, world: WorldState) {
    canvas.width = world.width;
    canvas.height = world.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    this.image = ctx.createImageData(world.width, world.height);
  }

  render(world: WorldState): void {
    const n = world.width * world.height;
    const data = this.image.data;
    const rgb: Rgb = { r: 0, g: 0, b: 0 };
    for (let i = 0; i < n; i++) {
      cellRGB(world, i, rgb);
      const p = i * 4;
      data[p] = rgb.r;
      data[p + 1] = rgb.g;
      data[p + 2] = rgb.b;
      data[p + 3] = 255;
    }
    this.ctx.putImageData(this.image, 0, 0);
  }
}
