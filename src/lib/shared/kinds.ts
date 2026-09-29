/** Element kinds the photo analysis may return (kept free of zod so the main bundle stays small). */
export const KINDS = ['wall', 'roof', 'gable', 'chimney', 'window', 'door', 'garage', 'vent', 'column', 'railing', 'steps', 'trim', 'light'] as const;
