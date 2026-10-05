import { renderNeural as classic, type NeuralData } from './neural-classic';
import { renderNeural as orbital } from './neural-orbital';
import { renderNeural as ember, type EmberView } from './neural-ember';
export { toggleHit, LIGHT_CANVAS } from './neural-ember';
export { NEURAL_DEMO } from './neural-classic';
export type { NeuralData } from './neural-classic';
export type NeuralDesign = 'classic' | 'orbital' | 'ember';
/** `view` carries what only edge-to-edge designs use: canvas colour, compact view, light skin. */
export function renderNeural(data: NeuralData, width = 120, frame = 0, color = true, design: NeuralDesign = 'orbital', view?: EmberView): string[] {
  return design === 'ember' ? ember(data, width, frame, color, view) : (design === 'classic' ? classic : orbital)(data, width, frame, color);
}
