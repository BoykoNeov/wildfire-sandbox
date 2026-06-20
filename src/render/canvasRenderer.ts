import { FireState, type WorldState } from '../core/world';
import type { IRenderer } from '../models/IRenderer';
import { Fuel } from '../sim/basicFuelModel';

/**
 * 2D top-down canvas renderer (Handoff §2.2). Reads world state, writes pixels;
 * never drives the sim. Cheap elevation tint for legibility + a fire overlay.
 * No perspective camera, no 3D — top-down serves the incident-commander role.
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
    const { width, height, layers } = world;
    const data = this.image.data;
    const fire = layers.fire.data;
    const fuel = layers.fuel.data;
    const elev = layers.elevation.data;

    for (let i = 0; i < width * height; i++) {
      let r: number;
      let g: number;
      let b: number;
      const state = fire[i];
      if (state === FireState.Burning) {
        r = 255;
        g = 120 + ((i * 37) % 80);
        b = 0;
      } else if (state === FireState.Burned) {
        r = 30;
        g = 26;
        b = 24;
      } else {
        const shade = 0.6 + (0.4 * elev[i]) / 1000;
        switch (fuel[i]) {
          case Fuel.Grass:
            r = 150 * shade;
            g = 190 * shade;
            b = 90 * shade;
            break;
          case Fuel.Brush:
            r = 110 * shade;
            g = 150 * shade;
            b = 70 * shade;
            break;
          case Fuel.Timber:
            r = 50 * shade;
            g = 100 * shade;
            b = 55 * shade;
            break;
          default:
            r = 60;
            g = 90;
            b = 140; // water / rock
        }
      }
      const p = i * 4;
      data[p] = r;
      data[p + 1] = g;
      data[p + 2] = b;
      data[p + 3] = 255;
    }
    this.ctx.putImageData(this.image, 0, 0);
  }
}
