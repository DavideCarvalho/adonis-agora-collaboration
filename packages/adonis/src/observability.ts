import { EventEmitter } from 'node:events';

/**
 * Failure reporting for the collaboration package.
 *
 * The library runs inside sockets and Hocuspocus hooks — places where a
 * thrown error either disappears into a generic handshake failure or is
 * swallowed by the engine. Without a seam here, a database outage and a
 * deliberate denial look identical from the outside, which is exactly how
 * apps end up wrapping every storage method in `console.error` just to see
 * what their own install is doing.
 *
 * Two sinks, in this order:
 *
 * 1. the **Adonis logger**, when the provider could resolve one
 *    ({@link setCollaborationLogger});
 * 2. an **event**, always emitted on {@link collaborationEvents}, so an app
 *    without (or before) a logger can still observe and alert.
 *
 * With neither a logger nor a listener the failure goes to `console.error`:
 * an unobserved outage is the one thing this module must never produce.
 */

/** Minimal logger contract — satisfied by the Adonis (pino) logger. */
export interface CollabLogger {
  error(mergingObject: Record<string, unknown>, message?: string): void;
}

/** What failed, and while doing what. */
export interface CollabErrorEvent {
  /** Subsystem that failed. */
  scope: 'storage' | 'authorize';
  /** Operation being attempted, e.g. `saveDocument`. */
  operation: string;
  /** Document the operation was about, when there is one. */
  docName?: string;
  /** The thrown value, unmodified. */
  error: unknown;
}

/**
 * Event name used on {@link collaborationEvents}.
 *
 * Deliberately NOT `'error'`: an EventEmitter with no listener for `'error'`
 * throws, which would turn an observability hook into a second outage.
 */
export const COLLAB_ERROR_EVENT = 'collaboration:error';

/** Emitter carrying {@link CollabErrorEvent} on {@link COLLAB_ERROR_EVENT}. */
export const collaborationEvents = new EventEmitter();

let logger: CollabLogger | undefined;

/** Installs the logger every report is written to (the provider calls this). */
export function setCollaborationLogger(next: CollabLogger | undefined): void {
  logger = next;
}

/** Subscribes to failures; returns an unsubscribe function. */
export function onCollaborationError(listener: (event: CollabErrorEvent) => void): () => void {
  collaborationEvents.on(COLLAB_ERROR_EVENT, listener);
  return () => {
    collaborationEvents.off(COLLAB_ERROR_EVENT, listener);
  };
}

/** Reports a failure to the logger and/or the event stream. Never throws. */
export function reportCollaborationError(event: CollabErrorEvent): void {
  const where = event.docName ? ` for document "${event.docName}"` : '';
  const message = `[@adonis-agora/collaboration] ${event.scope}.${event.operation} failed${where}`;

  if (logger) {
    try {
      logger.error(
        {
          err: event.error,
          scope: event.scope,
          operation: event.operation,
          ...(event.docName ? { docName: event.docName } : {}),
        },
        message,
      );
    } catch {
      // A broken logger must not escalate into a second failure.
    }
  }

  const hasListener = collaborationEvents.listenerCount(COLLAB_ERROR_EVENT) > 0;
  if (hasListener) {
    collaborationEvents.emit(COLLAB_ERROR_EVENT, event);
    return;
  }

  if (!logger) {
    // Neither sink configured — still better than silence.
    console.error(message, event.error);
  }
}
