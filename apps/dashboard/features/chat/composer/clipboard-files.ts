/** Read native clipboard files without taking over ordinary text paste. */
export function clipboardFiles(data: Pick<DataTransfer, 'items' | 'files'>): File[] {
  const items = Array.from(data.items ?? []).filter(item => item.kind === 'file')
    .map(item => item.getAsFile()).filter((file): file is File => file != null);
  const files = items.length ? items : Array.from(data.files ?? []);
  return files.map((file, index) => {
    if (file.name && file.name !== 'image.png') return file;
    const extension = file.type === 'image/jpeg' ? 'jpg' : (file.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
    return new File([file], `pasted-${Date.now()}-${index + 1}.${extension}`, { type: file.type });
  });
}
