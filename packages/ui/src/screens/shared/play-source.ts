/**
 * What a `<video>` gets from a `PlaySource` (contracts v14). A `url` or `service-worker` source is
 * the element's `src`; a `mediasource` source is attached by the web shell; an `element` source
 * (ADR 0022) drives the element itself through `attach`, so the screen sets no `src`.
 */
import type { PlaySource } from '@sovit/core';

/** The URL to set as the element's `src`, or `undefined` when the source supplies the media. */
export function playSourceUrl(source: PlaySource): string | undefined {
  return source.kind === 'url' || source.kind === 'service-worker' ? source.url : undefined;
}
