// Archive venue classification, separate from scope.mjs download permissions.
// Keep entitlement code out of the published SDK dependency graph.
// scope.mjs re-exports this function for compatibility.

/** The venue a given archive path belongs to. */
export function venueOfPath(filePath) {
  return String(filePath).toLowerCase().split('/').includes('predict-fun')
    ? 'predict' : 'polymarket';
}
