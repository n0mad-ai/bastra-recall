import { renderNeural as classic } from './neural-classic';
import type { NeuralData } from './types';
import type { PanelView } from './view';
import { renderNeural as orbital } from './neural-orbital';
import { renderNeural as ember } from './neural-ember';
export { toggleHit, LIGHT_CANVAS } from './view';
export { NEURAL_DEMO } from './types';
export type { NeuralData } from './types';
export type NeuralDesign = 'classic' | 'orbital' | 'ember';
/** `view` carries what only edge-to-edge designs use: canvas colour, compact view, light skin. */
export function renderNeural(data: NeuralData, width = 120, frame = 0, color = true, design: NeuralDesign = 'orbital', view?: PanelView): string[] {
  return design === 'ember' ? ember(data, width, frame, color, view) : (design === 'classic' ? classic : orbital)(data, width, frame, color, view);
}
