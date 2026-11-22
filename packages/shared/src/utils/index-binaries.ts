const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.bmp', '.webp', '.svg',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac', '.ogg', '.webm',
  '.fbx', '.psd', '.psb', '.exr', '.tga', '.tif', '.tiff', '.dds',
  '.blend', '.max', '.ma', '.mb', '.aif', '.aiff', '.unitypackage',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.xz',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a', '.lib',
  '.pyc', '.pyo', '.class', '.jar', '.war',
  '.sqlite', '.db', '.sqlite3',
  '.lock',
]);

export function isBinaryIndexPath(filePath: string): boolean {
  const lastDot = filePath.lastIndexOf('.');
  return lastDot >= 0 && BINARY_EXTENSIONS.has(filePath.slice(lastDot).toLowerCase());
}
