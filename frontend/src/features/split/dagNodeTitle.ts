export function dagNodeTitle(node: { readonly id: string; readonly label?: string }): string {
  const label = node.label?.trim();
  return label ? label : node.id;
}
