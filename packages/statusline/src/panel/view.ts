export interface PanelView { paper?: readonly number[]; compact?: boolean; light?: boolean }
export const LIGHT_CANVAS = [247, 242, 233] as const;
/** Shared symbol positions; retain Ember's confirmed mouse target area. */
export function toggleHit(width: number, x: number, y: number): 'view' | 'skin' | null {
  const end = width - 3;
  return width < 90 || y > 2 || x < end - 6 ? null : x >= end - 2 ? 'view' : 'skin';
}
/** Full edge-to-edge layouts share the measured six-point bottom inset. */
export function panelAir(compact: boolean | undefined, lines: number): number { return !compact && lines > 7 ? 6 : 0; }
