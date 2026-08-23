// Which venue an archive path belongs to.
//
// Split out of scope.mjs so that the parts of the codebase that only need to
// CLASSIFY a path do not have to import the file that decides who may DOWNLOAD
// one. data-taxonomy.mjs needs this function, and data-taxonomy.mjs is reachable
// from the published `outcometick` package — which would otherwise have dragged
// the whole entitlement gate into a public repo along with it.
//
// scope.mjs still re-exports this so its own export surface is unchanged; the
// copy of scope.mjs that chainlink-data keeps in sync is unaffected.

/** The venue a given archive path belongs to. */
export function venueOfPath(filePath) {
  return String(filePath).toLowerCase().split('/').includes('predict-fun')
    ? 'predict' : 'polymarket';
}
