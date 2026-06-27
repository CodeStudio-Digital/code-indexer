// The `mssql` package's bundled types aren't resolved in this workspace's TS
// setup; the driver imports it dynamically and casts to a minimal local shape,
// so an opaque module declaration is enough to type-check.
declare module 'mssql';
