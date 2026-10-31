import { ISSUE_ROUTES } from './issues';
import { PLATFORM_ROUTES } from './platform';
import type { ShimRoute } from './types';

/** Every route of the Jira-compatible API the shim serves (M1-069; ADR-086). */
export const COMPAT_ROUTES: readonly ShimRoute[] = [...ISSUE_ROUTES, ...PLATFORM_ROUTES];
export { fromNative } from './map';
export {
  type Native,
  type NativeAnswer,
  type ShimContext,
  ShimError,
  type ShimReply,
  type ShimRoute,
} from './types';
