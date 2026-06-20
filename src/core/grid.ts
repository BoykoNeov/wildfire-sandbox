/**
 * A typed-array backed 2D scalar field — one per simulation layer (Handoff §3.5).
 * Typed arrays comfortably handle hundreds of thousands of cells at 60fps.
 */
export type LayerData = Uint8Array | Float32Array;

export class Layer<T extends LayerData> {
  constructor(
    readonly data: T,
    readonly width: number,
    readonly height: number,
  ) {}

  index(x: number, y: number): number {
    return y * this.width + x;
  }

  get(x: number, y: number): number {
    return this.data[y * this.width + x];
  }

  set(x: number, y: number, value: number): void {
    this.data[y * this.width + x] = value;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }
}

export function uint8Layer(width: number, height: number): Layer<Uint8Array> {
  return new Layer(new Uint8Array(width * height), width, height);
}

export function float32Layer(width: number, height: number): Layer<Float32Array> {
  return new Layer(new Float32Array(width * height), width, height);
}
