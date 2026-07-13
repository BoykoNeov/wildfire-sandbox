import type { WorldState } from '../core/world';
import type { IRenderer } from '../models/IRenderer';
import { renderRGBA } from './palette';

/**
 * 2D top-down canvas renderer (Handoff §2.2). Reads world state, writes pixels;
 * never drives the sim. No perspective camera, no 3D — top-down serves the
 * incident-commander role. All colour/composition decisions live in the shared
 * palette's `renderRGBA`, so this and the headless PNG exporter never drift.
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
    renderRGBA(world, this.image.data);
    this.ctx.putImageData(this.image, 0, 0);
  }
}
