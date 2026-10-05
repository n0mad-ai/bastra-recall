import { renderNeural as classic, type NeuralData } from './neural-classic';
import { renderNeural as orbital } from './neural-orbital';
export { NEURAL_DEMO } from './neural-classic';
export type { NeuralData } from './neural-classic';
export type NeuralDesign = 'classic' | 'orbital';
export function renderNeural(data: NeuralData, width = 120, frame = 0, color = true, design: NeuralDesign = 'orbital'): string[] {
  return (design === 'classic' ? classic : orbital)(data, width, frame, color);
}
