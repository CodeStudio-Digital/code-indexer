interface ChangePathParts {
  name: string;
  directory: string;
}

/** Split a Git path for the compact IntelliJ-style file + parent presentation. */
export function changePathParts(path: string): ChangePathParts {
  const separator = path.lastIndexOf('/');
  if (separator < 0) return { name: path, directory: '.' };

  return {
    name: path.slice(separator + 1) || path,
    directory: path.slice(0, separator) || '.',
  };
}
