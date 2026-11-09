import cors, { type CorsOptions } from 'cors';
import type { Express } from 'express';
import helmet from 'helmet';

export interface SecurityConfig {
  corsAllowedOrigins: string[];
}

export const parseOrigins = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

export const loadSecurityConfig = (env: NodeJS.ProcessEnv = process.env): SecurityConfig => ({
  corsAllowedOrigins: parseOrigins(env.CORS_ALLOWED_ORIGINS),
});

export const buildCorsOptions = (allowedOrigins: string[]): CorsOptions => {
  if (allowedOrigins.includes('*')) {
    // Wildcard is never combined with credentials.
    return { origin: '*', credentials: false };
  }
  return {
    credentials: true,
    origin: (origin, callback) => {
      // Non-browser clients (no Origin header, e.g. the gateway) are not subject to CORS.
      callback(null, origin !== undefined && allowedOrigins.includes(origin));
    },
  };
};

/** helmet + CORS. Must be mounted before any router. */
export const applySecurityHeaders = (app: Express, config: SecurityConfig): void => {
  app.use(helmet());
  app.use(cors(buildCorsOptions(config.corsAllowedOrigins)));
};
