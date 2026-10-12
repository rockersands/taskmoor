import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';
import { installMatchMedia, setViewportWidth } from './viewport';

installMatchMedia();

// Every test starts on a desktop-sized viewport, the primary target.
beforeEach(() => {
  setViewportWidth(1440);
  window.location.hash = '';
});

afterEach(() => {
  cleanup();
});
