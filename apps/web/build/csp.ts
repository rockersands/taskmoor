// The app's content security policy for the preview server (M1-107). By path, as artefact.ts
// explains: Vite loads its config with Node and bundles only relative imports.
export { contentSecurityPolicy } from '../../../packages/webconfig/src/csp';
