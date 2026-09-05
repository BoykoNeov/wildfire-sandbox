import type { WorldState } from '../core/world';
import type { IRenderer } from '../models/IRenderer';
import { invalidateGroundColours, invalidateTerrainShading, renderRGBA, type ViewMode } from './palette';

/**
 * 2D top-down canvas renderer (Handoff §2.2). Reads world state, writes pixels;
 * never drives the sim. No perspective camera, no 3D — top-down serves the
 * incident-commander role. All colour/composition decisions live in the shared
 * palette's `renderRGBA`, so this and the headless PNG exporter never drift.
 */
export class CanvasRenderer implements IRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly image: ImageData;
  private readonly world: WorldState;
  /** Which data the unburned landscape encodes (see {@link ViewMode}). Fire draws the same on all. */
  view: ViewMode = 'terrain';
  /** Smoke plumes on the terrain view. */
  smoke = true;
  /** Flash fresh isolated ignitions (embers landing, clicks, a backburn going in). */
  spotFlash = true;

  constructor(canvas: HTMLCanvasElement, world: WorldState) {
    canvas.width = world.width;
    canvas.height = world.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    this.world = world;
    this.image = ctx.createImageData(world.width, world.height);
  }

  /** Call after the editor paints elevation or fuel: hillshade/contours are cached. */
  invalidateTerrain(): void {
    invalidateTerrainShading(this.world);
  }

  /** Call after the editor paints moisture: the unburned ground colour is cached. */
  invalidateGround(): void {
    invalidateGroundColours(this.world);
  }

  render(world: WorldState): void {
    renderRGBA(world, this.image.data, { view: this.view, smoke: this.smoke, spotFlash: this.spotFlash });
    this.ctx.putImageData(this.image, 0, 0);
  }
}
