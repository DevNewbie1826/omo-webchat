export function joinPath(base: string, name: string): string {
  if (base.length === 0) return `/${name}`;
  return base.endsWith("/") ? `${base}${name}` : `${base}/${name}`;
}
