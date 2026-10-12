/** Environment variable the global setup uses to hand the server URL to test workers. */
export const ADMIN_URL_ENV = 'TRACKSMITH_TEST_PG_ADMIN_URL';

declare module 'vitest' {
  export interface ProvidedContext {
    tracksmithPgAdminUrl: string;
  }
}
