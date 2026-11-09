import { storiesProject } from './vitest.stories.config';

/**
 * The same story tests in the dark skin (ADR-036): every story's axe checks run once per skin,
 * so a skin cannot ship with a contrast failure. The setup file reads STORY_SKIN.
 */
export default storiesProject('dark');
