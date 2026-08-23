import type { ApplicationService } from '@adonisjs/core/types';

/**
 * The booted {@link ApplicationService}, captured by `CollaborationProvider.register()` — which the
 * application instantiates with its OWN booted app instance.
 *
 * Why capture it here instead of `import app from '@adonisjs/core/services/app'`: in a pnpm
 * (workspace / hoisted) install this package can resolve a DIFFERENT physical copy of
 * `@adonisjs/core` than the one `bin/server` booted. The instance the provider RECEIVES is always
 * the booted one, so reading it here is immune to a core copy / peer-variant split.
 * Mirrors `@adonis-agora/durable`'s `booted_app`.
 */
let bootedApp: ApplicationService | undefined;
let resolveBootedApp: (app: ApplicationService) => void;
const bootedAppPromise = new Promise<ApplicationService>((resolve) => {
  resolveBootedApp = resolve;
});

/** Record the booted app. Called once by the provider during `register()`. */
export function setBootedApp(app: ApplicationService): void {
  if (bootedApp) return;
  bootedApp = app;
  resolveBootedApp(app);
}

/** Default window `whenBootedApp` waits for the provider before rejecting. */
const DEFAULT_BOOTED_APP_TIMEOUT_MS = 5_000;

/**
 * Resolves with the provider-captured booted app. `services/main` awaits this (instead of importing
 * `@adonisjs/core/services/app`) before reading the container, so its eager population is driven by
 * the SAME app copy `bin/server` booted.
 */
export function whenBootedApp(
  timeoutMs = DEFAULT_BOOTED_APP_TIMEOUT_MS,
): Promise<ApplicationService> {
  if (bootedApp) return Promise.resolve(bootedApp);

  setTimeout(() => {
    resolveBootedApp({
      get booted() {
        throw new Error(
          '@adonis-agora/collaboration: services/main aguardando boot — instale o provider com `node ace configure @adonis-agora/collaboration`',
        );
      },
    } as unknown as ApplicationService);
  }, timeoutMs);

  return bootedAppPromise;
}
