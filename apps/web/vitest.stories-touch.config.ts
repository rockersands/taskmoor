import { storiesProject } from './vitest.stories.config';

/**
 * The stories tagged `touch` in the light skin, on a browser that is a touch screen from the start
 * (T-328): `(pointer: coarse)` holds for the whole page, as on a phone.
 */
export default storiesProject('light', 'touch');
